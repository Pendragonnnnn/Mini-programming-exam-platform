import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string>,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const bad = (code: string, message: string, details?: Record<string, unknown>) => new HttpError(400, code, message, undefined, details);
export const unauthorized = (code = 'FORBIDDEN', message = 'Please sign in again.') => new HttpError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = "You don't have access to this.", details?: Record<string, unknown>) => new HttpError(403, code, message, undefined, details);
export const notFound = (code = 'NOT_FOUND', message = 'Not found.') => new HttpError(404, code, message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new HttpError(409, code, message, undefined, details);
export const invalid = (message: string, fieldErrors: Record<string, string> = {}, code = 'VALIDATION_FAILED', details?: Record<string, unknown>) =>
  new HttpError(422, code, message, fieldErrors, details);

export function zodToFieldErrors(e: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of e.issues) {
    const key = i.path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${p}` : String(p)), '');
    if (!out[key || '_']) out[key || '_'] = i.message;
  }
  return out;
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as any).requestId ?? 'req_' + crypto.randomBytes(6).toString('hex');
  if (err instanceof ZodError) {
    const fe = zodToFieldErrors(err);
    return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: Object.values(fe)[0] ?? 'Check the highlighted fields.', fieldErrors: fe, requestId } });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, fieldErrors: err.fieldErrors, details: err.details, requestId } });
  }
  if ((err as any)?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'The request is too large.', requestId } });
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON.', requestId } });
  }
  // Database down / unreachable / wrong credentials: say so instead of a bare 500.
  const code = (err as any)?.code;
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '57P01', '57P03', '3D000', '28P01', '28000'].includes(code)) {
    console.error(`[${requestId}] database problem:`, (err as any)?.message);
    const why = code === '3D000' ? 'the database does not exist' : code === '28P01' || code === '28000' ? 'the database user or password is wrong' : 'PostgreSQL is not running or not reachable';
    return res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: `The server can't use its database (${why}). Check DATABASE_URL and that PostgreSQL is running.`, requestId } });
  }
  console.error(`[${requestId}]`, err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on the server. Try again.', requestId } });
}
