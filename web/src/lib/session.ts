import { api, ApiError } from '../api/client';

/**
 * The exam session token (X-Exam-Session) is kept in sessionStorage per exam so a page reload
 * reuses it instead of calling /start again (which would look like a second device).
 */
const key = (examId: string) => `aegis-session:${examId}`;

export function getToken(examId: string): string | null {
  try {
    return window.sessionStorage.getItem(key(examId));
  } catch {
    return null;
  }
}

export function setToken(examId: string, token: string) {
  try {
    window.sessionStorage.setItem(key(examId), token);
  } catch {
    /* storage blocked: the in-memory copy still works for this page */
  }
}

export function clearToken(examId: string) {
  try {
    window.sessionStorage.removeItem(key(examId));
  } catch {
    /* ignore */
  }
}

export async function startSession(examId: string, integrityAccepted: boolean) {
  const r = await api(`/student/exams/${examId}/start`, { method: 'POST', body: { integrityAccepted, client: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: `${window.screen.width}x${window.screen.height}` } } });
  setToken(examId, r.sessionToken);
  return r;
}

/**
 * Use the stored token if it is still valid, else resume via /start. Throws ApiError for real problems.
 * Concurrent callers (e.g. React running an effect twice) share one request, so we never start two
 * sessions at once — the second would look like "opened on another device".
 */
const inflight = new Map<string, Promise<string>>();
export function ensureSession(examId: string): Promise<string> {
  let p = inflight.get(examId);
  if (!p) {
    p = ensureSessionOnce(examId).finally(() => setTimeout(() => inflight.delete(examId), 0));
    inflight.set(examId, p);
  }
  return p;
}

async function ensureSessionOnce(examId: string): Promise<string> {
  const t = getToken(examId);
  if (t) {
    try {
      await api(`/student/exams/${examId}/heartbeat`, { method: 'POST', body: { online: true }, examSession: t });
      return t;
    } catch (e) {
      if (!(e instanceof ApiError) || !['SESSION_TAKEN_OVER', 'SESSION_INVALID'].includes(e.code)) throw e;
    }
  }
  const r = await startSession(examId, false);
  return r.sessionToken;
}
