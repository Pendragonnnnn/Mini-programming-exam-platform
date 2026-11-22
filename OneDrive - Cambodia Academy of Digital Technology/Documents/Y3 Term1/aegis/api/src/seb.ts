import type { Request } from 'express';
import crypto from 'node:crypto';
import { config } from './config';
import { forbidden } from './errors';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Absolute URL as SEB hashed it (APP_PUBLIC_URL origin + original path/query, no fragment). */
export function absoluteUrl(req: Request): string {
  return config.appPublicUrl + req.originalUrl;
}

export function sebVersion(req: Request): string | null {
  const ua = req.get('user-agent') ?? '';
  const m = /SEB\/([\d.]+)/i.exec(ua);
  return m ? m[1]! : null;
}

/**
 * Verifies Safe Exam Browser request headers (BACKEND_SPEC_PART1 §2.3).
 * ConfigKeyHash = SHA256(url + ConfigKey); RequestHash = SHA256(url + BrowserExamKey).
 */
export function verifySeb(req: Request, opts: { required: boolean }): { verified: boolean; version: string | null } {
  const version = sebVersion(req);
  if (!opts.required || !config.sebRequired) return { verified: false, version };
  const url = absoluteUrl(req);
  const ckHash = (req.get('x-safeexambrowser-configkeyhash') ?? '').toLowerCase();
  const rqHash = (req.get('x-safeexambrowser-requesthash') ?? '').toLowerCase();
  let ok = false;
  if (ckHash && config.sebConfigKey && ckHash === sha(url + config.sebConfigKey)) ok = true;
  if (!ok && rqHash) ok = config.sebBrowserExamKeys.some((k) => rqHash === sha(url + k));
  if (!ok) throw forbidden('SEB_REQUIRED', 'Open this exam in Safe Exam Browser.');
  return { verified: true, version };
}
