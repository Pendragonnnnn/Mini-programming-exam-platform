import { useAuthStore } from '../stores/auth';
import { clock } from '../stores/clock';

const BASE = '/api';

export interface ApiErrorBody {
  error: { code: string; message: string; fieldErrors?: Record<string, string>; details?: Record<string, any>; requestId?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: Record<string, string>;
  readonly details: Record<string, any>;
  readonly method: string;
  readonly path: string;
  readonly statusText: string;
  constructor(status: number, body: ApiErrorBody | null, method: string, path: string, statusText: string) {
    super(body?.error.message ?? `${method} ${BASE}${path} · ${status} ${statusText}`);
    this.status = status;
    this.code = body?.error.code ?? (status >= 500 ? 'INTERNAL' : 'NOT_FOUND');
    this.fieldErrors = body?.error.fieldErrors ?? {};
    this.details = body?.error.details ?? {};
    this.method = method;
    this.path = path;
    this.statusText = statusText;
  }
  /** Mono hint shown on error cards, e.g. "GET /api/teacher/dashboard · 503 Service Unavailable". */
  get hint() {
    return `${this.method} ${BASE}${this.path.split('?')[0]} · ${this.status} ${this.statusText}`.trim();
  }
}

export class NetworkError extends Error {
  constructor(readonly method: string, readonly path: string) {
    super("The server didn't respond. Check your connection, then try again.");
  }
  get hint() {
    return `${this.method} ${BASE}${this.path.split('?')[0]} · no response`;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Exam session token (X-Exam-Session) for student exam endpoints. */
  examSession?: string | null;
  signal?: AbortSignal;
  keepalive?: boolean;
  raw?: boolean;
}

let refreshing: Promise<boolean> | null = null;

export function refreshAccessToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!res.ok) return false;
        useAuthStore.getState().setSession(await res.json());
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  const sp = new URLSearchParams();
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const qs = sp.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ''}`;
}

export async function api<T = any>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = useAuthStore.getState().accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.examSession) headers['X-Exam-Session'] = opts.examSession;
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new NetworkError(method, path);
  }
  const st = res.headers.get('X-Server-Time');
  if (st) clock.observe(st, performance.now() - started);

  if (res.status === 401 && !retried) {
    let body: ApiErrorBody | null = null;
    try {
      body = await res.clone().json();
    } catch {
      /* ignore */
    }
    if (body?.error.code === 'TOKEN_EXPIRED' || (!token && body?.error.code === 'FORBIDDEN')) {
      if (await refreshAccessToken()) return api<T>(path, opts, true);
    }
    if (body?.error.code !== 'SESSION_INVALID') useAuthStore.getState().clear();
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = await res.json();
    } catch {
      /* non JSON */
    }
    if (!body && [500, 502, 503, 504].includes(res.status)) {
      // The dev server (Vite) answers 500 with an empty body when the API isn't running.
      body = { error: { code: 'API_UNREACHABLE', message: "Can't reach the API server. Start it (cd api, then npm run dev) and make sure PostgreSQL is running." } } as ApiErrorBody;
    }
    throw new ApiError(res.status, body, method, path, res.statusText);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function download(path: string, fallbackName: string) {
  const res = await api<Response>(path, { raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof NetworkError) return e.message;
  return 'Something went wrong. Try again.';
}
