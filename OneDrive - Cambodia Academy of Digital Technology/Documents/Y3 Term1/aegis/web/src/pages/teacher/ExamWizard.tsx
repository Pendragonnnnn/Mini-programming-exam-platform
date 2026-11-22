import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { Avatar, Banner, DIFF_CLS, DIFF_LABEL, ErrorState, LangBadge, LoadingState, Seg, Switch, toast, QTYPE_LABEL, QTYPES, LANGS, langLabel, langList, EmptyState } from '../../components/ui';

const STEPS = [
  ['details', 'Details & schedule'],
  ['questions', 'Questions'],
  ['settings', 'Rules & settings'],
  ['review', 'Review & publish'],
] as const;
type Step = (typeof STEPS)[number][0];

function Stepper({ examId, step }: { examId?: string; step: Step }) {
  const idx = STEPS.findIndex((s) => s[0] === step);
  return (
    <nav aria-label="Exam setup steps" className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14, padding: '16px 24px' }}>
      {STEPS.map(([k, label], i) => (
        <span key={k} style={{ display: 'contents' }}>
          {i > 0 && <span aria-hidden="true" style={{ flex: 1, minWidth: 24, height: 2, borderRadius: 2, background: i <= idx ? 'var(--accent)' : 'var(--border)' }} />}
          {examId ? (
            <Link to={`/teacher/exams/${examId}/${k}`} aria-current={k === step ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 10, color: k === step ? 'var(--text)' : 'var(--text2)', fontWeight: k === step ? 600 : 400 }}>
              <StepDot i={i} idx={idx} />
              <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
            </Link>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, color: k === step ? 'var(--text)' : 'var(--muted)', fontWeight: k === step ? 600 : 400 }}>
              <StepDot i={i} idx={idx} />
              <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
function StepDot({ i, idx }: { i: number; idx: number }) {
  return (
    <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 999, fontSize: 13, fontWeight: 700, background: i <= idx ? 'var(--accent)' : 'var(--surface3)', color: i <= idx ? '#fff' : 'var(--muted)' }}>
      {i < idx ? <Icon name="tick" size={14} /> : i + 1}
    </span>
  );
}

function qMeta(x: any) {
  const kind = x.type && x.type !== 'code' ? QTYPE_LABEL[x.type] : `${x.testCount} tests`;
  return `${x.topic ? `${x.topic} · ` : ''}${kind}`;
}

export function ExamWizard() {
  const { examId, step: stepParam } = useParams();
  const step: Step = (examId ? (stepParam as Step) : 'details') ?? 'details';
  const exam = useQuery({ queryKey: ['exam', examId], queryFn: () => api(`/teacher/exams/${examId}`), enabled: !!examId });
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => api('/teacher/courses') });
  const title = exam.data?.details?.shortTitle || exam.data?.details?.title || 'New exam';
  const crumbs = ['Teacher', 'Exams', examId ? title : 'New exam'];
  if ((examId && exam.isLoading) || courses.isLoading) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading the exam" /></TeacherShell>;
  if (exam.error || courses.error) return <TeacherShell crumbs={crumbs}><ErrorState what="the exam" error={exam.error ?? courses.error} onRetry={() => { exam.refetch(); courses.refetch(); }} /></TeacherShell>;
  const e = exam.data;
  const locked = e && !['draft', 'scheduled'].includes(e.status);
  return (
    <TeacherShell crumbs={crumbs}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">{examId ? title : 'Create exam'}</h1>
          <p className="sub">{e ? `${e.course.code} · ${e.status === 'draft' ? 'Draft' : e.status === 'scheduled' ? 'Scheduled' : e.status}` : 'Set up the details, pick questions, set the rules, then publish.'}</p>
        </div>
      </div>
      <Stepper examId={examId} step={step} />
      {locked && <Banner tone="info">This exam has started, so its setup is read-only. You can still add accommodations on the Rules step.</Banner>}
      {e?.status === 'scheduled' && step !== 'review' && <Banner tone="warn">This exam is already published. Changes are visible to students right away.</Banner>}
      {step === 'details' && !courses.data.items.length && (
        <EmptyState icon="users" title="Create a course first" text="An exam belongs to a course and is given to its classes. Add a course, a class and your students first." action={<Link className="btn btn-primary" to="/teacher/courses">Go to Courses & students</Link>} />
      )}
      {step === 'details' && courses.data.items.length > 0 && <DetailsStep exam={e} courses={courses.data.items} locked={!!locked} />}
      {step === 'questions' && e && <QuestionsStep exam={e} locked={!!locked} />}
      {step === 'settings' && e && <SettingsStep exam={e} locked={!!locked} />}
      {step === 'review' && e && <ReviewStep exam={e} />}
    </TeacherShell>
  );
}

// ------------------------------------------------------------------ step 1
const pad = (n: number) => (n < 10 ? '0' : '') + n;
function splitUtc(iso: string | null) {
  if (!iso) return { date: '', time: '09:00' };
  const d = new Date(iso);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

function DetailsStep({ exam, courses, locked }: { exam: any; courses: any[]; locked: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const d = exam?.details;
  const [courseId, setCourseId] = useState<string>(exam?.course.id ?? courses[0]?.id ?? '');
  const [title, setTitle] = useState(d?.title ?? '');
  const [shortTitle, setShortTitle] = useState(d?.shortTitle ?? '');
  const [examType, setExamType] = useState(d?.examType ?? 'midterm');
  const [classIds, setClassIds] = useState<string[]>(d?.classIds ?? []);
  const [instructions, setInstructions] = useState(d?.instructionsMd ?? '');
  const init = splitUtc(d?.startsAt ?? null);
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [duration, setDuration] = useState<number>(d?.durationMinutes ?? 90);
  const [late, setLate] = useState<number>(d?.lateJoinMinutes ?? 15);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const course = courses.find((c) => c.id === courseId);
  const startsAt = date && time ? new Date(`${date}T${time}:00Z`) : null;
  const close = startsAt ? new Date(startsAt.getTime() + (late + duration) * 60_000) : null;
  const local = startsAt ? new Date(startsAt.getTime() + 7 * 3600_000) : null;
  const students = (course?.classes ?? []).filter((c: any) => classIds.includes(c.id)).reduce((a: number, c: any) => a + c.studentCount, 0);
  const conflicts = useQuery({
    queryKey: ['conflicts', exam?.id, startsAt?.toISOString(), duration, late, classIds.join(',')],
    queryFn: () => api(`/teacher/exams/${exam.id}/schedule-conflicts`, { query: { startsAt: startsAt!.toISOString(), durationMinutes: duration, lateJoinMinutes: late, classIds: classIds.join(',') } }),
    enabled: !!exam?.id && !!startsAt && classIds.length > 0,
  });
  useEffect(() => {
    if (!exam && course) setClassIds((ids) => ids.filter((id) => course.classes.some((c: any) => c.id === id)));
  }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const fe: Record<string, string> = {};
    if (!title.trim()) fe.title = 'Enter an exam title.';
    if (!courseId) fe.courseId = 'Choose a course.';
    if (Object.keys(fe).length) return setErrors(fe);
    setErrors({});
    setBusy(true);
    const body = { title: title.trim(), shortTitle: shortTitle.trim() || null, examType, classIds, instructionsMd: instructions, startsAt: startsAt ? startsAt.toISOString() : null, durationMinutes: duration, lateJoinMinutes: late };
    try {
      let id = exam?.id;
      if (!id) {
        const created = await api('/teacher/exams', { method: 'POST', body: { ...body, courseId } });
        id = created.id;
      } else if (!locked) {
        await api(`/teacher/exams/${id}/details`, { method: 'PATCH', body });
      }
      qc.invalidateQueries({ queryKey: ['exam', id] });
      qc.invalidateQueries({ queryKey: ['teacher-dashboard'] });
      nav(`/teacher/exams/${id}/questions`);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = (k: string) => errors[k] && <span className="err-text">{errors[k]}</span>;
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ flex: '3 1 600px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="icon-tile">
                <Icon name="file" size={18} />
              </span>
              <h2 className="h2">Exam details</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="label" htmlFor="et">
                Exam title <span style={{ color: 'var(--bad)' }}>*</span>
              </label>
              <div className={`field ${errors.title ? 'invalid' : ''}`}>
                <input id="et" value={title} onChange={(e) => setTitle(e.target.value)} disabled={locked} placeholder="e.g. Programming 1 — Midterm" />
              </div>
              {fieldErr('title')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="co">
                  Course <span style={{ color: 'var(--bad)' }}>*</span>
                </label>
                <div className="field">
                  <select id="co" value={courseId} onChange={(e) => setCourseId(e.target.value)} disabled={!!exam}>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} · {c.title}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevd" stroke="var(--muted)" />
                </div>
                {fieldErr('courseId')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="ty">
                  Exam type
                </label>
                <div className="field">
                  <select id="ty" value={examType} onChange={(e) => setExamType(e.target.value)} disabled={locked}>
                    {['quiz', 'midterm', 'final', 'lab'].map((t) => (
                      <option key={t} value={t}>
                        {t[0]!.toUpperCase() + t.slice(1)}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevd" stroke="var(--muted)" />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="st">
                  Short name
                </label>
                <div className="field">
                  <input id="st" value={shortTitle} onChange={(e) => setShortTitle(e.target.value)} disabled={locked} placeholder="e.g. Midterm" />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="label">Classes</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(course?.classes ?? []).map((c: any) => {
                  const on = classIds.includes(c.id);
                  return (
                    <button key={c.id} type="button" className={`chip ${on ? 'chip-on' : ''}`} aria-pressed={on} disabled={locked} onClick={() => setClassIds(on ? classIds.filter((x) => x !== c.id) : [...classIds, c.id])}>
                      {on && <Icon name="tick" size={13} />}
                      {c.code} · {c.studentCount}
                    </button>
                  );
                })}
              </div>
              <span className="hint">{classIds.length ? `${students} students will receive this exam.` : 'Choose at least one class before publishing.'}</span>
              {fieldErr('classIds')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="label" htmlFor="ins">
                Instructions for students
              </label>
              <div className="field area">
                <textarea id="ins" rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={locked} />
              </div>
              <span className="hint">Shown on the lobby screen before the exam starts. Markdown supported.</span>
            </div>
          </section>
          <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="icon-tile">
                <Icon name="calendar" size={18} />
              </span>
              <h2 className="h2">Schedule &amp; duration</h2>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="sd">
                  Start date (UTC) <span style={{ color: 'var(--bad)' }}>*</span>
                </label>
                <div className={`field ${errors.startsAt ? 'invalid' : ''}`}>
                  <Icon name="calendar" stroke="var(--muted)" />
                  <input id="sd" type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={locked} />
                </div>
                {fieldErr('startsAt')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="stt">
                  Start time (UTC) <span style={{ color: 'var(--bad)' }}>*</span>
                </label>
                <div className="field">
                  <Icon name="clock" stroke="var(--muted)" />
                  <input id="stt" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={locked} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="label">Students' local time</span>
                <div className="field readonly">
                  <Icon name="globe" stroke="var(--muted)" />
                  <span className="tnum">{local ? `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}${local.getUTCDate() !== startsAt!.getUTCDate() ? ' next day' : ''} in Phnom Penh` : '—'}</span>
                </div>
                <span className="hint">Phnom Penh (UTC+07:00). Everyone starts at the same moment.</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="label">Duration</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <Seg value={[15, 30, 45, 60, 90, 120, 180].includes(duration) ? String(duration) : ''} onChange={(v) => !locked && setDuration(Number(v))} options={[15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: String(m), label: `${m} min` }))} />
                <div className="field" style={{ width: 150 }}>
                  <input type="number" aria-label="Duration in minutes" min={5} max={600} value={duration} disabled={locked} onChange={(e) => setDuration(Math.max(5, Math.min(600, parseInt(e.target.value, 10) || 5)))} className="tnum" />
                  <span className="hint">minutes</span>
                </div>
              </div>
              <span className="hint">Pick a length or type any value from 5 to 600 minutes. Students get the full duration from the moment they start, up to the window close.</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="lj">
                  Late join window
                </label>
                <div className="field">
                  <Icon name="timer" stroke="var(--muted)" />
                  <select id="lj" value={late} onChange={(e) => setLate(Number(e.target.value))} disabled={locked}>
                    {[0, 5, 10, 15, 30, 60].map((m) => (
                      <option key={m} value={m}>
                        {m === 0 ? 'No late join' : `${m} minutes after start`}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevd" stroke="var(--muted)" />
                </div>
                <span className="hint">Lockout closes strictly after this window.</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="label">Window closes (UTC)</span>
                <div className="field readonly">
                  <Icon name="lock" stroke="var(--muted)" />
                  <span className="tnum">{close ? `${close.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${pad(close.getUTCHours())}:${pad(close.getUTCMinutes())} UTC` : '—'}</span>
                </div>
                <span className="hint">Start + late window + duration. Updates as you edit.</span>
              </div>
            </div>
          </section>
        </div>
        <aside className="card" style={{ flex: '1 1 300px', minWidth: 0, padding: 22, display: 'flex', flexDirection: 'column', gap: 16, position: 'sticky', top: 88 }}>
          <h2 className="h2">Summary</h2>
          {[
            ['Course', course?.code ?? '—'],
            ['Classes', `${classIds.length} · ${students} students`],
            ['Starts', startsAt ? `${startsAt.toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${time} UTC` : '—'],
            ['Duration', `${duration} minutes`],
            ['Late join', `${late} min`],
            ['Questions', exam ? `${exam.questions.items.length} · ${exam.questions.totalPoints} pts` : '—'],
          ].map(([a, b]) => (
            <div key={a} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13.5 }}>
              <span className="muted">{a}</span>
              <span style={{ fontWeight: 600, textAlign: 'right' }} className="tnum">
                {b}
              </span>
            </div>
          ))}
          {(conflicts.data?.items ?? []).map((c: any) => (
            <div key={c.classCode + c.startsAt} style={{ display: 'flex', gap: 10, padding: 12, borderRadius: 10, background: 'var(--warn-bg)', color: 'var(--warn)', fontSize: 13 }}>
              <Icon name="alert" />
              <span>
                {c.classCode} has a {c.label} that overlaps {new Date(c.startsAt).toISOString().slice(11, 16)}–{new Date(c.endsAt).toISOString().slice(11, 16)} UTC.
              </span>
            </div>
          ))}
        </aside>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, paddingTop: 8 }}>
        <Link className="btn btn-secondary" to="/teacher">
          Cancel
        </Link>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Continue to questions'}
          <Icon name="arrowr" />
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ step 2
function QuestionsStep({ exam, locked }: { exam: any; locked: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<{ questionId: string; points: number; title: string; difficulty: string; languages: string[]; meta: string }[]>(
    exam.questions.items.map((x: any) => ({ questionId: x.questionId, points: x.points, title: x.title, difficulty: x.difficulty, languages: x.languages, meta: qMeta(x) })),
  );
  const [order, setOrder] = useState(exam.questions.questionOrder);
  const [poolSize, setPoolSize] = useState<number>(exam.questions.poolSize ?? Math.max(1, exam.questions.items.length - 1));
  const [query, setQuery] = useState('');
  const [diff, setDiff] = useState('all');
  const [lang, setLang] = useState('all');
  const [busy, setBusy] = useState(false);
  const bank = useQuery({
    queryKey: ['bank', exam.course.id, query, diff, lang],
    queryFn: () =>
      api('/teacher/questions', {
        query: {
          courseId: exam.course.id,
          q: query,
          difficulty: diff === 'all' ? undefined : diff,
          language: lang === 'all' || lang.startsWith('type:') ? undefined : lang,
          type: lang.startsWith('type:') ? lang.slice(5) : lang === 'all' ? undefined : 'code',
          pageSize: 200,
        },
      }),
  });
  const total = picked.reduce((a, p) => a + (Number(p.points) || 0), 0);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= picked.length) return;
    const p = picked.slice();
    [p[i], p[j]] = [p[j]!, p[i]!];
    setPicked(p);
  };
  const save = async (next: boolean) => {
    setBusy(true);
    try {
      await api(`/teacher/exams/${exam.id}/questions`, { method: 'PUT', body: { items: picked.map((p) => ({ questionId: p.questionId, points: Number(p.points) || 0 })), questionOrder: order, poolSize: order === 'pool' ? poolSize : null } });
      qc.invalidateQueries({ queryKey: ['exam', exam.id] });
      if (next) nav(`/teacher/exams/${exam.id}/settings`);
      else toast.ok('Questions saved.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const ORD = [
    ['fixed', 'Fixed order', 'Every student sees the questions in the order above.'],
    ['shuffle', 'Shuffle questions', 'Each student gets the same questions in a random order.'],
    ['pool', 'Random pool', 'Each student gets a random subset of the questions above.'],
  ];
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <section style={{ flex: '3 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 className="h2">Exam questions</h2>
              <span className="badge b-gray">
                {picked.length} question{picked.length === 1 ? '' : 's'}
              </span>
              <span className={total === 100 ? 'badge b-green tnum' : 'badge b-amber tnum'}>{total} / 100 pts</span>
            </div>
            <Link className="btn btn-primary btn-sm" to={`/teacher/questions?new=1&course=${exam.course.id}&back=${exam.id}`}>
              <Icon name="plus" size={15} />
              Create new question
            </Link>
          </div>
          {picked.length === 0 && (
            <div className="card" style={{ padding: 32, textAlign: 'center', boxShadow: 'none', borderStyle: 'dashed' }}>
              <div style={{ fontWeight: 600 }}>Add your first question</div>
              <p className="hint" style={{ margin: '6px 0 0' }}>
                Pick questions from the bank on the right, or create a new one.
              </p>
            </div>
          )}
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {picked.map((q, i) => (
              <li key={q.questionId} className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', boxShadow: 'none' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button type="button" className="icon-btn" style={{ width: 26, height: 22 }} aria-label="Move up" onClick={() => move(i, -1)} disabled={locked}>
                    <Icon name="chevu" size={15} />
                  </button>
                  <button type="button" className="icon-btn" style={{ width: 26, height: 22 }} aria-label="Move down" onClick={() => move(i, 1)} disabled={locked}>
                    <Icon name="chevd" size={15} />
                  </button>
                </div>
                <span className="tnum" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 9, background: 'var(--surface3)', fontWeight: 700 }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{q.title}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <span className={DIFF_CLS[q.difficulty]}>{DIFF_LABEL[q.difficulty]}</span>
                    {q.languages.map((l) => (
                      <LangBadge key={l} lang={l} />
                    ))}
                    <span className="hint">{q.meta}</span>
                  </div>
                </div>
                <div className="field" style={{ width: 100, height: 36 }}>
                  <input type="number" min={0} max={1000} aria-label="Points" value={q.points} disabled={locked} onChange={(e) => setPicked(picked.map((x) => (x.questionId === q.questionId ? { ...x, points: Math.max(0, Math.min(1000, parseInt(e.target.value, 10) || 0)) } : x)))} className="tnum" style={{ height: 34, textAlign: 'right' }} />
                  <span className="hint">pts</span>
                </div>
                <Link className="icon-btn" to={`/teacher/questions/${q.questionId}?back=${exam.id}`} aria-label="Edit question">
                  <Icon name="edit" size={17} />
                </Link>
                <button type="button" className="icon-btn" aria-label="Remove question" disabled={locked} onClick={() => setPicked(picked.filter((x) => x.questionId !== q.questionId))}>
                  <Icon name="trash" size={17} />
                </button>
              </li>
            ))}
          </ol>
          <div className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'none' }}>
            <div className="label">Question order for students</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {ORD.map(([k, label]) => (
                <button key={k} type="button" className={`chip ${order === k ? 'chip-on' : ''}`} aria-pressed={order === k} disabled={locked || (k === 'pool' && picked.length < 2)} onClick={() => setOrder(k)}>
                  {label}
                </button>
              ))}
              {order === 'pool' && (
                <label className="field" style={{ width: 170, height: 34 }}>
                  <span className="hint">Pick</span>
                  <input type="number" min={1} max={Math.max(1, picked.length - 1)} value={poolSize} onChange={(e) => setPoolSize(Math.max(1, parseInt(e.target.value, 10) || 1))} style={{ height: 32 }} />
                  <span className="hint">of {picked.length}</span>
                </label>
              )}
            </div>
            <span className="hint">{ORD.find((o) => o[0] === order)![2]}</span>
          </div>
        </section>
        <aside className="card" style={{ flex: '2 1 340px', minWidth: 0, padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 className="h2">Question bank</h2>
            <span className="badge b-gray tnum">{bank.data?.total ?? '…'}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            <label className="field" style={{ height: 38 }}>
              <Icon name="search" stroke="var(--muted)" />
              <input type="search" placeholder="Search by title or topic…" aria-label="Search question bank" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <div className="field" style={{ height: 38, padding: '0 10px' }}>
                <select aria-label="Difficulty" value={diff} onChange={(e) => setDiff(e.target.value)} style={{ fontSize: 13 }}>
                  <option value="all">All levels</option>
                  <option value="easy">Easy</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
                <Icon name="chevd" size={14} stroke="var(--muted)" />
              </div>
              <div className="field" style={{ height: 38, padding: '0 10px' }}>
                <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} style={{ fontSize: 13 }}>
                  <option value="all">All types & languages</option>
                  {QTYPES.filter((t) => t !== 'code').map((t) => (
                    <option key={t} value={`type:${t}`}>
                      {QTYPE_LABEL[t]}
                    </option>
                  ))}
                  {LANGS.map((l) => (
                    <option key={l} value={l}>
                      Coding · {langLabel(l)}
                    </option>
                  ))}
                </select>
                <Icon name="chevd" size={14} stroke="var(--muted)" />
              </div>
            </div>
          </div>
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
            {bank.isLoading && <li className="hint" style={{ padding: '16px 0' }}>Loading…</li>}
            {bank.data?.items.length === 0 && <li className="hint" style={{ padding: '16px 0' }}>No questions match your search.</li>}
            {(bank.data?.items ?? []).map((b: any) => {
              const added = picked.some((p) => p.questionId === b.id);
              return (
                <li key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link to={`/teacher/questions/${b.id}?back=${exam.id}`} style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>
                      {b.title}
                    </Link>{' '}
                    <span className="hint">· {b.courseCode}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {b.type !== 'code' && <span className="badge b-gray">{QTYPE_LABEL[b.type]}</span>}
                      {b.languages.map((l: string) => (
                        <LangBadge key={l} lang={l} />
                      ))}
                      <span className={DIFF_CLS[b.difficulty]}>{DIFF_LABEL[b.difficulty]}</span>
                      <span className="badge b-gray tnum">{b.points} pts</span>
                      {!b.validated && <span className="badge b-amber">{b.type === 'code' ? 'Not validated' : 'No answer key'}</span>}
                    </div>
                  </div>
                  {added ? (
                    <span className="badge b-green">
                      <Icon name="tick" size={12} />
                      Added
                    </span>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={locked} onClick={() => setPicked([...picked, { questionId: b.id, points: b.points, title: b.title, difficulty: b.difficulty, languages: b.languages, meta: qMeta(b) }])}>
                      <Icon name="plus" size={14} />
                      Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, paddingTop: 8 }}>
        <Link className="btn btn-secondary" to={`/teacher/exams/${exam.id}/details`}>
          <Icon name="arrowl" />
          Back
        </Link>
        <div style={{ display: 'flex', gap: 10 }}>
          {!locked && (
            <button type="button" className="btn btn-secondary" onClick={() => save(false)} disabled={busy}>
              Save
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => (locked ? nav(`/teacher/exams/${exam.id}/settings`) : save(true))} disabled={busy}>
            Continue to rules
            <Icon name="arrowr" />
          </button>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ step 3
function SettingsStep({ exam, locked }: { exam: any; locked: boolean }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [s, setS] = useState({ ...exam.settings });
  const [acc, setAcc] = useState<any[]>(exam.settings.accommodations);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const students = useQuery({ queryKey: ['course-students', exam.course.id, search], queryFn: () => api(`/teacher/courses/${exam.course.id}/students`, { query: { q: search } }), enabled: search.length >= 2 });
  const set = (k: string, v: any) => setS((x: any) => ({ ...x, [k]: v }));
  const save = async (next: boolean) => {
    setBusy(true);
    try {
      if (!locked) {
        const { accommodations: _a, sebRequired: _s, ...body } = s;
        await api(`/teacher/exams/${exam.id}/settings`, { method: 'PATCH', body });
      }
      await api(`/teacher/exams/${exam.id}/accommodations`, { method: 'PUT', body: { items: acc.map((a) => ({ studentId: a.studentId, extraMinutes: Number(a.extraMinutes) })) } });
      qc.invalidateQueries({ queryKey: ['exam', exam.id] });
      if (next) nav(`/teacher/exams/${exam.id}/review`);
      else toast.ok('Settings saved.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const row = (icon: string, title: string, hint: string, key: string) => (
    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
      <span className="icon-tile" style={{ width: 34, height: 34 }}>
        <Icon name={icon} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="hint">{hint}</div>
      </div>
      <Switch on={!!s[key]} onChange={(v) => set(key, v)} label={title} disabled={locked} />
    </div>
  );
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: '8px 24px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0 6px' }}>
              <span className="icon-tile">
                <Icon name="shield" size={18} />
              </span>
              <h2 className="h2">Integrity &amp; proctoring</h2>
            </div>
            <div style={{ display: 'flex', gap: 12, padding: '12px 14px', borderRadius: 10, background: 'var(--accent-weak)', color: 'var(--accent-text)', fontSize: 13.5, margin: '8px 0 12px' }}>
              <Icon name="lock" />
              <span>
                <b>Handled by Safe Exam Browser.</b> Your team's SEB configuration locks every exam: no other apps or tabs, no outside clipboard, no AI tools, a single display and full screen. Teachers don't need to set anything here.
              </span>
            </div>
            {[
              ['lock', 'Safe Exam Browser required', 'The exam only opens inside SEB.'],
              ['clipboard', 'Copy & paste from outside blocked', 'Paste only inside the editor; attempts are logged.'],
              ['flag', 'Tab and focus changes logged', 'Flag after 2 switches; auto-submit after 5.'],
            ].map(([ic, t, hnt]) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                <span className="icon-tile" style={{ width: 34, height: 34 }}>
                  <Icon name={ic!} size={17} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t}</div>
                  <div className="hint">{hnt}</div>
                </div>
                <span className="badge b-green">Always on</span>
              </div>
            ))}
          </section>
          <section className="card" style={{ padding: '8px 24px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0 6px' }}>
              <span className="icon-tile">
                <Icon name="award" size={18} />
              </span>
              <h2 className="h2">Submission &amp; grading</h2>
            </div>
            {row('timer', 'Auto-submit when time ends', 'Saves and submits the latest version of every file.', 'autoSubmitOnTimeout')}
            {row('check', 'Auto-grade with tests', 'Score = weight of passed tests. AI suggests a score and feedback; you decide.', 'autoGradeWithTests')}
            {row('send', 'Release results after review', 'Students see scores only after you publish results.', 'releaseAfterReview')}
          </section>
        </div>
        <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="icon-tile">
                <Icon name="code" size={18} />
              </span>
              <div>
                <h2 className="h2">Allowed languages</h2>
                <p className="hint" style={{ margin: '2px 0 0' }}>
                  Each question can narrow this list. {s.allowedLanguages.length} selected.
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {LANGS.map((l) => {
                const on = s.allowedLanguages.includes(l);
                return (
                  <button key={l} type="button" className={`chip ${on ? 'chip-on' : ''}`} aria-pressed={on} disabled={locked} onClick={() => set('allowedLanguages', on ? s.allowedLanguages.filter((x: string) => x !== l) : [...s.allowedLanguages, l])}>
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      {langLabel(l)}
                    </span>
                  </button>
                );
              })}
            </div>
            <span className="hint">Only matters for coding questions. An exam with only multiple choice / short answer questions needs no language.</span>
          </section>
          <section className="card" style={{ padding: '8px 24px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0 6px' }}>
              <span className="icon-tile">
                <Icon name="terminal" size={18} />
              </span>
              <h2 className="h2">Code execution</h2>
            </div>
            {row('play', 'Allow Run code', 'Students can run their code with custom input.', 'allowRun')}
            {row('eye', 'Show sample tests', 'Sample tests and their output are visible to students.', 'showSampleTests')}
            {row('eyeoff', 'Run hidden tests on submit', 'Hidden tests run after final submission only.', 'runHiddenOnSubmit')}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, padding: '16px 0 8px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="rq">
                  Runs per question
                </label>
                <div className="field">
                  <input id="rq" type="number" min={1} placeholder="Unlimited" value={s.runsPerQuestion ?? ''} disabled={locked} onChange={(e) => set('runsPerQuestion', e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : null)} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="tl">
                  Time limit / test
                </label>
                <div className="field">
                  <input id="tl" type="number" min={0.5} max={10} step={0.5} className="mono" value={s.timeLimitMs / 1000} disabled={locked} onChange={(e) => set('timeLimitMs', Math.round(Math.min(10, Math.max(0.5, Number(e.target.value) || 2)) * 1000))} />
                  <span className="hint">s</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="ml">
                  Memory limit
                </label>
                <div className="field">
                  <input id="ml" type="number" min={64} max={1024} step={64} className="mono" value={s.memoryLimitMb} disabled={locked} onChange={(e) => set('memoryLimitMb', Math.min(1024, Math.max(64, parseInt(e.target.value, 10) || 256)))} />
                  <span className="hint">MB</span>
                </div>
              </div>
            </div>
          </section>
          <section className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="icon-tile">
                <Icon name="users" size={18} />
              </span>
              <h2 className="h2">Accommodations</h2>
            </div>
            {acc.length === 0 && <span className="hint">No students have extra time.</span>}
            {acc.map((a) => (
              <div key={a.studentId} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar initials={a.initials} size={32} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{a.fullName}</b> <span className="mono hint">{a.studentNumber}</span>
                </span>
                <div className="field" style={{ width: 110, height: 32 }}>
                  <span className="hint">+</span>
                  <input type="number" min={5} max={240} aria-label="Extra minutes" value={a.extraMinutes} onChange={(e) => setAcc(acc.map((x) => (x.studentId === a.studentId ? { ...x, extraMinutes: Math.max(5, Math.min(240, parseInt(e.target.value, 10) || 5)) } : x)))} style={{ height: 30 }} />
                  <span className="hint">min</span>
                </div>
                <button type="button" className="icon-btn" style={{ width: 30, height: 30 }} aria-label="Remove accommodation" onClick={() => setAcc(acc.filter((x) => x.studentId !== a.studentId))}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
            <div style={{ position: 'relative' }}>
              <label className="field" style={{ height: 38 }}>
                <Icon name="search" stroke="var(--muted)" />
                <input type="search" placeholder="Add a student (name or ID)…" aria-label="Find student" value={search} onChange={(e) => setSearch(e.target.value)} />
              </label>
              {search.length >= 2 && (
                <div className="card" style={{ position: 'absolute', top: 42, left: 0, right: 0, zIndex: 10, maxHeight: 220, overflow: 'auto', boxShadow: '0 12px 32px rgba(15,23,42,.18)' }}>
                  {(students.data?.items ?? []).filter((x: any) => !acc.some((a) => a.studentId === x.id)).map((x: any) => (
                    <button key={x.id} type="button" onClick={() => { setAcc([...acc, { studentId: x.id, studentNumber: x.studentId, fullName: x.fullName, initials: x.initials, extraMinutes: 15 }]); setSearch(''); }} style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}>
                      <Avatar initials={x.initials} size={28} />
                      <span style={{ flex: 1 }}>{x.fullName}</span>
                      <span className="mono hint">{x.studentId}</span>
                    </button>
                  ))}
                  {students.data?.items?.length === 0 && <div className="hint" style={{ padding: 12 }}>No students found.</div>}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, paddingTop: 8 }}>
        <Link className="btn btn-secondary" to={`/teacher/exams/${exam.id}/questions`}>
          <Icon name="arrowl" />
          Back
        </Link>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-secondary" onClick={() => save(false)} disabled={busy}>
            Save
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save(true)} disabled={busy}>
            Review exam
            <Icon name="arrowr" />
          </button>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ step 4
function ReviewStep({ exam }: { exam: any }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [notifyNow, setNotifyNow] = useState(exam.notify.now);
  const [reminder, setReminder] = useState(exam.notify.reminder1h);
  const [busy, setBusy] = useState(false);
  const checks = useQuery({ queryKey: ['publish-checks', exam.id], queryFn: () => api(`/teacher/exams/${exam.id}/publish-checks`), enabled: exam.status === 'draft' });
  const d = exam.details;
  const s = exam.settings;
  const startsAt = d.startsAt ? new Date(d.startsAt) : null;
  const localStr = useMemo(() => (startsAt ? new Date(startsAt.getTime() + 7 * 3600_000).toISOString().slice(11, 16) : ''), [startsAt]);
  const publish = async () => {
    setBusy(true);
    try {
      const r = await api(`/teacher/exams/${exam.id}/publish`, { method: 'POST', body: { notifyNow, reminder1h: reminder } });
      qc.invalidateQueries();
      nav('/teacher', { state: { published: r.notifiedCount } });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PUBLISH_CHECKS_FAILED') checks.refetch();
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const unpublish = async () => {
    if (!window.confirm('Move this exam back to draft? Students will no longer see it.')) return;
    try {
      await api(`/teacher/exams/${exam.id}/unpublish`, { method: 'POST' });
      qc.invalidateQueries();
      toast.ok('The exam is a draft again.');
    } catch (e) {
      toast.error(e);
    }
  };
  const preview = async () => {
    try {
      const r = await api(`/teacher/exams/${exam.id}/preview-session`, { method: 'POST' });
      nav(r.previewUrl);
    } catch (e) {
      toast.error(e);
    }
  };
  const card = (title: string, to: string, rows: [string, string][]) => (
    <section className="card" style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 className="h2">{title}</h2>
        {['draft', 'scheduled'].includes(exam.status) && (
          <Link className="btn btn-ghost btn-sm" to={`/teacher/exams/${exam.id}/${to}`}>
            <Icon name="edit" size={14} />
            Edit
          </Link>
        )}
      </div>
      {rows.map(([a, b], i) => (
        <div key={i} className="rv-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', fontSize: 13.5 }}>
          <span className="muted">{a}</span>
          <span style={{ fontWeight: 500, textAlign: 'right' }}>{b}</span>
        </div>
      ))}
    </section>
  );
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ flex: '3 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {card('Details & schedule', 'details', [
            ['Title', d.title],
            ['Classes', `${d.classIds.length} class${d.classIds.length === 1 ? '' : 'es'} · ${d.studentCount} students`],
            ['Starts', startsAt ? `${startsAt.toUTCString().slice(5, 22)} UTC (${localStr} in Phnom Penh)` : 'Not scheduled'],
            ['Duration', `${d.durationMinutes ?? '—'} minutes · late join ${d.lateJoinMinutes} min`],
            ['Window closes', d.windowClosesAt ? `${new Date(d.windowClosesAt).toISOString().slice(11, 16)} UTC` : '—'],
          ])}
          {card('Questions', 'questions', [
            ...exam.questions.items.map((q: any, i: number) => [`${i + 1}. ${q.title}`, `${q.points} pts · ${q.type && q.type !== 'code' ? QTYPE_LABEL[q.type] : langList(q.languages)}`] as [string, string]),
            ['Order', exam.questions.questionOrder === 'fixed' ? 'Fixed' : exam.questions.questionOrder === 'shuffle' ? 'Shuffled' : `Random pool of ${exam.questions.poolSize}`],
          ])}
          {card('Rules & settings', 'settings', [
            ['Integrity', 'Safe Exam Browser (team configuration)'],
            ['Execution', `${s.allowRun ? 'Run code allowed' : 'Run code off'} · ${s.timeLimitMs / 1000} s / ${s.memoryLimitMb} MB per test`],
            ['Grading', `${s.autoGradeWithTests ? 'Auto-grade with tests + AI suggestions' : 'Manual grading'}${s.releaseAfterReview ? ', release after review' : ''}`],
            ['Accommodations', s.accommodations.length ? `${s.accommodations.length} student${s.accommodations.length === 1 ? '' : 's'} with extra time` : 'None'],
          ])}
        </div>
        <aside style={{ flex: '2 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {exam.status === 'draft' ? (
            <section className="card" style={{ padding: '20px 24px' }}>
              <h2 className="h2">Pre-publish checks</h2>
              {checks.isLoading && <p className="hint">Checking…</p>}
              <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                {(checks.data?.checks ?? []).map((c: any) => (
                  <li key={c.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0' }}>
                    <span style={{ color: c.status === 'ok' ? 'var(--ok)' : c.status === 'warn' ? 'var(--warn)' : 'var(--bad)', marginTop: 1 }}>
                      <Icon name={c.status === 'ok' ? 'check' : 'alert'} size={17} />
                    </span>
                    <span style={{ fontSize: 13.5 }}>{c.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <Banner tone="ok">This exam is {exam.status === 'scheduled' ? 'published and scheduled' : exam.status}.</Banner>
          )}
          {exam.status === 'draft' && (
            <section className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <h2 className="h2">Notify students</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13.5 }}>
                <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={notifyNow} onChange={() => setNotifyNow(!notifyNow)} /> In-app notification now
                </label>
                <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={reminder} onChange={() => setReminder(!reminder)} /> Reminder 1 hour before start
                </label>
              </div>
              <button type="button" className="btn btn-primary btn-lg" onClick={publish} disabled={busy || !checks.data?.canPublish}>
                <Icon name="rocket" size={18} />
                {busy ? 'Publishing…' : 'Publish & send to students'}
              </button>
              {checks.data && !checks.data.canPublish && <span className="err-text">Fix the red checks first.</span>}
              <button type="button" className="btn btn-secondary" onClick={preview} disabled={!exam.questions.items.length}>
                <Icon name="eye" />
                Preview as student
              </button>
            </section>
          )}
          {exam.status === 'scheduled' && (
            <section className="card" style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button type="button" className="btn btn-secondary" onClick={preview}>
                <Icon name="eye" />
                Preview as student
              </button>
              <Link className="btn btn-secondary" to={`/teacher/exams/${exam.id}/monitor`}>
                <Icon name="pulse" />
                Open live monitor
              </Link>
              <button type="button" className="btn btn-danger" onClick={unpublish}>
                Unpublish (back to draft)
              </button>
            </section>
          )}
        </aside>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, paddingTop: 8 }}>
        <Link className="btn btn-secondary" to={`/teacher/exams/${exam.id}/settings`}>
          <Icon name="arrowl" />
          Back
        </Link>
      </div>
    </>
  );
}
