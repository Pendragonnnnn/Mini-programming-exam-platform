import { Router, type Request } from 'express';
import { z } from 'zod';
import { assertTeachesCourse, authenticate, initials, requireRole, teacherCourseIds } from '../auth';
import { config } from '../config';
import { one, q, tx } from '../db';
import { conflict, forbidden, h, invalid, notFound } from '../errors';
import { audit, notify } from '../services/audit';
import { sendMailLater } from '../services/mailer';
import { examDto, publishChecks, recomputeDeadlines, refreshSnapshots, windowClosesAt } from '../services/exams';
import { submitSession } from '../services/grading';
import { kick } from '../services/runs';
import { ENABLED_LANGS } from '../services/languages';
import { isCode, langSchema } from '../services/questions';
import { describeResponse, isAnswered } from '../services/choice';

export const teacherRouter = Router();
teacherRouter.use('/teacher', authenticate, requireRole('teacher'));

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const me = (req: Request) => req.user!;

/** Load an exam the teacher may manage, or 404. */
export async function ownExam(req: Request, id: string) {
  const e = await one(`SELECT * FROM exams WHERE id = $1`, [id]);
  if (!e) throw notFound('EXAM_NOT_FOUND', 'Exam not found.');
  const ok = await one(`SELECT 1 FROM course_teachers WHERE course_id = $1 AND teacher_id = $2`, [e.course_id, me(req).id]);
  if (!ok) throw notFound('EXAM_NOT_FOUND', 'Exam not found.');
  return e;
}

function action(status: string) {
  return status === 'live' ? 'monitor' : status === 'grading' ? 'grade' : status === 'completed' ? 'results' : 'edit';
}

async function examRows(courseIds: string[], filter: { status?: string[]; courseId?: string; q?: string }) {
  const rows = await q(
    `SELECT e.*, c.code AS course_code, c.title AS course_title,
       (SELECT count(DISTINCT en.student_id)::int FROM exam_classes ec JOIN enrollments en ON en.class_id = ec.class_id WHERE ec.exam_id = e.id) AS assigned,
       (SELECT count(*)::int FROM exam_sessions s WHERE s.exam_id = e.id AND s.status = 'in_progress' AND NOT s.is_preview) AS in_progress,
       (SELECT count(*)::int FROM exam_sessions s WHERE s.exam_id = e.id AND s.status IN ('submitted','auto_submitted','force_submitted') AND NOT s.is_preview) AS submitted,
       (SELECT count(*)::int FROM exam_sessions s WHERE s.exam_id = e.id AND NOT s.is_preview) AS real_sessions,
       (SELECT array_agg(el.language ORDER BY el.language) FROM exam_languages el WHERE el.exam_id = e.id
          AND (NOT EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.exam_id = e.id AND eq.snapshot ? 'languages')
               OR EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.exam_id = e.id AND COALESCE(eq.snapshot->>'type', 'code') = 'code' AND eq.snapshot->'languages' ? el.language::text))) AS langs
     FROM exams e JOIN courses c ON c.id = e.course_id
     WHERE e.course_id = ANY($1::uuid[]) AND NOT e.is_practice AND e.preview_question_id IS NULL
       AND ($2::text[] IS NULL OR e.status::text = ANY($2::text[]))
       AND ($3::uuid IS NULL OR e.course_id = $3)
       AND ($4::text = '' OR e.title ILIKE '%' || $4 || '%')
     ORDER BY CASE e.status WHEN 'live' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 WHEN 'grading' THEN 3 ELSE 4 END, e.starts_at DESC NULLS LAST`,
    [courseIds, filter.status ?? null, filter.courseId ?? null, filter.q ?? ''],
  );
  return rows.map((e: any) => ({
    examId: e.id,
    title: e.short_title ?? e.title,
    fullTitle: e.title,
    course: `${e.course_code} · ${e.course_title}`,
    languages: e.langs ?? [],
    status: e.status,
    startsAt: iso(e.starts_at),
    submissions: e.status === 'draft' ? null : { inProgress: e.in_progress, submitted: e.submitted, assigned: e.assigned },
    canReopen: e.status === 'grading' && e.real_sessions === 0,
    action: action(e.status),
  }));
}

// ---------------------------------------------------------------- dashboard
teacherRouter.get(
  '/teacher/dashboard',
  h(async (req, res) => {
    const u = me(req);
    const courseIds = await teacherCourseIds(u.id);
    const exams = await examRows(courseIds, {});
    const term = await one(`SELECT t.name FROM terms t JOIN courses c ON c.term_id = t.id WHERE c.id = ANY($1::uuid[]) ORDER BY t.starts_on DESC LIMIT 1`, [courseIds]);
    const students = await one<{ n: number; c: number }>(
      `SELECT count(DISTINCT en.student_id)::int AS n, count(DISTINCT cl.id)::int AS c FROM classes cl LEFT JOIN enrollments en ON en.class_id = cl.id WHERE cl.course_id = ANY($1::uuid[])`,
      [courseIds],
    );
    const toGrade = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM submissions sb JOIN exam_sessions s ON s.id = sb.session_id JOIN exams e ON e.id = s.exam_id
       WHERE e.course_id = ANY($1::uuid[]) AND sb.grading_status = 'needs_review' AND NOT s.is_preview`,
      [courseIds],
    );
    const avg = await one(
      `SELECT avg(100.0 * sb.final_total / NULLIF(m.mx,0))::float AS a FROM submissions sb JOIN exam_sessions s ON s.id = sb.session_id JOIN exams e ON e.id = s.exam_id
       JOIN LATERAL (SELECT sum(max_score) AS mx FROM submission_answers WHERE submission_id = sb.id) m ON true
       WHERE e.course_id = ANY($1::uuid[]) AND e.status IN ('grading','completed') AND NOT s.is_preview`,
      [courseIds],
    );
    const activeExams = exams.filter((e) => ['scheduled', 'live'].includes(e.status)).length;
    const newThisWeek = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM exams WHERE course_id = ANY($1::uuid[]) AND status IN ('scheduled','live') AND published_at > now() - interval '7 days' AND NOT is_practice AND preview_question_id IS NULL`,
      [courseIds],
    );
    const live = await one(`SELECT * FROM exams WHERE course_id = ANY($1::uuid[]) AND status = 'live' AND NOT is_practice ORDER BY starts_at LIMIT 1`, [courseIds]);
    let liveExam = null;
    if (live) {
      const row = exams.find((e) => e.examId === live.id)!;
      const flags = await one<{ n: number }>(`SELECT count(*)::int AS n FROM exam_sessions WHERE exam_id = $1 AND is_flagged AND NOT is_preview`, [live.id]);
      const ext = await one<{ m: number }>(`SELECT COALESCE(max(extra_minutes),0)::int AS m FROM exam_accommodations WHERE exam_id = $1`, [live.id]);
      liveExam = {
        examId: live.id,
        shortTitle: live.short_title ?? live.title,
        languages: row.languages,
        endsAt: new Date(windowClosesAt(live)!.getTime() + live.global_extension_minutes * 60_000).toISOString(),
        latestEndsAt: new Date(windowClosesAt(live)!.getTime() + (live.global_extension_minutes + ext!.m) * 60_000).toISOString(),
        inProgress: row.submissions?.inProgress ?? 0,
        submitted: row.submissions?.submitted ?? 0,
        flags: flags!.n,
      };
    }
    const activity = await q(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 6`,
      [u.id],
    );
    const bank = await q(
      `SELECT ql.language, count(DISTINCT qs.id)::int AS n FROM questions qs JOIN question_languages ql ON ql.question_id = qs.id
       WHERE qs.course_id = ANY($1::uuid[]) AND qs.archived_at IS NULL GROUP BY ql.language`,
      [courseIds],
    );
    const bankTotal = await one<{ n: number }>(`SELECT count(*)::int AS n FROM questions WHERE course_id = ANY($1::uuid[]) AND archived_at IS NULL`, [courseIds]);
    res.json({
      greetingName: u.displayName ?? u.fullName,
      termName: term?.name ?? '',
      summary: { liveExams: exams.filter((e) => e.status === 'live').length, toGrade: toGrade!.n },
      stats: {
        activeExams,
        activeExamsDeltaWeek: newThisWeek!.n,
        students: students!.n,
        classes: students!.c,
        toGrade: toGrade!.n,
        avgScorePercent: avg?.a != null ? Math.round(avg.a * 10) / 10 : null,
        avgScoreDeltaPercent: null,
      },
      liveExam,
      exams,
      recentActivity: activity.map((n: any) => ({
        kind: n.type === 'proctor_flag' ? 'flag' : n.type === 'submission' ? 'submission' : n.type === 'student_question' ? 'question' : 'bank',
        actorName: n.actor_name ?? '',
        text: n.actor_name && n.title.startsWith(n.actor_name) ? n.title.slice(n.actor_name.length).trim() : n.title,
        at: iso(n.created_at),
        link: n.link,
      })),
      questionBank: { total: bankTotal!.n, byLanguage: bank.map((b: any) => ({ language: b.language, count: b.n })) },
      serverNow: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------- courses
teacherRouter.get(
  '/teacher/courses',
  h(async (req, res) => {
    const rows = await q(
      `SELECT c.*, t.name AS term_name FROM courses c JOIN course_teachers ct ON ct.course_id = c.id JOIN terms t ON t.id = c.term_id
       WHERE ct.teacher_id = $1 ORDER BY c.code, t.name, c.title`,
      [me(req).id],
    );
    const items = [];
    for (const c of rows) {
      const classes = await q(
        `SELECT cl.id, cl.code, count(en.student_id)::int AS n FROM classes cl LEFT JOIN enrollments en ON en.class_id = cl.id WHERE cl.course_id = $1 GROUP BY cl.id ORDER BY cl.code`,
        [c.id],
      );
      items.push({ id: c.id, code: c.code, title: c.title, termName: c.term_name, classes: classes.map((x: any) => ({ id: x.id, code: x.code, studentCount: x.n })) });
    }
    res.json({ items });
  }),
);

teacherRouter.get(
  '/teacher/courses/:courseId/students',
  h(async (req, res) => {
    await assertTeachesCourse(me(req).id, String(req.params.courseId));
    const qq = String(req.query.q ?? '');
    const rows = await q(
      `SELECT DISTINCT ON (u.id) u.id, u.student_id, u.full_name, cl.code AS class_code FROM users u
       JOIN enrollments en ON en.student_id = u.id JOIN classes cl ON cl.id = en.class_id
       WHERE cl.course_id = $1 AND ($2 = '' OR u.full_name ILIKE '%' || $2 || '%' OR u.student_id ILIKE '%' || $2 || '%')
       ORDER BY u.id LIMIT 50`,
      [req.params.courseId, qq],
    );
    res.json({ items: rows.map((r: any) => ({ id: r.id, studentId: r.student_id, fullName: r.full_name, initials: initials(r.full_name), classCode: r.class_code })).sort((a: any, b: any) => a.fullName.localeCompare(b.fullName)) });
  }),
);

// ---------------------------------------------------------------- exams CRUD + wizard
teacherRouter.get(
  '/teacher/exams',
  h(async (req, res) => {
    const courseIds = await teacherCourseIds(me(req).id);
    const status = req.query.status ? String(req.query.status).split(',') : undefined;
    const items = await examRows(courseIds, { status, courseId: req.query.courseId ? String(req.query.courseId) : undefined, q: String(req.query.q ?? '') });
    res.json({ items, page: 1, pageSize: items.length, total: items.length });
  }),
);

const detailsSchema = z.object({
  courseId: z.string().uuid().optional(),
  title: z.string().trim().min(1, 'Enter an exam title.').max(200),
  shortTitle: z.string().trim().max(60).nullable().optional(),
  examType: z.enum(['quiz', 'midterm', 'final', 'lab', 'practice']),
  classIds: z.array(z.string().uuid()),
  instructionsMd: z.string().max(20_000),
  startsAt: z.string().datetime({ offset: true }).nullable(),
  durationMinutes: z.number().int().min(5, 'At least 5 minutes.').max(600, 'At most 10 hours.').nullable(),
  lateJoinMinutes: z.number().int().min(0).max(120),
});

async function assertClassesInCourse(courseId: string, classIds: string[]) {
  if (!classIds.length) return;
  const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM classes WHERE course_id = $1 AND id = ANY($2::uuid[])`, [courseId, classIds]);
  if (n!.n !== new Set(classIds).size) throw invalid('Choose classes from this course.', { classIds: 'Choose classes from this course.' });
}

teacherRouter.post(
  '/teacher/exams',
  h(async (req, res) => {
    const b = detailsSchema.partial().extend({ courseId: z.string().uuid(), title: z.string().trim().min(1, 'Enter an exam title.').max(200) }).parse(req.body);
    await assertTeachesCourse(me(req).id, b.courseId);
    await assertClassesInCourse(b.courseId, b.classIds ?? []);
    const id = await tx(async (c) => {
      const e = await one(
        `INSERT INTO exams(course_id, created_by, title, short_title, exam_type, instructions_md, starts_at, duration_minutes, late_join_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [b.courseId, me(req).id, b.title, b.shortTitle ?? null, b.examType ?? 'midterm', b.instructionsMd ?? '', b.startsAt ?? null, b.durationMinutes ?? 90, b.lateJoinMinutes ?? 15],
        c,
      );
      for (const cl of new Set(b.classIds ?? [])) await q(`INSERT INTO exam_classes(exam_id, class_id) VALUES ($1,$2)`, [e.id, cl], c);
      for (const l of ENABLED_LANGS) await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,$2)`, [e.id, l], c);
      await audit({ actor: me(req), category: 'settings', action: 'exam.created', examId: e.id, courseId: b.courseId, target: b.title, details: 'Created draft' }, c);
      return e.id;
    });
    res.status(201).json(await examDto(id));
  }),
);

teacherRouter.get(
  '/teacher/exams/:id',
  h(async (req, res) => {
    await ownExam(req, String(req.params.id));
    res.json(await examDto(String(req.params.id)));
  }),
);

function assertEditable(e: any) {
  if (!['draft', 'scheduled'].includes(e.status)) throw conflict('EXAM_NOT_EDITABLE', 'This exam has started, so its details can no longer change.');
}

teacherRouter.patch(
  '/teacher/exams/:id/details',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    assertEditable(e);
    const b = detailsSchema.partial().parse(req.body);
    if (b.courseId && b.courseId !== e.course_id) {
      if (e.status !== 'draft') throw invalid('Only draft exams can change course.', { courseId: 'Only draft exams can change course.' });
      const questions = await one<{ n: number }>(`SELECT count(*)::int AS n FROM exam_questions WHERE exam_id = $1`, [e.id]);
      if (questions!.n) throw invalid('Remove exam questions before changing course.', { courseId: 'Remove exam questions before changing course.' });
      await assertTeachesCourse(me(req).id, b.courseId);
      if (b.classIds?.length) await assertClassesInCourse(b.courseId, b.classIds);
    } else if (b.classIds) {
      await assertClassesInCourse(e.course_id, b.classIds);
    }
    if (b.startsAt && e.status === 'scheduled' && new Date(b.startsAt).getTime() < Date.now()) throw invalid('Pick a start time in the future.', { startsAt: 'Pick a start time in the future.' });
    await tx(async (c) => {
      const map: Record<string, string> = { courseId: 'course_id', title: 'title', shortTitle: 'short_title', examType: 'exam_type', instructionsMd: 'instructions_md', startsAt: 'starts_at', durationMinutes: 'duration_minutes', lateJoinMinutes: 'late_join_minutes' };
      const sets: string[] = [];
      const vals: unknown[] = [e.id];
      for (const [k, col] of Object.entries(map)) {
        if ((b as any)[k] !== undefined) {
          vals.push((b as any)[k]);
          sets.push(`${col} = $${vals.length}`);
        }
      }
      if (sets.length) await q(`UPDATE exams SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals, c);
      if (b.classIds) {
        await q(`DELETE FROM exam_classes WHERE exam_id = $1`, [e.id], c);
        for (const cl of new Set(b.classIds)) await q(`INSERT INTO exam_classes(exam_id, class_id) VALUES ($1,$2)`, [e.id, cl], c);
      }
      if (b.startsAt !== undefined) await q(`UPDATE exams SET reminder_sent_at = NULL WHERE id = $1`, [e.id], c);
      await audit({ actor: me(req), category: 'settings', action: 'settings.changed', examId: e.id, courseId: e.course_id, target: b.title ?? e.short_title ?? e.title, details: `Updated ${Object.keys(b).join(', ')}` }, c);
    });
    res.json(await examDto(e.id));
  }),
);

teacherRouter.get(
  '/teacher/exams/:id/schedule-conflicts',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const startsAt = req.query.startsAt ? new Date(String(req.query.startsAt)) : e.starts_at;
    const dur = Number(req.query.durationMinutes ?? e.duration_minutes ?? 90);
    const late = Number(req.query.lateJoinMinutes ?? e.late_join_minutes ?? 15);
    const classIds = req.query.classIds ? String(req.query.classIds).split(',').filter(Boolean) : (await q(`SELECT class_id FROM exam_classes WHERE exam_id = $1`, [e.id])).map((r: any) => r.class_id);
    if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) return res.json({ items: [] });
    const end = new Date(new Date(startsAt).getTime() + (dur + late) * 60_000);
    const rows = await q(
      `SELECT cs.*, cl.code FROM class_sessions cs JOIN classes cl ON cl.id = cs.class_id
       WHERE cs.class_id = ANY($1::uuid[]) AND cs.starts_at < $3 AND cs.ends_at > $2 ORDER BY cs.starts_at`,
      [classIds, startsAt, end],
    );
    res.json({ items: rows.map((r: any) => ({ classCode: r.code, label: r.label, startsAt: iso(r.starts_at), endsAt: iso(r.ends_at) })) });
  }),
);

teacherRouter.put(
  '/teacher/exams/:id/questions',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    assertEditable(e);
    const b = z
      .object({
        items: z.array(z.object({ questionId: z.string().uuid(), points: z.number().int().min(0).max(1000) })).max(200),
        questionOrder: z.enum(['fixed', 'shuffle', 'pool']),
        poolSize: z.number().int().min(1).nullable().optional(),
      })
      .parse(req.body);
    if (new Set(b.items.map((i) => i.questionId)).size !== b.items.length) throw invalid('A question is listed twice.', { items: 'A question is listed twice.' });
    if (b.questionOrder === 'pool' && (!b.poolSize || b.poolSize >= b.items.length)) throw invalid('Pool size must be smaller than the number of questions.', { poolSize: 'Pool size must be smaller than the number of questions.' });
    const courseIds = await teacherCourseIds(me(req).id);
    await tx(async (c) => {
      const existing = await q(`SELECT * FROM exam_questions WHERE exam_id = $1`, [e.id], c);
      const bySource = new Map(existing.map((x: any) => [x.source_question_id, x]));
      await q(`DELETE FROM exam_questions WHERE exam_id = $1 AND NOT (source_question_id = ANY($2::uuid[]))`, [e.id, b.items.map((i) => i.questionId)], c);
      for (const [i, it] of b.items.entries()) {
        const qrow = await one(`SELECT id, course_id, archived_at FROM questions WHERE id = $1`, [it.questionId], c);
        if (!qrow || !courseIds.includes(qrow.course_id)) throw invalid('One of the questions is not in your question bank.', { [`items[${i}].questionId`]: 'Not found' });
        if (qrow.archived_at && !bySource.has(it.questionId)) throw invalid('Archived questions cannot be added.', { [`items[${i}].questionId`]: 'Archived' });
        if (bySource.has(it.questionId)) {
          await q(`UPDATE exam_questions SET position = $2, points = $3 WHERE id = $1`, [bySource.get(it.questionId).id, i + 1, it.points], c);
        } else {
          await q(`INSERT INTO exam_questions(exam_id, source_question_id, position, points, snapshot) VALUES ($1,$2,$3,$4,'{}')`, [e.id, it.questionId, i + 1, it.points], c);
        }
      }
      await q(`UPDATE exams SET question_order = $2, pool_size = $3, updated_at = now() WHERE id = $1`, [e.id, b.questionOrder, b.questionOrder === 'pool' ? b.poolSize : null], c);
      await refreshSnapshots(e.id, c);
    });
    res.json((await examDto(e.id))!.questions);
  }),
);

teacherRouter.patch(
  '/teacher/exams/:id/settings',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    assertEditable(e);
    const b = z
      .object({
        allowedLanguages: z.array(langSchema),
        allowRun: z.boolean(),
        showSampleTests: z.boolean(),
        runHiddenOnSubmit: z.boolean(),
        runsPerQuestion: z.number().int().min(1).max(1000).nullable(),
        timeLimitMs: z.number().int().min(500).max(10_000),
        memoryLimitMb: z.number().int().min(64).max(1024),
        autoSubmitOnTimeout: z.boolean(),
        autoGradeWithTests: z.boolean(),
        releaseAfterReview: z.boolean(),
      })
      .partial()
      .parse(req.body);
    const cols: Record<string, string> = {
      allowRun: 'allow_run',
      showSampleTests: 'show_sample_tests',
      runHiddenOnSubmit: 'run_hidden_on_submit',
      runsPerQuestion: 'runs_per_question',
      timeLimitMs: 'time_limit_ms',
      memoryLimitMb: 'memory_limit_mb',
      autoSubmitOnTimeout: 'auto_submit_on_timeout',
      autoGradeWithTests: 'auto_grade_with_tests',
      releaseAfterReview: 'release_after_review',
    };
    await tx(async (c) => {
      const sets: string[] = [];
      const vals: unknown[] = [e.id];
      for (const [k, col] of Object.entries(cols)) {
        if ((b as any)[k] !== undefined) {
          vals.push((b as any)[k]);
          sets.push(`${col} = $${vals.length}`);
        }
      }
      if (sets.length) await q(`UPDATE exams SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals, c);
      if (b.allowedLanguages) {
        await q(`DELETE FROM exam_languages WHERE exam_id = $1`, [e.id], c);
        for (const l of new Set(b.allowedLanguages)) await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,$2)`, [e.id, l], c);
      }
      if (Object.keys(b).length) await audit({ actor: me(req), category: 'settings', action: 'settings.changed', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: `Changed ${Object.keys(b).join(', ')}` }, c);
    });
    res.json(await examDto(e.id));
  }),
);

teacherRouter.put(
  '/teacher/exams/:id/accommodations',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (e.status === 'completed' || e.status === 'archived') throw conflict('EXAM_NOT_EDITABLE', 'This exam is finished.');
    const b = z.object({ items: z.array(z.object({ studentId: z.string().uuid(), extraMinutes: z.number().int().min(5, 'At least 5 minutes.').max(240, 'At most 240 minutes.') })).max(500) }).parse(req.body);
    await tx(async (c) => {
      const before = new Map((await q(`SELECT student_id, extra_minutes FROM exam_accommodations WHERE exam_id = $1`, [e.id], c)).map((r: any) => [r.student_id, r.extra_minutes]));
      await q(`DELETE FROM exam_accommodations WHERE exam_id = $1`, [e.id], c);
      for (const it of b.items) {
        const enrolled = await one(`SELECT u.full_name FROM users u JOIN enrollments en ON en.student_id = u.id JOIN classes cl ON cl.id = en.class_id WHERE u.id = $1 AND cl.course_id = $2 LIMIT 1`, [it.studentId, e.course_id], c);
        if (!enrolled) throw invalid('That student is not enrolled in this course.', { studentId: 'Not enrolled' });
        await q(`INSERT INTO exam_accommodations(exam_id, student_id, extra_minutes) VALUES ($1,$2,$3) ON CONFLICT (exam_id, student_id) DO UPDATE SET extra_minutes = EXCLUDED.extra_minutes`, [e.id, it.studentId, it.extraMinutes], c);
        if (before.get(it.studentId) !== it.extraMinutes) {
          await audit({ actor: me(req), category: 'settings', action: 'accommodation.added', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: `Gave ${enrolled.full_name} +${it.extraMinutes} min` }, c);
        }
      }
      if (e.status === 'live') await recomputeDeadlines(e.id, null, c);
    });
    res.json({ items: (await examDto(e.id))!.settings.accommodations });
  }),
);

teacherRouter.get(
  '/teacher/exams/:id/publish-checks',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (e.status === 'draft') await tx((c) => refreshSnapshots(e.id, c));
    res.json(await publishChecks(e.id));
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/publish',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (e.status !== 'draft') throw conflict('EXAM_NOT_DRAFT', 'This exam is already published.');
    const b = z.object({ notifyNow: z.boolean().default(true), reminder1h: z.boolean().default(true) }).parse(req.body ?? {});
    let mails: any[] = [];
    const out = await tx(async (c) => {
      await refreshSnapshots(e.id, c);
      const checks = await publishChecks(e.id, c);
      if (!checks.canPublish) throw invalid('Fix the publish checks first.', {}, 'PUBLISH_CHECKS_FAILED', { checks: checks.checks });
      await q(`UPDATE exam_questions SET snapshotted_at = now() WHERE exam_id = $1`, [e.id], c);
      await q(`UPDATE exams SET status = 'scheduled', published_at = now(), notify_now = $2, notify_reminder_1h = $3, updated_at = now() WHERE id = $1`, [e.id, b.notifyNow, b.reminder1h], c);
      const people = await q(
        `SELECT DISTINCT u.id, u.email, u.full_name, u.student_id FROM exam_classes ec JOIN enrollments en ON en.class_id = ec.class_id JOIN users u ON u.id = en.student_id WHERE ec.exam_id = $1 AND u.is_active`,
        [e.id],
        c,
      );
      const students = people.map((r: any) => r.id);
      if (b.notifyNow) {
        await notify(students, { type: 'exam_published', title: `${e.title} is scheduled`, link: `/student` }, c);
        mails = people
          .filter((p: any) => p.email)
          .map((p: any) => ({
            to: p.email,
            subject: `New exam: ${e.title}`,
            title: e.title,
            paragraphs: [
              `Hello ${p.full_name},`,
              `Your teacher scheduled ${e.title}. Check your dashboard for its start time in your local timezone. It lasts ${e.duration_minutes} minutes.`,
              `Sign in with your student ID (${p.student_id}) and open the exam from your dashboard. The lobby opens 15 minutes before the start.`,
            ],
            button: { label: 'Open my exams', url: `${config.appPublicUrl}/login` },
          }));
      }
      const classes = (await q(`SELECT cl.code FROM exam_classes ec JOIN classes cl ON cl.id = ec.class_id WHERE ec.exam_id = $1 ORDER BY cl.code`, [e.id], c)).map((r: any) => r.code);
      await audit({ actor: me(req), category: 'publish', action: 'exam.published', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: `Published to ${classes.join(', ')} · ${students.length} students${b.notifyNow ? ' notified' : ''}` }, c);
      return { notifiedCount: b.notifyNow ? students.length : 0 };
    });
    sendMailLater(mails);
    const fresh = await one(`SELECT status, published_at FROM exams WHERE id = $1`, [e.id]);
    res.json({ status: fresh.status, publishedAt: iso(fresh.published_at), notifiedCount: out.notifiedCount, emailsQueued: mails.length });
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/reopen',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (e.status !== 'grading') throw conflict('EXAM_NOT_EDITABLE', 'Only exams in grading can be reopened.');
    await tx(async (c) => {
      const current = await one<{ status: string }>(`SELECT status FROM exams WHERE id = $1 FOR UPDATE`, [e.id], c);
      if (current?.status !== 'grading') throw conflict('EXAM_NOT_EDITABLE', 'This exam is no longer in grading.');
      const activity = await one<{ has_sessions: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM exam_sessions WHERE exam_id = $1 AND NOT is_preview) AS has_sessions`,
        [e.id],
        c,
      );
      if (activity!.has_sessions) throw conflict('EXAM_HAS_STUDENT_ACTIVITY', 'This exam cannot be edited because students have started it.');
      await q(`UPDATE exams SET status = 'draft', published_at = NULL, ended_at = NULL, reminder_sent_at = NULL, updated_at = now() WHERE id = $1`, [e.id], c);
      await q(`UPDATE exam_questions SET snapshotted_at = NULL WHERE exam_id = $1`, [e.id], c);
      await audit({ actor: me(req), category: 'publish', action: 'exam.reopened', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: 'Reopened as a draft; no student sessions existed' }, c);
    });
    res.json(await examDto(e.id));
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/unpublish',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (e.status !== 'scheduled' || new Date(e.starts_at).getTime() <= Date.now()) throw conflict('EXAM_NOT_EDITABLE', 'Only scheduled exams that have not started can be unpublished.');
    await tx(async (c) => {
      await q(`UPDATE exams SET status = 'draft', published_at = NULL WHERE id = $1`, [e.id], c);
      await q(`UPDATE exam_questions SET snapshotted_at = NULL WHERE exam_id = $1`, [e.id], c);
      await audit({ actor: me(req), category: 'publish', action: 'exam.unpublished', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: 'Moved back to draft' }, c);
    });
    res.json(await examDto(e.id));
  }),
);

teacherRouter.delete(
  '/teacher/exams/:id',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (e.status === 'live') throw conflict('EXAM_IN_PROGRESS', 'End the live exam before deleting it.');
    const activeRun = await one(
      `SELECT 1 FROM code_runs cr JOIN exam_questions eq ON eq.id = cr.exam_question_id
       WHERE eq.exam_id = $1 AND cr.status IN ('queued', 'running') LIMIT 1`,
      [e.id],
    );
    if (activeRun) throw conflict('EXAM_RUNS_ACTIVE', 'Wait for the exam code runs to finish before deleting it.');
    await tx(async (c) => {
      await audit(
        {
          actor: me(req),
          category: 'settings',
          action: 'exam.deleted',
          examId: e.id,
          courseId: e.course_id,
          target: e.short_title ?? e.title,
          details: `Deleted ${e.status} exam and its sessions, answers, submissions, and grading history.`,
        },
        c,
      );
      await q(`DELETE FROM exams WHERE id = $1`, [e.id], c);
    });
    res.status(204).end();
  }),
);

teacherRouter.get(
  '/teacher/exams/:id/seb-link',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const host = config.appPublicUrl.replace(/^https?:\/\//, '');
    res.json({ sebUrl: `${config.appPublicUrl.startsWith('https') ? 'sebs' : 'seb'}://${host}/seb/aegis-exam.seb`, startUrl: `${config.appPublicUrl}/student/exams/${e.id}/lobby` });
  }),
);

// ---------------------------------------------------------------- live monitor
teacherRouter.get(
  '/teacher/exams/:id/monitor',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const eqs = await q(`SELECT id, position FROM exam_questions WHERE exam_id = $1 ORDER BY position`, [e.id]);
    const students = await q(
      `SELECT DISTINCT u.id, u.student_id, u.full_name FROM exam_classes ec JOIN enrollments en ON en.class_id = ec.class_id JOIN users u ON u.id = en.student_id WHERE ec.exam_id = $1`,
      [e.id],
    );
    const sessions = new Map((await q(`SELECT * FROM exam_sessions WHERE exam_id = $1 AND NOT is_preview`, [e.id])).map((s: any) => [s.student_id, s]));
    const answers = await q(
      `SELECT a.session_id, a.exam_question_id, a.language, a.started, a.last_sample_passed, a.last_sample_total, a.response, eq.snapshot
       FROM session_answers a JOIN exam_sessions s ON s.id = a.session_id JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE s.exam_id = $1 AND NOT s.is_preview`,
      [e.id],
    );
    const bySession = new Map<string, any[]>();
    for (const a of answers) {
      if (!bySession.has(a.session_id)) bySession.set(a.session_id, []);
      bySession.get(a.session_id)!.push(a);
    }
    const acc = new Map((await q(`SELECT student_id, extra_minutes FROM exam_accommodations WHERE exam_id = $1`, [e.id])).map((r: any) => [r.student_id, r.extra_minutes]));
    const now = Date.now();
    const lateOpen = !!e.starts_at && now <= new Date(e.starts_at).getTime() + e.late_join_minutes * 60_000;
    const allRows = students.map((u: any) => {
      const s: any = sessions.get(u.id);
      const ans = s ? bySession.get(s.id) ?? [] : [];
      const ansBy = new Map(ans.map((a: any) => [a.exam_question_id, a]));
      let status: string = 'not_started';
      if (s && ['submitted', 'auto_submitted', 'force_submitted'].includes(s.status)) status = 'submitted';
      else if (s && s.status === 'in_progress') status = s.is_flagged ? 'flagged' : 'coding';
      const notes: string[] = [];
      if (s?.tab_switch_count) notes.push(`${s.tab_switch_count} tab switch${s.tab_switch_count === 1 ? '' : 'es'}`);
      if (acc.get(u.id)) notes.push(`Extra time +${acc.get(u.id)} min`);
      if (s?.live_extension_minutes) notes.push(`+${s.live_extension_minutes} min given`);
      if (status === 'not_started' && lateOpen) notes.push('Late window open');
      if (s?.status === 'auto_submitted') notes.push('Auto-submitted at time end');
      if (s?.status === 'force_submitted') notes.push(s.submit_reason === 'tab_switch_limit' ? 'Auto-submitted (tab switches)' : 'Submitted when exam ended');
      const current = ans.find((a: any) => s && eqs.find((x: any) => x.id === a.exam_question_id)?.position === s.current_question_position) ?? ans[0];
      return {
        sessionId: s?.id ?? null,
        studentId: u.id,
        studentNumber: u.student_id,
        fullName: u.full_name,
        initials: initials(u.full_name),
        language: current?.language ?? null,
        progress: eqs.map((eq: any) => {
          const a: any = ansBy.get(eq.id);
          if (!a) return 'not_started';
          if (!isCode(a.snapshot)) return isAnswered(a.snapshot, a.response) ? 'done' : 'not_started';
          if (a.last_sample_total > 0 && a.last_sample_passed === a.last_sample_total) return 'done';
          return a.started ? 'in_progress' : 'not_started';
        }),
        testsPassed: ans.reduce((x: number, a: any) => x + a.last_sample_passed, 0),
        testsTotal: ans.reduce((x: number, a: any) => x + a.last_sample_total, 0),
        status,
        notes,
        extraMinutes: s?.live_extension_minutes ?? 0,
        lastSeenAt: iso(s?.last_seen_at),
        online: !!s?.last_seen_at && status !== 'submitted' && now - new Date(s.last_seen_at).getTime() < 30_000,
      };
    });
    const seg = String(req.query.segment ?? 'all');
    const qq = String(req.query.q ?? '').toLowerCase();
    const rows = allRows
      .filter((r) => (seg === 'all' || r.status === seg) && (!qq || `${r.fullName} ${r.studentNumber}`.toLowerCase().includes(qq)))
      .sort((a, b) => (a.status === 'flagged' ? -1 : 0) - (b.status === 'flagged' ? -1 : 0) || a.fullName.localeCompare(b.fullName));
    const count = (s: string) => allRows.filter((r) => r.status === s).length;
    const flagLog = await q(
      `SELECT pe.*, u.full_name FROM proctor_events pe JOIN exam_sessions s ON s.id = pe.session_id JOIN users u ON u.id = s.student_id
       WHERE s.exam_id = $1 AND NOT s.is_preview AND pe.type IN ('tab_switch','fullscreen_exit','paste_blocked','session_takeover') ORDER BY pe.occurred_at DESC LIMIT 30`,
      [e.id],
    );
    const TEXT: Record<string, string> = { tab_switch: 'switched tabs', fullscreen_exit: 'left full screen', paste_blocked: 'paste blocked from outside', session_takeover: 'opened the exam on another device' };
    const close = windowClosesAt(e);
    res.json({
      exam: {
        id: e.id,
        shortTitle: e.short_title ?? e.title,
        status: e.status,
        startsAt: iso(e.starts_at),
        windowClosesAt: iso(close),
        endsAt: close ? new Date(close.getTime() + e.global_extension_minutes * 60_000).toISOString() : null,
        globalExtensionMinutes: e.global_extension_minutes,
      },
      stats: { assigned: allRows.length, inProgress: count('coding') + count('flagged'), submitted: count('submitted'), notStarted: count('not_started'), flags: count('flagged'), lateWindowOpen: lateOpen },
      segments: { all: allRows.length, coding: count('coding'), submitted: count('submitted'), flagged: count('flagged'), notStarted: count('not_started') },
      rows,
      flagLog: flagLog.map((f: any) => ({ at: iso(f.occurred_at), studentName: f.full_name, type: f.type, text: TEXT[f.type] ?? f.type })),
      page: 1,
      pageSize: rows.length,
      total: allRows.length,
      serverNow: new Date().toISOString(),
    });
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/extend',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (!['live', 'scheduled'].includes(e.status)) throw conflict('EXAM_NOT_EDITABLE', 'Only a scheduled or live exam can be extended.');
    const b = z.object({ minutes: z.number().int().min(1).max(60), studentId: z.string().uuid().optional() }).parse(req.body);
    const out = await tx(async (c) => {
      if (b.studentId) {
        const s = await one(`SELECT s.*, u.full_name FROM exam_sessions s JOIN users u ON u.id = s.student_id WHERE s.exam_id = $1 AND s.student_id = $2`, [e.id, b.studentId], c);
        if (!s || s.status !== 'in_progress') throw conflict('SESSION_INVALID', 'This student is not coding right now.');
        await q(`UPDATE exam_sessions SET live_extension_minutes = live_extension_minutes + $2 WHERE id = $1`, [s.id, b.minutes], c);
        await recomputeDeadlines(e.id, b.studentId, c);
        await audit({ actor: me(req), category: 'settings', action: 'exam.extended', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: `Gave ${s.full_name} +${b.minutes} min` }, c);
        const d = await one(`SELECT deadline_at, live_extension_minutes FROM exam_sessions WHERE id = $1`, [s.id], c);
        return { studentId: b.studentId, extraMinutes: d.live_extension_minutes, deadlineAt: iso(d.deadline_at), name: s.full_name };
      }
      await q(`UPDATE exams SET global_extension_minutes = global_extension_minutes + $2 WHERE id = $1`, [e.id, b.minutes], c);
      await recomputeDeadlines(e.id, null, c);
      const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM exam_sessions WHERE exam_id = $1 AND status = 'in_progress' AND NOT is_preview`, [e.id], c);
      await audit({ actor: me(req), category: 'settings', action: 'exam.extended', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: `Gave everyone +${b.minutes} min` }, c);
      return { globalExtensionMinutes: e.global_extension_minutes + b.minutes, affectedSessions: n!.n };
    });
    res.json(out);
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/end',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (!['live', 'scheduled'].includes(e.status)) throw conflict('EXAM_NOT_EDITABLE', 'This exam is not running.');
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const n = await tx(async (c) => {
      const sessions = await q(`SELECT id FROM exam_sessions WHERE exam_id = $1 AND status = 'in_progress' AND NOT is_preview`, [e.id], c);
      for (const s of sessions) await submitSession(s.id, 'teacher_ended', me(req).id, c);
      await q(`UPDATE exams SET status = 'grading', ended_at = now() WHERE id = $1`, [e.id], c);
      await audit({ actor: me(req), category: 'publish', action: 'exam.ended', examId: e.id, courseId: e.course_id, target: e.short_title ?? e.title, details: `Ended exam early · ${sessions.length} students submitted automatically` }, c);
      return sessions.length;
    });
    kick();
    res.json({ status: 'grading', forceSubmitted: n });
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/messages',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const b = z
      .object({
        scope: z.enum(['all', 'direct']),
        recipientStudentId: z.string().uuid().nullable().optional(),
        examQuestionId: z.string().uuid().nullable().optional(),
        body: z.string().trim().min(1, 'Write a message.').max(2000),
      })
      .parse(req.body);
    if (b.scope === 'direct' && !b.recipientStudentId) throw invalid('Choose a student.', { recipientStudentId: 'Choose a student.' });
    if (b.examQuestionId) {
      const ok = await one(`SELECT 1 FROM exam_questions WHERE id = $1 AND exam_id = $2`, [b.examQuestionId, e.id]);
      if (!ok) throw invalid('Unknown question.', { examQuestionId: 'Unknown question' });
    }
    const m = await one(
      `INSERT INTO exam_messages(exam_id, sender_id, scope, recipient_id, exam_question_id, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [e.id, me(req).id, b.scope, b.scope === 'direct' ? b.recipientStudentId : null, b.examQuestionId ?? null, b.body],
    );
    const recipients = b.scope === 'direct' ? 1 : (await one<{ n: number }>(`SELECT count(*)::int AS n FROM exam_sessions WHERE exam_id = $1 AND status = 'in_progress' AND NOT is_preview`, [e.id]))!.n;
    res.status(201).json({ id: m.id, recipients });
  }),
);

teacherRouter.get(
  '/teacher/exams/:id/sessions/:sessionId/live',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const s = await one(`SELECT s.*, u.full_name, u.student_id AS student_number FROM exam_sessions s JOIN users u ON u.id = s.student_id WHERE s.id = $1 AND s.exam_id = $2`, [req.params.sessionId, e.id]);
    if (!s) throw notFound('NOT_FOUND', 'Session not found.');
    const rows = await q(`SELECT a.*, eq.position, eq.snapshot FROM session_answers a JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE a.session_id = $1 ORDER BY eq.position`, [s.id]);
    const { fullFiles } = await import('../services/grading');
    res.json({
      student: { id: s.student_id, studentNumber: s.student_number, fullName: s.full_name },
      currentQuestionPosition: s.current_question_position,
      status: s.status,
      answers: rows.map((a: any) =>
        isCode(a.snapshot)
          ? { position: a.position, title: a.snapshot.title, type: 'code', language: a.language, files: fullFiles(a.snapshot, a.language, (a.files ?? {})[a.language]), serverSavedAt: iso(a.server_saved_at) }
          : { position: a.position, title: a.snapshot.title, type: a.snapshot.type, language: null, files: {}, answerText: describeResponse(a.snapshot, a.response) || '(no answer yet)', serverSavedAt: iso(a.server_saved_at) },
      ),
    });
  }),
);

teacherRouter.post(
  '/teacher/exams/:id/preview-session',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM exam_questions WHERE exam_id = $1`, [e.id]);
    if (!n!.n) throw forbidden('EXAM_NOT_OPEN', 'Add questions before previewing.');
    res.json({ previewUrl: `/student/exams/${e.id}/lobby?preview=1` });
  }),
);
