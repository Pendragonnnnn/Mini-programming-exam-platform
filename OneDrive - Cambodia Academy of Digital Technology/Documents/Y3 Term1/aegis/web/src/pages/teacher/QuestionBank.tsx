import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { ago, DIFF_CLS, DIFF_LABEL, EmptyState, ErrorState, LangBadge, LANGS, langLabel, LoadingState, QTYPE_LABEL, QTYPES, toast } from '../../components/ui';

export function QuestionBank() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState('');
  const [courseId, setCourseId] = useState('all');
  const [diff, setDiff] = useState('all');
  const [lang, setLang] = useState('all');
  const [qtype, setQtype] = useState('all');
  const [menu, setMenu] = useState(false);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => api('/teacher/courses') });
  const list = useQuery({
    queryKey: ['bank-list', q, courseId, diff, lang, qtype, archived],
    queryFn: () =>
      api('/teacher/questions', {
        query: { q, courseId: courseId === 'all' ? undefined : courseId, difficulty: diff === 'all' ? undefined : diff, language: lang === 'all' ? undefined : lang, type: qtype === 'all' ? undefined : qtype, includeArchived: archived || undefined, pageSize: 200 },
      }),
  });

  const create = async (cid: string, type = 'code') => {
    if (creating || !cid) return;
    setCreating(true);
    setMenu(false);
    try {
      const created = await api('/teacher/questions', { method: 'POST', body: { courseId: cid, type } });
      const back = sp.get('back');
      nav(`/teacher/questions/${created.id}${back ? `?back=${back}` : ''}`, { replace: sp.get('new') === '1' });
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(false);
    }
  };

  // "?new=1" (from the dashboard or the exam wizard) creates a question straight away.
  const started = useRef(false);
  useEffect(() => {
    if (sp.get('new') !== '1' || started.current || !courses.data) return;
    const cid = sp.get('course') ?? courses.data.items[0]?.id;
    if (!cid) return;
    started.current = true;
    sp.delete('new');
    setSp(sp, { replace: true });
    create(cid, sp.get('type') ?? 'code');
  }, [courses.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = ['Teacher', 'Question bank'];
  if (courses.isLoading) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading the question bank" /></TeacherShell>;
  if (courses.error) return <TeacherShell crumbs={crumbs}><ErrorState what="your courses" error={courses.error} onRetry={() => courses.refetch()} /></TeacherShell>;
  const items = (list.data?.items ?? []) as any[];
  const sel = (label: string, value: string, set: (v: string) => void, opts: [string, string][]) => (
    <div className="field" style={{ height: 38, padding: '0 10px', minWidth: 150 }}>
      <select aria-label={label} value={value} onChange={(e) => set(e.target.value)} style={{ fontSize: 13 }}>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <Icon name="chevd" size={14} stroke="var(--muted)" />
    </div>
  );
  return (
    <TeacherShell crumbs={crumbs}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">Question bank</h1>
          <p className="sub">Multiple choice, multiple answers, true/false, short answer and coding questions. Reuse them across exams.</p>
        </div>
        <div style={{ position: 'relative' }}>
          <button type="button" className="btn btn-primary" aria-expanded={menu} onClick={() => setMenu(!menu)} disabled={creating || !courses.data.items.length}>
            <Icon name="plus" />
            {creating ? 'Creating…' : 'New question'}
            <Icon name="chevd" size={14} />
          </button>
          {menu && (
            <div className="card" role="menu" style={{ position: 'absolute', right: 0, top: 46, zIndex: 25, width: 240, padding: 6, boxShadow: '0 12px 32px rgba(15,23,42,.18)' }}>
              {QTYPES.map((t) => (
                <button key={t} type="button" role="menuitem" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => create(courseId !== 'all' ? courseId : courses.data.items[0]?.id, t)}>
                  <Icon name={t === 'code' ? 'code' : t === 'short_answer' ? 'edit' : 'check'} size={16} />
                  {QTYPE_LABEL[t]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {!courses.data.items.length && (
        <EmptyState icon="users" title="Create a course first" text="Questions belong to a course. Add your course, classes and students, then come back here." action={<Link className="btn btn-primary" to="/teacher/courses">Go to Courses & students</Link>} />
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <label className="field" style={{ height: 38, flex: '1 1 260px' }}>
          <Icon name="search" stroke="var(--muted)" />
          <input type="search" placeholder="Search by title or topic…" aria-label="Search questions" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {sel('Course', courseId, setCourseId, [['all', 'All courses'], ...courses.data.items.map((c: any) => [c.id, c.code] as [string, string])])}
        {sel('Difficulty', diff, setDiff, [['all', 'All levels'], ['easy', 'Easy'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']])}
        {sel('Type', qtype, setQtype, [['all', 'All types'], ...QTYPES.map((t) => [t, QTYPE_LABEL[t]] as [string, string])])}
        {sel('Language', lang, setLang, [['all', 'All languages'], ...LANGS.map((l) => [l, langLabel(l)] as [string, string])])}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={archived} onChange={() => setArchived(!archived)} />
          Show archived
        </label>
      </div>
      {list.error ? (
        <ErrorState what="questions" error={list.error} onRetry={() => list.refetch()} />
      ) : list.isLoading ? (
        <LoadingState label="Loading questions" />
      ) : items.length === 0 ? (
        courses.data.items.length ? <EmptyState title="No questions yet" text="Choose New question to write your first one, or change the filters above." /> : null
      ) : (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Type</th>
                  <th>Languages</th>
                  <th>Level</th>
                  <th>Tests</th>
                  <th>Points</th>
                  <th>Used in</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id} style={{ opacity: x.archived ? 0.6 : 1 }}>
                    <td>
                      <Link to={`/teacher/questions/${x.id}`} style={{ fontWeight: 600, color: 'var(--text)' }}>
                        {x.title}
                      </Link>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                        <span className="hint">
                          {x.courseCode}
                          {x.topic ? ` · ${x.topic}` : ''}
                        </span>
                        {x.archived && <span className="badge b-gray">Archived</span>}
                        {!x.validated && <span className="badge b-amber">{x.type === 'code' ? 'Not validated' : 'No answer key'}</span>}
                      </div>
                    </td>
                    <td>
                      <span className="badge b-gray">{QTYPE_LABEL[x.type] ?? x.type}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {x.type !== 'code' && <span className="hint">—</span>}
                        {x.languages.map((l: string) => (
                          <LangBadge key={l} lang={l} />
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={DIFF_CLS[x.difficulty]}>{DIFF_LABEL[x.difficulty]}</span>
                    </td>
                    <td className="tnum">{x.type === 'code' ? x.testCount : '—'}</td>
                    <td className="tnum">{x.points}</td>
                    <td className="tnum">
                      {x.usedInExams} exam{x.usedInExams === 1 ? '' : 's'}
                    </td>
                    <td className="tnum hint" style={{ whiteSpace: 'nowrap' }}>
                      {ago(x.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </TeacherShell>
  );
}
