import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { StudentShell } from '../../components/Shell';
import { Banner, ErrorState, LangBadge, LoadingState, Markdown, useInterval } from '../../components/ui';
import { startSession } from '../../lib/session';
import { useAuthStore } from '../../stores/auth';
import { clock, fmtClock } from '../../stores/clock';

async function measureLatency(): Promise<number | null> {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try {
      await api('/health');
      samples.push(performance.now() - t);
    } catch {
      return null;
    }
  }
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

export function Lobby() {
  const { examId = '' } = useParams();
  const nav = useNavigate();
  const isTeacher = useAuthStore((s) => s.user?.role === 'teacher');
  const [agreed, setAgreed] = useState(false);
  const [recheck, setRecheck] = useState(0);
  const [latency, setLatency] = useState<number | null | 'checking'>('checking');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['lobby', examId, recheck],
    queryFn: () => api(`/student/exams/${examId}/lobby`, { query: { recheck: recheck > 0 ? 1 : undefined } }),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });
  useInterval(useCallback(() => setTick((t) => t + 1), []), 1000);
  useEffect(() => {
    setLatency('checking');
    measureLatency().then(setLatency);
  }, [recheck]);

  if (isLoading) return <StudentShell><LoadingState label="Loading the exam lobby" /></StudentShell>;
  if (error) {
    if (error instanceof ApiError && error.code === 'SEB_REQUIRED')
      return (
        <StudentShell>
          <ErrorState what="the exam" error={error} />
          <Banner tone="info">Open the exam link your teacher gave you in Safe Exam Browser, then sign in again inside it.</Banner>
        </StudentShell>
      );
    return <StudentShell><ErrorState what="the exam lobby" error={error} onRetry={() => refetch()} /></StudentShell>;
  }

  const e = data.exam;
  const practiceLike = e.isPractice || e.isPreview || isTeacher;
  const now = clock.now();
  const startsAt = e.startsAt ? new Date(e.startsAt).getTime() : now;
  const cd = Math.max(0, Math.round((startsAt - now) / 1000));
  const open = practiceLike || cd <= 0;
  const lateClosed = !practiceLike && e.lateJoinClosesAt && now > new Date(e.lateJoinClosesAt).getTime();
  const checks = (data.checks as any[]).map((c) => {
    if (c.key !== 'connection') return c;
    if (latency === 'checking') return { ...c, detail: 'Checking…', status: 'checking' };
    if (latency === null) return { ...c, detail: 'No connection to the server', status: 'failed' };
    return { ...c, detail: `${latency} ms latency · ${latency < 300 ? 'stable' : 'slow'}`, status: 'ready' };
  });
  const checking = isFetching || latency === 'checking';
  const failed = checks.some((c) => c.status === 'failed');
  const status = data.session.status;
  const inProgress = status === 'in_progress';
  const submitted = ['submitted', 'auto_submitted', 'force_submitted'].includes(status);
  const canStart = (agreed || practiceLike || inProgress) && !checking && !failed && open && !lateClosed && !submitted;
  const blockLabel = submitted
    ? 'Already submitted'
    : lateClosed && !inProgress
      ? 'Late join has closed'
      : checking
        ? 'Checking your device…'
        : failed
          ? 'Fix the device check first'
          : !open
            ? `Opens in ${fmtClock(cd)}`
            : 'Accept the rules to start';

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startSession(examId, true);
      // Ask for full screen (SEB is already full screen; this helps in a normal browser).
      document.documentElement.requestFullscreen?.().catch(() => undefined);
      nav(`/student/exams/${examId}/workspace`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_SUBMITTED') return nav(`/student/results/${examId}`);
      setStartError(err instanceof Error ? err.message : 'Could not start the exam.');
      refetch();
    } finally {
      setStarting(false);
    }
  };

  return (
    <StudentShell>
      {e.isPreview || isTeacher ? <Banner tone="info">Preview as student · nothing you do here is graded or shown to students.</Banner> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <Link to={isTeacher ? '/teacher' : '/student'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Icon name="arrowl" size={14} />
            {isTeacher ? 'Back to dashboard' : 'My exams'}
          </Link>
          <h1 className="h1" style={{ marginTop: 8 }}>
            Exam lobby
          </h1>
          <p className="sub">
            {e.title}
            {e.teacherName ? ` · ${e.teacherName}` : ''}
          </p>
        </div>
        {!practiceLike && (
          <div className="card" role="timer" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', boxShadow: 'none' }}>
            <span className="over">{cd > 0 ? 'Starts in' : 'Open now'}</span>
            <span className="mono tnum" style={{ fontSize: 22, fontWeight: 600 }}>
              {fmtClock(cd)}
            </span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ flex: '3 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h2 className="h2">About this exam</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
              {[
                ['Questions', `${e.questionCount} question${e.questionCount === 1 ? '' : 's'}${e.codingCount ? ` · ${e.codingCount} coding` : ''}`],
                ['Duration', `${e.durationMinutes} minutes${data.session.accommodationMinutes ? ` + ${data.session.accommodationMinutes}` : ''}`],
                ['Total', `${e.totalPoints} points`],
                ['Window closes', e.windowClosesAt ? new Date(e.windowClosesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'],
              ].map(([a, b]) => (
                <div key={a} style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                  <div className="over" style={{ fontSize: 10.5 }}>
                    {a}
                  </div>
                  <div className="tnum" style={{ fontWeight: 600, marginTop: 4 }}>
                    {b}
                  </div>
                </div>
              ))}
            </div>
            {e.instructionsMd && (
              <div>
                <div className="label" style={{ marginBottom: 6 }}>
                  Instructions{e.teacherShortName ? ` from ${e.teacherShortName}` : ''}
                </div>
                <Markdown text={e.instructionsMd} />
              </div>
            )}
            <div>
              <div className="label" style={{ marginBottom: 8 }}>
                Allowed languages
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {e.languages.map((l: string) => (
                  <LangBadge key={l} lang={l} />
                ))}
              </div>
            </div>
          </section>
          <section className="card" style={{ padding: '22px 24px' }}>
            <h2 className="h2">Exam rules</h2>
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
              {e.rules.map((r: any) => (
                <li key={r.text} style={{ display: 'flex', gap: 10, padding: '6px 0', color: 'var(--text2)' }}>
                  <span style={{ color: 'var(--accent-text)', marginTop: 2 }}>
                    <Icon name={r.icon === 'timer' ? 'timer' : r.icon} />
                  </span>
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside style={{ flex: '2 1 360px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <h2 className="h2">Device check</h2>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRecheck((n) => n + 1)}>
                <Icon name="refresh" size={14} />
                Check again
              </button>
            </div>
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
              {checks.map((c) => (
                <li key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div className="hint">{checking && c.key !== 'webcam' ? 'Checking…' : c.detail}</div>
                  </div>
                  <span className={checking && c.key !== 'webcam' ? 'badge b-blue' : c.status === 'ready' ? 'badge b-green' : c.status === 'failed' ? 'badge b-red' : 'badge b-gray'}>
                    {checking && c.key !== 'webcam' ? 'Checking' : c.status === 'ready' ? 'Ready' : c.status === 'failed' ? 'Problem' : 'Skipped'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!practiceLike && !inProgress && !submitted && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={agreed} onChange={() => setAgreed(!agreed)} style={{ marginTop: 3, width: 16, height: 16 }} />
                <span style={{ fontSize: 13.5, color: 'var(--text2)' }}>I will work alone and follow my school's academic integrity rules.</span>
              </label>
            )}
            {startError && <Banner tone="bad">{startError}</Banner>}
            {submitted ? (
              <Link className="btn btn-secondary btn-lg" to={`/student/results/${examId}`} style={{ width: '100%' }}>
                See your result
              </Link>
            ) : canStart ? (
              <button type="button" className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={start} disabled={starting}>
                <Icon name="play" size={18} />
                {starting ? 'Starting…' : inProgress ? 'Resume exam' : 'Start exam'}
              </button>
            ) : (
              <span className="btn btn-lg" aria-disabled="true" style={{ width: '100%', background: 'var(--surface3)', color: 'var(--muted)', cursor: 'not-allowed' }}>
                <Icon name="lock" size={18} />
                {blockLabel}
              </span>
            )}
            {!practiceLike && (
              <p className="hint" style={{ margin: 0, textAlign: 'center' }}>
                {open ? `The exam is open. Late join closes at ${new Date(e.lateJoinClosesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : 'Start unlocks automatically when the countdown reaches 00:00:00.'}
                <br />
                Starting begins your {e.durationMinutes} minutes.
              </p>
            )}
          </section>
        </aside>
      </div>
    </StudentShell>
  );
}
