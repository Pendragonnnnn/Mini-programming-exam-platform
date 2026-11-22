import { Router, type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { authenticate, randomToken, requireRole, sha256 } from '../auth';
import { config } from '../config';
import { one, q, tx, type Db } from '../db';
import { conflict, forbidden, h, HttpError, invalid, notFound } from '../errors';
import { verifySeb } from '../seb';
import { audit, courseTeacherIds, notify } from '../services/audit';
import { computeDeadline, effectiveLangs, examLangs, LOBBY_OPENS_BEFORE_MIN, refreshSnapshots, windowClosesAt } from '../services/exams';
import { fullFiles, submitSession } from '../services/grading';
import { isCode, langSchema, LANG_LABEL, normChoice } from '../services/questions';
import { describeResponse, isAnswered, scoreChoice, studentOptions } from '../services/choice';
import { runnerHealth, type FileMap, type Lang, type QuestionSpec } from '../services/runner';
import { createRun, kick } from '../services/runs';

export const studentRouter = Router();
studentRouter.use(authenticate);

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------- dashboard + results
studentRouter.get(
  '/student/dashboard',
  requireRole('student'),
  h(async (req, res) => {
    const me = req.user!.id;
    const rows = await q(
      `SELECT DISTINCT e.*, c.code AS course_code, c.title AS course_title, c.department,
              (SELECT count(*)::int FROM exam_questions WHERE exam_id = e.id) AS qcount,
              s.status AS session_status, s.submitted_at
       FROM exams e
       JOIN courses c ON c.id = e.course_id
       JOIN exam_classes ec ON ec.exam_id = e.id
       JOIN enrollments en ON en.class_id = ec.class_id AND en.student_id = $1
       LEFT JOIN exam_sessions s ON s.exam_id = e.id AND s.student_id = $1
       WHERE NOT e.is_practice AND e.status IN ('scheduled','live','grading','completed')
       ORDER BY e.starts_at`,
      [me],
    );
    const now = Date.now();
    const upcoming: any[] = [];
    const past: any[] = [];
    for (const e of rows) {
      const examL = await examLangs(e.id);
      const snaps = (await q(`SELECT snapshot FROM exam_questions WHERE exam_id = $1`, [e.id])).map((r: any) => r.snapshot);
      const langs = examL.filter((l) => snaps.some((sn: any) => isCode(sn) && sn.languages?.includes(l)));
      const startsAt = new Date(e.starts_at).getTime();
      const lateClose = startsAt + e.late_join_minutes * 60_000;
      const ss = e.session_status ?? 'not_started';
      const submitted = ['submitted', 'auto_submitted', 'force_submitted'].includes(ss);
      if (submitted || e.status === 'grading' || e.status === 'completed') {
        if (submitted || ss !== 'not_started') {
          const sub = await one(
            `SELECT sb.final_total, (SELECT COALESCE(SUM(max_score),0) FROM submission_answers WHERE submission_id = sb.id) AS max
             FROM submissions sb JOIN exam_sessions s ON s.id = sb.session_id WHERE s.exam_id = $1 AND s.student_id = $2`,
            [e.id, me],
          );
          const released = !!e.results_released_at;
          past.push({ examId: e.id, title: e.title, submittedAt: iso(e.submitted_at), status: released ? 'graded' : 'pending', score: released ? sub?.final_total ?? 0 : null, maxScore: sub?.max || 100 });
        }
        continue;
      }
      let state: string;
      if (ss === 'in_progress') state = 'in_progress';
      else if (now > lateClose) state = 'missed';
      else if (now >= startsAt - LOBBY_OPENS_BEFORE_MIN * 60_000) state = 'open';
      else state = 'locked';
      if (state === 'missed') continue;
      upcoming.push({
        examId: e.id,
        title: e.title,
        course: e.department ?? e.course_title,
        courseCode: e.course_code,
        questionCount: e.qcount,
        languages: langs,
        startsAt: iso(e.starts_at),
        lobbyOpensAt: new Date(startsAt - LOBBY_OPENS_BEFORE_MIN * 60_000).toISOString(),
        lateJoinClosesAt: new Date(lateClose).toISOString(),
        state,
        sessionStatus: ss,
      });
    }
    const practice = await one(`SELECT id FROM exams WHERE is_practice AND status = 'live' ORDER BY created_at LIMIT 1`);
    const qf = String(req.query.q ?? '').toLowerCase();
    const lf = String(req.query.language ?? '');
    res.json({
      upcoming: upcoming.filter((u) => (!qf || `${u.title} ${u.course}`.toLowerCase().includes(qf)) && (!lf || lf === 'all' || u.languages.includes(lf))),
      pastResults: past.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt))),
      practice: practice ? { examId: practice.id, languages: await examLangs(practice.id) } : null,
      serverNow: new Date().toISOString(),
    });
  }),
);

studentRouter.get(
  '/student/results',
  requireRole('student'),
  h(async (req, res) => {
    const rows = await q(
      `SELECT e.id, e.title, e.results_released_at, sb.submitted_at, sb.final_total,
              (SELECT COALESCE(SUM(max_score),0) FROM submission_answers WHERE submission_id = sb.id) AS max
       FROM submissions sb JOIN exam_sessions s ON s.id = sb.session_id JOIN exams e ON e.id = s.exam_id
       WHERE s.student_id = $1 AND NOT e.is_practice AND NOT s.is_preview ORDER BY sb.submitted_at DESC`,
      [req.user!.id],
    );
    res.json({
      items: rows.map((r: any) => ({
        examId: r.id,
        title: r.title,
        submittedAt: iso(r.submitted_at),
        status: r.results_released_at ? 'graded' : 'pending',
        score: r.results_released_at ? r.final_total : null,
        maxScore: r.max || 100,
      })),
    });
  }),
);

studentRouter.get(
  '/student/results/:examId',
  requireRole('student'),
  h(async (req, res) => {
    const me = req.user!.id;
    const row = await one(
      `SELECT e.*, s.id AS session_id, sb.id AS submission_id, sb.submitted_at, sb.final_total, sb.time_used_seconds,
              u.full_name AS teacher_name, u.display_name AS teacher_display
       FROM exams e
       JOIN exam_sessions s ON s.exam_id = e.id AND s.student_id = $2
       LEFT JOIN submissions sb ON sb.session_id = s.id
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = $1`,
      [req.params.examId, me],
    );
    if (!row || !row.submission_id) throw notFound('EXAM_NOT_FOUND', 'No result for this exam.');
    if (!row.results_released_at) {
      return res.json({
        examId: row.id,
        released: false,
        status: 'pending',
        submittedAt: iso(row.submitted_at),
        justSubmitted: Date.now() - new Date(row.submitted_at).getTime() < 10 * 60_000,
        title: row.title,
      });
    }
    const answers = await q(
      `SELECT sa.*, eq.position, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.submission_id = $1 ORDER BY eq.position`,
      [row.submission_id],
    );
    const stats = await one(
      `SELECT avg(sb.final_total)::float AS avg, count(*)::int AS n,
              count(*) FILTER (WHERE sb.final_total > $2)::int AS better
       FROM submissions sb JOIN exam_sessions s ON s.id = sb.session_id WHERE s.exam_id = $1 AND NOT s.is_preview`,
      [row.id, row.final_total],
    );
    let passed = 0;
    let total = 0;
    const questions = [];
    for (const a of answers) {
      const spec = a.snapshot as QuestionSpec;
      if (!isCode(spec)) {
        const sc = scoreChoice(spec, a.response, a.max_score);
        questions.push({
          position: a.position,
          title: spec.title,
          type: spec.type,
          language: null,
          score: a.final_score,
          maxScore: a.max_score,
          tests: [],
          yourAnswer: describeResponse(spec, a.response) || null,
          correct: sc.correct,
          explanation: normChoice(spec.choice).explanation || null,
          feedback: a.feedback || null,
        });
        continue;
      }
      const tests = await q(`SELECT name, outcome FROM test_results WHERE run_id = $1 ORDER BY sort_order`, [a.grading_run_id]);
      passed += tests.filter((t: any) => t.outcome === 'pass').length;
      total += tests.length;
      questions.push({
        position: a.position,
        title: spec.title,
        type: 'code',
        language: a.language,
        score: a.final_score,
        maxScore: a.max_score,
        tests: tests.map((t: any) => ({ name: t.name, passed: t.outcome === 'pass' })),
        feedback: a.feedback || null,
      });
    }
    const maxScore = answers.reduce((s: number, a: any) => s + a.max_score, 0);
    res.json({
      examId: row.id,
      released: true,
      title: row.title,
      subtitle: `submitted ${new Date(row.submitted_at).toUTCString().slice(5, 22)} UTC`,
      submittedAt: iso(row.submitted_at),
      releasedAt: iso(row.results_released_at),
      status: 'graded',
      score: row.final_total ?? 0,
      maxScore,
      teacherName: row.teacher_display ?? row.teacher_name,
      facts: {
        classAverage: stats?.avg != null ? Math.round(stats.avg * 10) / 10 : null,
        rankTopPercent: stats?.n ? Math.max(1, Math.ceil((100 * (stats.better + 1)) / stats.n)) : null,
        timeUsedMinutes: Math.round((row.time_used_seconds ?? 0) / 60),
        testsPassed: passed,
        testsTotal: total,
      },
      questions,
    });
  }),
);

studentRouter.get(
  '/student/practice',
  requireRole('student'),
  h(async (_req, res) => {
    const p = await one(`SELECT id FROM exams WHERE is_practice AND status = 'live' ORDER BY created_at LIMIT 1`);
    if (!p) throw notFound('EXAM_NOT_FOUND', 'No practice sandbox is available.');
    res.json({ examId: p.id });
  }),
);

// ---------------------------------------------------------------- exam access helpers
interface ExamCtx {
  exam: any;
  isPreview: boolean;
  sebVersion: string | null;
}
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      examCtx?: ExamCtx;
      examSession?: any;
    }
  }
}

/** Assignment + SEB gate for /student/exams/:examId/*. Teachers may enter only as a preview. */
async function examAccess(req: Request, _res: Response, next: NextFunction) {
  try {
    const exam = await one(`SELECT * FROM exams WHERE id = $1`, [req.params.examId]);
    if (!exam) throw notFound('EXAM_NOT_FOUND', 'Exam not found.');
    const u = req.user!;
    let isPreview = false;
    if (u.role === 'teacher') {
      const t = await one(`SELECT 1 FROM course_teachers WHERE course_id = $1 AND teacher_id = $2`, [exam.course_id, u.id]);
      if (!t) throw notFound('EXAM_NOT_FOUND', 'Exam not found.');
      isPreview = true;
    } else if (!exam.is_practice) {
      const a = await one(
        `SELECT 1 FROM exam_classes ec JOIN enrollments en ON en.class_id = ec.class_id WHERE ec.exam_id = $1 AND en.student_id = $2 LIMIT 1`,
        [exam.id, u.id],
      );
      if (!a || exam.status === 'draft' || exam.status === 'archived') throw notFound('EXAM_NOT_FOUND', 'Exam not found.');
    }
    const seb = verifySeb(req, { required: !isPreview && !exam.is_practice && exam.seb_required });
    req.examCtx = { exam, isPreview, sebVersion: seb.version };
    next();
  } catch (e) {
    next(e);
  }
}

/** Single-active-session gate (X-Exam-Session). */
async function sessionGate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.get('x-exam-session');
    const s = await one(`SELECT * FROM exam_sessions WHERE exam_id = $1 AND student_id = $2`, [req.params.examId, req.user!.id]);
    if (!s || s.status === 'not_started') throw new HttpError(401, 'SESSION_INVALID', 'Start the exam from the lobby first.');
    if (!token || !s.active_client_token_hash || sha256(token) !== s.active_client_token_hash) {
      if (s.status !== 'in_progress') throw conflict('ALREADY_SUBMITTED', 'This exam has been submitted.', { sessionStatus: s.status });
      throw conflict('SESSION_TAKEN_OVER', 'This exam was opened on another device.');
    }
    req.examSession = s;
    next();
  } catch (e) {
    next(e);
  }
}

function assertWritable(s: any) {
  if (s.status !== 'in_progress') throw conflict('ALREADY_SUBMITTED', 'This exam has been submitted.', { sessionStatus: s.status });
  if (s.deadline_at && Date.now() > new Date(s.deadline_at).getTime() + config.graceSeconds * 1000) throw conflict('TIME_UP', 'Time is up. Your exam was submitted automatically.');
}

const examRouter = Router({ mergeParams: true });
studentRouter.use('/student/exams/:examId', examAccess, examRouter);

// ---------------------------------------------------------------- lobby
examRouter.get(
  '/lobby',
  h(async (req, res) => {
    const { exam, sebVersion, isPreview } = req.examCtx!;
    const langs = await examLangs(exam.id);
    const teacher = await one(`SELECT full_name, display_name FROM users WHERE id = $1`, [exam.created_by]);
    const qcount = await one<{ n: number; p: number }>(`SELECT count(*)::int AS n, COALESCE(sum(points),0)::int AS p FROM exam_questions WHERE exam_id = $1`, [exam.id]);
    const session = await one(`SELECT status FROM exam_sessions WHERE exam_id = $1 AND student_id = $2`, [exam.id, req.user!.id]);
    const acc = await one(`SELECT extra_minutes FROM exam_accommodations WHERE exam_id = $1 AND student_id = $2`, [exam.id, req.user!.id]);
    const snaps = (await q(`SELECT snapshot FROM exam_questions WHERE exam_id = $1`, [exam.id])).map((r: any) => r.snapshot);
    // Draft previews refresh their snapshots on start, so fall back to the bank question type.
    const hasCode = snaps.some((sn: any) => !sn?.type || sn.type === 'code');
    const codingCount = snaps.filter((sn: any) => !sn?.type || sn.type === 'code').length;
    // Languages students can really use: allowed by the exam AND offered by at least one coding question.
    const usable = snaps.some((sn: any) => !sn?.languages) ? langs : langs.filter((l) => snaps.some((sn: any) => isCode(sn) && sn.languages?.includes(l)));
    const runner = hasCode ? await runnerHealth(req.query.recheck === '1' || req.query.recheck === 'true') : { ok: true, detail: '' };
    const sebOk = !config.sebRequired || exam.is_practice || isPreview;
    res.json({
      exam: {
        id: exam.id,
        title: exam.title,
        shortTitle: exam.short_title ?? exam.title,
        teacherName: teacher?.full_name ?? '',
        teacherShortName: teacher?.display_name ?? teacher?.full_name ?? '',
        questionCount: qcount!.n,
        durationMinutes: exam.duration_minutes ?? 90,
        totalPoints: qcount!.p,
        instructionsMd: exam.instructions_md,
        languages: usable,
        codingCount,
        isPractice: exam.is_practice,
        isPreview,
        startsAt: iso(exam.starts_at),
        lateJoinClosesAt: exam.starts_at ? new Date(new Date(exam.starts_at).getTime() + exam.late_join_minutes * 60_000).toISOString() : null,
        windowClosesAt: iso(windowClosesAt(exam)),
        rules: [
          { icon: 'monitor', text: 'The exam runs in Safe Exam Browser. Leaving the exam is logged.' },
          { icon: 'clipboard', text: 'Paste from outside the exam is blocked.' },
          { icon: 'save', text: 'Your answers auto-save every few seconds.' },
          ...(hasCode ? [{ icon: 'play', text: 'Run your code and the sample tests as often as you like. Hidden tests run after you submit.' }] : []),
          { icon: 'timer', text: 'When time ends, your latest answers are submitted automatically.' },
        ],
      },
      checks: [
        {
          key: 'seb',
          title: 'Safe Exam Browser',
          detail: sebVersion ? `Version ${sebVersion} detected` : sebOk ? (exam.is_practice || isPreview ? 'Not required for practice' : 'Not required on this server (development mode)') : 'Not detected',
          status: sebVersion || sebOk ? 'ready' : 'failed',
        },
        { key: 'display', title: 'Single display', detail: 'Enforced by Safe Exam Browser', status: 'ready' },
        { key: 'connection', title: 'Connection', detail: null, status: 'client' },
        hasCode
          ? { key: 'runner', title: 'Code runner', detail: runner.ok ? usable.map((l) => LANG_LABEL[l] ?? l).join(', ') + ' ready' : 'Code runner unavailable. Tell your invigilator.', status: runner.ok ? 'ready' : 'failed' }
          : { key: 'runner', title: 'Code runner', detail: 'Not needed for this exam', status: 'skipped' },
        { key: 'webcam', title: 'Webcam', detail: 'Not required for this exam', status: 'skipped' },
      ],
      session: { status: session?.status ?? 'not_started', accommodationMinutes: acc?.extra_minutes ?? 0 },
      serverNow: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------- start / resume
examRouter.post(
  '/start',
  h(async (req, res) => {
    const b = z.object({ integrityAccepted: z.boolean().optional(), client: z.record(z.any()).optional() }).parse(req.body ?? {});
    const { exam, isPreview, sebVersion } = req.examCtx!;
    const me = req.user!;
    const practiceLike = exam.is_practice || isPreview;
    const token = randomToken();
    const out = await tx(async (c) => {
      let s = await one(`SELECT * FROM exam_sessions WHERE exam_id = $1 AND student_id = $2 FOR UPDATE`, [exam.id, me.id], c);
      // Practice and teacher previews can be restarted any time.
      if (s && practiceLike && s.status !== 'in_progress') {
        await q(`DELETE FROM exam_sessions WHERE id = $1`, [s.id], c);
        s = null;
      }
      if (s && ['submitted', 'auto_submitted', 'force_submitted'].includes(s.status)) throw conflict('ALREADY_SUBMITTED', 'You already submitted this exam.', { sessionStatus: s.status });
      const now = new Date();
      if (!s || s.status === 'not_started') {
        if (!practiceLike && !b.integrityAccepted) throw invalid('Accept the integrity statement to start.', { integrityAccepted: 'Required' }, 'INTEGRITY_NOT_ACCEPTED');
        if (!practiceLike) {
          if (!['scheduled', 'live'].includes(exam.status) || !exam.starts_at) throw forbidden('EXAM_NOT_OPEN', 'This exam is not open.');
          const startsAt = new Date(exam.starts_at).getTime();
          if (now.getTime() < startsAt) throw forbidden('EXAM_NOT_OPEN', 'The exam has not started yet.', { opensAt: iso(exam.starts_at) });
          if (now.getTime() > startsAt + exam.late_join_minutes * 60_000) throw forbidden('LATE_JOIN_CLOSED', 'The late-join window has closed.');
          if (exam.status === 'scheduled') await q(`UPDATE exams SET status = 'live' WHERE id = $1 AND status = 'scheduled'`, [exam.id], c);
        } else if (isPreview) {
          await refreshSnapshots(exam.id, c);
        }
        const eqs = await q(`SELECT * FROM exam_questions WHERE exam_id = $1 ORDER BY position`, [exam.id], c);
        if (!eqs.length) throw forbidden('EXAM_NOT_OPEN', 'This exam has no questions yet.');
        let order = eqs.map((x: any) => x.id);
        if (exam.question_order !== 'fixed') {
          order = order
            .map((id: string) => ({ id, k: crypto.randomInt(1_000_000) }))
            .sort((a: any, b: any) => a.k - b.k)
            .map((x: any) => x.id);
          if (exam.question_order === 'pool' && exam.pool_size) order = order.slice(0, exam.pool_size);
        }
        const acc = await one(`SELECT extra_minutes FROM exam_accommodations WHERE exam_id = $1 AND student_id = $2`, [exam.id, me.id], c);
        const deadline = practiceLike
          ? new Date(now.getTime() + (exam.duration_minutes ?? 180) * 60_000)
          : computeDeadline(exam, now, acc?.extra_minutes ?? 0, 0);
        s = await one(
          `INSERT INTO exam_sessions(exam_id, student_id, status, integrity_accepted_at, started_at, deadline_at, question_order, active_client_token_hash, last_seen_at, current_question_position, is_preview, seb_version, client_ip)
           VALUES ($1,$2,'in_progress',$3,$4,$5,$6,$7,$4,1,$8,$9,$10)
           ON CONFLICT (exam_id, student_id) DO UPDATE SET status = 'in_progress', integrity_accepted_at = EXCLUDED.integrity_accepted_at, started_at = EXCLUDED.started_at,
             deadline_at = EXCLUDED.deadline_at, question_order = EXCLUDED.question_order, active_client_token_hash = EXCLUDED.active_client_token_hash, last_seen_at = EXCLUDED.last_seen_at
           RETURNING *`,
          [exam.id, me.id, b.integrityAccepted ? now : null, now, deadline, order, sha256(token), isPreview, sebVersion, req.ip ?? null],
          c,
        );
        const langs = await examLangs(exam.id, c);
        for (const eq of eqs.filter((x: any) => order.includes(x.id))) {
          const lang = effectiveLangs(eq.snapshot as QuestionSpec, langs)[0] ?? null;
          await q(`INSERT INTO session_answers(session_id, exam_question_id, language) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [s.id, eq.id, lang], c);
        }
        return { s, resumed: false };
      }
      // resume (in_progress): rotate the client token, detect takeover
      const recentlyActive = s.last_seen_at && now.getTime() - new Date(s.last_seen_at).getTime() < 60_000 && s.active_client_token_hash;
      await q(`UPDATE exam_sessions SET active_client_token_hash = $2, last_seen_at = now() WHERE id = $1`, [s.id, sha256(token)], c);
      if (recentlyActive && !practiceLike) {
        await q(`UPDATE exam_sessions SET is_flagged = true WHERE id = $1`, [s.id], c);
        await q(`INSERT INTO proctor_events(session_id, type, occurred_at) VALUES ($1, 'session_takeover', now())`, [s.id], c);
        await audit({ actor: null, category: 'lockdown', action: 'proctor.session_takeover', examId: exam.id, courseId: exam.course_id, target: `${me.fullName} · ${exam.short_title ?? exam.title}`, details: 'Exam opened on a second device · flagged' }, c);
        await notify(await courseTeacherIds(exam.course_id, c), { type: 'proctor_flag', title: `${me.fullName} opened ${exam.short_title ?? exam.title} on a second device`, actorName: me.fullName, link: `/teacher/exams/${exam.id}/monitor` }, c);
      }
      return { s, resumed: true };
    });
    res.json({
      sessionToken: token,
      session: { id: out.s.id, status: 'in_progress', startedAt: iso(out.s.started_at), deadlineAt: iso(out.s.deadline_at), resumed: out.resumed },
      serverNow: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------- workspace (session required below)
examRouter.use(sessionGate);

async function answerRows(sessionId: string, db?: Db) {
  return q(
    `SELECT a.*, eq.snapshot, eq.points, eq.position FROM session_answers a JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE a.session_id = $1`,
    [sessionId],
    db,
  );
}

async function runDto(runId: string) {
  const r = await one(`SELECT * FROM code_runs WHERE id = $1`, [runId]);
  if (!r) return null;
  const tests = await q(`SELECT * FROM test_results WHERE run_id = $1 ORDER BY sort_order`, [runId]);
  return {
    runId: r.id,
    kind: r.kind,
    status: r.status,
    language: r.language,
    command: r.command ?? '',
    compile: { ok: r.status !== 'compile_error', output: r.compile_output ?? '' },
    diagnostics: r.diagnostics ?? [],
    console: r.console ?? [],
    exitCode: r.exit_code,
    timeMs: r.time_ms,
    memoryKb: r.memory_kb,
    // Only visible tests are ever run for students, so names/messages are safe to show.
    tests: tests.map((t: any) => ({ name: t.name, tag: null, passed: t.outcome === 'pass', timeMs: t.time_ms, message: t.message ?? '' })),
    testsPassed: r.tests_passed ?? 0,
    testsTotal: r.tests_total ?? 0,
    finishedAt: iso(r.finished_at),
  };
}

examRouter.get(
  '/workspace',
  h(async (req, res) => {
    const { exam } = req.examCtx!;
    const s = req.examSession!;
    const langs = await examLangs(exam.id);
    const rows = await answerRows(s.id);
    const order: string[] = s.question_order ?? rows.map((r: any) => r.exam_question_id);
    const byId = new Map(rows.map((r: any) => [r.exam_question_id, r]));
    const questions = [];
    for (const [i, id] of order.entries()) {
      const a: any = byId.get(id);
      if (!a) continue;
      const spec = a.snapshot as QuestionSpec;
      if (!isCode(spec)) {
        questions.push({
          examQuestionId: id,
          position: i + 1,
          type: spec.type,
          title: spec.title,
          displayTitle: `Q${i + 1}: ${spec.title}`,
          short: spec.title,
          points: a.points,
          difficulty: spec.difficulty,
          descriptionMd: spec.instructionsMd,
          languages: [],
          options: studentOptions(spec, s.id + id),
          sample: null,
          templates: {},
          answer: { language: null, files: {}, response: a.response ?? null, revision: a.revision, serverSavedAt: iso(a.server_saved_at) },
          sampleStatus: { passed: 0, total: 0, started: a.started },
          lastRun: null,
        });
        continue;
      }
      const eff = effectiveLangs(spec, langs);
      const sampleTests = exam.show_sample_tests
        ? spec.tests.filter((t) => !t.hidden).sort((x, y) => x.sortOrder - y.sortOrder)
        : [];
      const sample = sampleTests[0];
      const templates: Record<string, any> = {};
      for (const l of eff) templates[l] = (spec.files[l]?.starter ?? []).map((f) => ({ path: f.path, readOnly: f.readOnly, content: f.content, isEntrypoint: f.isEntrypoint }));
      questions.push({
        examQuestionId: id,
        position: i + 1,
        type: 'code',
        title: spec.title,
        displayTitle: `Q${i + 1}: ${spec.title}`,
        short: spec.title,
        points: a.points,
        difficulty: spec.difficulty,
        descriptionMd: spec.instructionsMd,
        languages: eff,
        options: [],
        sample: sample ? { input: sample.input, expected: sample.expected } : null,
        sampleTests: sampleTests.map((t) => ({ id: t.id, name: t.name, kind: t.kind, input: t.input, expected: t.expected, matchType: t.matchType, floatTolerance: t.floatTolerance })),
        sampleSetup: eff.includes('python') && sampleTests.some((t) => t.kind === 'call') ? spec.setup?.python ?? null : null,
        limits: {
          timeLimitMs: Math.min(spec.limits.timeLimitMs, exam.time_limit_ms),
          memoryLimitMb: Math.min(spec.limits.memoryLimitMb, exam.memory_limit_mb),
        },
        templates,
        answer: { language: eff.includes(a.language) ? a.language : eff[0], files: a.files ?? {}, response: null, revision: a.revision, serverSavedAt: iso(a.server_saved_at) },
        sampleStatus: { passed: a.last_sample_passed, total: a.last_sample_total, started: a.started },
        lastRun: a.last_sample_run_id ? await runDto(a.last_sample_run_id) : null,
      });
    }
    const ann = await q(
      `SELECT * FROM exam_messages WHERE exam_id = $1 AND (scope = 'all' OR recipient_id = $2) ORDER BY created_at`,
      [exam.id, req.user!.id],
    );
    res.json({
      exam: { id: exam.id, shortTitle: exam.short_title ?? exam.title, title: exam.title, allowRun: exam.allow_run, showSampleTests: exam.show_sample_tests, autosaveSeconds: 10, isPractice: exam.is_practice, isPreview: s.is_preview },
      session: { id: s.id, status: s.status, deadlineAt: iso(s.deadline_at), currentQuestionPosition: s.current_question_position },
      questions,
      announcements: ann.map((m: any) => ({ id: m.id, createdAt: iso(m.created_at), body: m.body, examQuestionId: m.exam_question_id, scope: m.scope })),
      serverNow: new Date().toISOString(),
    });
  }),
);

// ---------------------------------------------------------------- save / sync
const responseSchema = z.object({ selected: z.array(z.string().max(40)).max(20).optional(), text: z.string().max(10_000).optional() });
const saveSchema = z.object({
  language: langSchema.nullable().optional(),
  files: z.record(z.string().max(120), z.string()).default({}),
  response: responseSchema.nullable().optional(),
  deletedFiles: z.array(z.string()).max(40).optional(),
  baseRevision: z.number().int().min(0),
  clientSavedAt: z.string().datetime({ offset: true }),
  currentQuestionPosition: z.number().int().min(1).optional().nullable(),
});
type SaveBody = z.infer<typeof saveSchema>;

async function saveAnswer(c: Db, s: any, examQuestionId: string, b: SaveBody, examLangsList: string[]) {
  const a = await one(
    `SELECT a.*, eq.snapshot FROM session_answers a JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE a.session_id = $1 AND a.exam_question_id = $2 FOR UPDATE OF a`,
    [s.id, examQuestionId],
    c,
  );
  if (!a) throw notFound('NOT_FOUND', 'Question not found in this exam.');
  const spec = a.snapshot as QuestionSpec;
  if (!isCode(spec)) {
    const r = b.response ?? {};
    const opts = new Set(normChoice(spec.choice).options.map((o) => o.id));
    let response: { selected?: string[]; text?: string };
    if (spec.type === 'short_answer') response = { text: r.text ?? '' };
    else {
      const sel = [...new Set(r.selected ?? [])];
      if (sel.some((x) => !opts.has(x))) throw invalid('Unknown option.', { response: 'Unknown option' });
      if (spec.type !== 'multiple_choice' && sel.length > 1) throw invalid('Choose only one option.', { response: 'Choose one' });
      response = { selected: sel };
    }
    const clientAt = new Date(b.clientSavedAt).toISOString();
    // Last write wins by client time (offline replays may arrive out of order).
    if (a.client_saved_at && new Date(a.client_saved_at).toISOString() > clientAt) {
      return { revision: a.revision, serverSavedAt: iso(a.server_saved_at), merged: true, answerId: a.id, files: {}, spec };
    }
    const rev = a.revision + 1;
    const fixed = await one(
      `UPDATE session_answers SET response = $2, revision = $3, client_saved_at = $4, server_saved_at = now(), started = $5 WHERE id = $1 RETURNING server_saved_at`,
      [a.id, JSON.stringify(response), rev, clientAt, isAnswered(spec, response)],
      c,
    );
    await q(`INSERT INTO answer_snapshots(answer_id, revision, language, files, response) VALUES ($1,$2,NULL,'{}',$3)`, [a.id, rev, JSON.stringify(response)], c);
    return { revision: rev, serverSavedAt: iso(fixed.server_saved_at), merged: false, answerId: a.id, files: {}, spec };
  }
  if (!b.language || !effectiveLangs(spec, examLangsList).includes(b.language)) throw invalid('This language is not allowed for this question.', { language: 'Not allowed' });
  const lang = b.language;
  const tpl = new Map((spec.files[lang]?.starter ?? []).map((f) => [f.path, f]));
  let size = 0;
  for (const [p, content] of Object.entries(b.files)) {
    const f = tpl.get(p);
    if (!f) throw invalid(`Unknown file ${p}.`, { [`files.${p}`]: 'Unknown file' }, 'UNKNOWN_FILE');
    if (f.readOnly) throw invalid(`${p} is read-only.`, { [`files.${p}`]: 'Read-only' }, 'READ_ONLY_FILE');
    if (Buffer.byteLength(content) > 200_000) throw invalid(`${p} is larger than 200 KB.`, { [`files.${p}`]: 'Too large' }, 'FILE_TOO_LARGE');
    size += Buffer.byteLength(content);
  }
  if (size > 1_000_000) throw invalid('Your answer is larger than 1 MB.', {}, 'FILE_TOO_LARGE');
  const files: Record<string, FileMap> = a.files ?? {};
  const times: Record<string, Record<string, string>> = a.file_times ?? {};
  const lf = { ...(files[lang] ?? {}) };
  const lt = { ...(times[lang] ?? {}) };
  const clientAt = new Date(b.clientSavedAt).toISOString();
  let merged = false;
  // Last write wins per file, by client timestamp (offline replays may arrive out of order).
  for (const [p, content] of Object.entries(b.files)) {
    if (lt[p] && lt[p]! > clientAt) {
      merged = true;
      continue;
    }
    lf[p] = content;
    lt[p] = clientAt;
  }
  for (const p of b.deletedFiles ?? []) {
    if (lt[p] && lt[p]! > clientAt) {
      merged = true;
      continue;
    }
    delete lf[p];
    lt[p] = clientAt;
  }
  files[lang] = lf;
  times[lang] = lt;
  const rev = a.revision + 1;
  const fixed = await one(
    `UPDATE session_answers SET language = $2, files = $3, file_times = $4, revision = $5, client_saved_at = $6, server_saved_at = now(),
            started = started OR $7
     WHERE id = $1 RETURNING server_saved_at`,
    [a.id, lang, JSON.stringify(files), JSON.stringify(times), rev, clientAt, Object.keys(b.files).length > 0],
    c,
  );
  const last = await one(`SELECT saved_at FROM answer_snapshots WHERE answer_id = $1 ORDER BY saved_at DESC LIMIT 1`, [a.id], c);
  if (!last || Date.now() - new Date(last.saved_at).getTime() > 60_000) {
    await q(`INSERT INTO answer_snapshots(answer_id, revision, language, files) VALUES ($1,$2,$3,$4)`, [a.id, rev, lang, JSON.stringify(lf)], c);
  }
  return { revision: rev, serverSavedAt: iso(fixed.server_saved_at), merged, answerId: a.id, files: lf, spec };
}

examRouter.put(
  '/answers/:examQuestionId',
  h(async (req, res) => {
    const s = req.examSession!;
    assertWritable(s);
    const b = saveSchema.parse(req.body);
    const langs = await examLangs(req.examCtx!.exam.id);
    const out = await tx(async (c) => {
      const r = await saveAnswer(c, s, String(req.params.examQuestionId), b, langs);
      await q(`UPDATE exam_sessions SET last_seen_at = now(), current_question_position = COALESCE($2, current_question_position) WHERE id = $1`, [s.id, b.currentQuestionPosition ?? null], c);
      return r;
    });
    res.json({ revision: out.revision, serverSavedAt: out.serverSavedAt, merged: out.merged || undefined });
  }),
);

examRouter.post(
  '/answers/sync',
  h(async (req, res) => {
    const s = req.examSession!;
    if (s.status !== 'in_progress') throw conflict('ALREADY_SUBMITTED', 'This exam has been submitted.', { sessionStatus: s.status });
    const b = z.object({ items: z.array(saveSchema.extend({ examQuestionId: z.string().uuid() })).max(500) }).parse(req.body);
    const langs = await examLangs(req.examCtx!.exam.id);
    const limit = new Date(s.deadline_at).getTime() + config.graceSeconds * 1000;
    const results: any[] = [];
    for (const it of b.items) {
      if (new Date(it.clientSavedAt).getTime() > limit) {
        results.push({ examQuestionId: it.examQuestionId, error: 'TIME_UP' });
        continue;
      }
      try {
        const r = await tx((c) => saveAnswer(c, s, it.examQuestionId, it, langs));
        results.push({ examQuestionId: it.examQuestionId, revision: r.revision, serverSavedAt: r.serverSavedAt });
      } catch (e: any) {
        results.push({ examQuestionId: it.examQuestionId, error: e?.code ?? 'INTERNAL' });
      }
    }
    await q(`UPDATE exam_sessions SET last_seen_at = now() WHERE id = $1`, [s.id]);
    res.json({ results, serverNow: new Date().toISOString(), deadlineAt: iso(s.deadline_at) });
  }),
);

// ---------------------------------------------------------------- heartbeat / events
examRouter.post(
  '/heartbeat',
  h(async (req, res) => {
    const s = req.examSession!;
    const b = z
      .object({ online: z.boolean().optional(), currentQuestionPosition: z.number().int().nullable().optional(), clientTime: z.string().optional(), lastAnnouncementId: z.string().uuid().nullable().optional() })
      .parse(req.body ?? {});
    const prev = s.last_seen_at ? new Date(s.last_seen_at).getTime() : Date.now();
    if (s.status === 'in_progress') {
      await q(`UPDATE exam_sessions SET last_seen_at = now(), current_question_position = COALESCE($2, current_question_position) WHERE id = $1`, [s.id, b.currentQuestionPosition ?? null]);
      if (Date.now() - prev > 60_000) {
        await q(`INSERT INTO proctor_events(session_id, type, occurred_at, duration_ms) VALUES ($1, 'heartbeat_gap', to_timestamp($2/1000.0), $3)`, [s.id, prev, Date.now() - prev]);
      }
    }
    let since = new Date(0);
    if (b.lastAnnouncementId) {
      const m = await one(`SELECT created_at FROM exam_messages WHERE id = $1`, [b.lastAnnouncementId]);
      if (m) since = m.created_at;
    }
    const msgs = await q(
      `SELECT * FROM exam_messages WHERE exam_id = $1 AND created_at > $3 AND (scope = 'all' OR recipient_id = $2) ORDER BY created_at`,
      [req.examCtx!.exam.id, req.user!.id, since],
    );
    const fresh = await one(`SELECT status, deadline_at FROM exam_sessions WHERE id = $1`, [s.id]);
    const exam = await one(`SELECT status FROM exams WHERE id = $1`, [req.examCtx!.exam.id]);
    res.json({
      serverNow: new Date().toISOString(),
      deadlineAt: iso(fresh.deadline_at),
      sessionStatus: fresh.status,
      examStatus: exam.status,
      announcements: msgs.filter((m: any) => m.scope === 'all').map((m: any) => ({ id: m.id, createdAt: iso(m.created_at), body: m.body, examQuestionId: m.exam_question_id, scope: 'all' })),
      directMessages: msgs.filter((m: any) => m.scope === 'direct').map((m: any) => ({ id: m.id, createdAt: iso(m.created_at), body: m.body })),
      forceSubmitted: fresh.status === 'force_submitted',
    });
  }),
);

examRouter.post(
  '/events',
  h(async (req, res) => {
    const s = req.examSession!;
    const { exam } = req.examCtx!;
    const b = z
      .object({
        events: z
          .array(
            z.object({
              type: z.enum(['tab_switch', 'fullscreen_exit', 'paste_blocked', 'connection_lost', 'connection_restored']),
              occurredAt: z.string().datetime({ offset: true }),
              durationMs: z.number().int().min(0).nullable().optional(),
              detail: z.record(z.any()).optional(),
            }),
          )
          .max(100),
      })
      .parse(req.body);
    if (s.is_preview || exam.is_practice || s.status !== 'in_progress') return res.json({ tabSwitchCount: s.tab_switch_count, flagged: s.is_flagged, autoSubmitted: false });
    const name = req.user!.fullName;
    const target = `${name} · ${exam.short_title ?? exam.title}`;
    let tabs = s.tab_switch_count;
    let flagged = s.is_flagged;
    let autoSubmitted = false;
    await tx(async (c) => {
      for (const e of b.events) {
        const at = new Date(Math.min(Date.now(), Math.max(Date.now() - 5 * 60_000, new Date(e.occurredAt).getTime())));
        await q(`INSERT INTO proctor_events(session_id, type, occurred_at, duration_ms, detail) VALUES ($1,$2,$3,$4,$5)`, [s.id, e.type, at, e.durationMs ?? null, e.detail ? JSON.stringify(e.detail) : null], c);
        if (e.type === 'tab_switch') {
          tabs++;
          const nth = tabs === 1 ? '1st' : tabs === 2 ? '2nd' : tabs === 3 ? '3rd' : `${tabs}th`;
          const willFlag = tabs >= config.flagAfterSwitches;
          await audit({ actor: null, category: 'lockdown', action: 'proctor.tab_switch', examId: exam.id, courseId: exam.course_id, target, details: `Tab switch (${nth} time)${willFlag ? ' · flagged' : ''}` }, c);
          if (willFlag) flagged = true;
          if (tabs === config.flagAfterSwitches) {
            await notify(await courseTeacherIds(exam.course_id, c), { type: 'proctor_flag', title: `${name} switched tabs ${tabs === 2 ? 'twice' : `${tabs} times`} in ${exam.short_title ?? exam.title}`, actorName: name, link: `/teacher/exams/${exam.id}/monitor` }, c);
          }
        } else if (e.type === 'fullscreen_exit') {
          await audit({ actor: null, category: 'lockdown', action: 'proctor.fullscreen_exit', examId: exam.id, courseId: exam.course_id, target, details: e.durationMs ? `Left full screen for ${Math.round(e.durationMs / 1000)} s` : 'Left full screen' }, c);
        } else if (e.type === 'paste_blocked') {
          await audit({ actor: null, category: 'lockdown', action: 'proctor.paste_blocked', examId: exam.id, courseId: exam.course_id, target, details: 'Paste from outside the editor blocked' }, c);
        }
      }
      await q(`UPDATE exam_sessions SET tab_switch_count = $2, is_flagged = $3 WHERE id = $1`, [s.id, tabs, flagged], c);
      if (tabs >= config.autoSubmitAfterSwitches) {
        await submitSession(s.id, 'tab_switch_limit', null, c);
        autoSubmitted = true;
      }
    });
    if (autoSubmitted) kick();
    res.json({ tabSwitchCount: tabs, flagged, autoSubmitted });
  }),
);

// ---------------------------------------------------------------- runs
const runWindow = new Map<string, number[]>();
function rateLimit(userId: string) {
  const now = Date.now();
  const arr = (runWindow.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= config.runRateLimitPerMin) {
    throw new HttpError(429, 'RATE_LIMITED', 'You are running code too quickly. Wait a few seconds.', undefined, { retryAfterSec: Math.ceil((60_000 - (now - arr[0]!)) / 1000) });
  }
  arr.push(now);
  runWindow.set(userId, arr);
}

examRouter.post(
  '/runs',
  h(async (req, res) => {
    const s = req.examSession!;
    const { exam } = req.examCtx!;
    assertWritable(s);
    const b = z
      .object({
        examQuestionId: z.string().uuid(),
        kind: z.enum(['run', 'custom_input', 'sample_tests']),
        language: langSchema,
        files: z.record(z.string().max(120), z.string()),
        stdin: z.string().max(100_000).nullable().optional(),
      })
      .parse(req.body);
    if (b.kind !== 'sample_tests' && !exam.allow_run) throw forbidden('RUN_DISABLED', 'Running code is turned off for this exam.');
    if (b.kind === 'sample_tests' && !exam.show_sample_tests) throw forbidden('SAMPLE_TESTS_HIDDEN', 'Sample tests are hidden for this exam.');
    rateLimit(req.user!.id);
    const hlt = await runnerHealth();
    if (!hlt.ok) throw new HttpError(503, 'RUNNER_UNAVAILABLE', "Couldn't reach the code runner. Your code is safe on this device and the timer is still running.");
    const langs = await examLangs(exam.id);
    const runId = await tx(async (c) => {
      // Save only the editable files that differ from the template (the edits), then run the full set.
      const a = await one(
        `SELECT a.*, eq.snapshot FROM session_answers a JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE a.session_id = $1 AND a.exam_question_id = $2`,
        [s.id, b.examQuestionId],
        c,
      );
      if (!a) throw notFound('NOT_FOUND', 'Question not found in this exam.');
      if (!isCode(a.snapshot)) throw invalid('Only coding questions can be run.', {});
      if (exam.runs_per_question && a.run_count >= exam.runs_per_question) throw new HttpError(429, 'RUN_LIMIT_REACHED', `You have used all ${exam.runs_per_question} runs for this question.`);
      const spec0 = a.snapshot as QuestionSpec;
      const edits: FileMap = {};
      const prevEdits: FileMap = (a.files ?? {})[b.language] ?? {};
      for (const f of spec0.files[b.language]?.starter ?? []) {
        if (f.readOnly) continue;
        const sent = b.files[f.path];
        if (sent === undefined) continue;
        // keep "edited" markers accurate: store only files that differ from the template or were edited before
        if (sent !== f.content || prevEdits[f.path] !== undefined) edits[f.path] = sent;
      }
      const saved = await saveAnswer(c, s, b.examQuestionId, { language: b.language, files: edits, baseRevision: a.revision, clientSavedAt: new Date().toISOString() }, langs);
      await q(`UPDATE session_answers SET run_count = run_count + 1, started = true WHERE id = $1`, [a.id], c);
      const spec: QuestionSpec = {
        ...saved.spec,
        limits: { timeLimitMs: Math.min(saved.spec.limits.timeLimitMs, exam.time_limit_ms), memoryLimitMb: Math.min(saved.spec.limits.memoryLimitMb, exam.memory_limit_mb) },
      };
      const files = fullFiles(spec, b.language as Lang, saved.files);
      return createRun({ kind: b.kind, requestedBy: req.user!.id, language: b.language as Lang, files, spec, stdin: b.kind === 'custom_input' ? b.stdin ?? '' : null, sessionId: s.id, answerId: a.id, examQuestionId: b.examQuestionId, priority: 3 }, c);
    });
    kick();
    const pos = await one<{ n: number }>(`SELECT count(*)::int AS n FROM code_runs WHERE status = 'queued' AND created_at <= (SELECT created_at FROM code_runs WHERE id = $1)`, [runId]);
    res.status(202).json({ runId, status: 'queued', position: pos!.n });
  }),
);

examRouter.post(
  '/local-runs',
  h(async (req, res) => {
    const s = req.examSession!;
    const { exam } = req.examCtx!;
    assertWritable(s);
    const b = z
      .object({
        examQuestionId: z.string().uuid(),
        kind: z.enum(['run', 'sample_tests']),
        language: langSchema,
        files: z.record(z.string().max(120), z.string()),
      })
      .parse(req.body);
    if (!['python', 'c', 'cpp'].includes(b.language)) throw invalid('This language does not use browser-local execution.', {});
    if (b.kind === 'run' && !exam.allow_run) throw forbidden('RUN_DISABLED', 'Running code is turned off for this exam.');
    if (b.kind === 'sample_tests' && !exam.show_sample_tests) throw forbidden('SAMPLE_TESTS_HIDDEN', 'Sample tests are hidden for this exam.');
    rateLimit(req.user!.id);
    const langs = await examLangs(exam.id);
    const saved = await tx(async (c) => {
      const a = await one(
        `SELECT a.*, eq.snapshot FROM session_answers a JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE a.session_id = $1 AND a.exam_question_id = $2`,
        [s.id, b.examQuestionId],
        c,
      );
      if (!a) throw notFound('NOT_FOUND', 'Question not found in this exam.');
      if (!isCode(a.snapshot)) throw invalid('Only coding questions can be run.', {});
      if (!effectiveLangs(a.snapshot as QuestionSpec, langs).includes(b.language)) throw invalid('This language is not allowed for this question.', { language: 'Not allowed' });
      if (exam.runs_per_question && a.run_count >= exam.runs_per_question) throw new HttpError(429, 'RUN_LIMIT_REACHED', `You have used all ${exam.runs_per_question} runs for this question.`);

      const spec = a.snapshot as QuestionSpec;
      const edits: FileMap = {};
      const previous: FileMap = (a.files ?? {})[b.language] ?? {};
      for (const file of spec.files[b.language]?.starter ?? []) {
        if (file.readOnly) continue;
        const content = b.files[file.path];
        if (content !== undefined && (content !== file.content || previous[file.path] !== undefined)) edits[file.path] = content;
      }
      const result = await saveAnswer(
        c,
        s,
        b.examQuestionId,
        { language: b.language, files: edits, baseRevision: a.revision, clientSavedAt: new Date().toISOString() },
        langs,
      );
      if (b.kind === 'sample_tests') {
        await q(
          `UPDATE session_answers SET run_count = run_count + 1, started = true, last_sample_passed = 0, last_sample_total = 0, last_sample_run_id = NULL WHERE id = $1`,
          [a.id],
          c,
        );
      } else {
        await q(`UPDATE session_answers SET run_count = run_count + 1, started = true WHERE id = $1`, [a.id], c);
      }
      await q(`UPDATE exam_sessions SET last_seen_at = now() WHERE id = $1`, [s.id], c);
      return result;
    });
    res.json({ revision: saved.revision, serverSavedAt: saved.serverSavedAt, merged: saved.merged || undefined });
  }),
);

const FINAL = new Set(['completed', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error']);

examRouter.get(
  '/runs/:runId',
  h(async (req, res) => {
    const s = req.examSession!;
    const waitMs = Math.min(20_000, Math.max(0, Number(req.query.waitMs) || 0));
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await one(`SELECT status, session_id FROM code_runs WHERE id = $1`, [req.params.runId]);
      if (!r || r.session_id !== s.id) throw notFound('NOT_FOUND', 'Run not found.');
      if (FINAL.has(r.status) || Date.now() >= until) break;
      await new Promise((rs) => setTimeout(rs, 250));
    }
    res.json(await runDto(String(req.params.runId)));
  }),
);

// ---------------------------------------------------------------- submit
examRouter.get(
  '/submit-summary',
  h(async (req, res) => {
    const s = req.examSession!;
    const rows = await answerRows(s.id);
    const order: string[] = s.question_order ?? [];
    const byId = new Map(rows.map((r: any) => [r.exam_question_id, r]));
    const questions = order
      .map((id, i) => {
        const a: any = byId.get(id);
        if (!a) return null;
        const spec = a.snapshot as QuestionSpec;
        if (!isCode(spec)) {
          const done = isAnswered(spec, a.response);
          return { position: i + 1, title: spec.title, type: spec.type, language: null, samplePassed: 0, sampleTotal: 0, status: done ? 'answered' : 'not_started' };
        }
        const status = a.last_sample_total > 0 && a.last_sample_passed === a.last_sample_total ? 'ready' : a.started ? 'some_failing' : 'not_started';
        return { position: i + 1, title: spec.title, type: 'code', language: a.language, samplePassed: a.last_sample_passed, sampleTotal: a.last_sample_total, status };
      })
      .filter(Boolean);
    res.json({ examTitle: req.examCtx!.exam.title, sessionId: s.id, questions, deadlineAt: iso(s.deadline_at) });
  }),
);

examRouter.post(
  '/submit',
  h(async (req, res) => {
    const s = req.examSession!;
    const b = z
      .object({
        confirmFinal: z.boolean(),
        pending: z
          .array(z.object({ examQuestionId: z.string().uuid(), language: langSchema.nullable().optional(), files: z.record(z.string()).default({}), response: responseSchema.nullable().optional(), clientSavedAt: z.string().datetime({ offset: true }) }))
          .max(200)
          .optional(),
      })
      .parse(req.body);
    if (!b.confirmFinal) throw invalid('Confirm that your answers are final.', { confirmFinal: 'Required' }, 'CONFIRM_REQUIRED');
    assertWritable(s);
    const langs = await examLangs(req.examCtx!.exam.id);
    const subId = await tx(async (c) => {
      for (const p of b.pending ?? []) {
        await saveAnswer(c, s, p.examQuestionId, { language: p.language, files: p.files, response: p.response, baseRevision: 0, clientSavedAt: p.clientSavedAt }, langs);
      }
      return submitSession(s.id, 'student', req.user!.id, c);
    });
    kick();
    const sub = await one(`SELECT submitted_at FROM submissions WHERE id = $1`, [subId]);
    res.status(202).json({ submissionId: subId, submittedAt: iso(sub?.submitted_at), redirect: s.is_preview ? `/teacher` : `/student/results/${req.examCtx!.exam.id}` });
  }),
);
