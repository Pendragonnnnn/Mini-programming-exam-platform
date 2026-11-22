import 'dotenv/config';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name}`);
  return v;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const isProd = process.env.NODE_ENV === 'production';
/** Demo testing mode: needs BOTH DEMO_MODE=true and NODE_ENV=development. Never on in production. */
const demoRequested = bool(process.env.DEMO_MODE, false);
const demoMode = demoRequested && process.env.NODE_ENV === 'development';

export const config = {
  isProd,
  demoRequested,
  demoMode,
  port: int(process.env.PORT, 4000),
  databaseUrl: req('DATABASE_URL', 'postgres://aegis:aegis@127.0.0.1:5432/aegis'),
  jwtAccessSecret: req('JWT_ACCESS_SECRET', isProd ? undefined : 'dev-access-secret-change-me'),
  accessTtlSec: int(process.env.JWT_ACCESS_TTL_SEC, 15 * 60),
  refreshTtlSec: int(process.env.JWT_REFRESH_TTL_SEC, 12 * 3600),
  corsOrigin: process.env.CORS_ORIGIN ?? '',
  appPublicUrl: (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, ''),

  runner: (process.env.RUNNER ?? 'local') as 'local' | 'judge0',
  judge0Url: process.env.JUDGE0_URL ?? 'http://judge0-server:2358',
  judge0Token: process.env.JUDGE0_AUTH_TOKEN ?? '',
  judge0MultiFileLang: int(process.env.JUDGE0_LANG_MULTIFILE, 89),
  runMaxConcurrency: int(process.env.RUN_MAX_CONCURRENCY, 4),
  runRateLimitPerMin: int(process.env.RUN_RATE_LIMIT_PER_MIN, 20),

  sebRequired: bool(process.env.SEB_REQUIRED, isProd),
  sebConfigKey: process.env.SEB_CONFIG_KEY ?? '',
  sebBrowserExamKeys: (process.env.SEB_BROWSER_EXAM_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  aiProvider: (process.env.AI_PROVIDER ?? 'heuristic') as 'none' | 'heuristic' | 'ollama',
  aiBaseUrl: process.env.AI_BASE_URL ?? 'http://ollama:11434',
  aiModel: process.env.AI_MODEL ?? 'qwen2.5-coder:7b',

  appName: process.env.APP_NAME ?? 'Aegis Exam',
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: int(process.env.SMTP_PORT, 587),
  smtpSecure: bool(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  smtpFrom: process.env.SMTP_FROM ?? '',
  inviteTtlDays: int(process.env.INVITE_TTL_DAYS, 14),

  auditRetentionDays: int(process.env.AUDIT_RETENTION_DAYS, 730),
  jobsEnabled: bool(process.env.JOBS_ENABLED, true),
  flagAfterSwitches: 2,
  autoSubmitAfterSwitches: 5,
  graceSeconds: 30,
};
