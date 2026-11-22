import { config } from './config';
import { one, q, tx } from './db';
import { notify } from './services/audit';
import { processAiQueue, submitSession } from './services/grading';
import { kick, recoverStuckRuns } from './services/runs';

/**
 * In-process scheduler (v1). Every query is idempotent and uses row locks / conditional updates,
 * so running several API processes is safe.
 */
async function lifecycleTick() {
  // scheduled -> live
  await q(`UPDATE exams SET status = 'live' WHERE status = 'scheduled' AND starts_at <= now() AND NOT is_practice`);

  // auto-submit sessions whose deadline (+ grace) has passed
  const due = await q<{ id: string }>(
    `SELECT id FROM exam_sessions WHERE status = 'in_progress' AND deadline_at < now() - make_interval(secs => $1) LIMIT 200`,
    [config.graceSeconds],
  );
  for (const s of due) {
    try {
      await tx((c) => submitSession(s.id, 'timeout', null, c));
    } catch (e) {
      console.error('[jobs] auto-submit failed', s.id, e);
    }
  }
  if (due.length) kick();

  // live -> grading once the window (+ all extensions) has closed and nobody is still coding
  await q(
    `UPDATE exams e SET status = 'grading', ended_at = now()
     WHERE e.status = 'live' AND NOT e.is_practice
       AND e.starts_at + make_interval(mins => e.late_join_minutes + e.duration_minutes + e.global_extension_minutes) < now()
       AND NOT EXISTS (SELECT 1 FROM exam_sessions s WHERE s.exam_id = e.id AND s.status = 'in_progress')`,
  );
}

async function minuteTick() {
  await recoverStuckRuns();
  // 1-hour reminders
  const remind = await q(
    `UPDATE exams SET reminder_sent_at = now()
     WHERE status = 'scheduled' AND notify_reminder_1h AND reminder_sent_at IS NULL AND starts_at - interval '1 hour' <= now() AND starts_at > now()
     RETURNING id, title`,
  );
  for (const e of remind) {
    const students = (await q(`SELECT DISTINCT en.student_id FROM exam_classes ec JOIN enrollments en ON en.class_id = ec.class_id WHERE ec.exam_id = $1`, [e.id])).map((r: any) => r.student_id);
    await notify(students, { type: 'exam_reminder', title: `${e.title} starts in 1 hour`, link: '/student' });
  }
  // audit retention
  await q(`DELETE FROM audit_events WHERE occurred_at < now() - make_interval(days => $1)`, [config.auditRetentionDays]);
  // re-queue AI suggestions stuck in "running" (e.g. after a restart)
  await q(`UPDATE ai_suggestions SET status = 'queued' WHERE status = 'running' AND created_at < now() - interval '5 minutes'`);
}

let started = false;
export function startJobs() {
  if (started || !config.jobsEnabled) return;
  started = true;
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => console.error(`[jobs] ${name}`, e));
  setInterval(safe('kick', async () => kick()), 2000);
  setInterval(safe('ai', processAiQueue), 3000);
  setInterval(safe('lifecycle', lifecycleTick), 5000);
  setInterval(safe('minute', minuteTick), 60_000);
  safe('lifecycle', lifecycleTick)();
  safe('minute', minuteTick)();
  void one;
}
