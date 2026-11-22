import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useState } from 'react';
import { api } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { ago, Banner, EmptyState, ErrorState, LangBadge, LoadingState, useInterval, langList, langLabel } from '../../components/ui';
import { clock, fmtClock } from '../../stores/clock';

export const STATUS_BADGE: Record<string, [string, string]> = {
  live: ['badge b-red', 'Live now'],
  scheduled: ['badge b-blue', 'Scheduled'],
  draft: ['badge b-gray', 'Draft'],
  grading: ['badge b-amber', 'Grading'],
  completed: ['badge b-green', 'Completed'],
  archived: ['badge b-gray', 'Archived'],
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function examActionLink(e: any) {
  switch (e.action) {
    case 'monitor':
      return { to: `/teacher/exams/${e.examId}/monitor`, label: 'Monitor' };
    case 'grade':
      return { to: `/teacher/exams/${e.examId}/grading`, label: 'Grade' };
    case 'results':
      return { to: `/teacher/exams/${e.examId}/results`, label: 'Results' };
    default:
      return { to: `/teacher/exams/${e.examId}/${e.status === 'scheduled' ? 'review' : 'details'}`, label: 'Edit' };
  }
}

export function TeacherDashboard() {
  const loc = useLocation();
  const nav = useNavigate();
  const [published, setPublished] = useState<number | null>((loc.state as any)?.published ?? null);
  const [, setTick] = useState(0);
  useInterval(useCallback(() => setTick((t) => t + 1), []), 1000);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['teacher-dashboard'], queryFn: () => api('/teacher/dashboard'), refetchInterval: 15_000 });

  if (isLoading) return <TeacherShell crumbs={['Teacher', 'Dashboard']}><LoadingState label="Loading your dashboard" /></TeacherShell>;
  if (error) return <TeacherShell crumbs={['Teacher', 'Dashboard']}><ErrorState what="your dashboard" error={error} onRetry={() => refetch()} /></TeacherShell>;
  const s = data.stats;
  const live = data.liveExam;
  const liveLeft = live ? Math.max(0, Math.round((new Date(live.endsAt).getTime() - clock.now()) / 1000)) : 0;
  const stat = (label: string, icon: string, value: string | number, badge?: [string, string]) => (
    <div className="card" style={{ flex: '1 1 200px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="over">{label}</span>
        <span className="icon-tile" style={{ width: 32, height: 32 }}>
          <Icon name={icon} size={17} />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="tnum" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-.02em' }}>
          {value}
        </span>
        {badge && (
          <span className={badge[0]} style={{ height: 22 }}>
            {badge[1]}
          </span>
        )}
      </div>
    </div>
  );
  return (
    <TeacherShell crumbs={['Teacher', 'Dashboard']}>
      {published !== null && (
        <Banner tone="ok" onClose={() => { setPublished(null); nav('.', { replace: true, state: null }); }}>
          <b>Exam published.</b> {published} student{published === 1 ? ' was' : 's were'} notified in the app.
        </Banner>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">
            {greeting()}, {data.greetingName}
          </h1>
          <p className="sub">
            {data.termName ? `${data.termName} · ` : ''}You have {data.summary.liveExams} exam{data.summary.liveExams === 1 ? '' : 's'} live and {data.summary.toGrade} submission{data.summary.toGrade === 1 ? '' : 's'} waiting for review.
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <Link className="btn btn-secondary" to="/teacher/questions?new=1">
            <Icon name="plus" />
            New question
          </Link>
          <Link className="btn btn-primary" to="/teacher/exams/new">
            <Icon name="plus" />
            Create exam
          </Link>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {stat('Active exams', 'fileplus', s.activeExams, s.activeExamsDeltaWeek ? ['badge b-blue', `+${s.activeExamsDeltaWeek} this week`] : undefined)}
        {stat('Students', 'users', s.students, ['badge b-gray', `${s.classes} class${s.classes === 1 ? '' : 'es'}`])}
        {stat('To grade', 'check', s.toGrade, s.toGrade ? ['badge b-amber', 'Needs review'] : undefined)}
        {stat('Avg. score', 'award', s.avgScorePercent != null ? `${s.avgScorePercent}%` : '—')}
      </div>
      {live && (
        <section className="card" style={{ padding: '22px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24, borderColor: 'var(--bad-line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '1 1 320px' }}>
            <span className="icon-tile" style={{ background: 'var(--bad-bg)', color: 'var(--bad)', width: 44, height: 44 }}>
              <Icon name="pulse" size={22} />
            </span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="badge b-red">
                  <Icon name="dot" size={8} />
                  LIVE
                </span>
                <span style={{ fontWeight: 700, fontSize: 16 }}>{live.shortTitle}</span>
              </div>
              <div className="hint" style={{ marginTop: 4 }}>
                {langList(live.languages)} · window closes in{' '}
                <span className="mono tnum" style={{ color: 'var(--text)' }}>
                  {fmtClock(liveLeft)}
                </span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            {[
              ['In progress', live.inProgress],
              ['Submitted', live.submitted],
              ['Flags', live.flags],
            ].map(([a, b], i) => (
              <div key={String(a)}>
                <div className="over">{a}</div>
                <div className="tnum" style={{ fontSize: 20, fontWeight: 700, color: i === 2 && Number(b) > 0 ? 'var(--bad)' : undefined }}>
                  {b}
                </div>
              </div>
            ))}
          </div>
          <Link className="btn btn-primary" to={`/teacher/exams/${live.examId}/monitor`}>
            Open live monitor
            <Icon name="arrowr" />
          </Link>
        </section>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <section className="card" style={{ flex: '3 1 600px', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px' }}>
            <h2 className="h2">My exams</h2>
            <span className="badge b-gray">
              {data.exams.length} exam{data.exams.length === 1 ? '' : 's'}
            </span>
          </div>
          {data.exams.length === 0 ? (
            <div style={{ padding: '0 24px 24px' }}>
              <EmptyState
                title="No exams yet"
                text="Create your first exam to see it here with its schedule and submissions."
                action={
                  <Link className="btn btn-primary" to="/teacher/exams/new">
                    <Icon name="plus" />
                    Create exam
                  </Link>
                }
              />
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th>Exam / course</th>
                    <th>Languages</th>
                    <th>Status</th>
                    <th>Schedule</th>
                    <th>Submissions</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.exams.map((e: any) => {
                    const [cls, label] = STATUS_BADGE[e.status] ?? ['badge b-gray', e.status];
                    const act = examActionLink(e);
                    return (
                      <tr key={e.examId}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{e.title}</div>
                          <div style={{ fontSize: 13, color: 'var(--muted)' }}>{e.course}</div>
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {e.languages.map((l: string) => (
                              <LangBadge key={l} lang={l} />
                            ))}
                          </div>
                        </td>
                        <td>
                          <span className={cls}>
                            <Icon name="dot" size={8} />
                            {label}
                          </span>
                        </td>
                        <td className="tnum" style={{ whiteSpace: 'nowrap' }}>
                          {e.startsAt ? new Date(e.startsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'Not scheduled'}
                        </td>
                        <td className="tnum" style={{ whiteSpace: 'nowrap' }}>
                          {!e.submissions ? '—' : e.status === 'live' ? `${e.submissions.inProgress} in progress` : `${e.submissions.submitted} / ${e.submissions.assigned}`}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Link className="btn btn-ghost btn-sm" to={act.to}>
                            {act.label}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: '20px 24px' }}>
            <h2 className="h2">Recent activity</h2>
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
              {data.recentActivity.length === 0 && <li className="hint" style={{ padding: '12px 0' }}>Nothing yet.</li>}
              {data.recentActivity.map((a: any, i: number) => (
                <li key={i} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ color: a.kind === 'flag' ? 'var(--bad)' : a.kind === 'submission' ? 'var(--ok)' : 'var(--accent-text)', marginTop: 2 }}>
                    <Icon name={a.kind === 'flag' ? 'flag' : a.kind === 'submission' ? 'check' : a.kind === 'question' ? 'chat' : 'book'} size={17} />
                  </span>
                  <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text2)' }}>
                    {a.link ? (
                      <Link to={a.link} style={{ color: 'inherit' }}>
                        {a.actorName && <b>{a.actorName} </b>}
                        {a.text}
                      </Link>
                    ) : (
                      <>
                        {a.actorName && <b>{a.actorName} </b>}
                        {a.text}
                      </>
                    )}
                  </span>
                  <span className="tnum" style={{ fontSize: 12, color: 'var(--faint)', whiteSpace: 'nowrap' }}>
                    {ago(a.at)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 className="h2">Question bank</h2>
              <span className="badge b-gray tnum">{data.questionBank.total}</span>
            </div>
            {data.questionBank.byLanguage.map((b: any) => {
              const max = Math.max(1, ...data.questionBank.byLanguage.map((x: any) => x.count));
              return (
                <div key={b.language} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 92, fontSize: 13, color: 'var(--text2)' }}>{langLabel(b.language)}</span>
                  <span className="bar" style={{ flex: 1 }}>
                    <span style={{ width: `${Math.round((100 * b.count) / max)}%` }} />
                  </span>
                  <span className="tnum" style={{ width: 24, textAlign: 'right', fontSize: 13 }}>
                    {b.count}
                  </span>
                </div>
              );
            })}
            <Link className="btn btn-secondary btn-sm" to="/teacher/questions" style={{ alignSelf: 'flex-start' }}>
              <Icon name="book" size={15} />
              Open question bank
            </Link>
          </section>
        </div>
      </div>
    </TeacherShell>
  );
}
