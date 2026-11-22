import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { StudentShell } from '../../components/Shell';
import { Banner, ErrorState, langLabel, LoadingState, toast, QTYPE_LABEL } from '../../components/ui';
import { clearLocal } from '../../lib/offline';
import { clearToken, ensureSession } from '../../lib/session';
import { useAuthStore } from '../../stores/auth';

export function Submit() {
  const { examId = '' } = useParams();
  const nav = useNavigate();
  const isTeacher = useAuthStore((s) => s.user?.role === 'teacher');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['submit-summary', examId],
    queryFn: async () => {
      const token = await ensureSession(examId);
      const summary = await api(`/student/exams/${examId}/submit-summary`, { examSession: token });
      return { ...summary, token };
    },
    retry: false,
  });

  if (isLoading) return <StudentShell><LoadingState label="Loading your answers" /></StudentShell>;
  if (error) {
    if (error instanceof ApiError && error.code === 'ALREADY_SUBMITTED') {
      nav(`/student/results/${examId}`, { replace: true });
      return null;
    }
    return <StudentShell><ErrorState what="your answers" error={error} onRetry={() => refetch()} /></StudentShell>;
  }

  const qs = data.questions as any[];
  const failing = qs.filter((q) => q.status === 'some_failing').map((q) => `Q${q.position}`);
  const empty = qs.filter((q) => q.status === 'not_started').map((q) => `Q${q.position}`);
  const parts: string[] = [];
  if (empty.length) parts.push(`${empty.join(', ')} ${empty.length === 1 ? 'has' : 'have'} no answer yet`);
  if (failing.length) parts.push(`${failing.join(' and ')} still ${failing.length === 1 ? 'fails' : 'fail'} some sample tests (or tests were not run)`);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api(`/student/exams/${examId}/submit`, { method: 'POST', examSession: data.token, body: { confirmFinal: true } });
      clearToken(examId);
      await clearLocal(data.sessionId);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
      nav(isTeacher ? '/teacher' : r.redirect, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_SUBMITTED') return nav(`/student/results/${examId}`, { replace: true });
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StudentShell>
      <div style={{ maxWidth: 880, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div>
          <Link to={`/student/exams/${examId}/workspace`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Icon name="arrowl" size={14} />
            Back to exam
          </Link>
          <h1 className="h1" style={{ marginTop: 8 }}>
            Review &amp; submit
          </h1>
          <p className="sub">{data.examTitle} · check every question before you submit</p>
        </div>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {qs.map((q) => (
            <li key={q.position} className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, padding: '16px 18px', boxShadow: 'none' }}>
              <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, background: 'var(--surface3)', fontWeight: 700 }}>
                {q.position}
              </span>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{q.title}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <span className="badge b-gray">{q.type && q.type !== 'code' ? QTYPE_LABEL[q.type] : langLabel(q.language)}</span>
                  <span className="hint">
                    {q.type && q.type !== 'code' ? (q.status === 'answered' ? 'Answered' : 'No answer yet') : q.sampleTotal ? `${q.samplePassed} / ${q.sampleTotal} sample tests pass` : 'Sample tests not run yet'}
                  </span>
                </div>
              </div>
              <span className={q.status === 'ready' || q.status === 'answered' ? 'badge b-green' : q.status === 'not_started' ? 'badge b-red' : 'badge b-amber'}>{q.status === 'ready' ? 'Ready' : q.status === 'answered' ? 'Answered' : q.status === 'not_started' ? (q.type && q.type !== 'code' ? 'Not answered' : 'Not started') : 'Some tests failing'}</span>
              <Link className="btn btn-secondary btn-sm" to={`/student/exams/${examId}/workspace`}>
                Open
              </Link>
            </li>
          ))}
        </ol>
        {parts.length ? <Banner tone="warn">You still have time. {parts.join(', and ')}. You can't edit your answers after submitting.</Banner> : <Banner tone="ok">Every question is answered{qs.some((q) => !q.type || q.type === 'code') ? ' and all sample tests pass. Hidden tests run after you submit' : ''}.</Banner>}
        <section className="card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="checkbox" checked={ok} onChange={() => setOk(!ok)} style={{ marginTop: 3, width: 16, height: 16 }} />
            <span style={{ fontSize: 13.5, color: 'var(--text2)' }}>I understand that submitting ends my exam and my answers are final.</span>
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 }}>
            <Link className="btn btn-secondary" to={`/student/exams/${examId}/workspace`}>
              Keep working
            </Link>
            <button type="button" className="btn btn-ok" disabled={!ok || busy} onClick={submit}>
              <Icon name="send" />
              {busy ? 'Submitting…' : 'Submit final answers'}
            </button>
          </div>
        </section>
      </div>
    </StudentShell>
  );
}
