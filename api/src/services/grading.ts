import { z } from 'zod';
import { config } from '../config';
import { one, pool, q, tx, type Db } from '../db';
import type { FileMap, Lang, QuestionSpec } from './runner';
import { audit, courseTeacherIds, notify } from './audit';
import { autoScore, createRun } from './runs';
import { isCode } from './questions';
import { scoreChoice } from './choice';

/** Template starter files overlaid by the student's edits (read-only files always come from the template). */
export function fullFiles(spec: QuestionSpec, lang: Lang, edits: FileMap | undefined): FileMap {
  const out: FileMap = {};
  for (const f of spec.files[lang]?.starter ?? []) out[f.path] = f.readOnly ? f.content : edits?.[f.path] ?? f.content;
  return out;
}

/** Reference solution set: starter (for read-only helper files) overlaid by reference files. */
export function referenceFiles(spec: QuestionSpec, lang: Lang): FileMap {
  const out: FileMap = {};
  for (const f of spec.files[lang]?.starter ?? []) out[f.path] = f.content;
  for (const f of spec.files[lang]?.reference ?? []) out[f.path] = f.content;
  return out;
}

// ---------- submit ----------
export async function submitSession(sessionId: string, reason: 'student' | 'timeout' | 'teacher_ended' | 'tab_switch_limit', actorId: string | null, db?: Db): Promise<string | null> {
  const work = async (c: Db) => {
    const s = await one(`SELECT s.*, e.run_hidden_on_submit, e.course_id, e.short_title, e.title AS exam_title, u.full_name
                         FROM exam_sessions s JOIN exams e ON e.id = s.exam_id JOIN users u ON u.id = s.student_id
                         WHERE s.id = $1 FOR UPDATE OF s`, [sessionId], c);
    if (!s) return null;
    const existing = await one<{ id: string }>(`SELECT id FROM submissions WHERE session_id = $1`, [sessionId], c);
    if (existing) return existing.id;
    if (s.status !== 'in_progress') return null;
    const status = reason === 'student' ? 'submitted' : reason === 'timeout' ? 'auto_submitted' : 'force_submitted';
    const now = new Date();
    const used = Math.max(0, Math.round((now.getTime() - new Date(s.started_at).getTime()) / 1000));
    await q(`UPDATE exam_sessions SET status = $2, submitted_at = $3, submit_reason = $4, active_client_token_hash = NULL WHERE id = $1`, [sessionId, status, now, reason], c);
    const sub = await one<{ id: string }>(
      `INSERT INTO submissions(session_id, submitted_at, reason, time_used_seconds) VALUES ($1,$2,$3,$4) RETURNING id`,
      [sessionId, now, reason, used],
      c,
    );
    const answers = await q(
      `SELECT a.*, eq.snapshot, eq.points FROM session_answers a JOIN exam_questions eq ON eq.id = a.exam_question_id WHERE a.session_id = $1 ORDER BY eq.position`,
      [sessionId],
      c,
    );
    for (const a of answers) {
      const spec = a.snapshot as QuestionSpec;
      if (!isCode(spec)) {
        const sc = scoreChoice(spec, a.response, a.points);
        await q(
          `INSERT INTO submission_answers(submission_id, exam_question_id, language, files, response, max_score, auto_score) VALUES ($1,$2,NULL,'{}',$3,$4,$5)`,
          [sub!.id, a.exam_question_id, JSON.stringify(a.response ?? null), a.points, sc.score],
          c,
        );
        continue;
      }
      const lang = a.language as Lang;
      const files = fullFiles(spec, lang, (a.files as Record<string, FileMap>)[lang]);
      const sa = await one<{ id: string }>(
        `INSERT INTO submission_answers(submission_id, exam_question_id, language, files, max_score) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [sub!.id, a.exam_question_id, lang, JSON.stringify(files), a.points],
        c,
      );
      const gradeSpec: QuestionSpec = { ...spec, points: a.points, tests: s.run_hidden_on_submit ? spec.tests : spec.tests.filter((t) => !t.hidden) };
      const runId = await createRun(
        { kind: 'final_grading', requestedBy: actorId ?? s.student_id, language: lang, files, spec: gradeSpec, sessionId, submissionAnswerId: sa!.id, examQuestionId: a.exam_question_id, priority: 8 },
        c,
      );
      await q(`UPDATE submission_answers SET grading_run_id = $2 WHERE id = $1`, [sa!.id, runId], c);
    }
    // Submissions with no coding answers have nothing to wait for.
    if (!answers.some((a: any) => isCode(a.snapshot))) await maybeFinalizeSubmission(sub!.id, c);
    if (reason !== 'student') {
      await audit(
        {
          actor: null,
          category: 'lockdown',
          action: 'session.auto_submitted',
          examId: s.exam_id,
          courseId: s.course_id,
          target: `${s.full_name} · ${s.short_title ?? s.exam_title}`,
          details: reason === 'timeout' ? 'Time ended · latest code submitted automatically' : reason === 'teacher_ended' ? 'Exam ended by teacher · submitted automatically' : 'Tab-switch limit reached · submitted automatically',
        },
        c,
      );
    }
    return sub!.id;
  };
  return db ? work(db) : tx(work);
}

// ---------- after runs ----------
export async function onRunFinished(runId: string): Promise<void> {
  const run = await one(`SELECT * FROM code_runs WHERE id = $1`, [runId]);
  if (!run) return;
  if (run.kind === 'sample_tests' && run.answer_id) {
    await q(
      `UPDATE session_answers SET last_sample_passed = $2, last_sample_total = $3, last_sample_run_id = $4, started = true WHERE id = $1`,
      [run.answer_id, run.tests_passed ?? 0, run.tests_total ?? 0, runId],
    );
  }
  if (run.kind === 'final_grading' && run.submission_answer_id) {
    const sa = await one(`SELECT * FROM submission_answers WHERE id = $1`, [run.submission_answer_id]);
    if (!sa) return;
    const tr = await q(`SELECT outcome, points_possible FROM test_results WHERE run_id = $1`, [runId]);
    const score = autoScore(sa.max_score, tr.map((t: any) => ({ weight: t.points_possible, passed: t.outcome === 'pass' })));
    await q(`UPDATE submission_answers SET auto_score = $2 WHERE id = $1`, [sa.id, score]);
    await maybeFinalizeSubmission(sa.submission_id);
  }
  if (run.kind === 'reference_validation' && run.validation_job_id) {
    await maybeFinishValidation(run.validation_job_id);
  }
}

export async function recomputeTotals(submissionId: string, db: Db = pool) {
  await q(
    `UPDATE submissions s SET
       auto_total = (SELECT COALESCE(SUM(auto_score),0) FROM submission_answers WHERE submission_id = s.id),
       final_total = (SELECT COALESCE(SUM(final_score),0) FROM submission_answers WHERE submission_id = s.id)
     WHERE s.id = $1`,
    [submissionId],
    db,
  );
}

export async function maybeFinalizeSubmission(submissionId: string, db: Db = pool) {
  const pending = await one<{ n: number }>(`SELECT count(*)::int AS n FROM submission_answers WHERE submission_id = $1 AND auto_score IS NULL`, [submissionId], db);
  if (pending!.n > 0) return;
  const sub = await one(
    `SELECT s.*, es.is_flagged, es.exam_id, es.student_id, es.is_preview, e.course_id, e.short_title, e.title AS exam_title, u.full_name
     FROM submissions s JOIN exam_sessions es ON es.id = s.session_id JOIN exams e ON e.id = es.exam_id JOIN users u ON u.id = es.student_id
     WHERE s.id = $1`,
    [submissionId],
    db,
  );
  if (!sub || sub.grading_status !== 'pending_tests') return;
  await recomputeTotals(submissionId, db);
  const fails = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM submission_answers sa JOIN test_results tr ON tr.run_id = sa.grading_run_id
     WHERE sa.submission_id = $1 AND tr.outcome <> 'pass'`,
    [submissionId],
    db,
  );
  const empty = await one<{ n: number }>(`SELECT count(*)::int AS n FROM submission_answers WHERE submission_id = $1`, [submissionId], db);
  // Short answers that did not match an accepted answer go to the teacher.
  const shortAnswers = await q(
    `SELECT sa.response, sa.max_score, eq.snapshot FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.submission_id = $1 AND sa.language IS NULL`,
    [submissionId],
    db,
  );
  const shortReview = shortAnswers.some((a: any) => a.snapshot.type === 'short_answer' && scoreChoice(a.snapshot, a.response, a.max_score).needsReview);
  const status = fails!.n > 0 || shortReview || sub.is_flagged || empty!.n === 0 ? 'needs_review' : 'reviewed';
  // Atomic transition: only one finisher wins if two grading runs complete at the same moment.
  const won = await one(
    `UPDATE submissions SET grading_status = $2::grading_status, reviewed_at = CASE WHEN $2::text = 'reviewed' THEN now() END
     WHERE id = $1 AND grading_status = 'pending_tests' RETURNING id`,
    [submissionId, status],
    db,
  );
  if (!won) return;
  if (config.aiProvider !== 'none') {
    await q(`INSERT INTO ai_suggestions(submission_answer_id) SELECT id FROM submission_answers WHERE submission_id = $1 AND language IS NOT NULL`, [submissionId], db);
    setImmediate(() => processAiQueue().catch((e) => console.error('[ai]', e)));
  }
  if (!sub.is_preview) {
    const totals = await one(`SELECT auto_total, (SELECT COALESCE(SUM(max_score),0) FROM submission_answers WHERE submission_id = $1) AS max FROM submissions WHERE id = $1`, [submissionId], db);
    await notify(await courseTeacherIds(sub.course_id, db), {
      type: 'submission',
      title: `${sub.full_name} submitted ${sub.short_title ?? sub.exam_title} · ${totals.auto_total} / ${totals.max}`,
      actorName: sub.full_name,
      link: `/teacher/exams/${sub.exam_id}/grading?submission=${submissionId}`,
    }, db);
  }
}

// ---------- validation ----------
async function maybeFinishValidation(jobId: string) {
  const job = await one(`SELECT * FROM validation_jobs WHERE id = $1`, [jobId]);
  if (!job) return;
  const runs = await q(`SELECT language, status, tests_passed, tests_total FROM code_runs WHERE validation_job_id = $1`, [jobId]);
  if (runs.some((r: any) => r.status === 'queued' || r.status === 'running')) return;
  if (job.is_draft) return;
  const allPassed = runs.length > 0 && runs.every((r: any) => r.status === 'completed' && r.tests_total > 0 && r.tests_passed === r.tests_total);
  const totalTests = runs[0]?.tests_total ?? 0;
  const summary = allPassed
    ? `All ${runs.length} reference solution${runs.length === 1 ? '' : 's'} pass ${totalTests} / ${totalTests} tests`
    : `Reference solutions failed: ${runs.filter((r: any) => !(r.status === 'completed' && r.tests_passed === r.tests_total)).map((r: any) => r.language).join(', ')}`;
  await q(`UPDATE questions SET last_validation = $2 WHERE id = $1 AND version = $3`, [job.question_id, JSON.stringify({ at: new Date().toISOString(), allPassed, summary }), job.version]);
}

// ---------- AI assistant (D4) ----------
const aiOut = z.object({
  suggestedScore: z.number(),
  suggestedFeedback: z.string().max(4000),
  rationale: z.string().max(8000).default(''),
  requirementChecks: z.array(z.object({ requirement: z.string(), met: z.boolean(), evidence: z.string().nullable().optional() })).max(30).default([]),
  highlightLines: z.array(z.object({ path: z.string(), lines: z.array(z.number().int()) })).max(30).default([]),
});

let aiBusy = 0;
export async function processAiQueue() {
  if (aiBusy >= 2) return;
  while (aiBusy < 2) {
    const job = await one(
      `UPDATE ai_suggestions SET status = 'running' WHERE id = (
         SELECT id FROM ai_suggestions WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
    );
    if (!job) return;
    aiBusy++;
    suggest(job.id, job.submission_answer_id)
      .catch(async (e) => {
        await q(`UPDATE ai_suggestions SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [job.id, String(e).slice(0, 500)]);
      })
      .finally(() => {
        aiBusy--;
        setImmediate(() => processAiQueue().catch(() => undefined));
      });
  }
}

async function suggest(id: string, submissionAnswerId: string) {
  const sa = await one(
    `SELECT sa.*, eq.snapshot, eq.position FROM submission_answers sa JOIN exam_questions eq ON eq.id = sa.exam_question_id WHERE sa.id = $1`,
    [submissionAnswerId],
  );
  const spec = sa.snapshot as QuestionSpec;
  const tests = await q(`SELECT name, is_hidden, outcome, message, points_possible FROM test_results WHERE run_id = $1 ORDER BY sort_order`, [sa.grading_run_id]);
  const files = sa.files as FileMap;
  let out: z.infer<typeof aiOut>;
  let model: string;
  if (config.aiProvider === 'ollama') {
    model = config.aiModel;
    out = await ollamaSuggest(spec, sa.max_score, files, tests, referenceFiles(spec, sa.language));
  } else {
    model = 'heuristic (no AI model)';
    out = heuristicSuggest(sa.auto_score ?? 0, tests, files);
  }
  out.suggestedScore = Math.max(0, Math.min(sa.max_score, Math.round(out.suggestedScore)));
  await q(
    `UPDATE ai_suggestions SET status = 'done', model = $2, suggested_score = $3, suggested_feedback = $4, rationale = $5,
            requirement_checks = $6, highlight_lines = $7, finished_at = now() WHERE id = $1`,
    [id, model, out.suggestedScore, out.suggestedFeedback, out.rationale, JSON.stringify(out.requirementChecks), JSON.stringify(out.highlightLines)],
  );
  if (out.highlightLines.length) {
    await q(`UPDATE submission_answers SET highlight_lines = COALESCE(highlight_lines, $2) WHERE id = $1`, [submissionAnswerId, JSON.stringify(out.highlightLines)]);
  }
}

/** Free, model-less fallback: summarises the test results. Labelled as heuristic in the UI. */
function heuristicSuggest(auto: number, tests: any[], files: FileMap): z.infer<typeof aiOut> {
  const failed = tests.filter((t) => t.outcome !== 'pass');
  const feedback = failed.length
    ? failed.map((t) => `${t.name}: ${t.message ?? 'failed'}`).join(' ')
    : 'Great work. All tests pass.';
  // Point at lines mentioned in error messages like "File.java:24".
  const highlight: { path: string; lines: number[] }[] = [];
  for (const t of failed) {
    const m = /([\w./-]+\.(?:java|py|c|cc|cpp|h|hpp|js)):(\d+)/.exec(t.message ?? '');
    if (m && files[m[1]!]) highlight.push({ path: m[1]!, lines: [Number(m[2])] });
  }
  return {
    suggestedScore: auto,
    suggestedFeedback: feedback.slice(0, 1000),
    rationale: failed.length ? `${tests.length - failed.length} of ${tests.length} tests pass. The suggestion keeps the automatic score; review the failing cases.` : 'All tests pass.',
    requirementChecks: tests.map((t) => ({ requirement: t.is_hidden ? `${t.name} (hidden test)` : t.name, met: t.outcome === 'pass', evidence: t.outcome === 'pass' ? null : t.message ?? null })),
    highlightLines: highlight,
  };
}

async function ollamaSuggest(spec: QuestionSpec, max: number, files: FileMap, tests: any[], reference: FileMap): Promise<z.infer<typeof aiOut>> {
  const numbered = Object.entries(files)
    .map(([p, c]) => `--- ${p}\n` + c.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n'))
    .join('\n\n');
  const prompt = `You are a teaching assistant helping a teacher grade a programming exam answer. The teacher makes the final decision.
Question: ${spec.title}
Requirements (markdown):
${spec.instructionsMd}

Maximum points: ${max}
Test results:
${tests.map((t) => `- ${t.name}${t.is_hidden ? ' (hidden)' : ''}: ${t.outcome}${t.outcome !== 'pass' ? ` — ${t.message}` : ''} [${t.points_possible} pts]`).join('\n')}

Student files (with line numbers):
${numbered}

Reference solution (teacher only):
${Object.entries(reference).map(([p, c]) => `--- ${p}\n${c}`).join('\n\n')}

Reply with JSON only: {"suggestedScore": integer 0..${max}, "suggestedFeedback": "short feedback to the student", "rationale": "reasoning for the teacher", "requirementChecks": [{"requirement": "...", "met": true|false, "evidence": "File:line or null"}], "highlightLines": [{"path": "File", "lines": [n]}]}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${config.aiBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.aiModel, stream: false, format: 'json', messages: [{ role: 'user', content: prompt }], options: { temperature: 0.1 } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data = (await r.json()) as any;
    try {
      return aiOut.parse(JSON.parse(data.message?.content ?? '{}'));
    } catch {
      /* retry once */
    }
  }
  throw new Error('AI returned invalid JSON twice');
}

export async function auditGradeChange(actor: any, examId: string, courseId: string, target: string, details: string, db: Db = pool) {
  await audit({ actor, category: 'grade_change', action: 'grade.changed', examId, courseId, target, details }, db);
}
