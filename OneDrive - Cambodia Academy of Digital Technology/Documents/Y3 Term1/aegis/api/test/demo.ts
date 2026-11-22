/**
 * Demo testing mode: one-click demo accounts, typed demo logins, role access, isolation from real data,
 * and that demo mode is OFF unless DEMO_MODE=true AND NODE_ENV=development. Run: npm test
 */
import './env';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { pool, q } from '../src/db';
import { migrate } from '../src/db/migrate';
import { startJobs } from '../src/jobs';
import { prepareTestDb } from './env';

let BASE = '';
let passed = 0;
const failures: string[] = [];
class Client {
  token = '';
  session = '';
  async req(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.session) headers['X-Exam-Session'] = this.session;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, data: (ct.includes('json') ? await res.json() : await res.text()) as any };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b);
}
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(e?.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}
const ok = (r: { status: number; data: any }, status = 200) => assert.equal(r.status, status, JSON.stringify(r.data).slice(0, 400));

/** What config.demoMode becomes for a given environment (fresh process, like a real server start). */
function demoFlag(env: Record<string, string>) {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then(m => console.log(JSON.stringify(m.config.demoMode)))"], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, JWT_ACCESS_SECRET: 'test-secret-for-config-check', ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop()!);
}

async function main() {
  await prepareTestDb();
  await migrate();
  await q(`TRUNCATE users, terms, courses, questions, exams, audit_events, notifications, validation_jobs, outbound_emails CASCADE`);
  const app = createApp();
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  startJobs();

  const realT = new Client();
  const realS = new Client();
  let realCourse = '';

  console.log('Demo mode switch');
  await step('demo mode needs DEMO_MODE=true AND NODE_ENV=development (never production)', async () => {
    assert.equal(demoFlag({ DEMO_MODE: 'true', NODE_ENV: 'development' }), true);
    assert.equal(demoFlag({ DEMO_MODE: 'true', NODE_ENV: 'production' }), false);
    assert.equal(demoFlag({ DEMO_MODE: 'true', NODE_ENV: '' }), false);
    assert.equal(demoFlag({ DEMO_MODE: 'false', NODE_ENV: 'development' }), false);
  });

  console.log('Real accounts (normal login keeps working)');
  await step('real teacher + real student via setup and invite; normal logins work', async () => {
    const s = await realT.post('/api/auth/setup', { fullName: 'Real Teacher', email: 'real@school.test', password: 'real-pass-1' });
    ok(s, 201);
    realT.token = s.data.accessToken;
    const c = await realT.post('/api/teacher/courses', { code: 'REAL1', title: 'Real Course', termName: 'T1' });
    realCourse = c.data.id;
    const cl = await realT.post(`/api/teacher/courses/${realCourse}/classes`, { code: 'A' });
    const add = await realT.post(`/api/teacher/classes/${cl.data.id}/students`, { students: [{ studentId: 'R001', fullName: 'Real Student' }] });
    const token = new URL(add.data.items[0].inviteLink).searchParams.get('token');
    ok(await realS.post('/api/auth/reset-password', { token, newPassword: 'student-pass-1' }), 204);
    const lt = await new Client().post('/api/auth/login', { identifier: 'real@school.test', password: 'real-pass-1', role: 'teacher' });
    ok(lt);
    const ls = await realS.post('/api/auth/login', { identifier: 'R001', password: 'student-pass-1', role: 'student' });
    ok(ls);
    realS.token = ls.data.accessToken;
    assert.equal(ls.data.user.isDemo, false);
  });

  console.log('Demo mode OFF (default)');
  config.demoMode = false;
  await step('demo endpoints are hidden and demo usernames do not work', async () => {
    assert.deepEqual((await new Client().get('/api/auth/demo')).data, { enabled: false });
    ok(await new Client().post('/api/auth/demo', { role: 'teacher' }), 404);
    ok(await new Client().post('/api/auth/login', { identifier: 'demo_teacher', password: 'DemoTeacher123', role: 'teacher' }), 401);
  });

  console.log('Demo mode ON');
  config.demoMode = true;
  const dT = new Client();
  const dS = new Client();
  await step('login page gets the demo accounts', async () => {
    const r = await new Client().get('/api/auth/demo');
    assert.equal(r.data.enabled, true);
    assert.equal(r.data.accounts.student.username, 'demo_student');
    assert.equal(r.data.accounts.teacher.password, 'DemoTeacher123');
  });
  await step('one-click Demo Teacher and Demo Student', async () => {
    const t = await dT.post('/api/auth/demo', { role: 'teacher' });
    ok(t);
    dT.token = t.data.accessToken;
    assert.equal(t.data.user.role, 'teacher');
    assert.equal(t.data.user.isDemo, true);
    const s = await dS.post('/api/auth/demo', { role: 'student' });
    ok(s);
    dS.token = s.data.accessToken;
    assert.equal(s.data.user.role, 'student');
    assert.equal(s.data.user.isDemo, true);
  });
  await step('typed demo logins work: demo_teacher / DemoTeacher123, demo_student / DemoStudent123', async () => {
    ok(await new Client().post('/api/auth/login', { identifier: 'demo_teacher', password: 'DemoTeacher123', role: 'teacher' }));
    ok(await new Client().post('/api/auth/login', { identifier: 'demo_student', password: 'DemoStudent123', role: 'student' }));
    ok(await new Client().post('/api/auth/login', { identifier: 'demo_student', password: 'wrong-password', role: 'student' }), 401);
  });
  await step('roles: student cannot open teacher pages, teacher cannot open student pages', async () => {
    ok(await dS.get('/api/teacher/dashboard'), 403);
    ok(await dS.get('/api/teacher/questions'), 403);
    ok(await dS.post('/api/teacher/exams', { courseId: realCourse, title: 'x', classIds: [] }), 403);
    ok(await dT.get('/api/student/dashboard'), 403);
  });
  await step('demo teacher sees only the demo course, with ready questions; never real data', async () => {
    const c = await dT.get('/api/teacher/courses');
    assert.deepEqual(c.data.items.map((x: any) => x.code), ['DEMO101']);
    const qs = await dT.get('/api/teacher/questions');
    assert.equal(qs.data.total, 5);
    assert.deepEqual(qs.data.items.map((x: any) => x.type).sort(), ['code', 'multiple_choice', 'short_answer', 'single_choice', 'true_false']);
    ok(await dT.get(`/api/teacher/courses/${realCourse}/teachers`), 403);
    const audit = await dT.get('/api/teacher/audit');
    assert.ok(!JSON.stringify(audit.data).includes('Real'), 'demo teacher saw real audit events');
    const realView = await realT.get('/api/teacher/courses');
    assert.deepEqual(realView.data.items.map((x: any) => x.code), ['REAL1'], 'real teacher saw the demo course');
  });
  await step('demo and real accounts never mix', async () => {
    const demoClass = (await dT.get('/api/teacher/courses')).data.items[0].classes[0].id;
    const addReal = await dT.post(`/api/teacher/classes/${demoClass}/students`, { students: [{ studentId: 'R001' }] });
    ok(addReal, 422);
    const realClass = (await realT.get('/api/teacher/courses')).data.items[0].classes[0].id;
    ok(await realT.post(`/api/teacher/classes/${realClass}/students`, { students: [{ studentId: 'DEMO_STUDENT' }] }), 422);
    ok(await dT.post(`/api/teacher/courses/${(await dT.get('/api/teacher/courses')).data.items[0].id}/teachers`, { email: 'x@y.test', fullName: 'X' }), 422);
    const newDemo = await dT.post(`/api/teacher/classes/${demoClass}/students`, { students: [{ studentId: 'DEMO_S2', fullName: 'Demo Two' }] });
    ok(newDemo, 201);
  });
  let examId = '';
  await step('demo student: open exam on the dashboard → lobby → start → answer → submit', async () => {
    const d = await dS.get('/api/student/dashboard');
    ok(d);
    const up = d.data.upcoming.find((u: any) => u.title.startsWith('Demo Exam'));
    assert.ok(up, 'no demo exam on the dashboard');
    assert.equal(up.state, 'open');
    examId = up.examId;
    ok(await dS.get(`/api/student/exams/${examId}/lobby`));
    const st = await dS.post(`/api/student/exams/${examId}/start`, { integrityAccepted: true });
    ok(st);
    dS.session = st.data.sessionToken;
    const ws = (await dS.get(`/api/student/exams/${examId}/workspace`)).data;
    assert.equal(ws.questions.length, 5);
    const cap = ws.questions.find((x: any) => x.title === 'Demo: capital city');
    const pp = cap.options.find((o: any) => o.text === 'Phnom Penh').id;
    ok(await dS.put(`/api/student/exams/${examId}/answers/${cap.examQuestionId}`, { response: { selected: [pp] }, baseRevision: 0, clientSavedAt: new Date().toISOString() }));
    const code = ws.questions.find((x: any) => x.type === 'code');
    ok(await dS.put(`/api/student/exams/${examId}/answers/${code.examQuestionId}`, { language: 'python', files: { 'main.py': 'a, b = map(int, input().split())\nprint(a + b)\n' }, baseRevision: 0, clientSavedAt: new Date().toISOString() }));
    ok(await dS.post(`/api/student/exams/${examId}/submit`, { confirmFinal: true }), 202);
  });
  await step('demo teacher sees the submission; next demo login gets a fresh exam', async () => {
    let items: any[] = [];
    for (let i = 0; i < 60; i++) {
      items = (await dT.get(`/api/teacher/exams/${examId}/grading/roster`)).data.items;
      if (items.length && items[0].gradingStatus !== 'pending_tests') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(items.length, 1);
    assert.equal(items[0].fullName, 'Demo Student');
    assert.equal(items[0].total, 12, 'capital (2) + code (10)');
    const again = await new Client().post('/api/auth/demo', { role: 'student' });
    const c2 = new Client();
    c2.token = again.data.accessToken;
    const d = await c2.get('/api/student/dashboard');
    const open = d.data.upcoming.filter((u: any) => u.title.startsWith('Demo Exam') && u.state === 'open');
    assert.ok(open.length >= 1 && open[0].examId !== examId, 'no fresh demo exam');
  });
  await step('real student never sees demo exams', async () => {
    const d = await realS.get('/api/student/dashboard');
    assert.ok(!JSON.stringify(d.data).includes('Demo Exam'));
  });

  console.log('Demo mode switched OFF again');
  config.demoMode = false;
  await step('existing demo sessions stop working; real accounts unaffected', async () => {
    const r = await dT.get('/api/teacher/dashboard');
    ok(r, 401);
    assert.equal(r.data.error.code, 'DEMO_DISABLED');
    ok(await new Client().post('/api/auth/login', { identifier: 'DEMO_STUDENT', password: 'DemoStudent123', role: 'student' }), 401);
    ok(await realT.get('/api/teacher/dashboard'));
    ok(await realS.get('/api/student/dashboard'));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  await pool.end().catch(() => undefined);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
