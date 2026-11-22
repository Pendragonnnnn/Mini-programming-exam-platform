import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config';
import { one, q } from './db';
import { forbidden, HttpError, unauthorized } from './errors';

export interface AuthUser {
  id: string;
  role: 'student' | 'teacher';
  studentId: string | null;
  email: string | null;
  fullName: string;
  displayName: string | null;
  initials: string;
  title: string | null;
  isDemo: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

export const initials = (name: string) =>
  name
    .replace(/^(dr|mr|ms|mrs|prof)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .filter((c) => /[A-Z]/.test(c))
    .slice(0, 2)
    .join('') || '?';

export function toAuthUser(r: any): AuthUser {
  return {
    id: r.id,
    role: r.role,
    studentId: r.student_id,
    email: r.email,
    fullName: r.full_name,
    displayName: r.display_name,
    initials: initials(r.full_name),
    title: r.title,
    isDemo: !!r.is_demo,
  };
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

export function signAccess(u: AuthUser) {
  const exp = Math.floor(Date.now() / 1000) + config.accessTtlSec;
  const token = jwt.sign({ sub: u.id, role: u.role, sid: u.studentId, name: u.fullName, exp }, config.jwtAccessSecret, { algorithm: 'HS256' });
  return { accessToken: token, accessTokenExpiresAt: new Date(exp * 1000).toISOString() };
}

export const REFRESH_COOKIE = 'aegis_rt';

export async function issueRefresh(res: Response, userId: string, familyId: string | null, req: Request): Promise<string> {
  const raw = randomToken();
  const fam = familyId ?? crypto.randomUUID();
  const row = await one<{ id: string }>(
    `INSERT INTO refresh_tokens(user_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1,$2,$3, now() + make_interval(secs => $4), $5, $6) RETURNING id`,
    [userId, sha256(raw), fam, config.refreshTtlSec, req.get('user-agent') ?? null, req.ip ?? null],
  );
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: config.refreshTtlSec * 1000,
  });
  return row!.id;
}

/** Validates the Bearer token. Throws 401 TOKEN_EXPIRED so the client refreshes. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const hdr = req.get('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    if (!m) throw unauthorized('FORBIDDEN', 'Please sign in.');
    let payload: any;
    try {
      payload = jwt.verify(m[1]!, config.jwtAccessSecret, { algorithms: ['HS256'] });
    } catch (e: any) {
      if (e?.name === 'TokenExpiredError') throw new HttpError(401, 'TOKEN_EXPIRED', 'Your session expired.');
      throw unauthorized('FORBIDDEN', 'Please sign in again.');
    }
    const row = await one(`SELECT * FROM users WHERE id = $1 AND is_active`, [payload.sub]);
    if (!row) throw unauthorized('FORBIDDEN', 'Please sign in again.');
    if (row.is_demo) throw unauthorized('DEMO_DISABLED', 'This demo account is disabled.');
    req.user = toAuthUser(row);
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRole =
  (role: 'student' | 'teacher') =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== role) return next(forbidden('FORBIDDEN', `This page is for ${role}s.`));
    next();
  };

/** Course ids the teacher teaches. */
export async function teacherCourseIds(teacherId: string): Promise<string[]> {
  const rows = await q<{ course_id: string }>(`SELECT course_id FROM course_teachers WHERE teacher_id = $1`, [teacherId]);
  return rows.map((r) => r.course_id);
}

export async function assertTeachesCourse(teacherId: string, courseId: string) {
  const r = await one(`SELECT 1 FROM course_teachers WHERE teacher_id = $1 AND course_id = $2`, [teacherId, courseId]);
  if (!r) throw forbidden('FORBIDDEN', "You don't teach this course.");
}
