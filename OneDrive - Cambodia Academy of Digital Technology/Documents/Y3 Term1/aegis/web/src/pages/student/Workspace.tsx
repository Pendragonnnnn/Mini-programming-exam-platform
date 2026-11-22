import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, NetworkError } from '../../api/client';
import { CodeEditor } from '../../components/CodeEditor';
import { Icon } from '../../components/Icon';
import { Logo, ThemeButton } from '../../components/Shell';
import { DIFF_CLS, DIFF_LABEL, ErrorState, langLabel, Markdown, QTYPE_LABEL, Seg, toast, type Lang } from '../../components/ui';
import { clearLocal, enqueue, getLocal, outbox, putLocal, removeOutbox } from '../../lib/offline';
import { clearToken, ensureSession } from '../../lib/session';
import { useAuthStore } from '../../stores/auth';
import { clock, fmtClock } from '../../stores/clock';

type Response = { selected?: string[]; text?: string };
type Files = Record<string, string>;
const FINAL = new Set(['completed', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error']);

export function Workspace() {
  const { examId = '' } = useParams();
  const nav = useNavigate();
  const isTeacher = useAuthStore((s) => s.user?.role === 'teacher');

  const [ws, setWs] = useState<any>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [qid, setQid] = useState<string>('');
  const [langs, setLangs] = useState<Record<string, Lang>>({});
  const [edits, setEdits] = useState<Record<string, Partial<Record<Lang, Files>>>>({});
  const [activeFile, setActiveFile] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, any>>({});
  const [consoleRun, setConsoleRun] = useState<Record<string, any>>({});
  const [sample, setSample] = useState<Record<string, { passed: number; total: number; started: boolean }>>({});
  const [bottom, setBottom] = useState<'t' | 'c' | 'i'>('t');
  const [stdin, setStdin] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [banner, setBanner] = useState<{ kind: 'reconnected' | 'restored'; text: string } | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [saveState, setSaveState] = useState<{ saving: boolean; at: number | null }>({ saving: false, at: null });
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [responses, setResponses] = useState<Record<string, Response>>({});
  const responsesRef = useRef(responses);
  responsesRef.current = responses;
  const dirtyChoice = useRef<Set<string>>(new Set());

  const token = useRef<string>('');
  const dirty = useRef<Record<string, { lang: Lang; paths: Set<string>; deleted: Set<string> }>>({});
  const revisions = useRef<Record<string, number>>({});
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const langsRef = useRef(langs);
  langsRef.current = langs;
  const lastCopied = useRef('');
  const hbFailures = useRef(0);
  const finished = useRef(false);
  const onlineRef = useRef(true);
  const lastAnnouncement = useRef<string | null>(null);
  const sessionId = ws?.session?.id as string | undefined;
  const practiceLike = !!(ws?.exam?.isPractice || ws?.exam?.isPreview || isTeacher);

  const goResults = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    clearToken(examId);
    if (sessionId) clearLocal(sessionId);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    nav(isTeacher ? '/teacher' : ws?.exam?.isPractice ? '/student' : `/student/results/${examId}`, { replace: true });
  }, [examId, isTeacher, nav, sessionId, ws]);

  const handleApiError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        if (e.code === 'SESSION_TAKEN_OVER') return setTakenOver(true), true;
        if (e.code === 'ALREADY_SUBMITTED' || e.code === 'TIME_UP') return goResults(), true;
      }
      return false;
    },
    [goResults],
  );

  // ---------------------------------------------------------------- bootstrap
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      token.current = await ensureSession(examId);
      const data = await api(`/student/exams/${examId}/workspace`, { examSession: token.current });
      const e: Record<string, Partial<Record<Lang, Files>>> = {};
      const l: Record<string, Lang> = {};
      const smp: Record<string, any> = {};
      const res: Record<string, any> = {};
      const rsp: Record<string, Response> = {};
      let restoredAt: string | null = null;
      for (const q of data.questions) {
        if (q.type && q.type !== 'code') {
          rsp[q.examQuestionId] = q.answer.response ?? {};
          revisions.current[q.examQuestionId] = q.answer.revision;
          smp[q.examQuestionId] = { passed: 0, total: 0, started: !!(q.answer.response?.selected?.length || q.answer.response?.text?.trim()) };
          continue;
        }
        e[q.examQuestionId] = { ...(q.answer.files ?? {}) };
        l[q.examQuestionId] = q.answer.language;
        smp[q.examQuestionId] = q.sampleStatus;
        if (q.lastRun) res[q.examQuestionId] = q.lastRun;
        revisions.current[q.examQuestionId] = q.answer.revision;
        // Restore newer local work that never reached the server (offline / crash).
        for (const lang of q.languages as Lang[]) {
          const local = await getLocal(data.session.id, q.examQuestionId, lang);
          if (!local || local.synced) continue;
          if (q.answer.serverSavedAt && new Date(local.clientSavedAt) <= new Date(q.answer.serverSavedAt)) continue;
          e[q.examQuestionId]![lang] = { ...(e[q.examQuestionId]![lang] ?? {}), ...local.files };
          dirty.current[q.examQuestionId] = { lang, paths: new Set(Object.keys(local.files)), deleted: new Set() };
          if (!restoredAt || local.clientSavedAt > restoredAt) restoredAt = local.clientSavedAt;
        }
      }
      setEdits(e);
      setResponses(rsp);
      setLangs(l);
      setSample(smp);
      setResults(res);
      setDeadline(data.session.deadlineAt);
      setAnnouncements(data.announcements);
      lastAnnouncement.current = data.announcements.at(-1)?.id ?? null;
      const cur = data.questions.find((q: any) => q.position === data.session.currentQuestionPosition) ?? data.questions[0];
      setQid(cur?.examQuestionId ?? '');
      setWs(data);
      if (restoredAt) {
        const left = Math.round((new Date(data.session.deadlineAt).getTime() - clock.now()) / 1000);
        setBanner({ kind: 'restored', text: `Welcome back. We restored your code from ${new Date(restoredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} and your remaining time (${fmtClock(left)}).` });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INTEGRITY_NOT_ACCEPTED') return nav(`/student/exams/${examId}/lobby`, { replace: true });
      if (err instanceof ApiError && err.code === 'ALREADY_SUBMITTED') return nav(isTeacher ? '/teacher' : `/student/results/${examId}`, { replace: true });
      setLoadError(err);
    }
  }, [examId, isTeacher, nav]);

  useEffect(() => {
    load();
  }, [load]);

  const question = useMemo(() => ws?.questions.find((q: any) => q.examQuestionId === qid), [ws, qid]);
  const lang: Lang = (question && (langs[qid] ?? question.languages[0])) as Lang;
  const templates: any[] = question?.templates?.[lang] ?? [];
  const filePath = activeFile[`${qid}:${lang}`] ?? templates.find((f) => !f.readOnly)?.path ?? templates[0]?.path;
  const file = templates.find((f) => f.path === filePath) ?? templates[0];
  const code = file ? (file.readOnly ? file.content : edits[qid]?.[lang]?.[file.path] ?? file.content) : '';

  const fullFiles = useCallback(
    (q: any, l: Lang): Files => {
      const out: Files = {};
      for (const f of q.templates[l] ?? []) out[f.path] = f.readOnly ? f.content : editsRef.current[q.examQuestionId]?.[l]?.[f.path] ?? f.content;
      return out;
    },
    [],
  );

  // ---------------------------------------------------------------- saving
  const flush = useCallback(
    async (opts: { keepalive?: boolean } = {}) => {
      if (!ws || finished.current) return;
      const entriesToSave = Object.entries(dirty.current);
      const choiceToSave = [...dirtyChoice.current];
      if (!entriesToSave.length && !choiceToSave.length) return;
      setSaveState((s) => ({ ...s, saving: true }));
      for (const q of choiceToSave) {
        dirtyChoice.current.delete(q);
        const body = { response: responsesRef.current[q] ?? {}, baseRevision: revisions.current[q] ?? 0, clientSavedAt: new Date(clock.now()).toISOString(), currentQuestionPosition: ws.questions.find((x: any) => x.examQuestionId === q)?.position };
        if (!onlineRef.current) {
          await enqueue({ kind: 'save', sessionId: ws.session.id, examQuestionId: q, body });
          continue;
        }
        try {
          const r = await api(`/student/exams/${examId}/answers/${q}`, { method: 'PUT', body, examSession: token.current, keepalive: opts.keepalive });
          revisions.current[q] = r.revision;
        } catch (e) {
          if (handleApiError(e)) return;
          if (e instanceof NetworkError) {
            await enqueue({ kind: 'save', sessionId: ws.session.id, examQuestionId: q, body });
            goOffline();
          } else toast.error(e);
        }
      }
      for (const [q, d] of entriesToSave) {
        const files: Files = {};
        for (const p of d.paths) {
          const v = editsRef.current[q]?.[d.lang]?.[p];
          if (v !== undefined) files[p] = v;
        }
        const body = { language: d.lang, files, deletedFiles: [...d.deleted], baseRevision: revisions.current[q] ?? 0, clientSavedAt: new Date(clock.now()).toISOString(), currentQuestionPosition: ws.questions.find((x: any) => x.examQuestionId === q)?.position };
        delete dirty.current[q];
        if (!onlineRef.current) {
          await enqueue({ kind: 'save', sessionId: ws.session.id, examQuestionId: q, body });
          continue;
        }
        try {
          const r = await api(`/student/exams/${examId}/answers/${q}`, { method: 'PUT', body, examSession: token.current, keepalive: opts.keepalive });
          revisions.current[q] = r.revision;
          await putLocal(ws.session.id, q, d.lang, { files: editsRef.current[q]?.[d.lang] ?? {}, clientSavedAt: body.clientSavedAt, synced: true });
        } catch (e) {
          if (handleApiError(e)) return;
          if (e instanceof NetworkError) {
            await enqueue({ kind: 'save', sessionId: ws.session.id, examQuestionId: q, body });
            goOffline();
          } else {
            toast.error(e);
          }
        }
      }
      setSaveState({ saving: false, at: Date.now() });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, examId, handleApiError],
  );

  const markDirty = (q: string, l: Lang, path: string | null, deleted?: string[]) => {
    const d = dirty.current[q]?.lang === l ? dirty.current[q]! : { lang: l, paths: new Set<string>(), deleted: new Set<string>() };
    if (path) {
      d.paths.add(path);
      d.deleted.delete(path);
    }
    for (const p of deleted ?? []) {
      d.deleted.add(p);
      d.paths.delete(p);
    }
    dirty.current[q] = d;
  };

  const onEdit = (v: string) => {
    if (!file || file.readOnly || finished.current) return;
    setEdits((prev) => {
      const next = { ...prev, [qid]: { ...(prev[qid] ?? {}), [lang]: { ...(prev[qid]?.[lang] ?? {}), [file.path]: v } } };
      if (ws) putLocal(ws.session.id, qid, lang, { files: next[qid]![lang]!, clientSavedAt: new Date(clock.now()).toISOString(), synced: false });
      return next;
    });
    markDirty(qid, lang, file.path);
    setSample((s) => ({ ...s, [qid]: { ...(s[qid] ?? { passed: 0, total: 0 }), started: true } }));
  };

  const flushRef = useRef(flush);
  flushRef.current = flush;
  const onChoice = (q: string, r: Response) => {
    if (finished.current || takenOver) return;
    setResponses((x) => ({ ...x, [q]: r }));
    responsesRef.current = { ...responsesRef.current, [q]: r };
    dirtyChoice.current.add(q);
    setSample((x) => ({ ...x, [q]: { passed: 0, total: 0, started: !!(r.selected?.length || r.text?.trim()) } }));
    // choices save right away; typed answers save after a short pause
    if (r.text === undefined) flushRef.current();
    else {
      window.clearTimeout((onChoice as any).t);
      (onChoice as any).t = window.setTimeout(() => flushRef.current(), 1200);
    }
  };

  // ---------------------------------------------------------------- connectivity
  const goOffline = () => {
    if (!onlineRef.current) return;
    onlineRef.current = false;
    setOnline(false);
    setBanner(null);
  };

  const reconnect = useCallback(async () => {
    if (!ws || finished.current) return;
    try {
      const items = await outbox(ws.session.id);
      const saves = items.filter(([, i]) => i.kind === 'save');
      const events = items.filter(([, i]) => i.kind === 'events');
      if (saves.length) {
        const r = await api(`/student/exams/${examId}/answers/sync`, { method: 'POST', examSession: token.current, body: { items: saves.map(([, i]: any) => ({ ...i.body, examQuestionId: i.examQuestionId })) } });
        for (const x of r.results) if (x.revision) revisions.current[x.examQuestionId] = x.revision;
        if (r.results.some((x: any) => x.error === 'TIME_UP')) toast.warn('Some changes arrived after time ended and were not saved.');
      }
      if (events.length) {
        await api(`/student/exams/${examId}/events`, { method: 'POST', examSession: token.current, body: { events: events.flatMap(([, i]: any) => i.events) } }).catch(() => undefined);
      }
      await removeOutbox(items.map(([k]) => k));
      onlineRef.current = true;
      setOnline(true);
      hbFailures.current = 0;
      await flush();
      const hb = await heartbeat();
      if (hb) {
        const left = Math.round((new Date(hb.deadlineAt).getTime() - clock.now()) / 1000);
        setBanner({ kind: 'reconnected', text: `Reconnected. Your code is synced and the timer is correct: ${fmtClock(left)} left.` });
        setTimeout(() => setBanner((b) => (b?.kind === 'reconnected' ? null : b)), 8000);
      }
    } catch (e) {
      if (!handleApiError(e) && !(e instanceof NetworkError)) toast.error(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, examId, flush, handleApiError]);

  const heartbeat = useCallback(async () => {
    if (!ws || finished.current) return null;
    try {
      const r = await api(`/student/exams/${examId}/heartbeat`, { method: 'POST', examSession: token.current, body: { online: onlineRef.current, currentQuestionPosition: ws.questions.find((x: any) => x.examQuestionId === qid)?.position ?? null, clientTime: new Date().toISOString(), lastAnnouncementId: lastAnnouncement.current } });
      hbFailures.current = 0;
      setDeadline(r.deadlineAt);
      const fresh = [...r.announcements, ...r.directMessages.map((m: any) => ({ ...m, scope: 'direct' }))];
      if (fresh.length) {
        setAnnouncements((a) => {
          const seen = new Set(a.map((x) => x.id));
          const add = fresh.filter((x) => !seen.has(x.id));
          add.forEach((x) => toast.info(`${x.scope === 'direct' ? 'Message from your teacher' : 'Announcement'}: ${x.body}`));
          return [...a, ...add];
        });
        const lastAll = r.announcements.at(-1);
        if (lastAll) lastAnnouncement.current = lastAll.id;
      }
      if (r.sessionStatus !== 'in_progress') {
        toast.info(r.sessionStatus === 'force_submitted' ? 'Your teacher ended the exam. Your latest code was submitted.' : 'Your exam was submitted.');
        goResults();
      }
      if (!onlineRef.current) reconnect();
      return r;
    } catch (e) {
      if (handleApiError(e)) return null;
      if (e instanceof NetworkError) {
        hbFailures.current++;
        if (hbFailures.current >= 2) goOffline();
      }
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, examId, qid, handleApiError, goResults, reconnect]);

  // timers: autosave + heartbeat every 10 s; clock every second
  useEffect(() => {
    if (!ws) return;
    const t = setInterval(() => {
      flush();
      heartbeat();
    }, (ws.exam.autosaveSeconds ?? 10) * 1000);
    return () => clearInterval(t);
  }, [ws, flush, heartbeat]);
  useEffect(() => {
    const off = () => goOffline();
    const on = () => reconnect();
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => {
      window.removeEventListener('offline', off);
      window.removeEventListener('online', on);
    };
  }, [reconnect]);

  // proctor events (ignored by the server for practice / preview)
  const sendEvents = useCallback(
    async (events: any[]) => {
      if (!ws || practiceLike || finished.current) return;
      if (!onlineRef.current) return enqueue({ kind: 'events', sessionId: ws.session.id, events });
      try {
        const r = await api(`/student/exams/${examId}/events`, { method: 'POST', examSession: token.current, body: { events } });
        if (r.autoSubmitted) {
          toast.bad('Too many tab switches. Your exam was submitted automatically.');
          goResults();
        }
      } catch (e) {
        if (e instanceof NetworkError) enqueue({ kind: 'events', sessionId: ws.session.id, events });
        else handleApiError(e);
      }
    },
    [ws, practiceLike, examId, goResults, handleApiError],
  );
  useEffect(() => {
    if (!ws) return;
    let fsLeftAt: number | null = null;
    const vis = () => {
      if (document.visibilityState === 'hidden') {
        flush({ keepalive: true });
        sendEvents([{ type: 'tab_switch', occurredAt: new Date().toISOString() }]);
      }
    };
    const fs = () => {
      if (!document.fullscreenElement) fsLeftAt = Date.now();
      else if (fsLeftAt) {
        sendEvents([{ type: 'fullscreen_exit', occurredAt: new Date(fsLeftAt).toISOString(), durationMs: Date.now() - fsLeftAt }]);
        fsLeftAt = null;
      }
    };
    const unload = () => flush({ keepalive: true });
    document.addEventListener('visibilitychange', vis);
    document.addEventListener('fullscreenchange', fs);
    window.addEventListener('beforeunload', unload);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      document.removeEventListener('fullscreenchange', fs);
      window.removeEventListener('beforeunload', unload);
    };
  }, [ws, flush, sendEvents]);

  const onPaste = useCallback(
    (text: string) => {
      if (practiceLike) return true;
      if (text === lastCopied.current || text.length <= 1) return true;
      toast.warn('Paste from outside the editor is blocked.');
      sendEvents([{ type: 'paste_blocked', occurredAt: new Date().toISOString(), detail: { length: text.length } }]);
      return false;
    },
    [practiceLike, sendEvents],
  );
  const onCopy = useCallback((t: string) => {
    lastCopied.current = t;
  }, []);

  // ---------------------------------------------------------------- deadline / auto-submit
  const deadlineRef = useRef<string | null>(null);
  deadlineRef.current = deadline;
  const submitting = useRef(false);
  const autoSubmit = useRef<() => void>(() => undefined);
  autoSubmit.current = () => {
    if (!ws || submitting.current || finished.current) return;
    submitting.current = true;
    (async () => {
      await flush();
      try {
        await api(`/student/exams/${examId}/submit`, { method: 'POST', examSession: token.current, body: { confirmFinal: true } });
      } catch {
        /* the server auto-submits at the deadline anyway */
      }
      toast.info('Time is up. Your latest code was submitted automatically.');
      goResults();
    })();
  };
  useEffect(() => {
    if (!ws) return;
    const t = setInterval(() => {
      const d = deadlineRef.current;
      if (d && new Date(d).getTime() - clock.now() <= 0) autoSubmit.current();
    }, 1000);
    return () => clearInterval(t);
  }, [ws]);

  // ---------------------------------------------------------------- actions
  const switchQuestion = (id: string) => {
    flush();
    setQid(id);
  };
  const switchLang = (l: Lang) => {
    if (l === lang) return;
    setLangs((x) => ({ ...x, [qid]: l }));
    markDirty(qid, l, null);
    flush();
  };
  const resetToStarter = () => {
    const removed = Object.keys(edits[qid]?.[lang] ?? {});
    if (!removed.length) return;
    if (!window.confirm('Reset all files of this question to the starter code? Your changes in this language are lost.')) return;
    setEdits((prev) => ({ ...prev, [qid]: { ...(prev[qid] ?? {}), [lang]: {} } }));
    markDirty(qid, lang, null, removed);
    if (ws) putLocal(ws.session.id, qid, lang, { files: {}, clientSavedAt: new Date(clock.now()).toISOString(), synced: false });
    flush();
  };

  const run = async (kind: 'run' | 'custom_input' | 'sample_tests') => {
    if (!question || running) return;
    if (!onlineRef.current) return toast.warn("You're offline. Running code needs a connection; your code is still saved on this device.");
    setRunning(kind);
    setBottom(kind === 'sample_tests' ? 't' : kind === 'run' ? 'c' : 'i');
    try {
      const r = await api(`/student/exams/${examId}/runs`, { method: 'POST', examSession: token.current, body: { examQuestionId: qid, kind, language: lang, files: fullFiles(question, lang), stdin: kind === 'custom_input' ? stdin : null } });
      delete dirty.current[qid];
      let res: any;
      for (let i = 0; i < 30; i++) {
        res = await api(`/student/exams/${examId}/runs/${r.runId}`, { examSession: token.current, query: { waitMs: 10000 } });
        if (FINAL.has(res.status)) break;
      }
      if (kind === 'sample_tests') {
        setResults((x) => ({ ...x, [qid]: res }));
        setSample((x) => ({ ...x, [qid]: { passed: res.testsPassed, total: res.testsTotal, started: true } }));
        if (res.status === 'compile_error') setConsoleRun((x) => ({ ...x, [qid]: res }));
      } else {
        setConsoleRun((x) => ({ ...x, [qid]: res }));
      }
      setSaveState({ saving: false, at: Date.now() });
    } catch (e) {
      if (handleApiError(e)) return;
      if (e instanceof NetworkError) goOffline();
      toast.error(e);
    } finally {
      setRunning(null);
    }
  };

  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const stableOnEdit = useCallback((v: string) => onEditRef.current(v), []);

  const goSubmit = async () => {
    await flush();
    nav(`/student/exams/${examId}/submit`);
  };

  const diagnostics = useMemo(
    () => [consoleRun[qid], results[qid]].filter((x) => x?.status === 'compile_error' || x?.status === 'runtime_error').flatMap((x: any) => x.diagnostics ?? []).filter((d: any) => d.path === file?.path),
    [consoleRun, results, qid, file?.path],
  );

  // ---------------------------------------------------------------- render
  if (loadError) {
    return (
      <div className="app" style={{ padding: 40 }}>
        <ErrorState what="your exam workspace" error={loadError} onRetry={load} />
      </div>
    );
  }
  if (!ws || !question) {
    return (
      <div className="app" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--muted)' }}>
        <div className="skel" style={{ width: 56, height: 56, borderRadius: 16 }} />
        <b style={{ color: 'var(--text)' }}>Preparing your workspace…</b>
        <span className="hint">Loading your questions…</span>
      </div>
    );
  }

  const qs = ws.questions as any[];
  const idx = qs.findIndex((x) => x.examQuestionId === qid);
  const res = results[qid];
  const con = consoleRun[qid];
  const qAnnouncements = announcements.filter((a) => !a.examQuestionId || a.examQuestionId === qid);
  const edited = (path: string) => edits[qid]?.[lang]?.[path] !== undefined;

  return (
    <div className="app" style={{ width: '100%', height: '100vh', minHeight: 700, display: 'flex', flexDirection: 'column' }}>
      <header style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 60, padding: '8px 18px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <Logo to={isTeacher ? '/teacher' : '/student'} />
          <span aria-hidden="true" style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{ws.exam.shortTitle}</span>
          {practiceLike && <span className="badge b-violet">{isTeacher ? 'Preview' : 'Practice'}</span>}
        </div>
        <nav aria-label="Questions" className="seg" style={{ padding: 3 }}>
          {qs.map((q) => {
            const s = sample[q.examQuestionId];
            const on = q.examQuestionId === qid;
            const isChoice = q.type && q.type !== 'code';
            const done = isChoice ? !!s?.started : s && s.total > 0 && s.passed === s.total;
            const label = on ? 'Active' : done ? (isChoice ? 'Answered' : 'Done') : s?.started ? 'In progress' : 'Pending';
            const stStyle = on ? { background: 'rgba(255,255,255,.2)', color: '#fff' } : done ? { background: 'var(--ok-bg)', color: 'var(--ok)' } : s?.started ? { background: 'var(--warn-bg)', color: 'var(--warn)' } : { background: 'var(--surface3)', color: 'var(--muted)' };
            return (
              <button key={q.examQuestionId} type="button" onClick={() => switchQuestion(q.examQuestionId)} aria-current={on} title={q.displayTitle} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, padding: '0 12px', border: 'none', borderRadius: 8, cursor: 'pointer', font: '600 13px Inter, system-ui, sans-serif', background: on ? 'var(--accent)' : 'transparent', color: on ? '#fff' : 'var(--text2)' }}>
                Q{q.position}
                <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.03em', padding: '2px 6px', borderRadius: 5, ...stStyle }}>{label}</span>
              </button>
            );
          })}
        </nav>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 999, font: '600 12px Inter, system-ui, sans-serif', border: `1px solid ${online ? 'var(--ok-line)' : 'var(--bad-line)'}`, background: online ? 'var(--ok-bg)' : 'var(--bad-bg)', color: online ? 'var(--ok)' : 'var(--bad)' }}>
            <Icon name="wifi" size={13} />
            {online ? 'Online' : 'Offline'}
          </span>
          <SaveLabel online={online} saving={saveState.saving} at={saveState.at} />
          <Countdown deadline={deadline} />
          <ThemeButton />
          <button type="button" className="btn btn-ok" onClick={goSubmit}>
            {practiceLike ? 'Finish' : 'Submit exam'}
            <Icon name="arrowr" />
          </button>
        </div>
      </header>
      {takenOver && (
        <div role="alert" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', background: 'var(--bad-bg)', color: 'var(--bad)', borderBottom: '1px solid var(--bad-line)', fontSize: 13 }}>
          <Icon name="alert" />
          <span style={{ flex: 1 }}>
            <b>This exam was opened on another device.</b> Continue there, or reload this page to take it back (your invigilator is notified).
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {!online && (
        <div role="alert" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', background: 'var(--warn-bg)', color: 'var(--warn)', borderBottom: '1px solid var(--warn-line)', fontSize: 13 }}>
          <Icon name="wifi" />
          <span>
            <b>You're offline.</b> Keep coding — your changes are saved on this device and sync when the connection comes back. The timer keeps running.
          </span>
        </div>
      )}
      {banner && (
        <div role="status" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 18px', background: banner.kind === 'reconnected' ? 'var(--ok-bg)' : 'var(--accent-weak)', color: banner.kind === 'reconnected' ? 'var(--ok)' : 'var(--accent-text)', borderBottom: `1px solid ${banner.kind === 'reconnected' ? 'var(--ok-line)' : 'var(--accent-line)'}`, fontSize: 13 }}>
          <Icon name={banner.kind === 'reconnected' ? 'check' : 'refresh'} />
          <span style={{ flex: 1 }}>{banner.text}</span>
          <button type="button" className="icon-btn" style={{ width: 26, height: 26, color: 'inherit' }} aria-label="Dismiss" onClick={() => setBanner(null)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <aside style={{ flex: '0 0 380px', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
            <span className="over" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Icon name="doc" size={15} stroke="var(--accent-text)" />
              {question.type && question.type !== 'code' ? QTYPE_LABEL[question.type] : 'Problem description'}
            </span>
            <span className="badge b-blue tnum">{question.points} pts</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, lineHeight: 1.35 }}>{question.displayTitle}</h1>
            <div style={{ display: 'flex', gap: 8, margin: '10px 0 6px' }}>
              <span className={DIFF_CLS[question.difficulty]}>{DIFF_LABEL[question.difficulty]}</span>
              <span className="badge b-gray">
                Question {idx + 1} of {qs.length}
              </span>
            </div>
            <Markdown text={question.descriptionMd} />
            {question.sample && (
              <>
                <div className="over" style={{ margin: '14px 0 6px' }}>
                  Sample test
                </div>
                <div className="mono ed" style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--ed-border)', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                  <div style={{ color: 'var(--muted)' }}>// input</div>
                  <div>{question.sample.input.split('\n').filter((l: string) => !/^\s*(java|python|javascript|js|cpp|c)\s*:/.test(l) || l.trim().startsWith(lang + ':')).map((l: string) => l.replace(/^\s*(java|python|javascript|js|cpp|c)\s*:\s?/, '')).join('\n')}</div>
                  <div style={{ color: 'var(--muted)' }}>// expected</div>
                  <div>{question.sample.expected.split('|')[0]}</div>
                </div>
              </>
            )}
            {qAnnouncements.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 10, marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--accent-weak)', color: 'var(--accent-text)', fontSize: 13 }}>
                <Icon name={a.scope === 'direct' ? 'chat' : 'megaphone'} />
                <span>
                  <b>
                    {a.scope === 'direct' ? 'Message' : 'Announcement'} {new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </b>{' '}
                  · {a.body}
                </span>
              </div>
            ))}
          </div>
          <div style={{ flex: 'none', display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
            <div>
              {idx > 0 && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => switchQuestion(qs[idx - 1].examQuestionId)}>
                  <Icon name="arrowl" size={15} />
                  Previous (Q{idx})
                </button>
              )}
            </div>
            <span className="tnum hint" style={{ textAlign: 'center' }}>
              Question {idx + 1} of {qs.length}
            </span>
            <div style={{ textAlign: 'right' }}>
              {idx < qs.length - 1 ? (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => switchQuestion(qs[idx + 1].examQuestionId)}>
                  Next (Q{idx + 2})
                  <Icon name="arrowr" size={15} />
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={goSubmit}>
                  Review &amp; submit
                  <Icon name="arrowr" size={15} />
                </button>
              )}
            </div>
          </div>
        </aside>
        {question.type && question.type !== 'code' ? (
          <ChoicePanel key={qid} question={question} response={responses[qid] ?? {}} onChange={(r) => onChoice(qid, r)} disabled={takenOver} onPaste={onPaste} />
        ) : (
        <section aria-label="Code editor" className="ed" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 'none', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--ed-border)', background: 'var(--surface)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="over" style={{ fontSize: 10.5 }}>
                Language
              </span>
              <Seg value={lang} onChange={(l) => switchLang(l as Lang)} options={question.languages.map((l: string) => ({ value: l, label: langLabel(l) }))} small />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="hint hide-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Icon name="info" size={14} />
                Tab indents · Esc then Tab leaves the editor
              </span>
              <button type="button" className="btn btn-quiet btn-sm" onClick={resetToStarter} disabled={!Object.keys(edits[qid]?.[lang] ?? {}).length}>
                <Icon name="refresh" size={14} />
                Reset to starter
              </button>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div role="tablist" aria-label="Files" style={{ flex: 'none', display: 'flex', overflowX: 'auto', background: 'var(--ed-panel)', borderBottom: '1px solid var(--ed-border)' }}>
              {templates.map((f) => (
                <button key={f.path} type="button" role="tab" aria-selected={f.path === file?.path} className="mono" onClick={() => setActiveFile((x) => ({ ...x, [`${qid}:${lang}`]: f.path }))} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 40, padding: '0 14px', border: 'none', borderRight: '1px solid var(--ed-border)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap', borderTop: `2px solid ${f.path === file?.path ? 'var(--accent)' : 'transparent'}`, background: f.path === file?.path ? 'var(--ed-bg)' : 'transparent', color: f.path === file?.path ? 'var(--ed-text)' : 'var(--muted)' }}>
                  <Icon name="file" size={13} />
                  {f.path}
                  {f.readOnly && <Icon name="lock" size={12} style={{ color: 'var(--faint)' }} />}
                  {!f.readOnly && edited(f.path) && <span aria-label="Edited" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--warn)' }} />}
                </button>
              ))}
            </div>
            {file?.readOnly && (
              <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', fontSize: 12, color: 'var(--muted)', background: 'var(--ed-panel)', borderBottom: '1px solid var(--ed-border)' }}>
                <Icon name="lock" size={13} />
                Provided by your teacher · read-only
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <CodeEditor key={`${qid}:${lang}:${file?.path}`} value={code} onChange={stableOnEdit} language={lang} readOnly={!!file?.readOnly || takenOver} diagnostics={diagnostics} onPaste={onPaste} onCopy={onCopy} ariaLabel={`Code for ${file?.path ?? 'file'}`} />
            </div>
            <div style={{ flex: 'none', borderTop: '1px solid var(--ed-border)', background: 'var(--ed-panel)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 12px', borderBottom: '1px solid var(--ed-border)' }}>
                <Seg value={bottom} onChange={setBottom} small options={[{ value: 't', label: `Tests · ${res ? `${res.testsPassed}/${res.testsTotal}` : '–'}` }, { value: 'c', label: 'Console' }, { value: 'i', label: 'Custom input' }]} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="hint" aria-live="polite">
                    {running ? 'Running…' : 'Sample tests only · hidden tests run on submit'}
                  </span>
                  {ws.exam.allowRun && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => run('run')} disabled={!!running}>
                      <Icon name="play" size={13} />
                      Run
                    </button>
                  )}
                  {ws.exam.showSampleTests && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => run('sample_tests')} disabled={!!running}>
                      <Icon name="tests" size={14} />
                      Run tests
                    </button>
                  )}
                </div>
              </div>
              <div style={{ height: 220, overflow: 'auto', padding: 12 }}>
                {running ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, color: 'var(--muted)', fontSize: 13 }}>
                    <Icon name="refresh" style={{ animation: 'spin 1s linear infinite' }} />
                    {running === 'sample_tests' ? 'Compiling and running tests…' : 'Compiling and running…'}
                  </div>
                ) : bottom === 't' ? (
                  <TestsPanel res={res} />
                ) : bottom === 'c' ? (
                  <ConsolePanel run={con} />
                ) : (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label className="over" htmlFor="stdin" style={{ fontSize: 10.5 }}>
                        STDIN · given to your program's entry point
                      </label>
                      <div className="field area" style={{ padding: '8px 10px' }}>
                        <textarea id="stdin" className="mono" rows={5} value={stdin} onChange={(e) => setStdin(e.target.value)} style={{ fontSize: 12.5 }} />
                      </div>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => run('custom_input')} disabled={!ws.exam.allowRun}>
                        <Icon name="play" size={13} />
                        Run with this input
                      </button>
                    </div>
                    <div style={{ flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span className="over" style={{ fontSize: 10.5 }}>
                        Output
                      </span>
                      <div className="mono ed" style={{ minHeight: 128, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--ed-border)', fontSize: 12.5, lineHeight: 1.8 }}>
                        {con?.kind === 'custom_input' ? <ConsoleLines run={con} /> : <span style={{ color: 'var(--muted)' }}>Press “Run with this input” to see output</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
        )}
      </div>
      {isTeacher && (
        <Link to="/teacher" className="btn btn-secondary btn-sm" style={{ position: 'fixed', left: 16, bottom: 16 }}>
          Exit preview
        </Link>
      )}
    </div>
  );
}

function TestsPanel({ res }: { res: any }) {
  if (!res) return <div className="hint" style={{ padding: 12 }}>Press Run tests to check your code against the sample tests.</div>;
  if (res.status === 'compile_error')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 10, padding: '11px 14px', borderRadius: 10, border: '1px solid var(--bad-line)', background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 13 }}>
          <Icon name="x" size={17} />
          Compilation failed. Fix the errors marked in the editor (see Console for details).
        </div>
      </div>
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {res.tests.length === 0 && <div className="hint">This question has no sample tests.</div>}
      {res.tests.map((t: any, i: number) => (
        <div key={i} style={{ display: 'flex', gap: 12, padding: '11px 14px', borderRadius: 10, border: `1px solid ${t.passed ? 'var(--ok-line)' : 'var(--bad-line)'}`, background: t.passed ? 'var(--ok-bg)' : 'var(--bad-bg)' }}>
          <span style={{ color: t.passed ? 'var(--ok)' : 'var(--bad)', display: 'inline-flex' }} role="img" aria-label={t.passed ? 'Passed' : 'Failed'}>
            <Icon name={t.passed ? 'check' : 'x'} size={17} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{t.name}</span>
              <span className="mono tnum" style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t.timeMs != null ? `${t.timeMs}ms` : ''}
              </span>
            </div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>
              {t.message}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConsoleLines({ run }: { run: any }) {
  return (
    <>
      {(run.console ?? []).map((l: any, i: number) => (
        <div key={i} style={{ whiteSpace: 'pre-wrap', color: l.stream === 'system' ? (l.tone === 'ok' ? 'var(--ok)' : l.tone === 'warn' ? 'var(--warn)' : 'var(--muted)') : l.stream === 'stderr' ? 'var(--bad)' : undefined }}>
          {l.text}
        </div>
      ))}
    </>
  );
}

function ConsolePanel({ run }: { run: any }) {
  return (
    <div className="mono ed" style={{ fontSize: 12.5, lineHeight: 1.8, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--ed-border)', minHeight: 190 }}>
      {run ? <ConsoleLines run={run} /> : <span style={{ color: 'var(--muted)' }}>Press Run to compile and run your program.</span>}
    </div>
  );
}

function useSecondTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}

function Countdown({ deadline }: { deadline: string | null }) {
  useSecondTick();
  const secs = deadline ? Math.max(0, Math.round((new Date(deadline).getTime() - clock.now()) / 1000)) : 0;
  const low = secs < 300;
  return (
    <span role="timer" aria-label="Time remaining" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 999, border: `1px solid ${low ? 'var(--bad-line)' : 'var(--warn-line)'}`, background: low ? 'var(--bad-bg)' : 'var(--warn-bg)', color: low ? 'var(--bad)' : 'var(--warn)' }}>
      <Icon name="clock" />
      <span className="mono tnum" style={{ fontWeight: 600 }}>
        {fmtClock(secs)}
      </span>
      <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.06em' }}>LEFT</span>
    </span>
  );
}

function SaveLabel({ online, saving, at }: { online: boolean; saving: boolean; at: number | null }) {
  useSecondTick();
  const ago = at ? Math.round((Date.now() - at) / 1000) : null;
  const label = !online ? 'Saved on this device' : saving ? 'Saving…' : ago === null ? 'All changes saved' : ago < 60 ? `Saved ${ago}s ago` : `Saved ${Math.floor(ago / 60)} min ago`;
  return (
    <span className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 112, fontSize: 12.5 }}>
      <Icon name="save" size={14} />
      {label}
    </span>
  );
}

/** Answer area for multiple choice, multiple answers, true/false and short answer questions. */
function ChoicePanel({ question, response, onChange, disabled, onPaste }: { question: any; response: Response; onChange: (r: Response) => void; disabled: boolean; onPaste: (t: string) => boolean }) {
  const multi = question.type === 'multiple_choice';
  const selected = new Set(response.selected ?? []);
  const toggle = (id: string) => {
    if (multi) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange({ selected: question.options.map((o: any) => o.id).filter((x: string) => next.has(x)) });
    } else onChange({ selected: [id] });
  };
  return (
    <section aria-label="Your answer" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '28px 32px', background: 'var(--bg)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="over">{question.type === 'short_answer' ? 'Type your answer' : multi ? 'Choose all that apply' : 'Choose one answer'}</div>
        {question.type === 'short_answer' ? (
          <div className="field area">
            <textarea
              aria-label="Your answer"
              rows={5}
              disabled={disabled}
              value={response.text ?? ''}
              onChange={(e) => onChange({ text: e.target.value })}
              onPaste={(e) => {
                if (!onPaste(e.clipboardData.getData('text'))) e.preventDefault();
              }}
              placeholder="Your answer"
              style={{ fontSize: 15 }}
            />
          </div>
        ) : (
          <div role={multi ? 'group' : 'radiogroup'} aria-label="Options" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {question.options.map((o: any, i: number) => {
              const on = selected.has(o.id);
              return (
                <label
                  key={o.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 12, cursor: disabled ? 'default' : 'pointer', border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-weak)' : 'var(--surface)', fontSize: 15 }}
                >
                  <input type={multi ? 'checkbox' : 'radio'} name={`q-${question.examQuestionId}`} checked={on} disabled={disabled} onChange={() => toggle(o.id)} style={{ width: 18, height: 18 }} />
                  <span className="mono" style={{ color: 'var(--muted)', width: 18 }}>{String.fromCharCode(65 + i)}</span>
                  <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{o.text}</span>
                </label>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="hint">Your answer saves automatically.</span>
          {question.type !== 'short_answer' && selected.size > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ selected: [] })} disabled={disabled}>
              Clear my answer
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
