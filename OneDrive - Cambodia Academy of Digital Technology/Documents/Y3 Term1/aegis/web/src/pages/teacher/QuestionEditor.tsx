import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { CodeEditor } from '../../components/CodeEditor';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { ago, Banner, CALL_TEST_LANGS, ErrorState, LANG_ENTRY, LANG_EXTS, LANG_LABEL, LANG_STARTER, LANGS, LoadingState, Markdown, QTYPE_LABEL, Seg, Spinner, Switch, toast, useInterval, type Lang } from '../../components/ui';

type QType = 'code' | 'single_choice' | 'multiple_choice' | 'true_false' | 'short_answer';
interface ChoiceOpt { id?: string; text: string; correct: boolean }
interface Choice { options: ChoiceOpt[]; shuffle: boolean; partialCredit: boolean; acceptedAnswers: string[]; caseSensitive: boolean; explanation: string }
interface StarterFile { path: string; content: string; readOnly: boolean; isEntrypoint: boolean }
interface LangFiles { starter: StarterFile[]; reference: { path: string; content: string }[]; setup: string; setupTarget: string }
interface Test { id?: string; name: string; kind: 'stdio' | 'call'; input: string; expected: string; matchType: 'exact' | 'token' | 'exception_class' | 'float_tolerance'; floatTolerance: number; weight: number; hidden: boolean; sortOrder: number }
interface Draft {
  version: number;
  type: QType;
  choice: Choice;
  title: string;
  difficulty: 'easy' | 'intermediate' | 'advanced';
  points: number;
  topic: string | null;
  languages: Lang[];
  instructionsMd: string;
  limits: { timeLimitMs: number; memoryLimitMb: number; networkAccess: false };
  files: Partial<Record<Lang, LangFiles>>;
  tests: Test[];
}

const DEFAULT_FILES = Object.fromEntries(
  LANGS.map((l) => [l, { starter: [{ path: LANG_ENTRY[l]!, content: LANG_STARTER[l]!, readOnly: false, isEntrypoint: true }], reference: [], setup: '', setupTarget: '' }]),
) as unknown as Record<Lang, LangFiles>;
const isLang = (l: string): l is Lang => (LANGS as readonly string[]).includes(l);

function toDraft(dto: any): Draft {
  const files: Draft['files'] = {};
  for (const [l, f] of Object.entries<any>(dto.files)) {
    if (!isLang(l)) continue;
    files[l] = {
      starter: f.starter.map((s: any) => ({ path: s.path, content: s.content, readOnly: !!s.readOnly, isEntrypoint: !!s.isEntrypoint })),
      reference: f.reference.map((s: any) => ({ path: s.path, content: s.content })),
      setup: f.setup ?? '',
      setupTarget: f.setupTarget ?? '',
    };
  }
  const c = dto.choice ?? {};
  return {
    version: dto.version,
    type: dto.type ?? 'code',
    choice: {
      options: (c.options ?? []).map((o: any) => ({ id: o.id, text: o.text, correct: !!o.correct })),
      shuffle: !!c.shuffle,
      partialCredit: !!c.partialCredit,
      acceptedAnswers: c.acceptedAnswers ?? [],
      caseSensitive: !!c.caseSensitive,
      explanation: c.explanation ?? '',
    },
    title: dto.title,
    difficulty: dto.difficulty,
    points: dto.points,
    topic: dto.topic,
    languages: dto.languages.filter(isLang),
    instructionsMd: dto.instructionsMd,
    limits: { timeLimitMs: dto.limits.timeLimitMs, memoryLimitMb: dto.limits.memoryLimitMb, networkAccess: false },
    files,
    tests: dto.tests.map((t: any, i: number) => ({ id: t.id, name: t.name, kind: t.kind, input: t.input, expected: t.expected, matchType: t.matchType, floatTolerance: t.floatTolerance ?? 0.01, weight: t.weight, hidden: t.hidden, sortOrder: i })),
  };
}

/** Body for PUT /teacher/questions/:id — only languages that are switched on are sent. */
function toBody(d: Draft) {
  if (d.type !== 'code') return { ...d, topic: d.topic?.trim() || null, languages: [], files: {}, tests: [] };
  const files: Record<string, LangFiles> = {};
  for (const l of d.languages) files[l] = d.files[l] ?? DEFAULT_FILES[l];
  return { ...d, topic: d.topic?.trim() || null, files, tests: d.tests.map((t, i) => ({ ...t, sortOrder: i })) };
}

export function QuestionEditor() {
  const { questionId } = useParams();
  const [sp] = useSearchParams();
  const back = sp.get('back');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['question', questionId], queryFn: () => api(`/teacher/questions/${questionId}`), refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>('');
  useEffect(() => {
    if (query.data && !draft) {
      const d = toDraft(query.data);
      setDraft(d);
      setSaved(JSON.stringify(toBody(d)));
    }
  }, [query.data, draft]);
  const dirty = !!draft && JSON.stringify(toBody(draft)) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const crumbs = ['Teacher', 'Question bank', draft?.title || 'Question'];
  if (query.isLoading || (query.data && !draft)) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading the question" /></TeacherShell>;
  if (query.error) return <TeacherShell crumbs={crumbs}><ErrorState what="the question" error={query.error} onRetry={() => query.refetch()} /></TeacherShell>;
  return (
    <TeacherShell crumbs={crumbs} wide>
      <Editor
        key={questionId}
        dto={query.data}
        draft={draft!}
        setDraft={setDraft as any}
        dirty={dirty}
        back={back}
        onSaved={(dto) => {
          const d = toDraft(dto);
          setDraft(d);
          setSaved(JSON.stringify(toBody(d)));
          qc.setQueryData(['question', questionId], dto);
          qc.invalidateQueries({ queryKey: ['bank-list'] });
          qc.invalidateQueries({ queryKey: ['bank'] });
        }}
        onReload={async () => {
          const r = await query.refetch();
          if (r.data) {
            const d = toDraft(r.data);
            setDraft(d);
            setSaved(JSON.stringify(toBody(d)));
          }
        }}
      />
    </TeacherShell>
  );
}

function Editor({ dto, draft, setDraft, dirty, back, onSaved, onReload }: { dto: any; draft: Draft; setDraft: (fn: (d: Draft) => Draft) => void; dirty: boolean; back: string | null; onSaved: (dto: any) => void; onReload: () => Promise<void> }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [mdMode, setMdMode] = useState<'write' | 'split' | 'preview'>('split');
  const [lang, setLang] = useState<Lang>(draft.languages[0] ?? 'java');
  const [fileTab, setFileTab] = useState<'starter' | 'reference' | 'setup'>('starter');
  const [fileIdx, setFileIdx] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [validation, setValidation] = useState<any>(dto.lastValidation ?? null);

  const set = useCallback(<K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v })), [setDraft]);
  const lf: LangFiles = draft.files[lang] ?? DEFAULT_FILES[lang];
  const setLf = (fn: (f: LangFiles) => LangFiles) => setDraft((d) => ({ ...d, files: { ...d.files, [lang]: fn(d.files[lang] ?? structuredClone(DEFAULT_FILES[lang])) } }));
  const list = fileTab === 'starter' ? lf.starter : lf.reference;
  const curFile = list[Math.min(fileIdx, list.length - 1)];
  const weightSum = draft.tests.reduce((a, t) => a + (Number(t.weight) || 0), 0);

  const toggleLang = (l: Lang) => {
    setDraft((d) => {
      const on = d.languages.includes(l);
      if (on && d.languages.length === 1) return d;
      const languages = on ? d.languages.filter((x) => x !== l) : [...d.languages, l];
      const files = { ...d.files };
      if (!on && !files[l]) files[l] = structuredClone(DEFAULT_FILES[l]);
      return { ...d, languages, files };
    });
    if (draft.languages.includes(l) && lang === l) setLang(draft.languages.find((x) => x !== l) ?? 'java');
    else if (!draft.languages.includes(l)) setLang(l);
    setFileIdx(0);
  };

  const save = async (): Promise<boolean> => {
    setBusy('save');
    setErrors({});
    try {
      const r = await api(`/teacher/questions/${dto.id}`, { method: 'PUT', body: toBody(draft) });
      setWarnings((r.warnings ?? []).map((w: any) => w.message));
      onSaved(r);
      setConflictMsg(null);
      toast.ok('Question saved.');
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setConflictMsg(e.message);
      else if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast.error(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    setBusy('validate');
    try {
      const r = await api(`/teacher/questions/${dto.id}/validate`, { method: 'POST', body: dirty ? { draft: toBody(draft) } : {} });
      setJobId(r.jobId);
      setValidation({ status: 'running', summary: 'Running reference solutions…', byLanguage: [] });
      if (r.missing?.length) toast.warn(`No reference solution for ${r.missing.map((l: string) => LANG_LABEL[l]).join(', ')} — skipped.`);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  useInterval(
    useCallback(async () => {
      if (!jobId) return;
      try {
        const v = await api(`/teacher/validations/${jobId}`);
        setValidation(v);
        if (v.status === 'completed') {
          setJobId(null);
          if (v.allPassed) toast.ok(v.summary);
          else toast.warn(v.summary);
        }
      } catch (e) {
        setJobId(null);
        toast.error(e);
      }
    }, [jobId]),
    jobId ? 1500 : null,
  );

  const preview = async () => {
    if (dirty && !(await save())) return;
    try {
      const r = await api(`/teacher/questions/${dto.id}/preview`, { method: 'POST' });
      nav(r.previewUrl);
    } catch (e) {
      toast.error(e);
    }
  };
  const duplicate = async () => {
    try {
      const r = await api(`/teacher/questions/${dto.id}/duplicate`, { method: 'POST' });
      toast.ok('Copy created.');
      nav(`/teacher/questions/${r.id}`);
    } catch (e) {
      toast.error(e);
    }
  };
  const archive = async () => {
    try {
      await api(`/teacher/questions/${dto.id}/${dto.archived ? 'unarchive' : 'archive'}`, { method: 'POST' });
      await onReload();
      toast.ok(dto.archived ? 'Question restored.' : 'Question archived. Existing exams keep their copy.');
    } catch (e) {
      toast.error(e);
    }
  };

  const fe = (k: string) => errors[k] && <span className="err-text">{errors[k]}</span>;
  const isCode = draft.type === 'code';
  const onlyStdio = draft.languages.some((l) => !CALL_TEST_LANGS.has(l));
  const testErr = (i: number) => Object.entries(errors).find(([k]) => k.startsWith(`tests[${i}]`) || k.startsWith(`tests.${i}`))?.[1];
  const fileErrs = Object.entries(errors).filter(([k]) => k.startsWith('files') || k === 'reference');

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <Link to={back ? `/teacher/exams/${back}/questions` : '/teacher/questions'} className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="arrowl" size={14} />
            {back ? 'Back to exam questions' : 'Question bank'}
          </Link>
          <h1 className="h1" style={{ marginTop: 6 }}>
            {draft.title || 'Untitled question'}
          </h1>
          <p className="sub">
            {QTYPE_LABEL[draft.type]} · {dto.course.code} · used in {dto.usedInExams} exam{dto.usedInExams === 1 ? '' : 's'}
            {dto.lastEditedBy ? ` · last edited by ${dto.lastEditedBy.isMe ? 'you' : dto.lastEditedBy.name} ${ago(dto.updatedAt)}` : ''}
            {dto.archived ? ' · archived' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={duplicate}>
            <Icon name="copy" size={15} />
            Duplicate
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={archive}>
            <Icon name="archive" size={15} />
            {dto.archived ? 'Restore' : 'Archive'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={preview} disabled={!!busy}>
            <Icon name="eye" />
            Test as student
          </button>
          {isCode && (
            <button type="button" className="btn btn-secondary" onClick={validate} disabled={!!busy || !!jobId}>
              {jobId ? <Spinner /> : <Icon name="tests" />}
              Validate solutions
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={save} disabled={!!busy || !dirty}>
            <Icon name="save" />
            {busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>

      {conflictMsg && (
        <Banner tone="bad" action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => { setConflictMsg(null); onReload(); }}>Reload latest</button>}>
          {conflictMsg} Your unsaved changes will be lost if you reload.
        </Banner>
      )}
      {warnings.map((w) => (
        <Banner key={w} tone="warn" onClose={() => setWarnings(warnings.filter((x) => x !== w))}>
          {w}
        </Banner>
      ))}
      {isCode && validation && (
        <Banner tone={validation.status === 'running' ? 'info' : validation.allPassed ? 'ok' : 'bad'}>
          <b>{validation.status === 'running' ? 'Validating…' : validation.allPassed ? 'Reference solutions pass.' : 'Validation failed.'}</b> {validation.summary}
          {(validation.byLanguage ?? []).filter((b: any) => b.status !== 'completed' || b.tests?.some((t: any) => !t.passed)).map((b: any) => (
            <div key={b.language} style={{ marginTop: 6 }}>
              <b>{LANG_LABEL[b.language]}:</b>{' '}
              {b.status === 'compile_error' && b.compileOutput ? <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '4px 0' }}>{b.compileOutput.slice(0, 1500)}</pre> : b.tests.filter((t: any) => !t.passed).map((t: any) => `${t.name}: ${t.message}`).join(' · ')}
            </div>
          ))}
        </Banner>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
        {/* ---------------- left column: info + instructions + tests */}
        <div style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <h2 className="h2">Basic info</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label className="label" htmlFor="qt">
                Question title <span style={{ color: 'var(--bad)' }}>*</span>
              </label>
              <div className={`field ${errors.title ? 'invalid' : ''}`}>
                <input id="qt" value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="Short name for this question" />
              </div>
              {fe('title')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="qd">
                  Difficulty
                </label>
                <div className="field">
                  <select id="qd" value={draft.difficulty} onChange={(e) => set('difficulty', e.target.value as Draft['difficulty'])}>
                    <option value="easy">Easy</option>
                    <option value="intermediate">Intermediate</option>
                    <option value="advanced">Advanced</option>
                  </select>
                  <Icon name="chevd" stroke="var(--muted)" />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="qp">
                  Points
                </label>
                <div className={`field ${errors.points ? 'invalid' : ''}`}>
                  <input id="qp" type="number" min={0} max={1000} value={draft.points} onChange={(e) => set('points', Math.max(0, Math.min(1000, parseInt(e.target.value, 10) || 0)))} className="tnum" />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="qtp">
                  Topic
                </label>
                <div className="field">
                  <input id="qtp" value={draft.topic ?? ''} onChange={(e) => set('topic', e.target.value)} placeholder="Optional" />
                </div>
              </div>
            </div>
            {isCode && (<>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="label">Languages students may use</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {LANGS.map((l) => {
                  const on = draft.languages.includes(l);
                  return (
                    <button key={l} type="button" className={`chip ${on ? 'chip-on' : ''}`} aria-pressed={on} disabled={on && draft.languages.length === 1} onClick={() => toggleLang(l)}>
                      {on && <Icon name="tick" size={13} />}
                      {LANG_LABEL[l]}
                    </button>
                  );
                })}
              </div>
              {fe('languages')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="qtl">
                  Time limit per test
                </label>
                <div className="field">
                  <input id="qtl" type="number" min={0.5} max={10} step={0.5} value={draft.limits.timeLimitMs / 1000} onChange={(e) => set('limits', { ...draft.limits, timeLimitMs: Math.round(Math.min(10, Math.max(0.5, Number(e.target.value) || 2)) * 1000) })} className="mono" />
                  <span className="hint">s</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="label" htmlFor="qml">
                  Memory limit
                </label>
                <div className="field">
                  <input id="qml" type="number" min={64} max={1024} step={64} value={draft.limits.memoryLimitMb} onChange={(e) => set('limits', { ...draft.limits, memoryLimitMb: Math.min(1024, Math.max(64, parseInt(e.target.value, 10) || 256)) })} className="mono" />
                  <span className="hint">MB</span>
                </div>
              </div>
            </div>
            <span className="hint">Network access is always off while code runs.</span>
            </>)}
          </section>

          <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 className="h2">{isCode ? 'Instructions & requirements' : 'Question text'}</h2>
                <p className="hint" style={{ margin: '2px 0 0' }}>
                  {isCode ? 'Markdown. Describe the task, the requirements, and an example.' : 'Markdown. This is what students read. Code blocks and images links are fine.'}
                </p>
              </div>
              <Seg small value={mdMode} onChange={setMdMode} options={[{ value: 'write', label: 'Write' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: mdMode === 'split' ? 'repeat(auto-fit, minmax(260px, 1fr))' : '1fr', gap: 14 }}>
              {mdMode !== 'preview' && (
                <div className="field area" style={{ alignItems: 'stretch' }}>
                  <textarea aria-label="Instructions (Markdown)" rows={16} value={draft.instructionsMd} onChange={(e) => set('instructionsMd', e.target.value)} className="mono" style={{ fontSize: 13 }} placeholder={isCode ? '## Task\nDescribe what the program must do…\n\n## Input\n…\n\n## Output\n…' : 'Write the question here…'} />
                </div>
              )}
              {mdMode !== 'write' && (
                <div className="card" style={{ padding: '4px 18px', boxShadow: 'none', minHeight: 200, maxHeight: 420, overflow: 'auto' }}>
                  {draft.instructionsMd.trim() ? <Markdown text={draft.instructionsMd} /> : <p className="hint">Nothing to preview yet.</p>}
                </div>
              )}
            </div>
          </section>

          {!isCode ? (
            <ChoiceEditor type={draft.type} choice={draft.choice} errors={errors} onChange={(c) => set('choice', c)} />
          ) : (
          <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h2 className="h2">Test cases</h2>
                <span className="badge b-gray">{draft.tests.length}</span>
                <span className={weightSum === draft.points ? 'badge b-green tnum' : 'badge b-amber tnum'}>
                  {weightSum} / {draft.points} pts
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setImportOpen(!importOpen)}>
                  <Icon name="upload" size={15} />
                  Import
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => set('tests', [...draft.tests, { name: `test${draft.tests.length + 1}`, kind: onlyStdio ? 'stdio' : draft.tests[draft.tests.length - 1]?.kind ?? 'stdio', input: '', expected: '', matchType: 'exact', floatTolerance: 0.01, weight: 0, hidden: false, sortOrder: draft.tests.length }])}
                >
                  <Icon name="plus" size={15} />
                  Add test
                </button>
              </div>
            </div>
            <p className="hint" style={{ margin: 0 }}>
              <b>Stdio</b> tests feed the input to the student's program and compare what it prints (works for every language). <b>Call</b> tests (Java, Python, JavaScript only) run statements against the setup object, e.g. <span className="mono">deposit(50)</span> then <span className="mono">getBalance()</span>; prefix a line with <span className="mono">java:</span>, <span className="mono">python:</span> or <span className="mono">javascript:</span> for language-specific input. Sample tests are visible to students; hidden tests run on submit.
              {onlyStdio && <><br /><b>C and C++ are on, so use Stdio tests only.</b></>}
            </p>
            {importOpen && <ImportTests onImport={(ts) => { set('tests', [...draft.tests, ...ts.map((t, i) => ({ ...t, sortOrder: draft.tests.length + i }))]); setImportOpen(false); }} />}
            {draft.tests.length === 0 && <div className="hint" style={{ padding: '12px 0' }}>No tests yet. Add a test or import JUnit / JSON.</div>}
            <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {draft.tests.map((t, i) => {
                const upd = (patch: Partial<Test>) => set('tests', draft.tests.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                const err = testErr(i);
                return (
                  <li key={t.id ?? `n${i}`} className="card" style={{ padding: 14, boxShadow: 'none', display: 'flex', flexDirection: 'column', gap: 10, borderColor: err ? 'var(--bad)' : undefined }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <span className="tnum hint" style={{ width: 22 }}>
                        {i + 1}
                      </span>
                      <div className="field" style={{ flex: '1 1 180px', height: 34 }}>
                        <input aria-label="Test name" value={t.name} onChange={(e) => upd({ name: e.target.value })} className="mono" style={{ height: 32, fontSize: 13 }} />
                      </div>
                      <div className="field" style={{ height: 34, padding: '0 8px' }}>
                        <select aria-label="Test kind" value={t.kind} onChange={(e) => upd({ kind: e.target.value as Test['kind'] })} style={{ fontSize: 13 }}>
                          <option value="stdio">Stdio</option>
                          <option value="call" disabled={onlyStdio}>Call</option>
                        </select>
                      </div>
                      <div className="field" style={{ height: 34, padding: '0 8px' }}>
                        <select aria-label="Match type" value={t.matchType} onChange={(e) => upd({ matchType: e.target.value as Test['matchType'] })} style={{ fontSize: 13 }}>
                          <option value="exact">Exact</option>
                          <option value="token">Ignore whitespace</option>
                          <option value="float_tolerance">Number ± tolerance</option>
                          <option value="exception_class">Throws exception</option>
                        </select>
                      </div>
                      {t.matchType === 'float_tolerance' && (
                        <div className="field" style={{ width: 96, height: 34 }}>
                          <span className="hint">±</span>
                          <input aria-label="Tolerance" type="number" step={0.001} min={0.000001} value={t.floatTolerance} onChange={(e) => upd({ floatTolerance: Math.max(0.000001, Number(e.target.value) || 0.01) })} style={{ height: 32 }} />
                        </div>
                      )}
                      <div className="field" style={{ width: 92, height: 34 }}>
                        <input aria-label="Weight" type="number" min={0} max={1000} value={t.weight} onChange={(e) => upd({ weight: Math.max(0, Math.min(1000, parseInt(e.target.value, 10) || 0)) })} className="tnum" style={{ height: 32, textAlign: 'right' }} />
                        <span className="hint">pts</span>
                      </div>
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                        <Switch on={t.hidden} onChange={(v) => upd({ hidden: v })} label="Hidden test" />
                        {t.hidden ? 'Hidden' : 'Sample'}
                      </label>
                      <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => { const a = draft.tests.slice(); [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; set('tests', a); }}>
                        <Icon name="chevu" size={15} />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Delete test" onClick={() => set('tests', draft.tests.filter((_, j) => j !== i))}>
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                      <div className="field area">
                        <textarea aria-label="Input" rows={3} className="mono" style={{ fontSize: 12.5 }} value={t.input} onChange={(e) => upd({ input: e.target.value })} placeholder={t.kind === 'call' ? 'deposit(50)\ngetBalance()' : 'Input given to the program (stdin)'} />
                      </div>
                      <div className="field area">
                        <textarea aria-label="Expected" rows={3} className="mono" style={{ fontSize: 12.5 }} value={t.expected} onChange={(e) => upd({ expected: e.target.value })} placeholder={t.matchType === 'exception_class' ? 'IllegalArgumentException|ValueError|Error' : 'Expected output'} />
                      </div>
                    </div>
                    {err && <span className="err-text">{err}</span>}
                  </li>
                );
              })}
            </ol>
          </section>
          )}
        </div>

        {/* ---------------- right column: files */}
        {isCode && (
        <section className="card" style={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'sticky', top: 88 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
            <h2 className="h2">Code</h2>
            <Seg small value={lang} onChange={(v) => { setLang(v); setFileIdx(0); }} options={draft.languages.map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '12px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <Seg
              small
              value={fileTab}
              onChange={(v) => { setFileTab(v); setFileIdx(0); }}
              options={[
                { value: 'starter', label: 'Starter code' },
                { value: 'reference', label: `Reference solution${lf.reference.length ? '' : ' ·  missing'}` },
                { value: 'setup', label: 'Test setup' },
              ]}
            />
          </div>
          {fileErrs.length > 0 && (
            <div style={{ padding: '10px 18px' }}>
              {fileErrs.map(([k, v]) => (
                <div key={k} className="err-text">
                  {v}
                </div>
              ))}
            </div>
          )}
          {fileTab === 'setup' ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p className="hint" style={{ margin: 0 }}>
                Runs before every <b>call</b> test. Create the object the tests use; bare calls like <span className="mono">deposit(5)</span> are bound to the variable below.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 260 }}>
                <label className="label" htmlFor="stv">
                  Variable name
                </label>
                <div className={`field ${errors[`files.${lang}.setupTarget`] ? 'invalid' : ''}`}>
                  <input id="stv" className="mono" value={lf.setupTarget} onChange={(e) => setLf((f) => ({ ...f, setupTarget: e.target.value }))} placeholder="e.g. account (optional)" />
                </div>
              </div>
              <div style={{ height: 260, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <CodeEditor ariaLabel="Test setup code" language={lang} value={lf.setup} onChange={(v) => setLf((f) => ({ ...f, setup: v }))} />
              </div>
            </div>
          ) : (
            <>
              <div role="tablist" aria-label="Files" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
                {list.map((f, i) => (
                  <button key={i} type="button" role="tab" aria-selected={i === fileIdx} className={`chip ${i === fileIdx ? 'chip-on' : ''}`} style={{ height: 30, fontSize: 12.5 }} onClick={() => setFileIdx(i)}>
                    <span className="mono">{f.path}</span>
                    {fileTab === 'starter' && (f as StarterFile).readOnly && <Icon name="lock" size={12} />}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const ext = LANG_EXTS[lang]![0]!;
                    const base = lang === 'java' ? 'File' : 'file';
                    const used = new Set(list.map((f) => f.path));
                    let n = list.length + 1;
                    while (used.has(`${base}${n}${ext}`)) n++;
                    const path = `${base}${n}${ext}`;
                    if (fileTab === 'starter') setLf((f) => ({ ...f, starter: [...f.starter, { path, content: '', readOnly: false, isEntrypoint: f.starter.length === 0 }] }));
                    else setLf((f) => ({ ...f, reference: [...f.reference, { path, content: '' }] }));
                    setFileIdx(list.length);
                  }}
                >
                  <Icon name="plus" size={14} />
                  File
                </button>
                {fileTab === 'reference' && lf.reference.length === 0 && lf.starter.length > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setLf((f) => ({ ...f, reference: f.starter.filter((s) => !s.readOnly).map((s) => ({ path: s.path, content: s.content })) })); setFileIdx(0); }}>
                    <Icon name="copy" size={14} />
                    Start from starter code
                  </button>
                )}
              </div>
              {curFile ? (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 18px', borderBottom: '1px solid var(--border)' }}>
                    <div className="field" style={{ height: 32, flex: '1 1 200px' }}>
                      <input
                        aria-label="File path"
                        className="mono"
                        style={{ height: 30, fontSize: 12.5 }}
                        value={curFile.path}
                        onChange={(e) => {
                          const p = e.target.value;
                          if (fileTab === 'starter') setLf((f) => ({ ...f, starter: f.starter.map((x, j) => (j === fileIdx ? { ...x, path: p } : x)) }));
                          else setLf((f) => ({ ...f, reference: f.reference.map((x, j) => (j === fileIdx ? { ...x, path: p } : x)) }));
                        }}
                      />
                    </div>
                    {fileTab === 'starter' && (
                      <>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                          <Switch on={(curFile as StarterFile).readOnly} onChange={(v) => setLf((f) => ({ ...f, starter: f.starter.map((x, j) => (j === fileIdx ? { ...x, readOnly: v } : x)) }))} label="Read-only for students" />
                          Read-only
                        </label>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                          <input type="radio" name="entry" checked={(curFile as StarterFile).isEntrypoint} onChange={() => setLf((f) => ({ ...f, starter: f.starter.map((x, j) => ({ ...x, isEntrypoint: j === fileIdx })) }))} />
                          Entry point
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Delete file"
                      onClick={() => {
                        if (fileTab === 'starter') setLf((f) => ({ ...f, starter: f.starter.filter((_, j) => j !== fileIdx) }));
                        else setLf((f) => ({ ...f, reference: f.reference.filter((_, j) => j !== fileIdx) }));
                        setFileIdx(Math.max(0, fileIdx - 1));
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                  <div style={{ height: 520 }}>
                    <CodeEditor
                      key={`${lang}-${fileTab}-${fileIdx}`}
                      ariaLabel={`${fileTab} ${curFile.path}`}
                      language={lang}
                      value={curFile.content}
                      onChange={(v) => {
                        if (fileTab === 'starter') setLf((f) => ({ ...f, starter: f.starter.map((x, j) => (j === fileIdx ? { ...x, content: v } : x)) }));
                        else setLf((f) => ({ ...f, reference: f.reference.map((x, j) => (j === fileIdx ? { ...x, content: v } : x)) }));
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="hint" style={{ padding: 24 }}>
                  {fileTab === 'reference' ? 'Add a reference solution so you can validate the tests before publishing. Students never see it.' : 'Add at least one starter file.'}
                </div>
              )}
            </>
          )}
        </section>
        )}
      </div>
    </>
  );
}

function ImportTests({ onImport }: { onImport: (t: Test[]) => void }) {
  const [text, setText] = useState('');
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const example = useMemo(() => '[{"name":"deposit_adds","input":"account.deposit(50.0)\\naccount.getBalance()","expected":"150.0","weight":10}]', []);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api('/teacher/questions/import-tests', { method: 'POST', body: { content: text, format: 'auto', hidden } });
      if (!r.count) return toast.warn('No tests found in that text.');
      onImport(r.tests.map((t: any) => ({ name: t.name, kind: t.kind ?? 'call', input: t.input ?? '', expected: t.expected ?? '', matchType: t.matchType ?? 'exact', floatTolerance: t.floatTolerance ?? 0.01, weight: t.weight ?? 0, hidden: t.hidden ?? hidden, sortOrder: 0 })));
      toast.ok(`Imported ${r.count} test${r.count === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const readFile = async (f: File | undefined) => {
    if (f) setText(await f.text());
  };
  return (
    <div className="card" style={{ padding: 14, boxShadow: 'none', display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface2)' }}>
      <div className="label">Paste JUnit tests or a JSON array</div>
      <div className="field area">
        <textarea rows={6} className="mono" style={{ fontSize: 12.5 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={example} aria-label="Tests to import" />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
          <Icon name="upload" size={14} />
          Choose file
          <input type="file" accept=".java,.json,.txt" style={{ display: 'none' }} onChange={(e) => readFile(e.target.files?.[0])} />
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={hidden} onChange={() => setHidden(!hidden)} /> Import as hidden tests
        </label>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary btn-sm" onClick={go} disabled={busy || !text.trim()}>
          {busy ? 'Importing…' : 'Import tests'}
        </button>
      </div>
    </div>
  );
}

/** Options + answer key for multiple choice, multiple answers, true/false and short answer. */
function ChoiceEditor({ type, choice, errors, onChange }: { type: QType; choice: Choice; errors: Record<string, string>; onChange: (c: Choice) => void }) {
  const set = (patch: Partial<Choice>) => onChange({ ...choice, ...patch });
  const opts = choice.options;
  const setOpt = (i: number, patch: Partial<ChoiceOpt>) => {
    let next = opts.map((o, j) => (j === i ? { ...o, ...patch } : o));
    // one-answer types: marking one correct un-marks the others
    if (patch.correct && type !== 'multiple_choice') next = next.map((o, j) => ({ ...o, correct: j === i }));
    set({ options: next });
  };
  const err = Object.entries(errors).filter(([k]) => k.startsWith('choice'));
  if (type === 'short_answer') {
    return (
      <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="h2">Accepted answers</h2>
        <p className="hint" style={{ margin: 0 }}>
          The student types an answer. It scores full points when it matches one of these (extra spaces are ignored). Answers that don't match go to you for review.
        </p>
        {choice.acceptedAnswers.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <input aria-label={`Accepted answer ${i + 1}`} value={a} onChange={(e) => set({ acceptedAnswers: choice.acceptedAnswers.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="An accepted answer" />
            </div>
            <button type="button" className="icon-btn" aria-label="Remove answer" onClick={() => set({ acceptedAnswers: choice.acceptedAnswers.filter((_, j) => j !== i) })}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ acceptedAnswers: [...choice.acceptedAnswers, ''] })}>
          <Icon name="plus" size={15} />
          Add accepted answer
        </button>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
          <Switch on={choice.caseSensitive} onChange={(v) => set({ caseSensitive: v })} label="Case sensitive" />
          Case sensitive (ABC ≠ abc)
        </label>
        <Explanation choice={choice} set={set} />
        {err.map(([k, v]) => (
          <span key={k} className="err-text">
            {v}
          </span>
        ))}
      </section>
    );
  }
  const tf = type === 'true_false';
  return (
    <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 className="h2">{tf ? 'Correct answer' : 'Options'}</h2>
      <p className="hint" style={{ margin: 0 }}>
        {type === 'multiple_choice' ? 'Tick every correct option. Students may choose several.' : tf ? 'Choose whether the statement is true or false.' : 'Tick the one correct option. Students choose one.'}
      </p>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {opts.map((o, i) => (
          <li key={o.id ?? `n${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, minWidth: 92, cursor: 'pointer' }}>
              <input type={type === 'multiple_choice' ? 'checkbox' : 'radio'} name="correct" checked={o.correct} onChange={(e) => setOpt(i, { correct: type === 'multiple_choice' ? e.target.checked : true })} aria-label={`Option ${i + 1} is correct`} />
              <span style={{ color: o.correct ? 'var(--ok)' : 'var(--muted)', fontWeight: o.correct ? 600 : 400 }}>{o.correct ? 'Correct' : 'Wrong'}</span>
            </label>
            <div className={`field ${errors[`choice.options[${i}].text`] ? 'invalid' : ''}`} style={{ flex: 1 }}>
              <input aria-label={`Option ${i + 1}`} value={o.text} disabled={tf} onChange={(e) => setOpt(i, { text: e.target.value })} placeholder={`Option ${i + 1}`} />
            </div>
            {!tf && (
              <>
                <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => { const a = opts.slice(); [a[i - 1], a[i]] = [a[i]!, a[i - 1]!]; set({ options: a }); }}>
                  <Icon name="chevu" size={15} />
                </button>
                <button type="button" className="icon-btn" aria-label="Delete option" onClick={() => set({ options: opts.filter((_, j) => j !== i) })}>
                  <Icon name="trash" size={15} />
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {!tf && (
        <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={opts.length >= 20} onClick={() => set({ options: [...opts, { text: '', correct: false }] })}>
          <Icon name="plus" size={15} />
          Add option
        </button>
      )}
      {!tf && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
          <Switch on={choice.shuffle} onChange={(v) => set({ shuffle: v })} label="Shuffle options" />
          Shuffle the options for each student
        </label>
      )}
      {type === 'multiple_choice' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
          <Switch on={choice.partialCredit} onChange={(v) => set({ partialCredit: v })} label="Partial credit" />
          Partial credit (each right pick counts, each wrong pick takes one away)
        </label>
      )}
      <Explanation choice={choice} set={set} />
      {err.map(([k, v]) => (
        <span key={k} className="err-text">
          {v}
        </span>
      ))}
    </section>
  );
}

function Explanation({ choice, set }: { choice: Choice; set: (p: Partial<Choice>) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label className="label" htmlFor="qexp">
        Explanation (optional, shown to students with their result)
      </label>
      <div className="field area">
        <textarea id="qexp" rows={3} value={choice.explanation} onChange={(e) => set({ explanation: e.target.value })} placeholder="Why the right answer is right" />
      </div>
    </div>
  );
}
