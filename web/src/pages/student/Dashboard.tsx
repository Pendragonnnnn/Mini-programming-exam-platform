import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Icon } from '../../components/Icon';
import { LiveClock } from '../../components/LiveClock';
import { StudentShell } from '../../components/Shell';
import { EmptyState, ErrorState, LangBadge, LoadingState, toast, useInterval, langList, LANGS, langLabel } from '../../components/ui';
import { startSession } from '../../lib/session';
import { useAuthStore } from '../../stores/auth';
import { clock, fmtClock } from '../../stores/clock';

function greeting(now: number) {
  const h = new Date(now).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function StudentDashboard() {
  const user = useAuthStore((s) => s.user);
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [lf, setLf] = useState('all');
  const [, setTick] = useState(0);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['student-dashboard'], queryFn: () => api('/student/dashboard'), refetchInterval: 5_000, refetchOnWindowFocus: true });
  useInterval(useCallback(() => setTick((t) => t + 1), []), 1000);

  const openPractice = async () => {
    try {
      await startSession(data.practice.examId, false);
      nav(`/student/exams/${data.practice.examId}/workspace`);
    } catch (e) {
      toast.error(e);
    }
  };

  if (isLoading) return <StudentShell><LoadingState label="Loading your exams" /></StudentShell>;
  if (error) return <StudentShell><ErrorState what="your exams" error={error} onRetry={() => refetch()} /></StudentShell>;

  const now = clock.now();
  const rows = (data.upcoming as any[]).filter((e) => (lf === 'all' || e.languages.includes(lf)) && (!query || `${e.title} ${e.course}`.toLowerCase().includes(query.toLowerCase())));
  const next = (data.upcoming as any[])[0];
  const secs = next ? Math.max(0, Math.round((new Date(next.startsAt).getTime() - now) / 1000)) : 0;

  return (
    <StudentShell>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">
            {greeting(clock.now())}, {user?.fullName.split(' ')[0]}
          </h1>
          <p className="sub">{data.upcoming.length ? `You have ${data.upcoming.length} upcoming exam${data.upcoming.length === 1 ? '' : 's'}.` : 'No upcoming exams right now.'}</p>
        </div>
        <LiveClock />
      </div>

      {next && (
        <section className="card" style={{ padding: '22px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24, borderColor: next.state === 'open' || next.state === 'in_progress' ? 'var(--accent-line)' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '1 1 320px' }}>
            <span className="icon-tile" style={{ width: 44, height: 44 }}>
              <Icon name="clipboard" size={22} />
            </span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{next.title}</div>
              <div className="hint" style={{ marginTop: 4 }}>
                {next.course} · {next.questionCount} questions · {next.languages.length ? langList(next.languages) : 'No coding'}
              </div>
            </div>
          </div>
          <div className="card" role="timer" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', boxShadow: 'none' }}>
            <span className="over">{next.state === 'in_progress' ? 'In progress' : secs > 0 ? 'Starts in' : 'Open now'}</span>
            <span className="mono tnum" style={{ fontSize: 22, fontWeight: 600 }}>
              {next.state === 'in_progress' ? '—' : fmtClock(secs)}
            </span>
          </div>
          {next.state === 'locked' ? (
            <span className="badge b-gray" style={{ height: 32, padding: '0 12px' }}>
              <Icon name="lock" size={12} />
              Lobby opens {new Date(next.lobbyOpensAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : (
            <Link className="btn btn-primary" to={next.state === 'in_progress' ? `/student/exams/${next.examId}/workspace` : `/student/exams/${next.examId}/lobby`}>
              {next.state === 'in_progress' ? 'Resume exam' : 'Open lobby'}
              <Icon name="arrowr" />
            </Link>
          )}
        </section>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <section className="card" style={{ flex: '3 1 600px', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="clipboard" size={20} stroke="var(--accent-text)" />
              <h2 className="h2">Upcoming exams</h2>
              <span className="badge b-gray">
                {rows.length} of {data.upcoming.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <label className="field" style={{ width: 240, height: 38 }}>
                <Icon name="search" stroke="var(--muted)" />
                <input type="search" placeholder="Filter exams" aria-label="Filter exams" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <div className="field" style={{ height: 38, width: 160 }}>
                <select aria-label="Language" value={lf} onChange={(e) => setLf(e.target.value)}>
                  <option value="all">All languages</option>
                  {LANGS.map((l) => (
                    <option key={l} value={l}>
                      {langLabel(l)}
                    </option>
                  ))}
                </select>
                <Icon name="chevd" stroke="var(--muted)" />
              </div>
            </div>
          </div>
          {data.upcoming.length === 0 ? (
            <div style={{ padding: '0 22px 22px' }}>
              <EmptyState title="No upcoming exams" text="When your teacher publishes an exam for your class, it shows up here." />
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <div role="table" aria-label="Upcoming exams" style={{ minWidth: 640 }}>
                <div role="row" className="grid-h" style={{ gridTemplateColumns: 'minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.1fr) 150px' }}>
                  <span role="columnheader">Exam</span>
                  <span role="columnheader">Languages</span>
                  <span role="columnheader">Date &amp; time</span>
                  <span role="columnheader" style={{ textAlign: 'right' }}>
                    Action
                  </span>
                </div>
                {rows.map((r) => (
                  <div key={r.examId} role="row" className="grid-r" style={{ gridTemplateColumns: 'minmax(0, 2.4fr) minmax(0, 1.6fr) minmax(0, 1.1fr) 150px' }}>
                    <div role="cell" style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, lineHeight: 1.4 }}>{r.title}</div>
                      <div className="hint" style={{ marginTop: 2 }}>
                        {r.course} · {r.questionCount} questions
                      </div>
                    </div>
                    <div role="cell" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {r.languages.map((l: string) => (
                        <LangBadge key={l} lang={l} />
                      ))}
                    </div>
                    <div role="cell" className="tnum">
                      <div style={{ fontWeight: 600, color: r.state !== 'locked' ? 'var(--accent-text)' : undefined }}>{new Date(r.startsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
                      <div className="hint">{new Date(r.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                    <div role="cell" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      {r.state === 'locked' ? (
                        <span className="badge b-gray" style={{ height: 28, padding: '0 10px' }}>
                          <Icon name="lock" size={12} />
                          Opens {new Date(r.lobbyOpensAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      ) : (
                        <Link className="btn btn-primary btn-sm" to={r.state === 'in_progress' ? `/student/exams/${r.examId}/workspace` : `/student/exams/${r.examId}/lobby`}>
                          {r.state === 'in_progress' ? 'Resume' : 'Open lobby'}
                          <Icon name="arrowr" size={15} />
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
                {rows.length === 0 && <div className="hint" style={{ padding: 24, textAlign: 'center' }}>No exams match your filter.</div>}
              </div>
            </div>
          )}
        </section>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: '20px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 className="h2">Past results</h2>
              <Link className="btn btn-ghost btn-sm" to="/student/results">
                View all
              </Link>
            </div>
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
              {data.pastResults.length === 0 && <li className="hint" style={{ padding: '12px 0' }}>No results yet.</li>}
              {data.pastResults.slice(0, 5).map((r: any) => (
                <li key={r.examId}>
                  <Link to={`/student/results/${r.examId}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)', color: 'var(--text)' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 600, fontSize: 13.5 }}>{r.title}</span>
                      <span className="hint">{r.submittedAt ? new Date(r.submittedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
                    </span>
                    <span className={r.status === 'graded' ? 'badge b-green' : 'badge b-amber'}>{r.status === 'graded' ? 'Graded' : 'Pending'}</span>
                    <span className="mono tnum" style={{ fontWeight: 600, fontSize: 13, minWidth: 56, textAlign: 'right' }}>
                      {r.score !== null ? `${r.score}/${r.maxScore}` : '—'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          {data.practice && (
            <section className="card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="icon-tile">
                  <Icon name="terminal" size={18} />
                </span>
                <div>
                  <h2 className="h2">Practice sandbox</h2>
                  <p className="hint" style={{ margin: '2px 0 0' }}>
                    Try the exam editor before the real thing.
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {data.practice.languages.map((l: string) => (
                  <LangBadge key={l} lang={l} />
                ))}
              </div>
              <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={openPractice}>
                <Icon name="play" size={14} />
                Open sandbox
              </button>
            </section>
          )}
        </div>
      </div>
    </StudentShell>
  );
}
