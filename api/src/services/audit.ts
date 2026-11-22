import type { Db } from '../db';
import { pool, q } from '../db';
import type { AuthUser } from '../auth';

export type AuditCategory = 'publish' | 'grade_change' | 'lockdown' | 'settings';

export async function audit(
  e: {
    actor: AuthUser | null;
    category: AuditCategory;
    action: string;
    examId?: string | null;
    courseId?: string | null;
    target: string;
    details: string;
    meta?: unknown;
  },
  db: Db = pool,
) {
  const label = e.actor ? (e.actor.role === 'teacher' ? e.actor.fullName : e.actor.fullName) : 'System';
  const role = e.actor ? (e.actor.role === 'teacher' ? 'Teacher' : 'Student') : 'Automatic';
  await q(
    `INSERT INTO audit_events(actor_id, actor_label, actor_role, category, action, exam_id, course_id, target_label, details, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.actor?.id ?? null, label, role, e.category, e.action, e.examId ?? null, e.courseId ?? null, e.target, e.details, e.meta ? JSON.stringify(e.meta) : null],
    db,
  );
}

export async function notify(
  userIds: string[],
  n: { type: string; title: string; actorName?: string | null; link?: string | null },
  db: Db = pool,
) {
  if (!userIds.length) return;
  await q(
    `INSERT INTO notifications(user_id, type, title, actor_name, link)
     SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) AS u`,
    [userIds, n.type, n.title, n.actorName ?? null, n.link ?? null],
    db,
  );
}

export async function courseTeacherIds(courseId: string, db: Db = pool): Promise<string[]> {
  return (await q<{ teacher_id: string }>(`SELECT teacher_id FROM course_teachers WHERE course_id = $1`, [courseId], db)).map((r) => r.teacher_id);
}
