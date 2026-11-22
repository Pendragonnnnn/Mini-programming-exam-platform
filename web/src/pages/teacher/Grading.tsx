import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, download } from '../../api/client';
import { CodeEditor } from '../../components/CodeEditor';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { Avatar, Banner, EmptyState, ErrorState, fmtDate, LangBadge, LoadingState, Seg, Spinner, toast, QTYPE_LABEL, Markdown } from '../../components/ui';

export function Grading() {
  const { examId } = useParams();
  const [sp, setSp] = useSearchParams();
  const [filter, setFilter] = useState<'all' | 'review' | 'reviewed'>('all');
  const [search, setSearch] = useState('');
  const roster = useQuery({ queryKey: ['roster', examId, filter, search], queryFn: () => api(`/teacher/exams/${examId}/grading/roster`, { query: { filter, q: search } }), placeholderData: (p) => p, refetchInterval: 10_000 });
  const selected = sp.get('s') ?? roster.data?.items[0]?.submissionId ?? null;
  const crumbs = ['Teacher', 'Grading', roster.data?.exam.shortTitle ?? '…'];
  if (roster.isLoading) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading submissions" /></TeacherShell>;
  if (roster.error && !roster.data) return <TeacherShell crumbs={crumbs}><ErrorState what="submissions" error={roster.error} onRetry={() => roster.refetch()} /></TeacherShell>;
  const r = roster.data;
  const items = r.items as any[];
  const select = (id: string) => setSp({ s: id }, { replace: true });
  const next = () => {
    const i = items.findIndex((x) => x.submissionId === selected);
    const after = [...items.slice(i + 1), ...items.slice(0, Math.max(0, i))].find((x) => x.gradingStatus !== 'reviewed');
    if (after) select(after.submissionId);
    else toast.ok('Every submission is reviewed. You can release results now.');
  };
  return (
    <TeacherShell crumbs={crumbs} wide>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">Grading · {r.exam.shortTitle}</h1>
          <p className="sub">
            {r.counts.reviewed} of {r.counts.all} reviewed. Tests give the auto score and the AI assistant suggests a score and feedback — you set the final grade.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {r.exam.status === 'live' && (
            <Link className="btn btn-secondary" to={`/teacher/exams/${examId}/monitor`}>
              <Icon name="pulse" />
              Live monitor
            </Link>
          )}
          <Link className="btn btn-primary" to={`/teacher/exams/${examId}/results`}>
            <Icon name="chart" />
            Results
          </Link>
        </div>
      </div>
      {r.exam.resultsReleasedAt && <Banner tone="info">Results are released. Changes you make now are visible to students right away.</Banner>}
      {r.counts.all === 0 ? (
        <EmptyState title="No submissions yet" text="Submissions appear here as soon as students submit." />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
          <aside className="card" style={{ flex: '1 1 280px', maxWidth: 360, minWidth: 0, overflow: 'hidden', position: 'sticky', top: 88 }}>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid var(--border)' }}>
              <Seg small value={filter} onChange={setFilter} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }} options={[{ value: 'all', label: `All ${r.counts.all}` }, { value: 'review', label: `To review ${r.counts.review}` }, { value: 'reviewed', label: `Done ${r.counts.reviewed}` }]} />
              <label className="field" style={{ height: 36 }}>
                <Icon name="search" stroke="var(--muted)" />
                <input type="search" placeholder="Find a student…" aria-label="Find a student" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
              {items.length === 0 && <li className="hint" style={{ padding: 16 }}>No submissions match.</li>}
              {items.map((x) => (
                <li key={x.submissionId}>
                  <button
                    type="button"
                    onClick={() => select(x.submissionId)}
                    aria-current={x.submissionId === selected}
                    style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'center', padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border)', background: x.submissionId === selected ? 'var(--accent-weak)' : 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
                  >
                    <Avatar initials={x.initials} size={32} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.fullName}</span>
                      <span style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        {x.perQuestion.map((p: any) => (
                          <span key={p.position} className="tnum" title={`Q${p.position}`} style={{ fontSize: 11, padding: '1px 5px', borderRadius: 5, background: p.hasFailures ? 'var(--warn-bg)' : 'var(--ok-bg)', color: p.hasFailures ? 'var(--warn)' : 'var(--ok)' }}>
                            {p.score}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span className="tnum" style={{ display: 'block', fontWeight: 700 }}>
                        {x.total}
                        <span className="hint">/{x.maxTotal}</span>
                      </span>
                      {x.gradingStatus === 'reviewed' ? (
                        <span className="badge b-green" style={{ height: 20 }}>
                          Reviewed
                        </span>
                      ) : x.gradingStatus === 'pending_tests' ? (
                        <span className="badge b-gray" style={{ height: 20 }}>
                          Testing
                        </span>
                      ) : (
                        <span className="badge b-amber" style={{ height: 20 }}>
                          Review
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <div style={{ flex: '4 1 640px', minWidth: 0 }}>{selected ? <SubmissionDetail key={selected} submissionId={selected} onNext={next} /> : <EmptyState title="Choose a submission" text="Pick a student on the left." />}</div>
        </div>
      )}
    </TeacherShell>
  );
}

function SubmissionDetail({ submissionId, onNext }: { submissionId: string; onNext: () => void }) {
  const qc = useQueryClient();
  const [qi, setQi] = useState(0);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['submission', submissionId],
    queryFn: () => api(`/teacher/grading/submissions/${submissionId}`),
    refetchInterval: (q) => {
      const d: any = q.state.data;
      if (!d) return false;
      const waiting = d.gradingStatus === 'pending_tests' || d.questions.some((x: any) => ['queued', 'running'].includes(x.gradingRunStatus) || ['queued', 'running'].includes(x.ai.status));
      return waiting ? 3000 : false;
    },
  });
  const [busy, setBusy] = useState(false);
  if (isLoading) return <LoadingState label="Loading the submission" />;
  if (error) return <ErrorState what="the submission" error={error} onRetry={() => refetch()} />;
  const d = data;
  const q = d.questions[Math.min(qi, d.questions.length - 1)];
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['roster'] });
    qc.invalidateQueries({ queryKey: ['submission', submissionId] });
  };
  const markReviewed = async (goNext: boolean) => {
    setBusy(true);
    try {
      await api(`/teacher/grading/submissions/${submissionId}/review`, { method: 'POST' });
      invalidate();
      toast.ok(`${d.student.fullName} marked as reviewed.`);
      if (goNext) onNext();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="card" style={{ padding: '18px 22px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
        <Avatar initials={d.student.initials} size={42} strong />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 17 }}>{d.student.fullName}</div>
          <div className="hint">
            <span className="mono">{d.student.studentNumber}</span> · submitted {fmtDate(d.submittedAt)}
            {d.submitReason !== 'student' ? ` · ${d.submitReason === 'timeout' ? 'auto-submitted at time end' : d.submitReason === 'tab_switch_limit' ? 'auto-submitted (tab switches)' : 'submitted when the exam ended'}` : ''}
            {d.extraMinutes ? ` · +${d.extraMinutes} min accommodation` : ''}
          </div>
        </div>
        {d.flagCount > 0 && (
          <span className="badge b-red">
            <Icon name="flag" size={12} />
            {d.flagCount} integrity event{d.flagCount === 1 ? '' : 's'}
          </span>
        )}
        <div style={{ textAlign: 'right' }}>
          <div className="over">Total</div>
          <div className="tnum" style={{ fontSize: 24, fontWeight: 700 }}>
            {d.total}
            <span className="hint" style={{ fontSize: 15 }}>
              {' '}
              / {d.maxTotal}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(`/teacher/grading/submissions/${submissionId}/files.zip`, 'submission.zip').catch((e) => toast.error(e))}>
            <Icon name="download" size={15} />
            Files
          </button>
          {d.gradingStatus === 'reviewed' ? (
            <button type="button" className="btn btn-secondary" onClick={onNext}>
              Next to review
              <Icon name="arrowr" />
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => markReviewed(true)} disabled={busy || d.gradingStatus === 'pending_tests'}>
              <Icon name="check" />
              Mark reviewed &amp; next
            </button>
          )}
        </div>
      </section>
      {d.gradingStatus === 'pending_tests' && (
        <Banner tone="info">
          <Spinner /> Hidden tests are still running for this submission…
        </Banner>
      )}
      <div role="tablist" aria-label="Questions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {d.questions.map((x: any, i: number) => (
          <button key={x.submissionAnswerId} type="button" role="tab" aria-selected={i === qi} className={`chip ${i === qi ? 'chip-on' : ''}`} onClick={() => setQi(i)}>
            {x.label}
            <span className="tnum" style={{ fontWeight: 700 }}>
              {x.finalScore}/{x.maxScore}
            </span>
          </button>
        ))}
      </div>
      {q && <QuestionGrade key={q.submissionAnswerId} q={q} onChanged={invalidate} />}
    </div>
  );
}

function QuestionGrade({ q, onChanged }: { q: any; onChanged: () => void }) {
  const [score, setScore] = useState<number>(q.finalScore);
  const [feedback, setFeedback] = useState<string>(q.feedback);
  const [file, setFile] = useState<string>(q.primaryFile);
  const [saving, setSaving] = useState(false);
  const [accepted, setAccepted] = useState<boolean | undefined>(undefined);
  const [testView, setTestView] = useState<'all' | 'failed'>('all');
  const touched = useRef(false);
  useEffect(() => {
    // Follow server updates (tests finishing, a save) until the teacher starts editing.
    if (!touched.current) {
      setScore(q.finalScore);
      setFeedback(q.feedback);
    }
  }, [q.finalScore, q.feedback]);
  const edit = { score: (v: number) => { touched.current = true; setScore(v); }, feedback: (v: string) => { touched.current = true; setFeedback(v); } };
  const dirty = score !== q.finalScore || feedback !== q.feedback;
  const cur = q.files.find((f: any) => f.path === file) ?? q.files[0];
  const hl = useMemo(() => {
    const all = [...(q.highlightLines ?? []), ...(q.ai?.highlightLines ?? [])];
    return [...new Set(all.filter((h: any) => h.path === cur?.path).flatMap((h: any) => h.lines as number[]))];
  }, [q, cur?.path]);
  const tests = testView === 'failed' ? q.tests.filter((t: any) => !t.passed) : q.tests;

  const save = async () => {
    setSaving(true);
    try {
      await api(`/teacher/grading/answers/${q.submissionAnswerId}`, { method: 'PUT', body: { teacherScore: score, feedback, acceptedAiSuggestion: accepted } });
      toast.ok('Grade saved.');
      touched.current = false;
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SCORE_OUT_OF_RANGE') setScore(Math.max(0, Math.min(q.maxScore, score)));
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  const askAi = async () => {
    try {
      await api(`/teacher/grading/answers/${q.submissionAnswerId}/ai-suggestion`, { method: 'POST' });
      toast.info('Asking the AI assistant…');
      onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  const ai = q.ai;
  const isCode = !q.type || q.type === 'code';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      {!isCode ? <ChoiceReview q={q} /> : (
      <section className="card" style={{ flex: '3 1 520px', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <LangBadge lang={q.language} />
          {q.files.map((f: any) => (
            <button key={f.path} type="button" className={`chip ${f.path === cur?.path ? 'chip-on' : ''}`} style={{ height: 30 }} onClick={() => setFile(f.path)}>
              <span className="mono" style={{ fontSize: 12 }}>
                {f.path}
              </span>
            </button>
          ))}
          {hl.length > 0 && <span className="hint" style={{ marginLeft: 'auto' }}>Highlighted lines need a look</span>}
        </div>
        <div style={{ height: 460 }}>{cur ? <CodeEditor key={cur.path} readOnly language={q.language} value={cur.content} highlightLines={hl} ariaLabel={cur.path} /> : <p className="hint" style={{ padding: 18 }}>No files were submitted.</p>}</div>
        {q.compileOutput && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bad-bg)' }}>
            <b style={{ color: 'var(--bad)' }}>Compile error</b>
            <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '6px 0 0', maxHeight: 160, overflow: 'auto' }}>
              {q.compileOutput}
            </pre>
          </div>
        )}
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
            <b>Tests</b>
            <span className={q.testsPassed === q.testsTotal && q.testsTotal ? 'badge b-green tnum' : 'badge b-amber tnum'}>
              {q.testsPassed} / {q.testsTotal} passed
            </span>
            {['queued', 'running'].includes(q.gradingRunStatus) && <Spinner />}
            <span style={{ flex: 1 }} />
            <Seg small value={testView} onChange={setTestView} options={[{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }]} />
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 280, overflow: 'auto' }}>
            {tests.map((t: any, i: number) => (
              <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 16px', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                <span style={{ color: t.passed ? 'var(--ok)' : 'var(--bad)', marginTop: 1 }}>
                  <Icon name={t.passed ? 'check' : 'x'} size={16} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="mono">{t.name}</span> {t.hidden && <span className="badge b-gray" style={{ height: 18 }}>hidden</span>}
                  {!t.passed && <div style={{ color: 'var(--text2)', marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.detail}</div>}
                </span>
                <span className="tnum hint" style={{ whiteSpace: 'nowrap' }}>
                  {t.pointsAwarded}/{t.pointsPossible} pts{t.timeMs != null ? ` · ${t.timeMs} ms` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      )}
      <div style={{ flex: '2 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 className="h2">Your grade</h2>
            <span className="hint tnum">Auto score {q.autoScore ?? '—'} / {q.maxScore}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" className="icon-btn" aria-label="Lower score" onClick={() => edit.score(Math.max(0, score - 1))}>
              <Icon name="minus" />
            </button>
            <div className="field" style={{ width: 110 }}>
              <input type="number" min={0} max={q.maxScore} aria-label="Score" className="tnum" style={{ textAlign: 'center', fontWeight: 700, fontSize: 18 }} value={score} onChange={(e) => edit.score(Math.max(0, Math.min(q.maxScore, parseInt(e.target.value, 10) || 0)))} />
            </div>
            <button type="button" className="icon-btn" aria-label="Raise score" onClick={() => edit.score(Math.min(q.maxScore, score + 1))}>
              <Icon name="plus" />
            </button>
            <span className="hint tnum">/ {q.maxScore}</span>
            {q.autoScore !== null && score !== q.autoScore && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => edit.score(q.autoScore)}>
                Reset to auto
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="label" htmlFor={`fb-${q.submissionAnswerId}`}>
              Feedback for the student
            </label>
            <div className="field area">
              <textarea id={`fb-${q.submissionAnswerId}`} rows={5} value={feedback} onChange={(e) => edit.feedback(e.target.value)} placeholder="What went well, and what to fix…" maxLength={5000} />
            </div>
            <span className="hint">Students see this with their score after you release results.</span>
          </div>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            <Icon name="save" />
            {saving ? 'Saving…' : dirty ? 'Save grade' : 'Saved'}
          </button>
        </section>
        {isCode && (
        <section className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, borderColor: 'var(--accent-line, var(--border))' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="icon-tile" style={{ width: 32, height: 32 }}>
              <Icon name="sparkle" size={16} />
            </span>
            <h2 className="h2" style={{ flex: 1 }}>
              AI assistant
            </h2>
            {ai.model && <span className="hint">{ai.model}</span>}
          </div>
          {ai.status === 'disabled' && <p className="hint" style={{ margin: 0 }}>The AI assistant is turned off on this server.</p>}
          {['queued', 'running'].includes(ai.status) && (
            <p className="hint" style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Spinner /> {q.autoScore === null ? 'Waiting for tests to finish…' : 'Reviewing the code…'}
            </p>
          )}
          {ai.status === 'failed' && (
            <>
              <p className="err-text" style={{ margin: 0 }}>{ai.error}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={askAi}>
                <Icon name="refresh" size={15} />
                Try again
              </button>
            </>
          )}
          {ai.status === 'done' && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="over">Suggested</span>
                <span className="tnum" style={{ fontSize: 20, fontWeight: 700 }}>
                  {ai.suggestedScore} / {q.maxScore}
                </span>
              </div>
              {ai.rationale && <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text2)' }}>{ai.rationale}</p>}
              {ai.requirementChecks?.length > 0 && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {ai.requirementChecks.map((c: any, i: number) => (
                    <li key={i} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                      <span style={{ color: c.met ? 'var(--ok)' : 'var(--warn)' }}>
                        <Icon name={c.met ? 'check' : 'alert'} size={15} />
                      </span>
                      <span>
                        {c.requirement}
                        {c.evidence ? <span className="hint"> — {c.evidence}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {ai.suggestedFeedback && (
                <blockquote style={{ margin: 0, padding: '10px 12px', borderLeft: '3px solid var(--accent)', background: 'var(--surface2)', borderRadius: 6, fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{ai.suggestedFeedback}</blockquote>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    edit.score(Math.max(0, Math.min(q.maxScore, ai.suggestedScore ?? score)));
                    if (ai.suggestedFeedback) edit.feedback(ai.suggestedFeedback);
                    setAccepted(true);
                  }}
                >
                  <Icon name="tick" size={15} />
                  Use suggestion
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={askAi}>
                  <Icon name="refresh" size={15} />
                  Ask again
                </button>
              </div>
              <span className="hint">Suggestions only — nothing changes until you save your grade.</span>
            </>
          )}
        </section>
        )}
      </div>
    </div>
  );
}

/** Teacher view of a multiple choice / multiple answers / true-false / short answer response. */
function ChoiceReview({ q }: { q: any }) {
  const c = q.choice;
  return (
    <section className="card" style={{ flex: '3 1 520px', minWidth: 0, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span className="badge b-gray">{QTYPE_LABEL[q.type]}</span>
        <span className={c.correct ? 'badge b-green' : 'badge b-red'}>{c.correct ? 'Correct' : q.type === 'multiple_choice' && q.autoScore > 0 ? 'Partly correct' : 'Wrong'}</span>
        {c.partialCredit && <span className="hint">Partial credit on</span>}
      </div>
      {q.instructionsMd && <Markdown text={q.instructionsMd} />}
      {q.type === 'short_answer' ? (
        <>
          <div>
            <div className="over">Student answer</div>
            <div style={{ marginTop: 6, padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface2)', whiteSpace: 'pre-wrap', fontSize: 15 }}>{c.studentText?.trim() ? c.studentText : <span className="hint">No answer</span>}</div>
          </div>
          <div>
            <div className="over">Accepted answers{c.caseSensitive ? ' (case sensitive)' : ''}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {c.acceptedAnswers.map((a: string) => (
                <span key={a} className="badge b-green">{a}</span>
              ))}
            </div>
          </div>
          {!c.correct && c.studentText?.trim() && <span className="hint">The answer didn't match exactly. If it is right, give the points in “Your grade”.</span>}
        </>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {c.options.map((o: any) => (
            <li key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${o.selected ? (o.correct ? 'var(--ok)' : 'var(--bad)') : 'var(--border)'}`, background: o.selected ? (o.correct ? 'var(--ok-bg)' : 'var(--bad-bg)') : 'transparent' }}>
              <Icon name={o.selected ? (o.correct ? 'check' : 'x') : 'dot'} size={17} />
              <span style={{ flex: 1 }}>{o.text}</span>
              {o.selected && <span className="hint">Student's choice</span>}
              {o.correct && <span className="badge b-green">Correct answer</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
