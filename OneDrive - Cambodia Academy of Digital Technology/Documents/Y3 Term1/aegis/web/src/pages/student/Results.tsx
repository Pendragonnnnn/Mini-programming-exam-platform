import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { Icon } from '../../components/Icon';
import { StudentShell } from '../../components/Shell';
import { Banner, EmptyState, ErrorState, LangBadge, LoadingState, Seg, QTYPE_LABEL } from '../../components/ui';

export function StudentResults() {
  const { examId } = useParams();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['student-results'], queryFn: () => api('/student/results') });
  const current = examId ?? list.data?.items?.[0]?.examId;
  const detail = useQuery({
    queryKey: ['student-result', current],
    queryFn: () => api(`/student/results/${current}`),
    enabled: !!current,
    refetchInterval: (q) => (q.state.data && !q.state.data.released ? 20_000 : false),
  });

  if (list.isLoading || (current && detail.isLoading)) return <StudentShell><LoadingState label="Loading your results" /></StudentShell>;
  if (list.error) return <StudentShell><ErrorState what="your results" error={list.error} onRetry={() => list.refetch()} /></StudentShell>;
  if (detail.error) return <StudentShell><ErrorState what="this result" error={detail.error} onRetry={() => detail.refetch()} /></StudentShell>;
  const items = list.data.items as any[];
  if (!current)
    return (
      <StudentShell>
        <EmptyState
          title="No results yet"
          text="Results appear here after you submit an exam and your teacher releases the scores."
          action={
            <Link className="btn btn-primary" to="/student">
              Back to my exams
            </Link>
          }
        />
      </StudentShell>
    );
  const d = detail.data;
  return (
    <StudentShell>
      {d?.justSubmitted && !d.released && (
        <Banner tone="ok">
          <b>Exam submitted.</b> Hidden tests are running. Your teacher will release your final score after review.
        </Banner>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">Results</h1>
          <p className="sub">{d?.released ? `${d.title} · ${d.subtitle}` : d?.title ?? ''}</p>
        </div>
        {items.length > 1 && (
          <Seg
            value={current}
            onChange={(v) => nav(`/student/results/${v}`)}
            options={items.slice(0, 5).map((x) => ({ value: x.examId, label: x.title.split(':')[0] }))}
          />
        )}
      </div>
      {!d?.released ? (
        <EmptyState
          icon="clock"
          title="Your score isn't released yet"
          text="Your teacher is reviewing the exam. You'll see your score, test results and feedback here once they release them."
          action={
            <Link className="btn btn-secondary" to="/student">
              Back to my exams
            </Link>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          <aside className="card" style={{ flex: '1 1 300px', minWidth: 0, padding: 26, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
            <div role="img" aria-label={`Score ${d.score} out of ${d.maxScore}`} style={{ width: 168, height: 168, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `conic-gradient(var(--accent) 0 ${(100 * d.score) / (d.maxScore || 100)}%, var(--surface3) ${(100 * d.score) / (d.maxScore || 100)}% 100%)` }}>
              <div style={{ width: 136, height: 136, borderRadius: 999, background: 'var(--surface)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span className="tnum" style={{ fontSize: 38, fontWeight: 700, lineHeight: 1 }}>
                  {d.score}
                </span>
                <span className="hint">of {d.maxScore}</span>
              </div>
            </div>
            <span className="badge b-green">Graded · released {new Date(d.releasedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5 }}>
              {[
                ['Class average', d.facts.classAverage ?? '—'],
                ['Your rank', d.facts.rankTopPercent ? `Top ${d.facts.rankTopPercent}%` : '—'],
                ['Time used', `${d.facts.timeUsedMinutes} min`],
                ...(d.facts.testsTotal ? [['Tests passed', `${d.facts.testsPassed} / ${d.facts.testsTotal}`]] : []),
              ].map(([a, b]) => (
                <div key={String(a)} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="muted">{a}</span>
                  <b className="tnum">{b}</b>
                </div>
              ))}
            </div>
            <Link className="btn btn-secondary btn-sm" to="/student" style={{ width: '100%' }}>
              <Icon name="arrowl" size={14} />
              Back to my exams
            </Link>
          </aside>
          <div style={{ flex: '3 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {d.questions.map((q: any) => (
              <section key={q.position} className="card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                  <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 9, background: 'var(--surface3)', fontWeight: 700 }}>
                    {q.position}
                  </span>
                  <h2 className="h2" style={{ flex: 1 }}>
                    {q.title}
                  </h2>
                  {q.type && q.type !== 'code' ? <span className="badge b-gray">{QTYPE_LABEL[q.type]}</span> : <LangBadge lang={q.language} />}
                  <span className="tnum" style={{ fontWeight: 700, fontSize: 16 }}>
                    {q.score}
                    <span className="hint"> / {q.maxScore}</span>
                  </span>
                </div>
                <span className="bar">
                  <span style={{ width: `${q.maxScore ? Math.round((100 * q.score) / q.maxScore) : 0}%`, background: q.score === q.maxScore ? 'var(--ok)' : 'var(--accent)' }} />
                </span>
                {q.type && q.type !== 'code' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
                    <div>
                      <span className="hint">Your answer: </span>
                      <b>{q.yourAnswer ?? 'No answer'}</b>{' '}
                      <span className={q.correct ? 'badge b-green' : 'badge b-red'}>{q.correct ? 'Correct' : 'Not correct'}</span>
                    </div>
                    {q.explanation && (
                      <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                        <b>Explanation:</b> {q.explanation}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {q.tests.map((t: any) => (
                    <span key={t.name} className={`badge mono ${t.passed ? 'b-green' : 'b-red'}`} style={{ fontWeight: 500 }}>
                      {t.passed ? '✓' : '✗'} {t.name}
                    </span>
                  ))}
                </div>
                {q.feedback && (
                  <div style={{ display: 'flex', gap: 10, padding: '12px 14px', borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 13.5 }}>
                    <span style={{ color: 'var(--accent-text)' }}>
                      <Icon name="chat" />
                    </span>
                    <span>
                      <b>{d.teacherName}:</b> <span style={{ color: 'var(--text2)' }}>{q.feedback}</span>
                    </span>
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      )}
    </StudentShell>
  );
}
