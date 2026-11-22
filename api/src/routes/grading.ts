import AdmZip from 'adm-zip';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, initials, requireRole, teacherCourseIds } from '../auth';
import { config } from '../config';
import { one, q, tx } from '../db';
import { conflict, h, invalid, notFound } from '../errors';
import { audit, notify } from '../services/audit';
import { sendMailLater } from '../services/mailer';
import { auditGradeChange, processAiQueue, recomputeTotals } from '../services/grading';
import type { QuestionSpec } from '../services/runner';
import { isCode, normChoice } from '../services/questions';
import { describeResponse, scoreChoice } from '../services/choice';
import { ownExam } from './teacher';

export const gradingRouter = Router();
gradingRouter.use('/teacher', authenticate, requireRole('teacher'));

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function ownSubmission(req: Request, submissionId: string) {
  const s = await one(
    `SELECT sb.*, es.exam_id, es.student_id, es.is_flagged, es.is_preview, e.course_id, e.short_title, e.title AS exam_title, u.full_name, u.student_id AS student_number
     FROM submissions sb JOIN exam_sessions es ON es.id = sb.session_id JOIN exams e ON e.id = es.exam_id JOIN users u ON u.id = es.student_id WHERE sb.id = $1`,
    [submissionId],
  );
  if (!s) throw notFound('NOT_FOUND', 'Submission not found.');
  const courses = await teacherCourseIds(req.user!.id);
  if (!courses.includes(s.course_id)) throw notFound('NOT_FOUND', 'Submission not found.');
  return s;
}

// ---------------------------------------------------------------- roster
gradingRouter.get(
  '/teacher/exams/:id/grading/roster',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const rows = await q(
      `SELECT sb.*, u.full_name, u.student_id AS student_number FROM submissions sb JOIN exam_sessions es ON es.id = sb.session_id JOIN users u ON u.id = es.student_id
       WHERE es.exam_id = $1 AND NOT es.is_preview ORDER BY u.full_name`,
      [e.id],
    );
    const items = [];
    for (const r of rows) {
      const answers = await q(
        `SELECT sa.final_score, sa.max_score, sa.language, eq.position,
           (SELECT count(*)::int FROM test_results tr WHERE tr.run_id = sa.grading_run_id AND tr.outcome <> 'pass') AS fails
         FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.submission_id = $1 ORDER BY eq.position`,
        [r.id],
      );
      items.push({
        submissionId: r.id,
        studentNumber: r.student_number,
        fullName: r.full_name,
        initials: initials(r.full_name),
        total: r.final_total ?? answers.reduce((a: number, x: any) => a + x.final_score, 0),
        maxTotal: answers.reduce((a: number, x: any) => a + x.max_score, 0),
        perQuestion: answers.map((a: any) => ({ position: a.position, score: a.final_score, hasFailures: a.fails > 0 || (a.language === null && a.final_score < a.max_score) })),
        needsReview: r.grading_status === 'needs_review',
        gradingStatus: r.grading_status,
      });
    }
    const filter = String(req.query.filter ?? 'all');
    const qq = String(req.query.q ?? '').toLowerCase();
    const filtered = items.filter(
      (i) =>
        (filter === 'all' || (filter === 'review' ? i.gradingStatus !== 'reviewed' : i.gradingStatus === 'reviewed')) &&
        (!qq || `${i.fullName} ${i.studentNumber}`.toLowerCase().includes(qq)),
    );
    res.json({
      counts: { all: items.length, review: items.filter((i) => i.gradingStatus !== 'reviewed').length, reviewed: items.filter((i) => i.gradingStatus === 'reviewed').length },
      items: filtered,
      page: 1,
      pageSize: filtered.length,
      total: items.length,
      exam: { id: e.id, shortTitle: e.short_title ?? e.title, status: e.status, resultsReleasedAt: iso(e.results_released_at) },
    });
  }),
);

async function questionDetail(sa: any) {
  const spec = sa.snapshot as QuestionSpec;
  if (!isCode(spec)) {
    const c = normChoice(spec.choice);
    const sc = scoreChoice(spec, sa.response, sa.max_score);
    const picked = new Set<string>(sa.response?.selected ?? []);
    return {
      submissionAnswerId: sa.id,
      position: sa.position,
      label: `Q${sa.position}: ${spec.title}`,
      title: spec.title,
      type: spec.type,
      language: null,
      maxScore: sa.max_score,
      autoScore: sa.auto_score,
      teacherScore: sa.teacher_score,
      finalScore: sa.final_score,
      adjusted: sa.teacher_score !== null && sa.teacher_score !== sa.auto_score,
      feedback: sa.feedback ?? '',
      files: [],
      primaryFile: '',
      highlightLines: [],
      tests: [],
      testsPassed: sc.correct ? 1 : 0,
      testsTotal: 1,
      gradingRunStatus: 'completed',
      compileOutput: null,
      instructionsMd: spec.instructionsMd,
      choice: {
        options: c.options.map((o) => ({ id: o.id, text: o.text, correct: o.correct, selected: picked.has(o.id) })),
        acceptedAnswers: c.acceptedAnswers,
        caseSensitive: c.caseSensitive,
        partialCredit: c.partialCredit,
        studentText: sa.response?.text ?? null,
        answerText: describeResponse(spec, sa.response),
        correct: sc.correct,
      },
      ai: { status: 'disabled', suggestedScore: null, suggestedFeedback: null, rationale: null, requirementChecks: [], highlightLines: [], model: null, createdAt: null, error: null },
    };
  }
  const tests = sa.grading_run_id ? await q(`SELECT * FROM test_results WHERE run_id = $1 ORDER BY sort_order`, [sa.grading_run_id]) : [];
  const run = sa.grading_run_id ? await one(`SELECT status, compile_output FROM code_runs WHERE id = $1`, [sa.grading_run_id]) : null;
  const ai = await one(`SELECT * FROM ai_suggestions WHERE submission_answer_id = $1 ORDER BY created_at DESC LIMIT 1`, [sa.id]);
  const files = Object.entries(sa.files as Record<string, string>).map(([path, content]) => ({ path, content }));
  const editable = new Set((spec.files[sa.language as 'java' | 'python']?.starter ?? []).filter((f) => !f.readOnly).map((f) => f.path));
  const hl = (sa.highlight_lines ?? ai?.highlight_lines ?? []) as { path: string; lines: number[] }[];
  const primary = hl[0]?.path ?? files.find((f) => editable.has(f.path) && f.content.trim())?.path ?? files[0]?.path ?? '';
  return {
    submissionAnswerId: sa.id,
    position: sa.position,
    label: `Q${sa.position}: ${spec.title}`,
    title: spec.title,
    type: 'code',
    language: sa.language,
    instructionsMd: spec.instructionsMd,
    choice: null,
    maxScore: sa.max_score,
    autoScore: sa.auto_score,
    teacherScore: sa.teacher_score,
    finalScore: sa.final_score,
    adjusted: sa.teacher_score !== null && sa.teacher_score !== sa.auto_score,
    feedback: sa.feedback ?? '',
    files,
    primaryFile: primary,
    highlightLines: hl,
    tests: tests.map((t: any) => ({
      name: t.name,
      hidden: t.is_hidden,
      passed: t.outcome === 'pass',
      outcome: t.outcome,
      timeMs: t.time_ms,
      pointsAwarded: t.points_awarded,
      pointsPossible: t.points_possible,
      detail: t.outcome === 'pass' ? 'Passed' : t.message ?? 'Failed',
    })),
    testsPassed: tests.filter((t: any) => t.outcome === 'pass').length,
    testsTotal: tests.length,
    gradingRunStatus: run?.status ?? 'queued',
    compileOutput: run?.status === 'compile_error' ? run.compile_output : null,
    ai: ai
      ? {
          status: ai.status,
          suggestedScore: ai.suggested_score,
          suggestedFeedback: ai.suggested_feedback,
          rationale: ai.rationale,
          requirementChecks: ai.requirement_checks ?? [],
          highlightLines: ai.highlight_lines ?? [],
          model: ai.model,
          createdAt: iso(ai.created_at),
          error: ai.status === 'failed' ? 'The AI assistant could not answer. Try again.' : null,
        }
      : { status: config.aiProvider === 'none' ? 'disabled' : 'queued', suggestedScore: null, suggestedFeedback: null, rationale: null, requirementChecks: [], highlightLines: [], model: null, createdAt: null, error: null },
  };
}

gradingRouter.get(
  '/teacher/grading/submissions/:submissionId',
  h(async (req, res) => {
    const s = await ownSubmission(req, String(req.params.submissionId));
    const answers = await q(
      `SELECT sa.*, eq.position, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.submission_id = $1 ORDER BY eq.position`,
      [s.id],
    );
    const flags = await one<{ n: number }>(`SELECT count(*)::int AS n FROM proctor_events WHERE session_id = $1 AND type IN ('tab_switch','fullscreen_exit','paste_blocked','session_takeover')`, [s.session_id]);
    const acc = await one(`SELECT extra_minutes FROM exam_accommodations WHERE exam_id = $1 AND student_id = $2`, [s.exam_id, s.student_id]);
    const questions = [];
    for (const a of answers) questions.push(await questionDetail(a));
    res.json({
      submissionId: s.id,
      examId: s.exam_id,
      student: { id: s.student_id, studentNumber: s.student_number, fullName: s.full_name, initials: initials(s.full_name) },
      submittedAt: iso(s.submitted_at),
      submitReason: s.reason,
      extraMinutes: acc?.extra_minutes ?? 0,
      flagCount: flags!.n,
      gradingStatus: s.grading_status,
      total: questions.reduce((a, x) => a + x.finalScore, 0),
      maxTotal: questions.reduce((a, x) => a + x.maxScore, 0),
      questions,
    });
  }),
);

gradingRouter.put(
  '/teacher/grading/answers/:id',
  h(async (req, res) => {
    const b = z.object({ teacherScore: z.number().int().nullable(), feedback: z.string().max(5000), acceptedAiSuggestion: z.boolean().optional() }).parse(req.body);
    const sa = await one(`SELECT sa.*, eq.position, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.id = $1`, [req.params.id]);
    if (!sa) throw notFound('NOT_FOUND', 'Answer not found.');
    const s = await ownSubmission(req, sa.submission_id);
    if (b.teacherScore !== null && (b.teacherScore < 0 || b.teacherScore > sa.max_score)) {
      throw invalid(`Score must be between 0 and ${sa.max_score}.`, { teacherScore: `0–${sa.max_score}` }, 'SCORE_OUT_OF_RANGE');
    }
    const newScore = b.teacherScore === sa.auto_score ? null : b.teacherScore;
    await tx(async (c) => {
      const oldFinal = sa.final_score;
      await q(`UPDATE submission_answers SET teacher_score = $2, feedback = $3 WHERE id = $1`, [sa.id, newScore, b.feedback], c);
      const fresh = await one(`SELECT final_score FROM submission_answers WHERE id = $1`, [sa.id], c);
      const fbChanged = (sa.feedback ?? '') !== b.feedback;
      if (oldFinal !== fresh.final_score || fbChanged) {
        await q(`INSERT INTO grade_changes(submission_answer_id, changed_by, old_score, new_score, feedback_changed) VALUES ($1,$2,$3,$4,$5)`, [sa.id, req.user!.id, oldFinal, fresh.final_score, fbChanged], c);
        const parts = [];
        if (oldFinal !== fresh.final_score) parts.push(`Score ${oldFinal} → ${fresh.final_score} / ${sa.max_score}`);
        if (fbChanged) parts.push(sa.feedback ? 'feedback updated' : 'feedback added');
        await auditGradeChange(req.user!, s.exam_id, s.course_id, `${s.full_name} · Q${sa.position}`, parts.join(' · '), c);
      }
      if (b.acceptedAiSuggestion !== undefined) {
        await q(`UPDATE ai_suggestions SET accepted = $2 WHERE id = (SELECT id FROM ai_suggestions WHERE submission_answer_id = $1 ORDER BY created_at DESC LIMIT 1)`, [sa.id, b.acceptedAiSuggestion], c);
      }
      await recomputeTotals(sa.submission_id, c);
    });
    const updated = await one(`SELECT sa.*, eq.position, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.id = $1`, [sa.id]);
    res.json(await questionDetail(updated));
  }),
);

gradingRouter.post(
  '/teacher/grading/submissions/:submissionId/review',
  h(async (req, res) => {
    const s = await ownSubmission(req, String(req.params.submissionId));
    if (s.grading_status === 'pending_tests') throw conflict('REVIEW_INCOMPLETE', 'Tests are still running for this submission.');
    const r = await one(`UPDATE submissions SET grading_status = 'reviewed', reviewed_at = now(), reviewed_by = $2 WHERE id = $1 RETURNING reviewed_at`, [s.id, req.user!.id]);
    res.json({ gradingStatus: 'reviewed', reviewedAt: iso(r.reviewed_at) });
  }),
);

gradingRouter.post(
  '/teacher/grading/answers/:id/ai-suggestion',
  h(async (req, res) => {
    if (config.aiProvider === 'none') throw conflict('AI_DISABLED', 'The AI assistant is turned off on this server.');
    const sa = await one(`SELECT * FROM submission_answers WHERE id = $1`, [req.params.id]);
    if (!sa) throw notFound('NOT_FOUND', 'Answer not found.');
    await ownSubmission(req, sa.submission_id);
    if (!sa.language) throw conflict('AI_DISABLED', 'The AI assistant only reviews coding answers.');
    if (sa.auto_score === null) throw conflict('REVIEW_INCOMPLETE', 'Tests are still running.');
    await q(`INSERT INTO ai_suggestions(submission_answer_id) VALUES ($1)`, [sa.id]);
    setImmediate(() => processAiQueue().catch(() => undefined));
    res.status(202).json({ status: 'queued' });
  }),
);

gradingRouter.get(
  '/teacher/grading/submissions/:submissionId/files.zip',
  h(async (req, res) => {
    const s = await ownSubmission(req, String(req.params.submissionId));
    const answers = await q(`SELECT sa.*, eq.position, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.submission_id = $1 ORDER BY eq.position`, [s.id]);
    const zip = new AdmZip();
    for (const a of answers) {
      if (!isCode(a.snapshot)) {
        zip.addFile(`Q${a.position}-${slug(a.snapshot.title)}/answer.txt`, Buffer.from(describeResponse(a.snapshot, a.response) + '\n', 'utf8'));
        continue;
      }
      for (const [p, c] of Object.entries(a.files as Record<string, string>)) zip.addFile(`Q${a.position}-${slug(a.snapshot.title)}/${p}`, Buffer.from(c, 'utf8'));
    }
    const name = `${slug(s.full_name)}-${s.student_number}-${slug(s.short_title ?? s.exam_title)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(zip.toBuffer());
  }),
);

// ---------------------------------------------------------------- results
async function resultRows(examId: string) {
  return q(
    `SELECT sb.*, es.student_id, u.full_name, u.student_id AS student_number,
       (SELECT string_agg(DISTINCT cl.code, ' ') FROM enrollments en JOIN classes cl ON cl.id = en.class_id JOIN exam_classes ec ON ec.class_id = cl.id AND ec.exam_id = es.exam_id WHERE en.student_id = es.student_id) AS class_code
     FROM submissions sb JOIN exam_sessions es ON es.id = sb.session_id JOIN users u ON u.id = es.student_id
     WHERE es.exam_id = $1 AND NOT es.is_preview ORDER BY u.full_name`,
    [examId],
  );
}

gradingRouter.get(
  '/teacher/exams/:id/results',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const subs = await resultRows(e.id);
    const eqs = await q(`SELECT id, position, points, snapshot FROM exam_questions WHERE exam_id = $1 ORDER BY position`, [e.id]);
    const maxTotal = eqs.reduce((a: number, x: any) => a + x.points, 0) || 100;
    const totals = subs.map((s: any) => s.final_total ?? 0).sort((a: number, b: number) => a - b);
    const n = totals.length;
    const avg = n ? totals.reduce((a: number, b: number) => a + b, 0) / n : null;
    const median = n ? (n % 2 ? totals[(n - 1) / 2] : (totals[n / 2 - 1] + totals[n / 2]) / 2) : null;
    const pct = (v: number) => (100 * v) / maxTotal;
    const bands = [
      ['0-49', 0, 49.999],
      ['50-59', 50, 59.999],
      ['60-69', 60, 69.999],
      ['70-79', 70, 79.999],
      ['80-89', 80, 89.999],
      ['90-100', 90, 100],
    ] as const;
    const answers = await q(
      `SELECT sa.*, eq.position FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id
       JOIN submissions sb ON sb.id = sa.submission_id JOIN exam_sessions es ON es.id = sb.session_id WHERE es.exam_id = $1 AND NOT es.is_preview`,
      [e.id],
    );
    const byLang = new Map<string, { students: Set<string>; pcts: number[] }>();
    for (const a of answers) {
      if (!a.language) continue;
      if (!byLang.has(a.language)) byLang.set(a.language, { students: new Set(), pcts: [] });
      const g = byLang.get(a.language)!;
      g.students.add(a.submission_id);
      if (a.max_score) g.pcts.push((100 * a.final_score) / a.max_score);
    }
    const perQuestion = [];
    for (const eq of eqs) {
      const qa = answers.filter((a: any) => a.exam_question_id === eq.id);
      const fails = await q(
        `SELECT tr.name, count(*) FILTER (WHERE tr.outcome <> 'pass')::int AS f FROM test_results tr JOIN submission_answers sa ON sa.grading_run_id = tr.run_id
         JOIN submissions sb ON sb.id = sa.submission_id JOIN exam_sessions es ON es.id = sb.session_id
         WHERE sa.exam_question_id = $1 AND NOT es.is_preview GROUP BY tr.name ORDER BY f DESC, tr.name LIMIT 1`,
        [eq.id],
      );
      const worst = fails[0];
      const spec = eq.snapshot as QuestionSpec;
      if (!isCode(spec)) {
        const wrong = qa.filter((a: any) => a.final_score < eq.points).length;
        perQuestion.push({
          position: eq.position,
          title: spec.title,
          type: spec.type,
          average: qa.length ? Math.round((10 * qa.reduce((x: number, a: any) => x + a.final_score, 0)) / qa.length) / 10 : 0,
          maxScore: eq.points,
          mostFailedTest: wrong ? 'Answer not fully correct' : null,
          failureRatePercent: qa.length ? Math.round((100 * wrong) / qa.length) : 0,
        });
        continue;
      }
      perQuestion.push({
        type: 'code',
        position: eq.position,
        title: (eq.snapshot as QuestionSpec).title,
        average: qa.length ? Math.round((10 * qa.reduce((x: number, a: any) => x + a.final_score, 0)) / qa.length) / 10 : 0,
        maxScore: eq.points,
        mostFailedTest: worst && worst.f > 0 ? worst.name : null,
        failureRatePercent: worst && qa.length ? Math.round((100 * worst.f) / qa.length) : 0,
      });
    }
    const prev = await one(
      `SELECT e2.title, e2.short_title, avg(sb.final_total)::float AS a FROM exams e2 JOIN exam_sessions es ON es.exam_id = e2.id JOIN submissions sb ON sb.session_id = es.id
       WHERE e2.course_id = $1 AND e2.id <> $2 AND e2.status = 'completed' AND e2.ended_at IS NOT NULL AND NOT es.is_preview
       GROUP BY e2.id ORDER BY max(e2.starts_at) DESC LIMIT 1`,
      [e.course_id, e.id],
    );
    const insights = perQuestion
      .filter((p) => p.mostFailedTest && p.failureRatePercent >= 25)
      .map((p) => ({ text: p.type === 'code' ? `${p.failureRatePercent}% of students failed ${p.mostFailedTest} in Q${p.position}. Consider reviewing it next class.` : `${p.failureRatePercent}% of students did not get Q${p.position} fully right. Consider reviewing it next class.` }));
    res.json({
      exam: { id: e.id, title: e.short_title ?? e.title, durationMinutes: e.duration_minutes, status: e.status },
      released: !!e.results_released_at,
      releasedAt: iso(e.results_released_at),
      submittedCount: n,
      needsReview: subs.filter((s: any) => s.grading_status !== 'reviewed').length,
      stats: {
        average: avg !== null ? Math.round(avg * 10) / 10 : null,
        averageDelta: avg !== null && prev?.a != null ? Math.round((avg - prev.a) * 10) / 10 : null,
        averageDeltaLabel: prev ? `vs ${prev.short_title ?? prev.title}` : null,
        median,
        passRatePercent: n ? Math.round((100 * totals.filter((t: number) => pct(t) >= 50).length) / n) : null,
        passThreshold: 50,
        avgTimeUsedMinutes: n ? Math.round(subs.reduce((a: number, s: any) => a + s.time_used_seconds, 0) / n / 60) : null,
        maxTotal,
      },
      distribution: bands.map(([band, lo, hi]) => ({ band, count: totals.filter((t: number) => pct(t) >= lo && pct(t) <= hi).length })),
      byLanguage: [...byLang.entries()].map(([language, g]) => ({ language, students: g.students.size, avgPercent: g.pcts.length ? Math.round(g.pcts.reduce((a, b) => a + b, 0) / g.pcts.length) : 0 })),
      insights,
      perQuestion,
    });
  }),
);

gradingRouter.post(
  '/teacher/exams/:id/results/release',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    if (!['grading', 'completed'].includes(e.status)) throw conflict('EXAM_NOT_EDITABLE', 'Results can be released after the exam ends.');
    const b = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    const pending = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM submissions sb JOIN exam_sessions es ON es.id = sb.session_id WHERE es.exam_id = $1 AND sb.grading_status <> 'reviewed' AND NOT es.is_preview`,
      [e.id],
    );
    if (pending!.n > 0 && !b.force) throw conflict('REVIEW_INCOMPLETE', `${pending!.n} submission${pending!.n === 1 ? ' still needs' : 's still need'} review.`, { pending: pending!.n });
    const people = await q(`SELECT es.student_id, u.email, u.full_name FROM exam_sessions es JOIN submissions sb ON sb.session_id = es.id JOIN users u ON u.id = es.student_id WHERE es.exam_id = $1 AND NOT es.is_preview`, [e.id]);
    const students = people.map((r: any) => r.student_id);
    await tx(async (c) => {
      await q(`UPDATE exams SET results_released_at = now(), status = 'completed' WHERE id = $1`, [e.id], c);
      await notify(students, { type: 'results_released', title: `Your result for ${e.title} is ready`, link: `/student/results/${e.id}` }, c);
      await audit({ actor: req.user!, category: 'publish', action: 'results.released', examId: e.id, courseId: e.course_id, target: `${e.short_title ?? e.title} results`, details: `Released results to ${students.length} students` }, c);
    });
    sendMailLater(
      people
        .filter((p: any) => p.email)
        .map((p: any) => ({ to: p.email, subject: `Your result for ${e.title} is ready`, title: e.title, paragraphs: [`Hello ${p.full_name},`, 'Your teacher released the results. Sign in to see your score and feedback.'], button: { label: 'See my result', url: `${config.appPublicUrl}/student/results/${e.id}` } })),
    );
    const r = await one(`SELECT results_released_at FROM exams WHERE id = $1`, [e.id]);
    res.json({ released: true, releasedAt: iso(r.results_released_at), studentCount: students.length });
  }),
);

gradingRouter.post(
  '/teacher/exams/:id/results/hide',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    await q(`UPDATE exams SET results_released_at = NULL WHERE id = $1`, [e.id]);
    await audit({ actor: req.user!, category: 'publish', action: 'results.hidden', examId: e.id, courseId: e.course_id, target: `${e.short_title ?? e.title} results`, details: 'Hid results from students' });
    res.json({ released: false, releasedAt: null, studentCount: 0 });
  }),
);

gradingRouter.get(
  '/teacher/exams/:id/results/export.csv',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const eqs = await q(`SELECT id, position FROM exam_questions WHERE exam_id = $1 ORDER BY position`, [e.id]);
    const subs = await resultRows(e.id);
    const head = ['student_id', 'name', 'language', ...eqs.map((x: any) => `q${x.position}`), 'total', 'class', 'status', 'submitted_at', 'time_used_min', 'reviewed'];
    const lines = [head.join(',')];
    for (const s of subs) {
      const ans = await q(`SELECT exam_question_id, language, final_score FROM submission_answers WHERE submission_id = $1`, [s.id]);
      const by = new Map(ans.map((a: any) => [a.exam_question_id, a]));
      const langs = [...new Set(ans.map((a: any) => a.language).filter(Boolean))].join(' ');
      lines.push(
        [s.student_number, s.full_name, langs, ...eqs.map((x: any) => (by.get(x.id) as any)?.final_score ?? 0), s.final_total ?? 0, s.class_code ?? '', s.reason, iso(s.submitted_at), Math.round(s.time_used_seconds / 60), s.grading_status === 'reviewed' ? 'yes' : 'no']
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(e.short_title ?? e.title)}-results.csv"`);
    res.send('﻿' + lines.join('\n'));
  }),
);

gradingRouter.get(
  '/teacher/exams/:id/submissions.zip',
  h(async (req, res) => {
    const e = await ownExam(req, String(req.params.id));
    const subs = await resultRows(e.id);
    const zip = new AdmZip();
    for (const s of subs) {
      const ans = await q(`SELECT sa.*, eq.position, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.submission_id = $1`, [s.id]);
      for (const a of ans) {
        if (!isCode(a.snapshot)) {
          zip.addFile(`${s.student_number}-${slug(s.full_name)}/Q${a.position}-${slug(a.snapshot.title)}/answer.txt`, Buffer.from(describeResponse(a.snapshot, a.response) + '\n', 'utf8'));
          continue;
        }
        for (const [p, c] of Object.entries(a.files as Record<string, string>)) zip.addFile(`${s.student_number}-${slug(s.full_name)}/Q${a.position}-${slug(a.snapshot.title)}/${p}`, Buffer.from(c, 'utf8'));
      }
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(e.short_title ?? e.title)}-submissions.zip"`);
    res.send(zip.toBuffer());
  }),
);

// ---------------------------------------------------------------- audit
async function auditQuery(req: Request) {
  const courses = await teacherCourseIds(req.user!.id);
  const cat = req.query.category ? String(req.query.category) : null;
  const qq = String(req.query.q ?? '');
  const params = [courses, req.user!.id, cat, qq, req.query.examId ? String(req.query.examId) : null];
  const where = `(course_id = ANY($1::uuid[]) OR exam_id IN (SELECT id FROM exams WHERE course_id = ANY($1::uuid[])) OR actor_id = $2)
    AND ($3::text IS NULL OR category::text = $3)
    AND ($4 = '' OR actor_label ILIKE '%' || $4 || '%' OR target_label ILIKE '%' || $4 || '%' OR details ILIKE '%' || $4 || '%')
    AND ($5::uuid IS NULL OR exam_id = $5)`;
  return { where, params };
}

gradingRouter.get(
  '/teacher/audit',
  h(async (req, res) => {
    const { where, params } = await auditQuery(req);
    const pageSize = Math.min(200, Number(req.query.pageSize) || 50);
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = await q(`SELECT * FROM audit_events WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
    const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE ${where}`, params);
    res.json({
      items: rows.map((r: any) => ({ id: r.id, occurredAt: iso(r.occurred_at), who: r.actor_label, role: r.actor_role, category: r.category, target: r.target_label, details: r.details })),
      page,
      pageSize,
      total: total!.n,
      retentionDays: config.auditRetentionDays,
    });
  }),
);

gradingRouter.get(
  '/teacher/audit/export.csv',
  h(async (req, res) => {
    const { where, params } = await auditQuery(req);
    const rows = await q(`SELECT * FROM audit_events WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT 50000`, params);
    const LABEL: Record<string, string> = { publish: 'Publish', grade_change: 'Grade change', lockdown: 'Lockdown', settings: 'Settings' };
    const lines = [['time_utc', 'who', 'role', 'event', 'target', 'details'].join(',')];
    for (const r of rows) lines.push([new Date(r.occurred_at).toISOString().slice(0, 16).replace('T', ' '), r.actor_label, r.actor_role, LABEL[r.category], r.target_label, r.details].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send('﻿' + lines.join('\n'));
  }),
);
