import { one, pool, q, type Db } from '../db';
import type { Lang, QuestionSpec } from './runner';
import { isCode, loadQuestionSpec, QUESTION_TYPE_LABEL } from './questions';
import { langLabel } from './languages';

export const LOBBY_OPENS_BEFORE_MIN = 15;

export function windowClosesAt(e: { starts_at: Date | null; late_join_minutes: number; duration_minutes: number | null }): Date | null {
  if (!e.starts_at || !e.duration_minutes) return null;
  return new Date(new Date(e.starts_at).getTime() + (e.late_join_minutes + e.duration_minutes) * 60_000);
}

/** BACKEND_SPEC_PART1 §10.2 deadline formula. */
export function computeDeadline(
  e: { starts_at: Date; late_join_minutes: number; duration_minutes: number; global_extension_minutes: number },
  startedAt: Date,
  accommodationMin: number,
  liveExtensionMin: number,
): Date {
  const personal = new Date(startedAt).getTime() + e.duration_minutes * 60_000;
  const close = windowClosesAt(e)!.getTime();
  return new Date(Math.min(personal, close) + (accommodationMin + e.global_extension_minutes + liveExtensionMin) * 60_000);
}

/** Recompute deadlines for in-progress sessions after extensions / accommodation changes. */
export async function recomputeDeadlines(examId: string, studentId: string | null, db: Db = pool) {
  const e = await one(`SELECT * FROM exams WHERE id = $1`, [examId], db);
  if (!e || !e.starts_at || !e.duration_minutes) return;
  const sessions = await q(
    `SELECT s.*, COALESCE(a.extra_minutes, 0) AS acc FROM exam_sessions s
     LEFT JOIN exam_accommodations a ON a.exam_id = s.exam_id AND a.student_id = s.student_id
     WHERE s.exam_id = $1 AND s.status = 'in_progress' AND ($2::uuid IS NULL OR s.student_id = $2)`,
    [examId, studentId],
    db,
  );
  for (const s of sessions) {
    if (s.is_preview) continue;
    const d = computeDeadline(e, s.started_at, s.acc, s.live_extension_minutes);
    await q(`UPDATE exam_sessions SET deadline_at = $2 WHERE id = $1`, [s.id, d], db);
  }
}

/** Languages a student can use on a question: question ∩ exam allowed ∩ has starter code. */
export function effectiveLangs(spec: QuestionSpec, examLangs: string[]): Lang[] {
  if (!isCode(spec)) return [];
  const has = (l: Lang) => (spec.files[l]?.starter?.length ?? 0) > 0;
  const eff = spec.languages.filter((l) => (examLangs.length === 0 || examLangs.includes(l)) && has(l));
  return eff.length ? eff : spec.languages.filter(has);
}

/** Rebuild draft snapshots from the current bank versions. */
export async function refreshSnapshots(examId: string, db: Db, freeze = false) {
  const eqs = await q(`SELECT * FROM exam_questions WHERE exam_id = $1 AND snapshotted_at IS NULL`, [examId], db);
  for (const eq of eqs) {
    if (!eq.source_question_id) continue;
    const loaded = await loadQuestionSpec(eq.source_question_id, db);
    if (!loaded) continue;
    await q(`UPDATE exam_questions SET snapshot = $2, source_version = $3, snapshotted_at = $4 WHERE id = $1`, [eq.id, JSON.stringify(loaded.spec), loaded.row.version, freeze ? new Date() : null], db);
  }
}

export async function examLangs(examId: string, db: Db = pool): Promise<string[]> {
  return (await q<{ language: string }>(`SELECT language FROM exam_languages WHERE exam_id = $1 ORDER BY language`, [examId], db)).map((r) => r.language);
}

export async function examDto(examId: string, db: Db = pool) {
  const e = await one(`SELECT e.*, c.code AS course_code, c.title AS course_title FROM exams e JOIN courses c ON c.id = e.course_id WHERE e.id = $1`, [examId], db);
  if (!e) return null;
  const classIds = (await q(`SELECT class_id FROM exam_classes WHERE exam_id = $1`, [examId], db)).map((r: any) => r.class_id);
  const studentCount = await one<{ n: number }>(
    `SELECT count(DISTINCT en.student_id)::int AS n FROM enrollments en WHERE en.class_id = ANY($1::uuid[])`,
    [classIds],
    db,
  );
  const eqs = await q(`SELECT * FROM exam_questions WHERE exam_id = $1 ORDER BY position`, [examId], db);
  const acc = await q(
    `SELECT a.*, u.student_id AS student_number, u.full_name FROM exam_accommodations a JOIN users u ON u.id = a.student_id WHERE a.exam_id = $1 ORDER BY u.full_name`,
    [examId],
    db,
  );
  const langs = await examLangs(examId, db);
  const { initials } = await import('../auth');
  return {
    id: e.id,
    status: e.status,
    course: { id: e.course_id, code: e.course_code, title: e.course_title },
    details: {
      title: e.title,
      shortTitle: e.short_title,
      examType: e.exam_type,
      classIds,
      studentCount: studentCount!.n,
      instructionsMd: e.instructions_md,
      startsAt: e.starts_at,
      durationMinutes: e.duration_minutes,
      isPractice: e.is_practice,
      lateJoinMinutes: e.late_join_minutes,
      windowClosesAt: windowClosesAt(e),
    },
    questions: {
      items: eqs.map((x: any) => {
        const s = x.snapshot as QuestionSpec;
        return {
          examQuestionId: x.id,
          questionId: x.source_question_id,
          type: s.type ?? 'code',
          typeLabel: QUESTION_TYPE_LABEL[s.type ?? 'code'],
          position: x.position,
          title: s.title,
          topic: s.topic,
          difficulty: s.difficulty,
          languages: effectiveLangs(s, langs),
          testCount: s.tests.length,
          points: x.points,
        };
      }),
      totalPoints: eqs.reduce((a: number, x: any) => a + x.points, 0),
      questionOrder: e.question_order,
      poolSize: e.pool_size,
    },
    settings: {
      allowedLanguages: langs,
      allowRun: e.allow_run,
      showSampleTests: e.show_sample_tests,
      runHiddenOnSubmit: e.run_hidden_on_submit,
      runsPerQuestion: e.runs_per_question,
      timeLimitMs: e.time_limit_ms,
      memoryLimitMb: e.memory_limit_mb,
      autoSubmitOnTimeout: e.auto_submit_on_timeout,
      autoGradeWithTests: e.auto_grade_with_tests,
      releaseAfterReview: e.release_after_review,
      sebRequired: true,
      accommodations: acc.map((a: any) => ({ studentId: a.student_id, studentNumber: a.student_number, fullName: a.full_name, initials: initials(a.full_name), extraMinutes: a.extra_minutes })),
    },
    notify: { now: e.notify_now, reminder1h: e.notify_reminder_1h },
    publishedAt: e.published_at,
    resultsReleasedAt: e.results_released_at,
    updatedAt: e.updated_at,
  };
}

export async function publishChecks(examId: string, db: Db = pool) {
  const e = await one(`SELECT * FROM exams WHERE id = $1`, [examId], db);
  const checks: { key: string; status: 'ok' | 'warn' | 'error'; message: string }[] = [];
  const eqs = await q(`SELECT * FROM exam_questions WHERE exam_id = $1 ORDER BY position`, [examId], db);
  const langs = await examLangs(examId, db);
  const classes = await one<{ n: number }>(`SELECT count(*)::int AS n FROM exam_classes WHERE exam_id = $1`, [examId], db);

  if (!e.starts_at || !e.duration_minutes) checks.push({ key: 'schedule', status: 'error', message: 'Set a start date, start time and duration.' });
  else if (new Date(e.starts_at).getTime() < Date.now()) checks.push({ key: 'schedule', status: 'error', message: 'The start time is in the past.' });
  if (!classes!.n) checks.push({ key: 'classes', status: 'error', message: 'Choose at least one class.' });
  const anyCode = eqs.some((x: any) => isCode(x.snapshot as QuestionSpec));
  if (anyCode && !langs.length) checks.push({ key: 'languages', status: 'error', message: 'Allow at least one programming language.' });
  if (!eqs.length) checks.push({ key: 'questions', status: 'error', message: 'Add at least one question.' });

  let missingStarter = false;
  let totalTests = 0;
  let validated = true;
  for (const eq of eqs) {
    const s = eq.snapshot as QuestionSpec;
    if (eq.source_question_id) {
      const qrow = await one(`SELECT last_validation FROM questions WHERE id = $1`, [eq.source_question_id], db);
      if (!qrow?.last_validation?.allPassed) validated = false;
    }
    if (!isCode(s)) continue;
    totalTests += s.tests.length;
    if (!s.tests.length) checks.push({ key: `tests_${eq.position}`, status: 'error', message: `Q${eq.position} has no test cases.` });
    const allowed = s.languages.filter((l) => langs.includes(l));
    if (!allowed.length) checks.push({ key: `langs_${eq.position}`, status: 'error', message: `Q${eq.position} doesn't support any of the allowed languages.` });
    for (const l of allowed) {
      if (!(s.files[l]?.starter?.length)) {
        missingStarter = true;
        const others = allowed.filter((x) => x !== l && s.files[x]?.starter?.length).map(langLabel);
        checks.push({ key: `starter_${eq.position}_${l}`, status: 'warn', message: `Q${eq.position} has no ${langLabel(l)} starter code${others.length ? ` — students can only answer in ${others.join(', ')}` : ''}` });
      }
    }
  }
  if (anyCode && !missingStarter) checks.unshift({ key: 'starter_code', status: 'ok', message: 'Every coding question has starter code for each allowed language' });
  if (eqs.length) {
    checks.push(
      validated
        ? { key: 'reference_solutions', status: 'ok', message: anyCode ? `Answer keys set · reference solutions pass ${totalTests} / ${totalTests} tests` : 'Every question has an answer key' }
        : { key: 'reference_solutions', status: 'error', message: 'Every coding question needs validated reference solutions, and every other question an answer key. Open the question editor to fix it.' },
    );
  }
  const total = eqs.reduce((a: number, x: any) => a + x.points, 0);
  if (eqs.length) checks.push({ key: 'points_total', status: total > 0 ? 'ok' : 'error', message: total > 0 ? `Exam is worth ${total} points` : 'The exam is worth 0 points.' });
  checks.push({ key: 'launch_link', status: 'ok', message: 'Safe Exam Browser launch link ready' });
  return { canPublish: !checks.some((c) => c.status === 'error'), checks };
}
