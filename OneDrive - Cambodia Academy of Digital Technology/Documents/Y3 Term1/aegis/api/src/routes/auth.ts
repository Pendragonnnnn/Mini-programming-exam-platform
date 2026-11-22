import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, issueRefresh, randomToken, REFRESH_COOKIE, sha256, signAccess, toAuthUser } from '../auth';
import { config } from '../config';
import { one, q, tx } from '../db';
import { bad, conflict, h, HttpError, invalid, unauthorized } from '../errors';
import { emailEnabled, sendMail } from '../services/mailer';
import { DEMO_STUDENT, DEMO_TEACHER, ensureDemo, ensureDemoExam } from '../services/demo';

export const authRouter = Router();

// simple in-memory login throttle: 5 failures / 15 min per identifier
const failures = new Map<string, { n: number; until: number }>();

authRouter.post(
  '/login',
  h(async (req, res) => {
    const b = z.object({ identifier: z.string().trim().min(1, 'Enter your ID or email.'), password: z.string().min(1, 'Enter your password.'), role: z.enum(['student', 'teacher']) }).parse(req.body);
    const key = b.identifier.toLowerCase();
    const f = failures.get(key);
    if (f && f.n >= 5 && f.until > Date.now()) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Wait a few minutes and try again.', undefined, { retryAfterSec: Math.ceil((f.until - Date.now()) / 1000) });
    // Demo usernames (demo mode only): demo_teacher maps to the demo teacher's internal email.
    const ident = config.demoMode && key === DEMO_TEACHER.username ? DEMO_TEACHER.email : b.identifier;
    if (config.demoMode && (key === DEMO_TEACHER.username || key === DEMO_STUDENT.username)) await ensureDemo();
    const user = await one(`SELECT * FROM users WHERE (lower(email) = lower($1) OR upper(student_id) = upper($1)) AND is_active`, [ident]);
    if (user?.is_demo && !config.demoMode) throw new HttpError(401, 'DEMO_DISABLED', 'Demo accounts are turned off on this server.');
    const ok = user && (await bcrypt.compare(b.password, user.password_hash));
    if (!ok) {
      if (user && !user.password_set_at) throw new HttpError(401, 'ACCOUNT_NOT_SET_UP', 'This account is not set up yet. Open the link your teacher sent you, or ask them to send a new one.');
      const cur = failures.get(key);
      failures.set(key, { n: (cur && cur.until > Date.now() ? cur.n : 0) + 1, until: Date.now() + 15 * 60_000 });
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'That ID or password is not right.');
    }
    failures.delete(key);
    if (user.role !== b.role) {
      throw new HttpError(403, 'ROLE_MISMATCH', user.role === 'teacher' ? 'This account is a teacher account. Switch to the Teacher tab.' : 'This account is a student account. Switch to the Student tab.');
    }
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    const u = toAuthUser(user);
    await issueRefresh(res, u.id, null, req);
    res.json({ ...signAccess(u), user: u });
  }),
);

authRouter.post(
  '/refresh',
  h(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized('REFRESH_INVALID', 'Please sign in again.');
    const out = await tx(async (c) => {
      const row = await one(`SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [sha256(raw)], c);
      if (!row) return null;
      if (row.revoked_at) {
        // reuse of a rotated token: revoke the whole family
        await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id], c);
        return null;
      }
      if (new Date(row.expires_at).getTime() < Date.now()) return null;
      const user = await one(`SELECT * FROM users WHERE id = $1 AND is_active`, [row.user_id], c);
      if (!user || (user.is_demo && !config.demoMode)) return null;
      await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id], c);
      return { user, family: row.family_id, oldId: row.id };
    });
    if (!out) {
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw unauthorized('REFRESH_INVALID', 'Please sign in again.');
    }
    const newId = await issueRefresh(res, out.user.id, out.family, req);
    await q(`UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1`, [out.oldId, newId]);
    const u = toAuthUser(out.user);
    res.json({ ...signAccess(u), user: u });
  }),
);

authRouter.post(
  '/logout',
  h(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (raw) {
      const row = await one(`SELECT family_id FROM refresh_tokens WHERE token_hash = $1`, [sha256(raw)]);
      if (row) await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.status(204).end();
  }),
);

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

authRouter.post(
  '/forgot-password',
  h(async (req, res) => {
    const b = z.object({ identifier: z.string().trim().min(1) }).parse(req.body);
    const user = await one(`SELECT id, email, full_name FROM users WHERE (lower(email) = lower($1) OR upper(student_id) = upper($1)) AND is_active`, [b.identifier]);
    if (user?.email) {
      const token = randomToken(32);
      await q(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [user.id, sha256(token)]);
      const link = `${config.appPublicUrl}/reset?token=${token}`;
      void sendMail({
        to: user.email,
        subject: `${config.appName}: reset your password`,
        title: `Hello ${user.full_name}`,
        paragraphs: ['Someone asked to reset the password of your exam account. If it was you, use the button below within 30 minutes.', "If it wasn't you, ignore this email."],
        button: { label: 'Reset password', url: link },
      });
    }
    // Same answer whether or not the account exists. Without email, students ask their teacher for a new link.
    res.status(202).json({ emailEnabled: emailEnabled() });
  }),
);

authRouter.post(
  '/reset-password',
  h(async (req, res) => {
    const b = z.object({ token: z.string().min(10), newPassword: z.string() }).parse(req.body);
    if (b.newPassword.length < 8) throw invalid('Use at least 8 characters.', { newPassword: 'Use at least 8 characters.' }, 'WEAK_PASSWORD');
    await tx(async (c) => {
      const r = await one(`SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(b.token)], c);
      if (!r) throw bad('TOKEN_INVALID', 'This reset link is invalid or expired.');
      await q(`UPDATE users SET password_hash = $2, password_set_at = now(), updated_at = now() WHERE id = $1`, [r.user_id, await bcrypt.hash(b.newPassword, 10)], c);
      // One link per person: using it retires their other pending links.
      await q(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [r.user_id], c);
      await q(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [r.id], c);
      await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [r.user_id], c);
    });
    res.status(204).end();
  }),
);

/** Who an invite / reset link belongs to (for the "set your password" page). */
authRouter.get(
  '/link-info',
  h(async (req, res) => {
    const token = String(req.query.token ?? '');
    const r = await one(
      `SELECT pr.purpose, u.full_name, u.student_id, u.role, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
      [sha256(token)],
    );
    if (!r) throw bad('TOKEN_INVALID', 'This link is invalid or expired. Ask your teacher for a new one.');
    res.json({ purpose: r.purpose, fullName: r.full_name, role: r.role, loginId: r.role === 'student' ? r.student_id : r.email });
  }),
);

// ---------------------------------------------------------------- first-run setup
authRouter.get(
  '/setup',
  h(async (_req, res) => {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'teacher'`);
    res.json({ needsSetup: n!.n === 0, appName: config.appName, emailEnabled: emailEnabled() });
  }),
);

/** Creates the very first teacher account. Disabled as soon as any teacher exists. */
authRouter.post(
  '/setup',
  h(async (req, res) => {
    const b = z
      .object({
        fullName: z.string().trim().min(1, 'Enter your name.').max(120),
        email: z.string().trim().email('Enter a valid email address.').max(200),
        password: z.string().min(8, 'Use at least 8 characters.').max(200),
      })
      .parse(req.body);
    const user = await tx(async (c) => {
      await q(`LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, [], c);
      const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'teacher'`, [], c);
      if (n!.n > 0) throw conflict('SETUP_DONE', 'Setup is already complete. Sign in instead.');
      return one(
        `INSERT INTO users(role, email, full_name, password_hash, password_set_at, last_login_at) VALUES ('teacher',$1,$2,$3, now(), now()) RETURNING *`,
        [b.email, b.fullName, await bcrypt.hash(b.password, 10)],
        c,
      );
    });
    const u = toAuthUser(user);
    await issueRefresh(res, u.id, null, req);
    res.status(201).json({ ...signAccess(u), user: u });
  }),
);

// ---------------------------------------------------------------- demo testing mode (development only)
/** Is demo mode on? The login page shows the demo buttons only when it is. */
authRouter.get(
  '/demo',
  h(async (_req, res) => {
    res.json(
      config.demoMode
        ? { enabled: true, accounts: { student: { username: DEMO_STUDENT.username, password: DEMO_STUDENT.password }, teacher: { username: DEMO_TEACHER.username, password: DEMO_TEACHER.password } } }
        : { enabled: false },
    );
  }),
);

/** One-click demo sign-in. Returns 404 unless DEMO_MODE=true and NODE_ENV=development. */
authRouter.post(
  '/demo',
  h(async (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const b = z.object({ role: z.enum(['student', 'teacher']) }).parse(req.body);
    const d = await ensureDemo();
    if (b.role === 'student') await ensureDemoExam();
    const user = await one(`UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING *`, [b.role === 'teacher' ? d.teacherId : d.studentId]);
    const u = toAuthUser(user);
    await issueRefresh(res, u.id, null, req);
    res.json({ ...signAccess(u), user: u });
  }),
);
