import { config } from '../config';
import { one, pool, q, tx, type Db } from '../db';
import { buildJob } from './runner/harness';
import { parseDiagnostics, parseNode, parsePython, type Diagnostic } from './runner/diagnostics';
import { evaluateTest } from './runner/match';
import { driver, type FileMap, type Lang, type QuestionSpec, type TestSpec } from './runner';
import { onRunFinished } from './grading';

export type RunKind = 'run' | 'custom_input' | 'sample_tests' | 'final_grading' | 'reference_validation';

export interface CreateRunInput {
  kind: RunKind;
  requestedBy: string;
  language: Lang;
  files: FileMap;
  spec: QuestionSpec;
  stdin?: string | null;
  sessionId?: string | null;
  answerId?: string | null;
  submissionAnswerId?: string | null;
  questionId?: string | null;
  examQuestionId?: string | null;
  validationJobId?: string | null;
  priority?: number;
}

export async function createRun(i: CreateRunInput, db: Db = pool): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO code_runs(kind, requested_by, language, files, spec, stdin, session_id, answer_id, submission_answer_id, question_id, exam_question_id, validation_job_id, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      i.kind,
      i.requestedBy,
      i.language,
      JSON.stringify(i.files),
      JSON.stringify(i.spec),
      i.stdin ?? null,
      i.sessionId ?? null,
      i.answerId ?? null,
      i.submissionAnswerId ?? null,
      i.questionId ?? null,
      i.examQuestionId ?? null,
      i.validationJobId ?? null,
      i.priority ?? 5,
    ],
    db,
  );
  kick();
  return row!.id;
}

/** Score for a question from passed weights (BACKEND_SPEC_PART1 §10.4). */
export function autoScore(points: number, tests: { weight: number; passed: boolean }[]): number {
  const total = tests.reduce((a, t) => a + t.weight, 0);
  const passed = tests.filter((t) => t.passed).reduce((a, t) => a + t.weight, 0);
  if (total === 0) return 0;
  if (total === points) return passed;
  return Math.min(points, Math.round((points * passed) / total));
}

type ConsoleLine = { stream: 'system' | 'stdout' | 'stderr'; text: string; tone?: 'ok' | 'warn' };

const splitLines = (s: string, stream: ConsoleLine['stream']): ConsoleLine[] =>
  s
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .filter((l, i, arr) => !(arr.length === 1 && l === ''))
    .map((text) => ({ stream, text }));

export async function processRun(runId: string): Promise<void> {
  const run = await one(`SELECT * FROM code_runs WHERE id = $1`, [runId]);
  if (!run) return;
  const spec = run.spec as QuestionSpec;
  const lang = run.language as Lang;
  const files = run.files as FileMap;
  const programMode = run.kind === 'run' || run.kind === 'custom_input';
  const tests: TestSpec[] = programMode
    ? []
    : (run.kind === 'sample_tests' ? spec.tests.filter((t) => !t.hidden) : spec.tests).slice().sort((a, b) => a.sortOrder - b.sortOrder);

  const built = buildJob(lang, files, spec, programMode ? 'program' : 'tests', tests, run.stdin);
  const consoleLines: ConsoleLine[] = [{ stream: 'system', text: built.command }];
  let status = 'completed';
  let diagnostics: Diagnostic[] = [];
  let exitCode: number | null = null;
  let timeMs: number | null = null;
  let stdout = '';
  let stderr = '';
  const results: { t: TestSpec; outcome: string; actual: string; message: string; timeMs: number | null }[] = [];
  let compileOutput = '';

  if (programMode && built.noEntrypoint) {
    const why: Record<string, string> = { java: 'No main method found. Add one to run your program, or use Run tests.', python: 'No Python file to run.', c: 'No .c file to compile.', cpp: 'No .cpp file to compile.', javascript: 'No .js file to run.' };
    consoleLines.push({ stream: 'system', text: why[lang] ?? 'Nothing to run.', tone: 'warn' });
    await finish();
    return;
  }

  const res = await driver.exec(built.job);
  compileOutput = res.compile.output ?? '';
  if (res.internalError) {
    const attempts = (run.attempts ?? 0) + 1;
    if (attempts < 2) {
      await q(`UPDATE code_runs SET status = 'queued', attempts = $2 WHERE id = $1`, [runId, attempts]);
      return;
    }
    status = 'internal_error';
    consoleLines.push({ stream: 'stderr', text: 'The code runner had a problem. Try again in a moment.' });
    console.error('[runner]', res.internalError);
    for (const t of tests) results.push({ t, outcome: 'error', actual: '', message: 'Runner error', timeMs: null });
    await finish();
    return;
  }

  if (!res.compile.ok) {
    status = 'compile_error';
    const out = res.compile.output.trim();
    diagnostics = parseDiagnostics(lang, out);
    const harnessErr = lang === 'java' && /__AegisT\d+\.java/.test(out) && diagnostics.length === 0;
    consoleLines.push(...splitLines(harnessErr ? out.replace(/__AegisT\d+\.java/g, 'test harness') : out, 'stderr'));
    consoleLines.push({ stream: 'system', text: harnessErr ? 'A test could not be compiled. Check the test input matches your class and method names.' : 'Compilation failed.' });
    for (const t of tests) results.push({ t, outcome: 'error', actual: '', message: harnessErr ? 'Test could not be compiled against your code.' : 'Compilation failed', timeMs: null });
    await finish();
    return;
  }

  if (programMode) {
    const r = res.runs[built.programRunIndex!]!;
    stdout = r.stdout;
    stderr = r.stderr;
    exitCode = r.exitCode;
    timeMs = r.timeMs;
    consoleLines.push(...splitLines(r.stdout, 'stdout'));
    if (r.stderr.trim()) consoleLines.push(...splitLines(r.stderr, 'stderr'));
    if (r.timedOut) {
      status = 'time_limit';
      consoleLines.push({ stream: 'system', text: `Stopped: time limit of ${spec.limits.timeLimitMs} ms exceeded.`, tone: 'warn' });
    } else {
      if (r.exitCode !== 0) {
        status = 'runtime_error';
        if (lang === 'python') diagnostics = parsePython(r.stderr).map((d) => ({ ...d, source: 'runtime' as const }));
        if (lang === 'javascript') diagnostics = parseNode(r.stderr).map((d) => ({ ...d, source: 'runtime' as const }));
      }
      consoleLines.push({ stream: 'system', text: `Process finished in ${(r.timeMs / 1000).toFixed(2)}s · exit code ${r.exitCode}` });
    }
    await finish();
    return;
  }

  tests.forEach((t, i) => {
    const idx = built.testRunIndex[i]!;
    const r = idx >= 0 ? res.runs[idx] ?? null : null;
    const ev =
      !r && t.kind === 'call' && (lang === 'c' || lang === 'cpp')
        ? { outcome: 'error' as const, actual: '', message: 'Function-call tests are not available for C/C++. Ask your teacher to use STDIN/STDOUT tests.' }
        : evaluateTest(t, r, spec.limits.timeLimitMs);
    results.push({ t, outcome: ev.outcome, actual: ev.actual, message: ev.message, timeMs: r ? r.timeMs : null });
  });
  const passed = results.filter((r) => r.outcome === 'pass').length;
  consoleLines.push({ stream: 'system', text: `${passed} of ${results.length} tests passed.`, tone: passed === results.length ? 'ok' : 'warn' });
  await finish();

  async function finish() {
    await tx(async (c) => {
      for (const [i, r] of results.entries()) {
        await q(
          `INSERT INTO test_results(run_id, test_case_ref, name, is_hidden, outcome, points_awarded, points_possible, time_ms, actual_output, message, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [runId, r.t.id, r.t.name, r.t.hidden, r.outcome, r.outcome === 'pass' ? r.t.weight : 0, r.t.weight, r.timeMs, r.actual.slice(0, 4096), r.message, i],
          c,
        );
      }
      await q(
        `UPDATE code_runs SET status = $2, command = $3, compile_output = $4, diagnostics = $5, console = $6, stdout = $7, stderr = $8,
                exit_code = $9, time_ms = $10, tests_passed = $11, tests_total = $12, finished_at = now()
         WHERE id = $1`,
        [
          runId,
          status,
          built.command,
          compileOutput.slice(0, 65536),
          JSON.stringify(diagnostics),
          JSON.stringify(consoleLines.slice(0, 2000)),
          stdout.slice(0, 65536),
          stderr.slice(0, 65536),
          exitCode,
          timeMs,
          programMode ? null : results.filter((r) => r.outcome === 'pass').length,
          programMode ? null : results.length,
        ],
        c,
      );
    });
    await onRunFinished(runId);
  }
}

// ---------- queue ----------
let active = 0;
let scheduled = false;

/** Claim and process queued runs up to RUN_MAX_CONCURRENCY. Safe across several API processes. */
export function kick() {
  if (!config.jobsEnabled || scheduled) return;
  scheduled = true;
  setImmediate(async () => {
    scheduled = false;
    while (active < config.runMaxConcurrency) {
      const claimed = await one<{ id: string }>(
        `UPDATE code_runs SET status = 'running', started_at = now()
         WHERE id = (SELECT id FROM code_runs WHERE status = 'queued' ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id`,
      ).catch(() => null);
      if (!claimed) break;
      active++;
      processRun(claimed.id)
        .catch(async (e) => {
          console.error('[run] failed', claimed.id, e);
          await q(`UPDATE code_runs SET status = 'internal_error', finished_at = now() WHERE id = $1`, [claimed.id]).catch(() => undefined);
        })
        .finally(() => {
          active--;
          kick();
        });
    }
  });
}

/** Re-queue runs stuck in "running" (e.g. after a crash). */
export async function recoverStuckRuns() {
  await q(`UPDATE code_runs SET status = 'queued' WHERE status = 'running' AND started_at < now() - interval '3 minutes'`);
}
