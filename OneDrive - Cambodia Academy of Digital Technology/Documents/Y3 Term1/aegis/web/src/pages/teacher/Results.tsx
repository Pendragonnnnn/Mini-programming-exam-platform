import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { Banner, EmptyState, ErrorState, fmtDate, LANG_LABEL, LoadingState, toast } from '../../components/ui';

export function TeacherResults() {
  const { examId } = useParams();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['results', examId], queryFn: () => api(`/teacher/exams/${examId}/results`) });
  const crumbs = ['Teacher', 'Results', data?.exam.title ?? '…'];
  if (isLoading) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading results" /></TeacherShell>;
  if (error) return <TeacherShell crumbs={crumbs}><ErrorState what="results" error={error} onRetry={() => refetch()} /></TeacherShell>;
  const d = data;
  const s = d.stats;
  const ended = ['grading', 'completed'].includes(d.exam.status);

  const release = async (force = false) => {
    setBusy(true);
    try {
      const r = await api(`/teacher/exams/${examId}/results/release`, { method: 'POST', body: { force } });
      toast.ok(`Results released to ${r.studentCount} student${r.studentCount === 1 ? '' : 's'}.`);
      qc.invalidateQueries();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REVIEW_INCOMPLETE' && !force) {
        setBusy(false);
        if (window.confirm(`${e.message} Release anyway? Students will see the current scores, and you can still change grades afterwards.`)) return release(true);
        return;
      }
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const hide = async () => {
    if (!window.confirm('Hide results from students again?')) return;
    try {
      await api(`/teacher/exams/${examId}/results/hide`, { method: 'POST' });
      toast.ok('Results hidden.');
      qc.invalidateQueries();
    } catch (e) {
      toast.error(e);
    }
  };
  const maxBand = Math.max(1, ...d.distribution.map((b: any) => b.count));
  const stat = (label: string, value: string, sub?: string) => (
    <div className="card" style={{ flex: '1 1 180px', padding: '16px 20px' }}>
      <div className="over">{label}</div>
      <div className="tnum" style={{ fontSize: 26, fontWeight: 700 }}>
        {value}
      </div>
      {sub && <div className="hint">{sub}</div>}
    </div>
  );
  return (
    <TeacherShell crumbs={crumbs}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">Results · {d.exam.title}</h1>
          <p className="sub">
            {d.submittedCount} submission{d.submittedCount === 1 ? '' : 's'} · {d.needsReview ? `${d.needsReview} still to review` : 'all reviewed'}
            {d.released ? ` · released ${fmtDate(d.releasedAt)}` : ' · not released yet'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" disabled={!d.submittedCount} onClick={() => download(`/teacher/exams/${examId}/results/export.csv`, 'results.csv').catch((e) => toast.error(e))}>
            <Icon name="download" />
            Export CSV
          </button>
          <button type="button" className="btn btn-secondary" disabled={!d.submittedCount} onClick={() => download(`/teacher/exams/${examId}/submissions.zip`, 'submissions.zip').catch((e) => toast.error(e))}>
            <Icon name="download" />
            All code (ZIP)
          </button>
          <Link className="btn btn-secondary" to={`/teacher/exams/${examId}/grading`}>
            <Icon name="check" />
            Grading
          </Link>
          {d.released ? (
            <button type="button" className="btn btn-danger" onClick={hide}>
              <Icon name="eyeoff" />
              Hide results
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => release(false)} disabled={busy || !ended || !d.submittedCount}>
              <Icon name="send" />
              {busy ? 'Releasing…' : 'Release to students'}
            </button>
          )}
        </div>
      </div>
      {!ended && <Banner tone="info">The exam is still {d.exam.status}. You can release results once it ends.</Banner>}
      {d.released && <Banner tone="ok">Students can see their score and your feedback.</Banner>}
      {d.submittedCount === 0 ? (
        <EmptyState title="No submissions yet" text="Results appear once students submit." />
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            {stat('Average', s.average != null ? `${s.average} / ${s.maxTotal}` : '—', s.averageDelta != null ? `${s.averageDelta > 0 ? '+' : ''}${s.averageDelta} ${s.averageDeltaLabel}` : undefined)}
            {stat('Median', s.median != null ? String(s.median) : '—')}
            {stat('Pass rate', s.passRatePercent != null ? `${s.passRatePercent}%` : '—', `${s.passThreshold}% or more`)}
            {stat('Avg. time used', s.avgTimeUsedMinutes != null ? `${s.avgTimeUsedMinutes} min` : '—', d.exam.durationMinutes ? `of ${d.exam.durationMinutes} min` : undefined)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
            <section className="card" style={{ flex: '3 1 520px', minWidth: 0, padding: '20px 24px' }}>
              <h2 className="h2">Score distribution</h2>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 200, marginTop: 18 }} role="img" aria-label={`Score distribution: ${d.distribution.map((b: any) => `${b.band}%: ${b.count}`).join(', ')}`}>
                {d.distribution.map((b: any) => (
                  <div key={b.band} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
                    <span className="tnum" style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {b.count}
                    </span>
                    <span style={{ width: '100%', maxWidth: 56, height: `${(100 * b.count) / maxBand}%`, minHeight: b.count ? 6 : 2, borderRadius: '6px 6px 2px 2px', background: b.count ? 'var(--accent)' : 'var(--surface3)' }} />
                    <span className="hint tnum" style={{ fontSize: 12 }}>
                      {b.band}
                    </span>
                  </div>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 10 }}>Percent of the {s.maxTotal} available points.</p>
            </section>
            <div style={{ flex: '2 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <section className="card" style={{ padding: '20px 24px' }}>
                <h2 className="h2">By language</h2>
                {d.byLanguage.map((b: any) => (
                  <div key={b.language} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
                    <span style={{ width: 92, fontSize: 13 }}>{LANG_LABEL[b.language] ?? b.language}</span>
                    <span className="bar" style={{ flex: 1 }}>
                      <span style={{ width: `${b.avgPercent}%` }} />
                    </span>
                    <span className="tnum" style={{ width: 90, textAlign: 'right', fontSize: 13 }}>
                      {b.avgPercent}% · {b.students}
                    </span>
                  </div>
                ))}
              </section>
              <section className="card" style={{ padding: '20px 24px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="sparkle" stroke="var(--accent-text)" />
                  <h2 className="h2">Insights</h2>
                </div>
                {d.insights.length === 0 ? (
                  <p className="hint">No test stands out — failures are spread out.</p>
                ) : (
                  <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13.5, color: 'var(--text2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {d.insights.map((x: any, i: number) => (
                      <li key={i}>{x.text}</li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
          <section className="card" style={{ overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px 8px' }}>
              <h2 className="h2">Per question</h2>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Average</th>
                    <th>Most failed test</th>
                    <th>Failure rate</th>
                  </tr>
                </thead>
                <tbody>
                  {d.perQuestion.map((p: any) => (
                    <tr key={p.position}>
                      <td>
                        <b>Q{p.position}.</b> {p.title}
                      </td>
                      <td className="tnum">
                        {p.average} / {p.maxScore}
                      </td>
                      <td className="mono" style={{ fontSize: 13 }}>
                        {p.mostFailedTest ?? <span className="hint">—</span>}
                      </td>
                      <td className="tnum">{p.mostFailedTest ? `${p.failureRatePercent}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </TeacherShell>
  );
}
