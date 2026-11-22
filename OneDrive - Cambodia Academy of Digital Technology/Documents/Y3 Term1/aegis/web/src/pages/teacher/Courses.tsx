import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { ago, Avatar, Banner, EmptyState, ErrorState, LoadingState, Switch, toast } from '../../components/ui';

interface ParsedStudent {
  studentId: string;
  fullName: string;
  email: string | null;
}

/** "ID, Full name, email" per line (comma, tab or semicolon). A header row is skipped. */
export function parseStudentLines(text: string): { rows: ParsedStudent[]; bad: string[] } {
  const rows: ParsedStudent[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t|;|,/).map((p) => p.trim().replace(/^"|"$/g, ''));
    const [id = '', name = '', email = ''] = parts;
    if (/^(student[\s_-]*id|id)$/i.test(id)) continue;
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(id) || (email && !/^\S+@\S+\.\S+$/.test(email))) {
      bad.push(line);
      continue;
    }
    rows.push({ studentId: id.toUpperCase(), fullName: name, email: email || null });
  }
  return { rows, bad };
}

function copy(text: string, what = 'Copied.') {
  navigator.clipboard?.writeText(text).then(
    () => toast.ok(what),
    () => toast.warn('Copy failed. Select the text and copy it yourself.'),
  );
}

export function Courses() {
  const { courseId } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const courses = useQuery({ queryKey: ['courses'], queryFn: () => api('/teacher/courses') });
  const [showNew, setShowNew] = useState(false);
  const items: any[] = courses.data?.items ?? [];
  const current = items.find((c) => c.id === courseId) ?? (courseId ? null : items[0]);

  useEffect(() => {
    if (!courseId && items[0]) nav(`/teacher/courses/${items[0].id}${sp.get('welcome') ? '?welcome=1' : ''}`, { replace: true });
  }, [courseId, items, nav, sp]);

  const crumbs = ['Teacher', 'Courses & students'];
  if (courses.isLoading) return <TeacherShell crumbs={crumbs}><LoadingState label="Loading your courses" /></TeacherShell>;
  if (courses.error) return <TeacherShell crumbs={crumbs}><ErrorState what="your courses" error={courses.error} onRetry={() => courses.refetch()} /></TeacherShell>;
  const refresh = () => qc.invalidateQueries({ queryKey: ['courses'] });

  return (
    <TeacherShell crumbs={crumbs} wide>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">Courses & students</h1>
          <p className="sub">Create your courses and classes, add students by their student ID, and send them their sign-in link.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowNew(!showNew)}>
          <Icon name="plus" />
          New course
        </button>
      </div>
      {sp.get('welcome') && (
        <Banner tone="info">
          <b>Welcome!</b> Start here: 1) create a course, 2) add a class, 3) add your students by student ID, 4) write questions in the Question bank, 5) create an exam.
        </Banner>
      )}
      {(showNew || items.length === 0) && (
        <NewCourse
          onCreated={(id) => {
            setShowNew(false);
            refresh();
            nav(`/teacher/courses/${id}`);
          }}
          onCancel={items.length ? () => setShowNew(false) : undefined}
        />
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          <nav aria-label="Courses" className="card" style={{ flex: '0 0 260px', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {items.map((c) => (
              <Link key={c.id} to={`/teacher/courses/${c.id}`} className={`nav-a ${current?.id === c.id ? 'nav-on' : ''}`} style={{ flexDirection: 'column', alignItems: 'flex-start', height: 'auto', padding: '10px 12px', gap: 2 }}>
                <b>{c.code}</b>
                <span className="hint">
                  {c.title} · {c.classes.reduce((a: number, x: any) => a + x.studentCount, 0)} students
                </span>
              </Link>
            ))}
          </nav>
          <div style={{ flex: '1 1 640px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
            {current ? <CourseDetail key={current.id} course={current} onChanged={refresh} /> : <EmptyState title="Course not found" text="Choose a course on the left." />}
          </div>
        </div>
      )}
    </TeacherShell>
  );
}

function NewCourse({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel?: () => void }) {
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [term, setTerm] = useState('');
  const [fe, setFe] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFe({});
    try {
      const r = await api('/teacher/courses', { method: 'POST', body: { code: code.trim(), title: title.trim(), termName: term.trim() } });
      toast.ok('Course created. Now add a class.');
      onCreated(r.id);
    } catch (x) {
      if (x instanceof ApiError) setFe(x.fieldErrors);
      toast.error(x);
    } finally {
      setBusy(false);
    }
  };
  const f = (id: string, label: string, v: string, set: (s: string) => void, ph: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px' }}>
      <label className="label" htmlFor={`nc-${id}`}>
        {label}
      </label>
      <div className={`field ${fe[id] ? 'invalid' : ''}`}>
        <input id={`nc-${id}`} value={v} onChange={(e) => set(e.target.value)} placeholder={ph} />
      </div>
      {fe[id] && <span className="err-text">{fe[id]}</span>}
    </div>
  );
  return (
    <form className="card" onSubmit={submit} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 className="h2">New course</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {f('code', 'Course code', code, setCode, 'e.g. PRG101')}
        {f('title', 'Course title', title, setTitle, 'e.g. Programming 1')}
        {f('termName', 'Term', term, setTerm, 'e.g. Semester 1 2026')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create course'}
        </button>
        {onCancel && (
          <button className="btn btn-ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function CourseDetail({ course, onChanged }: { course: any; onChanged: () => void }) {
  const [classId, setClassId] = useState<string | null>(course.classes[0]?.id ?? null);
  const [newClass, setNewClass] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!classId || !course.classes.some((c: any) => c.id === classId)) setClassId(course.classes[0]?.id ?? null);
  }, [course.classes, classId]);

  const addClass = async (e: FormEvent) => {
    e.preventDefault();
    if (!newClass.trim()) return;
    setBusy(true);
    try {
      const r = await api(`/teacher/courses/${course.id}/classes`, { method: 'POST', body: { code: newClass.trim() } });
      setNewClass('');
      setClassId(r.id);
      onChanged();
      toast.ok('Class added. Now add its students.');
    } catch (x) {
      toast.error(x);
    } finally {
      setBusy(false);
    }
  };
  const removeCourse = async () => {
    if (!window.confirm(`Delete ${course.code}? This works only when the course has no questions or exams.`)) return;
    try {
      await api(`/teacher/courses/${course.id}`, { method: 'DELETE' });
      toast.ok('Course deleted.');
      onChanged();
      window.location.assign('/teacher/courses');
    } catch (x) {
      toast.error(x);
    }
  };
  return (
    <>
      <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <h2 className="h2">
              {course.code} · {course.title}
            </h2>
            <p className="hint" style={{ margin: '4px 0 0' }}>{course.termName}</p>
          </div>
          <button type="button" className="btn btn-danger btn-sm" onClick={removeCourse}>
            <Icon name="trash" size={15} />
            Delete course
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="label">Classes</span>
          {course.classes.map((c: any) => (
            <button key={c.id} type="button" className={`chip ${classId === c.id ? 'chip-on' : ''}`} onClick={() => setClassId(c.id)}>
              {c.code} <span className="hint">· {c.studentCount}</span>
            </button>
          ))}
          <form onSubmit={addClass} style={{ display: 'flex', gap: 6 }}>
            <div className="field" style={{ height: 34, width: 170 }}>
              <input aria-label="New class name" value={newClass} onChange={(e) => setNewClass(e.target.value)} placeholder="New class, e.g. Group A" style={{ height: 32 }} />
            </div>
            <button className="btn btn-secondary btn-sm" type="submit" disabled={busy || !newClass.trim()}>
              <Icon name="plus" size={14} />
              Add class
            </button>
          </form>
        </div>
      </section>
      {classId ? <ClassStudents key={classId} classId={classId} onChanged={onChanged} /> : <EmptyState icon="users" title="Add a class" text="Students belong to classes (e.g. Group A, Morning class). Add one above, then add its students." />}
      <CourseTeachers courseId={course.id} />
    </>
  );
}

function ClassStudents({ classId, onChanged }: { classId: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const roster = useQuery({ queryKey: ['class-students', classId], queryFn: () => api(`/teacher/classes/${classId}/students`) });
  const [text, setText] = useState('');
  const [sendInvites, setSendInvites] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [links, setLinks] = useState<{ studentId: string; fullName: string; link: string }[]>([]);
  const [showMsg, setShowMsg] = useState(false);
  const parsed = parseStudentLines(text);
  const reload = () => {
    qc.invalidateQueries({ queryKey: ['class-students', classId] });
    onChanged();
  };

  const add = async () => {
    if (!parsed.rows.length) return toast.warn('Type at least one student ID.');
    setBusy(true);
    try {
      const r = await api(`/teacher/classes/${classId}/students`, { method: 'POST', body: { students: parsed.rows, sendInvites } });
      setResult(r);
      setLinks(r.items.filter((i: any) => i.inviteLink).map((i: any) => ({ studentId: i.studentId, fullName: i.fullName, link: i.inviteLink })));
      setText('');
      reload();
      toast.ok(`${r.enrolled} student${r.enrolled === 1 ? '' : 's'} added.`);
    } catch (x) {
      toast.error(x);
    } finally {
      setBusy(false);
    }
  };
  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setText((await f.text()).trim());
  };
  const resend = async (s: any) => {
    try {
      const r = await api(`/teacher/students/${s.id}/invite`, { method: 'POST' });
      if (r.inviteLink) setLinks((l) => [{ studentId: s.studentId, fullName: s.fullName, link: r.inviteLink }, ...l.filter((x) => x.studentId !== s.studentId)]);
      toast.ok(r.emailQueued ? `Link emailed to ${s.email}.` : 'New link ready below. Send it to the student.');
    } catch (x) {
      toast.error(x);
    }
  };
  const remove = async (s: any) => {
    if (!window.confirm(`Remove ${s.studentId} (${s.fullName}) from this class? Their account and past results stay.`)) return;
    try {
      await api(`/teacher/classes/${classId}/students/${s.id}`, { method: 'DELETE' });
      reload();
    } catch (x) {
      toast.error(x);
    }
  };

  if (roster.isLoading) return <LoadingState label="Loading students" />;
  if (roster.error) return <ErrorState what="the students" error={roster.error} onRetry={() => roster.refetch()} />;
  const data = roster.data;
  const emailOn = data.emailEnabled;
  return (
    <>
      <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <h2 className="h2">Add students to {data.class.code}</h2>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            One student per line: <span className="mono">student ID, full name, email</span>. Only the ID is required. You can also paste from Excel or open a CSV file.
          </p>
        </div>
        <div className="field area">
          <textarea aria-label="Students to add" rows={6} className="mono" style={{ fontSize: 13 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'E20230001, Sok Dara, dara@example.com\nE20230002, Chan Lina\nE20230003'} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={15} />
            Open CSV
            <input type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }} onChange={(e) => readFile(e.target.files?.[0])} />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
            <Switch on={sendInvites} onChange={setSendInvites} label="Send sign-in links" />
            {emailOn ? 'Email each new student a link to set their password' : 'Create sign-in links for new students'}
          </label>
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {parsed.rows.length} ready{parsed.bad.length ? ` · ${parsed.bad.length} line${parsed.bad.length === 1 ? '' : 's'} not understood` : ''}
          </span>
          <button type="button" className="btn btn-primary" onClick={add} disabled={busy || !parsed.rows.length}>
            <Icon name="users" />
            {busy ? 'Adding…' : `Add ${parsed.rows.length || ''} student${parsed.rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
        {parsed.bad.length > 0 && (
          <Banner tone="warn">
            These lines will be skipped (check the ID and email): <span className="mono">{parsed.bad.slice(0, 5).join(' | ')}</span>
          </Banner>
        )}
        {!emailOn && (
          <Banner tone="info">
            Email is not set up on this server, so students won't get an email. After adding them, copy their sign-in links below and send them (Telegram, Google Classroom, etc.). To send emails automatically, set SMTP_HOST in the server settings.
          </Banner>
        )}
        {result && (
          <Banner tone="ok" onClose={() => setResult(null)}>
            Added {result.enrolled} · new accounts {result.created} · already in class {result.alreadyEnrolled}
            {result.emailsQueued ? ` · ${result.emailsQueued} emails sent` : ''}
          </Banner>
        )}
        {links.length > 0 && (
          <div className="card" style={{ boxShadow: 'none', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <b>Sign-in links to send ({links.length})</b>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(links.map((l) => `${l.studentId} ${l.fullName}: ${l.link}`).join('\n'), 'All links copied.')}>
                <Icon name="copy" size={14} />
                Copy all
              </button>
            </div>
            <span className="hint">Each link is personal and works once. Students set their password, then sign in with their student ID.</span>
            {links.map((l) => (
              <div key={l.studentId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <b className="mono" style={{ minWidth: 110 }}>{l.studentId}</b>
                <span style={{ minWidth: 120 }}>{l.fullName}</span>
                <span className="mono hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.link}</span>
                <button type="button" className="icon-btn" aria-label={`Copy link for ${l.studentId}`} onClick={() => copy(l.link)}>
                  <Icon name="copy" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <h2 className="h2">
            {data.class.code} · {data.items.length} student{data.items.length === 1 ? '' : 's'}
          </h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowMsg(!showMsg)} disabled={!data.items.length}>
            <Icon name="mail" size={15} />
            Message this class
          </button>
        </div>
        {showMsg && <ClassMessage classId={classId} emailOn={emailOn} onDone={() => setShowMsg(false)} />}
        {data.items.length === 0 ? (
          <div className="hint" style={{ padding: 20 }}>No students in this class yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Student ID</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((s: any) => (
                  <tr key={s.id}>
                    <td className="mono">
                      <b>{s.studentId}</b>
                    </td>
                    <td>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar initials={s.initials} size={30} />
                        {s.fullName}
                      </span>
                    </td>
                    <td className="hint">{s.email ?? '—'}</td>
                    <td>
                      <span className={s.status === 'active' ? 'badge b-green' : s.status === 'invited' ? 'badge b-amber' : 'badge b-gray'}>{s.status === 'active' ? 'Active' : s.status === 'invited' ? 'Invited' : 'Disabled'}</span>
                    </td>
                    <td className="hint">{s.lastLoginAt ? ago(s.lastLoginAt) : 'Never'}</td>
                    <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => resend(s)} title={s.status === 'active' ? 'Send a password reset link' : 'Send a new sign-in link'}>
                        <Icon name="send" size={14} />
                        {s.status === 'active' ? 'Reset link' : 'New link'}
                      </button>
                      <button type="button" className="icon-btn" aria-label={`Remove ${s.studentId}`} onClick={() => remove(s)}>
                        <Icon name="trash" size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ClassMessage({ classId, emailOn, onDone }: { classId: string; emailOn: boolean; onDone: () => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/teacher/classes/${classId}/message`, { method: 'POST', body: { subject, body } });
      toast.ok(`Sent to ${r.notified} students${r.emailsQueued ? ` (${r.emailsQueued} by email)` : ''}.`);
      onDone();
    } catch (x) {
      toast.error(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={send} style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid var(--border)' }}>
      <div className="field">
        <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject, e.g. Midterm on Monday" />
      </div>
      <div className="field area">
        <textarea aria-label="Message" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Your message to the class" />
      </div>
      <span className="hint">Students see it in their notifications{emailOn ? ' and get it by email' : ''}.</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !subject.trim() || !body.trim()}>
          <Icon name="send" size={14} />
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CourseTeachers({ courseId }: { courseId: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['course-teachers', courseId], queryFn: () => api(`/teacher/courses/${courseId}/teachers`) });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/teacher/courses/${courseId}/teachers`, { method: 'POST', body: { email: email.trim(), fullName: name.trim() } });
      setLink(r.inviteLink);
      setEmail('');
      setName('');
      qc.invalidateQueries({ queryKey: ['course-teachers', courseId] });
      toast.ok(r.emailSent ? 'Teacher invited by email.' : r.invited ? 'Teacher added. Send them the link below.' : 'Teacher added.');
    } catch (x) {
      toast.error(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 className="h2">Teachers of this course</h2>
      {(list.data?.items ?? []).map((t: any) => (
        <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14 }}>
          <b>{t.fullName}</b>
          <span className="hint">{t.email}</span>
          {t.isMe && <span className="badge b-blue">You</span>}
          {t.status === 'invited' && <span className="badge b-amber">Invited</span>}
        </div>
      ))}
      <form onSubmit={add} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <div className="field" style={{ flex: '1 1 180px' }}>
          <input aria-label="Teacher name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Co-teacher name" />
        </div>
        <div className="field" style={{ flex: '1 1 220px' }}>
          <input aria-label="Teacher email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="their@email" />
        </div>
        <button className="btn btn-secondary" type="submit" disabled={busy || !email.trim() || !name.trim()}>
          Add teacher
        </button>
      </form>
      {link && (
        <Banner tone="info" onClose={() => setLink(null)}>
          Send this sign-in link to the new teacher: <span className="mono" style={{ wordBreak: 'break-all' }}>{link}</span>{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(link)}>
            Copy
          </button>
        </Banner>
      )}
    </section>
  );
}
