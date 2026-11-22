import { createStore, del, entries, get, set } from 'idb-keyval';

/**
 * IndexedDB persistence so students never lose code on Wi-Fi drops or reloads.
 *  - answers: latest local edits per session/question/language (+ client timestamp)
 *  - outbox:  saves and proctor events that could not reach the server yet, replayed in order
 */
const answersStore = createStore('aegis-answers', 'answers');
const outboxStore = createStore('aegis-outbox', 'outbox');

export interface LocalAnswer {
  files: Record<string, string>;
  clientSavedAt: string;
  synced: boolean;
}

const aKey = (sessionId: string, qid: string, lang: string) => `${sessionId}:${qid}:${lang}`;

export async function putLocal(sessionId: string, qid: string, lang: string, a: LocalAnswer) {
  try {
    await set(aKey(sessionId, qid, lang), a, answersStore);
  } catch {
    /* private mode / quota: fall back to memory only */
  }
}

export async function getLocal(sessionId: string, qid: string, lang: string): Promise<LocalAnswer | undefined> {
  try {
    return await get(aKey(sessionId, qid, lang), answersStore);
  } catch {
    return undefined;
  }
}

export async function clearLocal(sessionId: string) {
  try {
    const all = await entries<string, LocalAnswer>(answersStore);
    await Promise.all(all.filter(([k]) => k.startsWith(`${sessionId}:`)).map(([k]) => del(k, answersStore)));
    const ob = await entries<string, OutboxItem>(outboxStore);
    await Promise.all(ob.filter(([, v]) => v.sessionId === sessionId).map(([k]) => del(k, outboxStore)));
  } catch {
    /* ignore */
  }
}

export type OutboxItem =
  | { kind: 'save'; sessionId: string; examQuestionId: string; body: { language?: string | null; files?: Record<string, string>; response?: { selected?: string[]; text?: string }; deletedFiles?: string[]; baseRevision: number; clientSavedAt: string } }
  | { kind: 'events'; sessionId: string; events: { type: string; occurredAt: string; durationMs?: number | null; detail?: Record<string, unknown> }[] };

let seq = 0;
export async function enqueue(item: OutboxItem) {
  const k = `${Date.now().toString().padStart(15, '0')}-${(seq++).toString().padStart(6, '0')}`;
  try {
    await set(k, item, outboxStore);
  } catch {
    /* ignore */
  }
}

export async function outbox(sessionId: string): Promise<[string, OutboxItem][]> {
  try {
    const all = await entries<string, OutboxItem>(outboxStore);
    return all.filter(([, v]) => v.sessionId === sessionId).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

export async function removeOutbox(keys: string[]) {
  try {
    await Promise.all(keys.map((k) => del(k, outboxStore)));
  } catch {
    /* ignore */
  }
}
