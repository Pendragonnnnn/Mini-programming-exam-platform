import bcrypt from 'bcryptjs';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { assertTeachesCourse, authenticate, initials, randomToken, requireRole, sha256 } from '../auth';
import { config } from '../config';
import { one, pool, q, tx, type Db } from '../db';
import { conflict, h, invalid, notFound } from '../errors';
import { audit, notify } from '../services/audit';
import { emailEnabled, sendMailLater, type Mail } from '../services/mailer';

/**
 * Courses, classes, students and co-teachers. Teachers manage everything themselves:
 * students are added by student ID and get an invite message to set their own password.
 */
export const manageRouter = Router();
manageRouter.use('/teacher', authenticate, requireRole('teacher'));

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const me = (req: Request) => req.user!;

export const studentIdSchema = z
  .string()
  .trim()
  .min(2, 'Student ID is too short.')
  .max(40, 'Student ID is too long.')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore in student IDs.')
  .transform((s) => s.toUpperCase());
const emailSchema = z.string().trim().max(200).email('Enter a valid email address.');
const optEmail = z.union([emailSchema, z.literal('').transform(() => null), z.null()]).optional();

async function unusableHash() {
  return bcrypt.hash(randomToken(24), 10);
}

/** New invite link (older unused invites stay valid until they expire). */
export async function createInvite(userId: string, db: Db): Promise<string> {
  const token = randomToken(32);
  await q(
    `INSERT INTO password_resets(user_id, token_hash, expires_at, purpose) VALUES ($1,$2, now() + make_interval(days => $3), 'invite')`,
    [userId, sha256(token), config.inviteTtlDays],
    db,
  );
  return `${config.appPublicUrl}/reset?token=${token}&invite=1`;
}

function studentInviteMail(u: { email: string; full_name: string; student_id: string }, link: string, teacherName: string, courseLabel: string): Mail {
  return {
    to: u.email,
    subject: `${config.appName}: set up your exam account`,
    title: `Hello ${u.full_name}`,
    paragraphs: [
      `${teacherName} added you to ${courseLabel} on ${config.appName}, where you will take your exams.`,
      `Your student ID is ${u.student_id}. Choose your password with the button below, then sign in with your student ID.`,
      `This link works for ${config.inviteTtlDays} days. If it expires, ask your teacher to send a new one.`,
    ],
    button: { label: 'Set my password', url: link },
  };
}

async function ownClass(req: Request, classId: string) {
  const cl = await one(`SELECT cl.*, c.code AS course_code, c.title AS course_title FROM classes cl JOIN courses c ON c.id = cl.course_id WHERE cl.id = $1`, [classId]);
  if (!cl) throw notFound('NOT_FOUND', 'Class not found.');
  await assertTeachesCourse(me(req).id, cl.course_id);
  return cl;
}

/** A student the teacher may manage (enrolled in one of their courses). */
async function ownStudent(req: Request, userId: string) {
  const u = await one(
    `SELECT DISTINCT u.* FROM users u JOIN enrollments en ON en.student_id = u.id JOIN classes cl ON cl.id = en.class_id
     JOIN course_teachers ct ON ct.course_id = cl.course_id WHERE u.id = $1 AND u.role = 'student' AND ct.teacher_id = $2`,
    [userId, me(req).id],
  );
  if (!u) throw notFound('NOT_FOUND', 'Student not found.');
  return u;
}

const studentDto = (u: any) => ({
  id: u.id,
  studentId: u.student_id,
  fullName: u.full_name,
  initials: initials(u.full_name),
  email: u.email,
  status: !u.is_active ? 'disabled' : u.password_set_at ? 'active' : 'invited',
  lastLoginAt: iso(u.last_login_at),
});

// ---------------------------------------------------------------- courses
manageRouter.post(
  '/teacher/courses',
  h(async (req, res) => {
    const b = z
      .object({
        code: z.string().trim().min(1, 'Enter a course code.').max(40),
        title: z.string().trim().min(1, 'Enter a course title.').max(200),
        termName: z.string().trim().min(1, 'Enter a term, e.g. Semester 1 2026.').max(80),
        department: z.string().trim().max(120).optional().nullable(),
      })
      .parse(req.body);
    const id = await tx(async (c) => {
      let term = await one(`SELECT id FROM terms WHERE name = $1`, [b.termName], c);
      term ??= await one(`INSERT INTO terms(name, starts_on, ends_on) VALUES ($1, current_date, current_date + 180) RETURNING id`, [b.termName], c);
      const dup = await one(`SELECT 1 FROM courses WHERE term_id = $1 AND code = $2`, [term.id, b.code], c);
      if (dup) throw invalid(`${b.code} already exists in ${b.termName}.`, { code: 'Already exists in this term.' });
      const co = await one(`INSERT INTO courses(term_id, code, title, department, is_demo) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [term.id, b.code, b.title, b.department || null, me(req).isDemo], c);
      await q(`INSERT INTO course_teachers(course_id, teacher_id) VALUES ($1,$2)`, [co.id, me(req).id], c);
      await audit({ actor: me(req), category: 'settings', action: 'course.created', courseId: co.id, target: `${b.code} · ${b.title}`, details: `Created course in ${b.termName}` }, c);
      return co.id;
    });
    res.status(201).json({ id });
  }),
);

manageRouter.patch(
  '/teacher/courses/:courseId',
  h(async (req, res) => {
    const id = String(req.params.courseId);
    await assertTeachesCourse(me(req).id, id);
    const b = z.object({ code: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(200), department: z.string().trim().max(120).nullable() }).partial().parse(req.body);
    await q(`UPDATE courses SET code = COALESCE($2, code), title = COALESCE($3, title), department = CASE WHEN $5 THEN $4 ELSE department END WHERE id = $1`, [
      id,
      b.code ?? null,
      b.title ?? null,
      b.department || null,
      b.department !== undefined,
    ]).catch((e) => {
      if (e?.code === '23505') throw invalid('Another course in this term already uses that code.', { code: 'Already used' });
      throw e;
    });
    res.json({ ok: true });
  }),
);

manageRouter.delete(
  '/teacher/courses/:courseId',
  h(async (req, res) => {
    const id = String(req.params.courseId);
    await assertTeachesCourse(me(req).id, id);
    const used = await one<{ e: number; qn: number }>(
      `SELECT (SELECT count(*)::int FROM exams WHERE course_id = $1 AND preview_question_id IS NULL) AS e, (SELECT count(*)::int FROM questions WHERE course_id = $1) AS qn`,
      [id],
    );
    if (used!.e || used!.qn) throw conflict('COURSE_IN_USE', 'This course has exams or questions. Delete or move them first.');
    await tx(async (c) => {
      await q(`DELETE FROM exams WHERE course_id = $1`, [id], c);
      await q(`DELETE FROM courses WHERE id = $1`, [id], c);
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- co-teachers
manageRouter.get(
  '/teacher/courses/:courseId/teachers',
  h(async (req, res) => {
    const id = String(req.params.courseId);
    await assertTeachesCourse(me(req).id, id);
    const rows = await q(`SELECT u.* FROM users u JOIN course_teachers ct ON ct.teacher_id = u.id WHERE ct.course_id = $1 ORDER BY u.full_name`, [id]);
    res.json({ items: rows.map((u: any) => ({ id: u.id, fullName: u.full_name, email: u.email, status: u.password_set_at ? 'active' : 'invited', isMe: u.id === me(req).id })) });
  }),
);

manageRouter.post(
  '/teacher/courses/:courseId/teachers',
  h(async (req, res) => {
    const id = String(req.params.courseId);
    await assertTeachesCourse(me(req).id, id);
    const b = z.object({ email: emailSchema, fullName: z.string().trim().min(1, 'Enter their name.').max(120) }).parse(req.body);
    const course = await one(`SELECT code, title FROM courses WHERE id = $1`, [id]);
    if (me(req).isDemo) throw invalid('Demo accounts cannot add teachers.', { email: 'Not available in demo mode' });
    const out = await tx(async (c) => {
      let u = await one(`SELECT * FROM users WHERE lower(email) = lower($1)`, [b.email], c);
      if (u?.is_demo) throw invalid('That email belongs to a demo account.', { email: 'Demo account' });
      let link: string | null = null;
      if (u && u.role !== 'teacher') throw invalid('That email belongs to a student account.', { email: 'Student account' });
      if (!u) {
        u = await one(`INSERT INTO users(role, email, full_name, password_hash) VALUES ('teacher',$1,$2,$3) RETURNING *`, [b.email, b.fullName, await unusableHash()], c);
        link = await createInvite(u.id, c);
      }
      await q(`INSERT INTO course_teachers(course_id, teacher_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id], c);
      await audit({ actor: me(req), category: 'settings', action: 'course.teacher_added', courseId: id, target: `${course.code} · ${course.title}`, details: `Added ${u.full_name} as a teacher` }, c);
      return { u, link };
    });
    if (out.link) {
      sendMailLater([
        {
          to: b.email,
          subject: `${config.appName}: you were added as a teacher`,
          title: `Hello ${b.fullName}`,
          paragraphs: [`${me(req).fullName} added you as a teacher of ${course.code} · ${course.title} on ${config.appName}.`, 'Choose your password with the button below, then sign in with your email on the Teacher tab.'],
          button: { label: 'Set my password', url: out.link },
        },
      ]);
    }
    res.status(201).json({ id: out.u.id, invited: !!out.link, emailSent: !!out.link && emailEnabled(), inviteLink: out.link && !emailEnabled() ? out.link : null });
  }),
);

manageRouter.delete(
  '/teacher/courses/:courseId/teachers/:userId',
  h(async (req, res) => {
    const id = String(req.params.courseId);
    await assertTeachesCourse(me(req).id, id);
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM course_teachers WHERE course_id = $1`, [id]);
    if (n!.n <= 1) throw conflict('LAST_TEACHER', 'A course needs at least one teacher.');
    await q(`DELETE FROM course_teachers WHERE course_id = $1 AND teacher_id = $2`, [id, req.params.userId]);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- classes
manageRouter.post(
  '/teacher/courses/:courseId/classes',
  h(async (req, res) => {
    const id = String(req.params.courseId);
    await assertTeachesCourse(me(req).id, id);
    const b = z.object({ code: z.string().trim().min(1, 'Enter a class name, e.g. Group A.').max(60) }).parse(req.body);
    const dup = await one(`SELECT 1 FROM classes WHERE course_id = $1 AND code = $2`, [id, b.code]);
    if (dup) throw invalid('A class with this name already exists in the course.', { code: 'Already exists' });
    const cl = await one(`INSERT INTO classes(course_id, code) VALUES ($1,$2) RETURNING id`, [id, b.code]);
    res.status(201).json({ id: cl.id, code: b.code });
  }),
);

manageRouter.patch(
  '/teacher/classes/:classId',
  h(async (req, res) => {
    const cl = await ownClass(req, String(req.params.classId));
    const b = z.object({ code: z.string().trim().min(1).max(60) }).parse(req.body);
    const dup = await one(`SELECT 1 FROM classes WHERE course_id = $1 AND code = $2 AND id <> $3`, [cl.course_id, b.code, cl.id]);
    if (dup) throw invalid('A class with this name already exists in the course.', { code: 'Already exists' });
    await q(`UPDATE classes SET code = $2 WHERE id = $1`, [cl.id, b.code]);
    res.json({ id: cl.id, code: b.code });
  }),
);

manageRouter.delete(
  '/teacher/classes/:classId',
  h(async (req, res) => {
    const cl = await ownClass(req, String(req.params.classId));
    const used = await one(`SELECT 1 FROM exam_classes ec JOIN exams e ON e.id = ec.exam_id WHERE ec.class_id = $1 AND e.status <> 'draft' LIMIT 1`, [cl.id]);
    if (used) throw conflict('CLASS_IN_USE', 'This class has published exams, so it cannot be deleted.');
    await tx(async (c) => {
      await q(`DELETE FROM exam_classes WHERE class_id = $1`, [cl.id], c);
      await q(`DELETE FROM classes WHERE id = $1`, [cl.id], c);
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------- students
manageRouter.get(
  '/teacher/classes/:classId/students',
  h(async (req, res) => {
    const cl = await ownClass(req, String(req.params.classId));
    const rows = await q(`SELECT u.*, en.enrolled_at FROM users u JOIN enrollments en ON en.student_id = u.id WHERE en.class_id = $1 ORDER BY u.student_id`, [cl.id]);
    res.json({
      class: { id: cl.id, code: cl.code, courseId: cl.course_id, courseCode: cl.course_code, courseTitle: cl.course_title },
      emailEnabled: emailEnabled(),
      items: rows.map((u: any) => ({ ...studentDto(u), enrolledAt: iso(u.enrolled_at) })),
    });
  }),
);

/** Add students by student ID (one or many). New accounts get an invite; existing ones are just enrolled. */
manageRouter.post(
  '/teacher/classes/:classId/students',
  h(async (req, res) => {
    const cl = await ownClass(req, String(req.params.classId));
    const b = z
      .object({
        students: z.array(z.object({ studentId: studentIdSchema, fullName: z.string().trim().max(120).optional().default(''), email: optEmail })).min(1, 'Add at least one student ID.').max(1000),
        sendInvites: z.boolean().default(true),
      })
      .parse(req.body);
    const seen = new Set<string>();
    for (const [i, s] of b.students.entries()) {
      if (seen.has(s.studentId)) throw invalid(`${s.studentId} is listed twice.`, { [`students[${i}].studentId`]: 'Listed twice' });
      seen.add(s.studentId);
    }
    const courseLabel = `${cl.course_code} · ${cl.course_title}`;
    const mails: Mail[] = [];
    const results = await tx(async (c) => {
      const out: any[] = [];
      for (const [i, s] of b.students.entries()) {
        let u = await one(`SELECT * FROM users WHERE upper(student_id) = $1`, [s.studentId], c);
        let created = false;
        if (!u) {
          if (s.email) {
            const taken = await one(`SELECT student_id FROM users WHERE lower(email) = lower($1)`, [s.email], c);
            if (taken) throw invalid(`${s.email} is already used by ${taken.student_id ?? 'a teacher'}.`, { [`students[${i}].email`]: 'Email already used' });
          }
          u = await one(
            `INSERT INTO users(role, email, student_id, full_name, password_hash, is_demo) VALUES ('student',$1,$2,$3,$4,$5) RETURNING *`,
            [s.email ?? null, s.studentId, s.fullName || s.studentId, await unusableHash(), me(req).isDemo],
            c,
          );
          created = true;
        } else if (u.is_demo !== me(req).isDemo) {
          // Demo and real accounts never mix: demo teachers can't see real students, and the other way round.
          throw invalid(`${s.studentId} is ${u.is_demo ? 'a demo account' : 'a real student account, which a demo teacher cannot add'}.`, { [`students[${i}].studentId`]: 'Not allowed' });
        } else if (u.role !== 'student') {
          throw invalid(`${s.studentId} belongs to a teacher account.`, { [`students[${i}].studentId`]: 'Teacher account' });
        } else {
          // Fill in details the teacher now knows; never overwrite with blanks.
          if ((s.fullName && u.full_name === u.student_id) || (s.email && !u.email)) {
            u = await one(`UPDATE users SET full_name = CASE WHEN full_name = student_id AND $2 <> '' THEN $2 ELSE full_name END, email = COALESCE(email, $3), updated_at = now() WHERE id = $1 RETURNING *`, [u.id, s.fullName, s.email ?? null], c);
          }
        }
        const enr = await one(`INSERT INTO enrollments(class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING class_id`, [cl.id, u.id], c);
        let inviteLink: string | null = null;
        let emailQueued = false;
        if (b.sendInvites && !u.password_set_at) {
          const link = await createInvite(u.id, c);
          if (u.email && emailEnabled()) {
            mails.push(studentInviteMail(u, link, me(req).fullName, courseLabel));
            emailQueued = true;
          } else inviteLink = link;
        }
        out.push({ id: u.id, studentId: u.student_id, fullName: u.full_name, email: u.email, created, enrolled: !!enr, alreadyEnrolled: !enr, status: u.password_set_at ? 'active' : 'invited', emailQueued, inviteLink });
      }
      // In-app message for students who already have an account.
      const existing = out.filter((r) => r.enrolled && r.status === 'active').map((r) => r.id);
      if (existing.length) await notify(existing, { type: 'teacher_message', title: `You were added to ${courseLabel} (${cl.code})`, actorName: me(req).fullName, link: '/student' }, c);
      await audit({ actor: me(req), category: 'settings', action: 'class.students_added', courseId: cl.course_id, target: `${cl.course_code} ${cl.code}`, details: `Added ${out.filter((r) => r.enrolled).length} students (${out.filter((r) => r.created).length} new accounts)` }, c);
      return out;
    });
    sendMailLater(mails);
    res.status(201).json({
      emailEnabled: emailEnabled(),
      created: results.filter((r) => r.created).length,
      enrolled: results.filter((r) => r.enrolled).length,
      alreadyEnrolled: results.filter((r) => r.alreadyEnrolled).length,
      emailsQueued: results.filter((r) => r.emailQueued).length,
      items: results,
    });
  }),
);

manageRouter.delete(
  '/teacher/classes/:classId/students/:userId',
  h(async (req, res) => {
    const cl = await ownClass(req, String(req.params.classId));
    await q(`DELETE FROM enrollments WHERE class_id = $1 AND student_id = $2`, [cl.id, req.params.userId]);
    res.status(204).end();
  }),
);

manageRouter.patch(
  '/teacher/students/:userId',
  h(async (req, res) => {
    const u = await ownStudent(req, String(req.params.userId));
    const b = z.object({ fullName: z.string().trim().min(1).max(120), email: optEmail, isActive: z.boolean() }).partial().parse(req.body);
    if (b.email) {
      const taken = await one(`SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2`, [b.email, u.id]);
      if (taken) throw invalid('That email is already used.', { email: 'Already used' });
    }
    const row = await one(
      `UPDATE users SET full_name = COALESCE($2, full_name), email = CASE WHEN $3 THEN $4 ELSE email END, is_active = COALESCE($5, is_active), updated_at = now() WHERE id = $1 RETURNING *`,
      [u.id, b.fullName ?? null, b.email !== undefined, b.email ?? null, b.isActive ?? null],
    );
    if (b.isActive === false) await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
    res.json(studentDto(row));
  }),
);

/** Send (or re-send) the invite / password link to one student. */
manageRouter.post(
  '/teacher/students/:userId/invite',
  h(async (req, res) => {
    const u = await ownStudent(req, String(req.params.userId));
    const course = await one(
      `SELECT c.code, c.title FROM courses c JOIN classes cl ON cl.course_id = c.id JOIN enrollments en ON en.class_id = cl.id JOIN course_teachers ct ON ct.course_id = c.id
       WHERE en.student_id = $1 AND ct.teacher_id = $2 LIMIT 1`,
      [u.id, me(req).id],
    );
    const link = await createInvite(u.id, pool);
    const willEmail = !!u.email && emailEnabled();
    if (willEmail) sendMailLater([studentInviteMail(u, link, me(req).fullName, `${course.code} · ${course.title}`)]);
    res.json({ emailQueued: willEmail, inviteLink: willEmail ? null : link });
  }),
);

/** Message every student in a class: in-app notification + email when configured. */
manageRouter.post(
  '/teacher/classes/:classId/message',
  h(async (req, res) => {
    const cl = await ownClass(req, String(req.params.classId));
    const b = z.object({ subject: z.string().trim().min(1, 'Add a subject.').max(150), body: z.string().trim().min(1, 'Write a message.').max(5000), sendEmail: z.boolean().default(true) }).parse(req.body);
    const students = await q(`SELECT u.id, u.email, u.full_name FROM users u JOIN enrollments en ON en.student_id = u.id WHERE en.class_id = $1 AND u.is_active`, [cl.id]);
    await notify(students.map((s: any) => s.id), { type: 'teacher_message', title: `${b.subject} — ${b.body.slice(0, 160)}`, actorName: me(req).fullName, link: '/student' });
    const mails: Mail[] = b.sendEmail && emailEnabled()
      ? students.filter((s: any) => s.email).map((s: any) => ({ to: s.email, subject: `${cl.course_code}: ${b.subject}`, title: b.subject, paragraphs: [`Hello ${s.full_name},`, b.body, `— ${me(req).fullName}, ${cl.course_code} · ${cl.course_title}`], button: { label: `Open ${config.appName}`, url: `${config.appPublicUrl}/login` } }))
      : [];
    sendMailLater(mails);
    res.status(201).json({ notified: students.length, emailsQueued: mails.length, emailEnabled: emailEnabled() });
  }),
);
