import { Router } from 'express';
import { authenticate } from '../auth';
import { one, q } from '../db';
import { h } from '../errors';
import { runnerHealth } from '../services/runner';
import { ENABLED_LANGS, LANGS } from '../services/languages';
import { QUESTION_TYPE_LABEL } from '../services/questions';

export const sharedRouter = Router();

sharedRouter.get('/health', (_req, res) => {
  res.json({ ok: true, serverNow: new Date().toISOString() });
});

sharedRouter.get(
  '/health/runner',
  h(async (_req, res) => {
    const hlt = await runnerHealth();
    const ql = await one<{ n: number }>(`SELECT count(*)::int AS n FROM code_runs WHERE status IN ('queued','running')`);
    res.json({ ok: hlt.ok, queueLength: ql!.n, languages: ENABLED_LANGS, detail: hlt.detail });
  }),
);

sharedRouter.get('/meta/languages', (_req, res) => {
  res.json({
    items: ENABLED_LANGS.map((l) => ({ id: l, label: LANGS[l].label, exts: LANGS[l].exts, entry: LANGS[l].entry, starter: LANGS[l].starter, callTests: LANGS[l].callTests, enabled: true })),
    questionTypes: Object.entries(QUESTION_TYPE_LABEL).map(([id, label]) => ({ id, label })),
  });
});

sharedRouter.get(
  '/notifications',
  authenticate,
  h(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === 'true';
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = await q(
      `SELECT * FROM notifications WHERE user_id = $1 AND ($2::bool = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [req.user!.id, unreadOnly, pageSize, (page - 1) * pageSize],
    );
    const total = await one<{ n: number; u: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE read_at IS NULL)::int AS u FROM notifications WHERE user_id = $1`,
      [req.user!.id],
    );
    res.json({
      items: rows.map((n: any) => ({ id: n.id, type: n.type, title: n.title, actorName: n.actor_name, link: n.link, createdAt: n.created_at, read: !!n.read_at })),
      page,
      pageSize,
      total: total!.n,
      unreadCount: total!.u,
    });
  }),
);

sharedRouter.post(
  '/notifications/read-all',
  authenticate,
  h(async (req, res) => {
    await q(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user!.id]);
    res.status(204).end();
  }),
);
