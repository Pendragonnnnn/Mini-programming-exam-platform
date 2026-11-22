import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { CodeEditor } from '../../components/CodeEditor';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { ago, Avatar, Banner, ErrorState, LangBadge, LoadingState, Seg, toast, useInterval, langLabel, QTYPE_LABEL } from '../../components/ui';
import { clock, fmtClock } from '../../stores/clock';

const STATUS: Record<string, [string, string]> = {
  coding: ['badge b-blue', 'Coding'],
  flagged: ['badge b-red', 'Flagged'],
  submitted: ['badge b-green', 'Submitted'],
  not_started: ['badge b-gray', 'Not started'],
};
const DOT: Record<string, string> = { done: 'var(--ok)', in_progress: 'var(--accent)', not_started: 'var(--surface3)' };

export function LiveMonitor() {
  const { examId } = useParams();
  const qc = useQueryClient();
  const [segment, setSegment] = useState('all');
  const [search, setSearch] = useState('');
  const [msgOpen, setMsgOpen] = useState<null | { scope: 'all' | 'direct'; studentId?: string; name?: string }>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [, tick] = useState(0);
  useInterval(useCallback(() => tick((t) => t + 1), []), 1000);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['monitor', examId, segment, search],
    queryFn: () => api(`/teacher/exams/${examId}/monitor`, { query: { segment, q: search } }),
    refetchInterval: 5000,
    placeholderData: (p) => p,
  });
  const crumbs = ['Teacher', 'Live monitor', data?.exam.shortTitle ?? '…'];
  if (isLoading) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading the live monitor" /></TeacherShell>;
  if (error && !data) return <TeacherShell crumbs={crumbs}><ErrorState what="the live monitor" error={error} onRetry={() => refetch()} /></TeacherShell>;
  const e = data.exam;
  const s = data.stats;
  const left = e.endsAt ? Math.max(0, Math.round((new Date(e.endsAt).getTime() - clock.now()) / 1000)) : 0;
  const notStartedYet = e.startsAt && new Date(e.startsAt).getTime() > clock.now();
  const running = ['live', 'scheduled'].includes(e.status);

  const extend = async (minutes: number, studentId?: string) => {
    try {
      const r = await api(`/teacher/exams/${examId}/extend`, { method: 'POST', body: { minutes, studentId } });
      toast.ok(studentId ? `Gave ${r.name} +${minutes} min.` : `Everyone got +${minutes} min (${r.affectedSessions} coding now).`);
      qc.invalidateQueries({ queryKey: ['monitor', examId] });
    } catch (err) {
      toast.error(err);
    }
  };
  const end = async () => {
    if (!window.confirm(`End ${e.shortTitle} now? Everyone still coding (${s.inProgress}) is submitted with their latest saved code. This can't be undone.`)) return;
    try {
      const r = await api(`/teacher/exams/${examId}/end`, { method: 'POST', body: { confirm: true } });
      toast.ok(`Exam ended. ${r.forceSubmitted} session${r.forceSubmitted === 1 ? '' : 's'} submitted automatically.`);
      qc.invalidateQueries();
    } catch (err) {
      toast.error(err);
    }
  };
  const stat = (label: string, v: number, color?: string) => (
    <div className="card" style={{ flex: '1 1 150px', padding: '16px 18px' }}>
      <div className="over">{label}</div>
      <div className="tnum" style={{ fontSize: 26, fontWeight: 700, color }}>
        {v}
      </div>
    </div>
  );
  return (
    <TeacherShell crumbs={crumbs} wide>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {e.status === 'live' ? (
              <span className="badge b-red">
                <Icon name="dot" size={8} />
                LIVE
              </span>
            ) : (
              <span className="badge b-gray">{e.status}</span>
            )}
            <h1 className="h1">{e.shortTitle}</h1>
          </div>
          <p className="sub">
            {notStartedYet ? (
              <>Starts {new Date(e.startsAt).toUTCString().slice(5, 22)} UTC</>
            ) : running ? (
              <>
                Window closes in <span className="mono tnum" style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtClock(left)}</span>
                {e.globalExtensionMinutes ? ` · everyone +${e.globalExtensionMinutes} min` : ''}
                {s.lateWindowOpen ? ' · late join open' : ''}
              </>
            ) : (
              'This exam has ended.'
            )}
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {running && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setMsgOpen({ scope: 'all' })}>
                <Icon name="megaphone" />
                Message everyone
              </button>
              <div className="seg" role="group" aria-label="Extend for everyone">
                {[5, 10, 15].map((m) => (
                  <button key={m} type="button" className="seg-i" onClick={() => extend(m)}>
                    +{m} min
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-danger" onClick={end}>
                End exam
              </button>
            </>
          )}
          {!running && (
            <Link className="btn btn-primary" to={`/teacher/exams/${examId}/grading`}>
              Go to grading
              <Icon name="arrowr" />
            </Link>
          )}
        </div>
      </div>
      {error && <Banner tone="warn">Couldn't refresh — showing the last data. Retrying every 5 seconds.</Banner>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {stat('Assigned', s.assigned)}
        {stat('In progress', s.inProgress, 'var(--accent-text)')}
        {stat('Submitted', s.submitted, 'var(--ok)')}
        {stat('Not started', s.notStarted)}
        {stat('Flagged', s.flags, s.flags ? 'var(--bad)' : undefined)}
      </div>
      {msgOpen && <MessageBox examId={examId!} target={msgOpen} onClose={() => setMsgOpen(null)} />}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <section className="card" style={{ flex: '3 1 680px', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}>
            <Seg
              small
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'all', label: `All ${data.segments.all}` },
                { value: 'coding', label: `Coding ${data.segments.coding}` },
                { value: 'flagged', label: `Flagged ${data.segments.flagged}` },
                { value: 'submitted', label: `Submitted ${data.segments.submitted}` },
                { value: 'not_started', label: `Not started ${data.segments.notStarted}` },
              ]}
            />
            <label className="field" style={{ height: 36, width: 240 }}>
              <Icon name="search" stroke="var(--muted)" />
              <input type="search" placeholder="Find a student…" aria-label="Find a student" value={search} onChange={(ev) => setSearch(ev.target.value)} />
            </label>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ minWidth: 860 }}>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Language</th>
                  <th>Progress</th>
                  <th>Sample tests</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="hint" style={{ textAlign: 'center', padding: 28 }}>
                      No students in this view.
                    </td>
                  </tr>
                )}
                {data.rows.map((r: any) => {
                  const [cls, label] = STATUS[r.status] ?? ['badge b-gray', r.status];
                  return (
                    <tr key={r.studentId} style={r.status === 'flagged' ? { background: 'var(--bad-bg)' } : undefined}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ position: 'relative' }}>
                            <Avatar initials={r.initials} size={32} />
                            {r.online && <span title="Online" style={{ position: 'absolute', right: -1, bottom: -1, width: 10, height: 10, borderRadius: 99, background: 'var(--ok)', border: '2px solid var(--surface)' }} />}
                          </span>
                          <div>
                            <div style={{ fontWeight: 600 }}>{r.fullName}</div>
                            <div className="mono hint">{r.studentNumber}</div>
                          </div>
                        </div>
                      </td>
                      <td>{r.language ? <LangBadge lang={r.language} /> : <span className="hint">—</span>}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }} aria-label={`Progress: ${r.progress.filter((p: string) => p === 'done').length} of ${r.progress.length} done`}>
                          {r.progress.map((p: string, i: number) => (
                            <span key={i} title={`Q${i + 1}: ${p.replace('_', ' ')}`} style={{ width: 22, height: 8, borderRadius: 4, background: DOT[p] }} />
                          ))}
                        </div>
                      </td>
                      <td className="tnum">{r.testsTotal ? `${r.testsPassed} / ${r.testsTotal}` : '—'}</td>
                      <td>
                        <span className={cls}>{label}</span>
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text2)', maxWidth: 220 }}>
                        {r.notes.join(' · ') || <span className="hint">{r.lastSeenAt ? `Seen ${ago(r.lastSeenAt)}` : ''}</span>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {r.sessionId && (
                          <button type="button" className="icon-btn" aria-label={`View ${r.fullName}'s code`} title="View code" onClick={() => setViewing(r.sessionId)}>
                            <Icon name="eye" size={16} />
                          </button>
                        )}
                        {running && (r.status === 'coding' || r.status === 'flagged') && (
                          <>
                            <button type="button" className="icon-btn" aria-label={`Message ${r.fullName}`} title="Message" onClick={() => setMsgOpen({ scope: 'direct', studentId: r.studentId, name: r.fullName })}>
                              <Icon name="chat" size={16} />
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" title="Give this student 5 more minutes" onClick={() => extend(5, r.studentId)}>
                              +5
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="card" style={{ flex: '1 1 300px', minWidth: 0, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="flag" stroke="var(--bad)" />
            <h2 className="h2">Integrity log</h2>
          </div>
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
            {data.flagLog.length === 0 && <li className="hint" style={{ padding: '10px 0' }}>No integrity events yet.</li>}
            {data.flagLog.map((f: any, i: number) => (
              <li key={i} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
                <span className="mono tnum hint" style={{ whiteSpace: 'nowrap' }}>
                  {new Date(f.at).toISOString().slice(11, 19)}
                </span>
                <span>
                  <b>{f.studentName}</b> {f.text}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint" style={{ marginTop: 12 }}>
            Times in UTC. A student is flagged after 2 tab switches and auto-submitted after 5.
          </p>
        </aside>
      </div>
      {viewing && <CodeViewer examId={examId!} sessionId={viewing} onClose={() => setViewing(null)} />}
    </TeacherShell>
  );
}

function MessageBox({ examId, target, onClose }: { examId: string; target: { scope: 'all' | 'direct'; studentId?: string; name?: string }; onClose: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api(`/teacher/exams/${examId}/messages`, { method: 'POST', body: { scope: target.scope, recipientStudentId: target.studentId ?? null, body } });
      toast.ok(target.scope === 'all' ? `Message sent to ${r.recipients} student${r.recipients === 1 ? '' : 's'}.` : `Message sent to ${target.name}.`);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10, borderColor: 'var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <b>{target.scope === 'all' ? 'Message everyone taking the exam' : `Message ${target.name}`}</b>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="field area">
        <textarea rows={3} autoFocus value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Clarification for Q2: getBalance() returns a double." aria-label="Message" maxLength={2000} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={send} disabled={busy || !body.trim()}>
          <Icon name="send" size={15} />
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </section>
  );
}

function CodeViewer({ examId, sessionId, onClose }: { examId: string; sessionId: string; onClose: () => void }) {
  const [pos, setPos] = useState(0);
  const [file, setFile] = useState<string | null>(null);
  const { data, error, refetch } = useQuery({ queryKey: ['live-code', sessionId], queryFn: () => api(`/teacher/exams/${examId}/sessions/${sessionId}/live`), refetchInterval: 10_000 });
  const ans = data?.answers?.[pos];
  const paths = ans ? Object.keys(ans.files) : [];
  const cur = file && paths.includes(file) ? file : paths[0];
  return (
    <div role="dialog" aria-modal="true" aria-label="Student code" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onClose}>
      <div className="card" style={{ width: 'min(1000px, 100%)', height: 'min(720px, 100%)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
          <b style={{ flex: 1 }}>{data ? `${data.student.fullName} · ${data.student.studentNumber}` : 'Loading…'}</b>
          {ans && <span className="hint">Saved {ago(ans.serverSavedAt)}</span>}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {error ? (
          <ErrorState what="the student's code" error={error} onRetry={() => refetch()} />
        ) : !data ? (
          <LoadingState label="Loading code" />
        ) : data.answers.length === 0 ? (
          <p className="hint" style={{ padding: 24 }}>This student hasn't opened a question yet.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, padding: '10px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              {data.answers.map((a: any, i: number) => (
                <button key={i} type="button" className={`chip ${i === pos ? 'chip-on' : ''}`} onClick={() => { setPos(i); setFile(null); }}>
                  Q{a.position} · {a.language ? langLabel(a.language) : QTYPE_LABEL[a.type] ?? ''}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {paths.map((p) => (
                <button key={p} type="button" className={`chip ${p === cur ? 'chip-on' : ''}`} onClick={() => setFile(p)}>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {p}
                  </span>
                </button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              {ans && !ans.language ? (
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <b>{ans.title}</b>
                  <span className="hint">Current answer</span>
                  <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', whiteSpace: 'pre-wrap' }}>{ans.answerText}</div>
                </div>
              ) : (
                cur && <CodeEditor key={`${pos}-${cur}`} readOnly language={ans.language} value={ans.files[cur]} ariaLabel={cur} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
