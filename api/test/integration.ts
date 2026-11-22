/**
 * End-to-end API test against a real Postgres + local runner.
 * Run: npm test   (uses TEST_DATABASE_URL, default postgres://aegis:aegis@127.0.0.1:5432/aegis_test — never your real database)
 */
import './env';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool, q, one } from '../src/db';
import { startJobs } from '../src/jobs';
import { prepareTestDb } from './env';
import { seed } from './fixtures';

let BASE = '';
let passed = 0;
const failures: string[] = [];

class Client {
  token = '';
  cookie = '';
  session = '';
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.session) headers['X-Exam-Session'] = this.session;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith('aegis_rt=')) this.cookie = set.split(';')[0]!;
    const ct = res.headers.get('content-type') ?? '';
    const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data: data as any, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  async login(identifier: string, password: string, role: 'student' | 'teacher') {
    const r = await this.post('/api/auth/login', { identifier, password, role });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    this.token = r.data.accessToken;
    return r.data;
  }
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${e?.message?.split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitRun(c: Client, examId: string, runId: string) {
  for (let i = 0; i < 20; i++) {
    const r = await c.get(`/api/student/exams/${examId}/runs/${runId}?waitMs=5000`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (!['queued', 'running'].includes(r.data.status)) return r.data;
  }
  throw new Error('run did not finish');
}

async function main() {
  await prepareTestDb();
  await seed();
  const app = createApp();
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  startJobs();

  const mid = await one(`SELECT id FROM exams WHERE short_title = 'FX Exam'`);
  const examId: string = mid.id;
  const alex = new Client();
  const teacher = new Client();
  const sarah = new Client();
  let ws: any;
  const qByTitle = (t: string) => ws.questions.find((x: any) => x.title === t);

  console.log('Auth');
  await step('health', async () => {
    const r = await alex.get('/api/health');
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('x-server-time'));
  });
  await step('wrong password → 401 INVALID_CREDENTIALS', async () => {
    const r = await new Client().post('/api/auth/login', { identifier: 'S0001', password: 'nope', role: 'student' });
    assert.equal(r.status, 401);
    assert.equal(r.data.error.code, 'INVALID_CREDENTIALS');
  });
  await step('teacher on Student tab → 403 ROLE_MISMATCH', async () => {
    const r = await new Client().post('/api/auth/login', { identifier: 'teacher@test.local', password: 'teacher12345', role: 'student' });
    assert.equal(r.status, 403);
    assert.equal(r.data.error.code, 'ROLE_MISMATCH');
  });
  await step('validation error envelope', async () => {
    const r = await new Client().post('/api/auth/login', { identifier: '', password: '', role: 'student' });
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'VALIDATION_FAILED');
    assert.ok(r.data.error.fieldErrors.identifier);
  });
  await step('student + teacher login, /me', async () => {
    await alex.login('S0001', 'student12345', 'student');
    await teacher.login('teacher@test.local', 'teacher12345', 'teacher');
    await sarah.login('test.student.two@students.test.local', 'student12345', 'student');
    const me = await alex.get('/api/auth/me');
    assert.equal(me.data.user.fullName, 'Test Student One');
    assert.equal(me.data.user.initials, 'TS');
  });
  await step('refresh rotates, reused refresh token is rejected', async () => {
    const c = new Client();
    await c.login('S0007', 'student12345', 'student');
    const old = c.cookie;
    const r1 = await c.post('/api/auth/refresh');
    assert.equal(r1.status, 200);
    assert.notEqual(c.cookie, old);
    const reuse = new Client();
    reuse.cookie = old;
    const r2 = await reuse.post('/api/auth/refresh');
    assert.equal(r2.status, 401);
    // the whole family is revoked now
    const r3 = await c.post('/api/auth/refresh');
    assert.equal(r3.status, 401);
  });
  await step('role guard: student cannot call teacher API', async () => {
    const r = await alex.get('/api/teacher/dashboard');
    assert.equal(r.status, 403);
  });

  console.log('Student exam flow');
  await step('dashboard lists the open midterm', async () => {
    const r = await alex.get('/api/student/dashboard');
    assert.equal(r.status, 200);
    const e = r.data.upcoming.find((x: any) => x.examId === examId);
    assert.ok(e, 'midterm missing');
    assert.equal(e.state, 'open');
    assert.deepEqual(e.languages, ['java', 'python']);
    assert.ok(r.data.practice?.examId);
  });
  await step('lobby returns checks and exam meta', async () => {
    const r = await alex.get(`/api/student/exams/${examId}/lobby`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.exam.questionCount, 3);
    assert.equal(r.data.exam.totalPoints, 100);
    assert.equal(r.data.checks.find((c: any) => c.key === 'runner').status, 'ready');
  });
  await step('start without integrity → 422', async () => {
    const r = await alex.post(`/api/student/exams/${examId}/start`, {});
    assert.equal(r.status, 422);
    assert.equal(r.data.error.code, 'INTEGRITY_NOT_ACCEPTED');
  });
  let firstToken = '';
  await step('start → session token + deadline', async () => {
    const r = await alex.post(`/api/student/exams/${examId}/start`, { integrityAccepted: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    firstToken = r.data.sessionToken;
    alex.session = firstToken;
    assert.ok(new Date(r.data.session.deadlineAt).getTime() > Date.now() + 60 * 60_000);
  });
  await step('workspace hides hidden tests and reference code', async () => {
    const r = await alex.get(`/api/student/exams/${examId}/workspace`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    ws = r.data;
    assert.equal(ws.questions.length, 3);
    const raw = JSON.stringify(ws);
    assert.ok(!raw.includes('502.5'), 'hidden expected value leaked');
    assert.ok(!raw.includes('Insufficient funds")'), 'reference solution leaked');
    const q2 = qByTitle('Banking Account Inheritance Hierarchy');
    assert.equal(q2.templates.java.find((f: any) => f.path === 'InsufficientFundsException.java').readOnly, true);
    assert.equal(q2.sample.expected, '600.0');
  });
  await step('resume from a second device takes over the session', async () => {
    const other = new Client();
    other.token = alex.token;
    const r = await other.post(`/api/student/exams/${examId}/start`, { integrityAccepted: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.session.resumed, true);
    const hb = await alex.post(`/api/student/exams/${examId}/heartbeat`, { online: true });
    assert.equal(hb.status, 409);
    assert.equal(hb.data.error.code, 'SESSION_TAKEN_OVER');
    alex.session = r.data.sessionToken;
  });
  await step('save answer, read-only and unknown files rejected', async () => {
    const q2 = qByTitle('Banking Account Inheritance Hierarchy');
    const ro = await alex.put(`/api/student/exams/${examId}/answers/${q2.examQuestionId}`, { language: 'java', files: { 'InsufficientFundsException.java': 'x' }, baseRevision: 0, clientSavedAt: new Date().toISOString() });
    assert.equal(ro.status, 422);
    assert.equal(ro.data.error.code, 'READ_ONLY_FILE');
    const unk = await alex.put(`/api/student/exams/${examId}/answers/${q2.examQuestionId}`, { language: 'java', files: { 'Hack.java': 'x' }, baseRevision: 0, clientSavedAt: new Date().toISOString() });
    assert.equal(unk.data.error.code, 'UNKNOWN_FILE');
    const fixed = q2.templates.java.find((f: any) => f.path === 'SavingsAccount.java').content.replace('return false; // TODO: handle overdraft as the spec says', 'throw new InsufficientFundsException("Insufficient funds");');
    const ok = await alex.put(`/api/student/exams/${examId}/answers/${q2.examQuestionId}`, { language: 'java', files: { 'SavingsAccount.java': fixed }, baseRevision: 0, clientSavedAt: new Date().toISOString(), currentQuestionPosition: 2 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(ok.data.revision >= 1);
  });
  await step('offline sync: last write wins per file by client time', async () => {
    const q1 = qByTitle('BankAccount Class');
    const base = q1.templates.java.find((f: any) => f.path === 'BankAccount.java').content;
    const older = base.replace('// TODO: reject negative amounts', '// OLD');
    const newer = base.replace('// TODO: reject negative amounts', '// NEW');
    const t0 = Date.now();
    const r = await alex.post(`/api/student/exams/${examId}/answers/sync`, {
      items: [
        { examQuestionId: q1.examQuestionId, language: 'java', files: { 'BankAccount.java': newer }, baseRevision: 0, clientSavedAt: new Date(t0).toISOString() },
        { examQuestionId: q1.examQuestionId, language: 'java', files: { 'BankAccount.java': older }, baseRevision: 0, clientSavedAt: new Date(t0 - 5000).toISOString() },
      ],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const w = await alex.get(`/api/student/exams/${examId}/workspace`);
    const saved = w.data.questions.find((x: any) => x.examQuestionId === q1.examQuestionId).answer.files.java['BankAccount.java'];
    assert.ok(saved.includes('// NEW'), 'older offline write overwrote the newer one');
  });
  await step('Run tests (Java, packages): sample tests pass after the fix', async () => {
    const q2 = qByTitle('Banking Account Inheritance Hierarchy');
    const w = await alex.get(`/api/student/exams/${examId}/workspace`);
    const ans = w.data.questions.find((x: any) => x.examQuestionId === q2.examQuestionId).answer.files.java;
    const files = Object.fromEntries(q2.templates.java.map((f: any) => [f.path, ans[f.path] ?? f.content]));
    const r = await alex.post(`/api/student/exams/${examId}/runs`, { examQuestionId: q2.examQuestionId, kind: 'sample_tests', language: 'java', files });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const res = await waitRun(alex, examId, r.data.runId);
    assert.equal(res.status, 'completed', JSON.stringify(res.console));
    assert.equal(res.testsTotal, 2, 'hidden test must not run on Run tests');
    assert.equal(res.testsPassed, 2, JSON.stringify(res.tests));
  });
  await step('Run tests (Python starter): overdraft test fails with a clear message', async () => {
    const q2 = qByTitle('Banking Account Inheritance Hierarchy');
    const files = Object.fromEntries(q2.templates.python.map((f: any) => [f.path, f.content]));
    const r = await alex.post(`/api/student/exams/${examId}/runs`, { examQuestionId: q2.examQuestionId, kind: 'sample_tests', language: 'python', files });
    const res = await waitRun(alex, examId, r.data.runId);
    assert.equal(res.testsPassed, 1);
    const t = res.tests.find((x: any) => !x.passed);
    assert.match(t.message, /to be thrown, but returned false instead/);
  });
  await step('Run (program): console output and exit code', async () => {
    const q1 = qByTitle('BankAccount Class');
    const files = Object.fromEntries(q1.templates.java.map((f: any) => [f.path, f.content]));
    const r = await alex.post(`/api/student/exams/${examId}/runs`, { examQuestionId: q1.examQuestionId, kind: 'run', language: 'java', files });
    const res = await waitRun(alex, examId, r.data.runId);
    assert.equal(res.status, 'completed');
    assert.ok(res.console.some((l: any) => l.stream === 'stdout' && l.text === 'Balance: 500.0'), JSON.stringify(res.console));
    assert.equal(res.exitCode, 0);
  });
  await step('Custom input (Python stdin)', async () => {
    const q1 = qByTitle('BankAccount Class');
    const files = Object.fromEntries(q1.templates.python.map((f: any) => [f.path, f.content]));
    files['main.py'] = 'import sys\nprint("got", sys.stdin.read().strip().upper())\n';
    const r = await alex.post(`/api/student/exams/${examId}/runs`, { examQuestionId: q1.examQuestionId, kind: 'custom_input', language: 'python', files, stdin: 'hello wörld' });
    const res = await waitRun(alex, examId, r.data.runId);
    assert.ok(res.console.some((l: any) => l.text === 'got HELLO WÖRLD'), JSON.stringify(res.console));
  });
  await step('compile error → diagnostics with file and line', async () => {
    const q1 = qByTitle('BankAccount Class');
    const files = Object.fromEntries(q1.templates.java.map((f: any) => [f.path, f.content]));
    files['BankAccount.java'] = files['BankAccount.java'].replace('return balance;', 'return balance');
    const r = await alex.post(`/api/student/exams/${examId}/runs`, { examQuestionId: q1.examQuestionId, kind: 'sample_tests', language: 'java', files });
    const res = await waitRun(alex, examId, r.data.runId);
    assert.equal(res.status, 'compile_error');
    assert.equal(res.diagnostics[0].path, 'BankAccount.java');
    assert.equal(res.diagnostics[0].line, 20);
  });
  await step('infinite loop → time limit', async () => {
    const q1 = qByTitle('BankAccount Class');
    const files = Object.fromEntries(q1.templates.python.map((f: any) => [f.path, f.content]));
    files['main.py'] = 'while True:\n    pass\n';
    const r = await alex.post(`/api/student/exams/${examId}/runs`, { examQuestionId: q1.examQuestionId, kind: 'run', language: 'python', files });
    const res = await waitRun(alex, examId, r.data.runId);
    assert.equal(res.status, 'time_limit');
  });
  await step('restore the fixed Q1 answer for grading', async () => {
    const q1 = qByTitle('BankAccount Class');
    const ref = q1.templates.java.find((f: any) => f.path === 'BankAccount.java').content
      .replace('        // TODO: reject negative amounts with IllegalArgumentException, then add to the balance', '        if (amount < 0) throw new IllegalArgumentException("neg");\n        balance += amount;')
      .replace('        // TODO: return false when funds are insufficient, otherwise subtract and return true\n        return false;', '        if (amount > balance) return false;\n        balance -= amount;\n        return true;');
    const r = await alex.put(`/api/student/exams/${examId}/answers/${q1.examQuestionId}`, { language: 'java', files: { 'BankAccount.java': ref }, baseRevision: 0, clientSavedAt: new Date().toISOString() });
    assert.equal(r.status, 200);
    // the Python run above switched Q2's answer language; the student switches back to Java
    const q2 = qByTitle('Banking Account Inheritance Hierarchy');
    const r2 = await alex.put(`/api/student/exams/${examId}/answers/${q2.examQuestionId}`, { language: 'java', files: {}, baseRevision: 0, clientSavedAt: new Date().toISOString() });
    assert.equal(r2.status, 200);
  });
  await step('tab switches flag the session; teacher gets notified', async () => {
    const now = new Date().toISOString();
    const r = await alex.post(`/api/student/exams/${examId}/events`, { events: [{ type: 'tab_switch', occurredAt: now }, { type: 'tab_switch', occurredAt: now }] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.flagged, true);
    const n = await teacher.get('/api/notifications');
    assert.ok(n.data.items.some((x: any) => x.type === 'proctor_flag' && x.title.includes('Test Student One switched tabs twice')));
  });

  console.log('Teacher live actions');
  await step('monitor shows the flagged student with progress', async () => {
    const r = await teacher.get(`/api/teacher/exams/${examId}/monitor`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const row = r.data.rows.find((x: any) => x.fullName === 'Test Student One');
    assert.equal(row.status, 'flagged');
    assert.equal(row.progress.length, 3);
    assert.ok(r.data.flagLog.length >= 2);
    assert.equal(r.data.stats.assigned, 8);
  });
  await step('+10 min for one student updates the deadline seen by heartbeat', async () => {
    const before = await alex.post(`/api/student/exams/${examId}/heartbeat`, { online: true });
    const me = await alex.get('/api/auth/me');
    const r = await teacher.post(`/api/teacher/exams/${examId}/extend`, { minutes: 10, studentId: me.data.user.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const after = await alex.post(`/api/student/exams/${examId}/heartbeat`, { online: true });
    const diff = new Date(after.data.deadlineAt).getTime() - new Date(before.data.deadlineAt).getTime();
    assert.ok(diff > 0, `deadline did not move (${diff})`);
  });
  await step('announcement reaches the student heartbeat', async () => {
    const r = await teacher.post(`/api/teacher/exams/${examId}/messages`, { scope: 'all', body: 'Interest is applied monthly at 0.5%.' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const hb = await alex.post(`/api/student/exams/${examId}/heartbeat`, { online: true, lastAnnouncementId: null });
    assert.ok(hb.data.announcements.some((a: any) => a.body.includes('0.5%')));
  });

  console.log('Submit + grading');
  await step('submit-summary reflects sample runs', async () => {
    const r = await alex.get(`/api/student/exams/${examId}/submit-summary`);
    assert.equal(r.status, 200);
    assert.equal(r.data.questions.length, 3);
  });
  await step('submit requires confirmation, then succeeds once', async () => {
    const bad = await alex.post(`/api/student/exams/${examId}/submit`, { confirmFinal: false });
    assert.equal(bad.status, 422);
    const r = await alex.post(`/api/student/exams/${examId}/submit`, { confirmFinal: true, pending: [] });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    const again = await alex.post(`/api/student/exams/${examId}/submit`, { confirmFinal: true });
    assert.equal(again.status, 409);
  });
  await step('Sarah starts and submits the untouched starter code', async () => {
    const s = await sarah.post(`/api/student/exams/${examId}/start`, { integrityAccepted: true });
    sarah.session = s.data.sessionToken;
    const r = await sarah.post(`/api/student/exams/${examId}/submit`, { confirmFinal: true });
    assert.equal(r.status, 202, JSON.stringify(r.data));
  });
  let subId = '';
  await step('hidden tests graded, auto score + AI suggestion ready', async () => {
    for (let i = 0; i < 60; i++) {
      const r = await teacher.get(`/api/teacher/exams/${examId}/grading/roster`);
      const a = r.data.items.find((x: any) => x.fullName === 'Test Student One');
      if (a && a.gradingStatus !== 'pending_tests') {
        subId = a.submissionId;
        break;
      }
      await sleep(1000);
    }
    assert.ok(subId, 'grading did not finish');
    for (let i = 0; i < 30; i++) {
      const d = await teacher.get(`/api/teacher/grading/submissions/${subId}`);
      if (d.data.questions.every((x: any) => x.ai?.status === 'done')) break;
      await sleep(500);
    }
    const d = await teacher.get(`/api/teacher/grading/submissions/${subId}`);
    const q1 = d.data.questions.find((x: any) => x.position === 1);
    const q2 = d.data.questions.find((x: any) => x.position === 2);
    const q3 = d.data.questions.find((x: any) => x.position === 3);
    assert.equal(q1.autoScore, 30, JSON.stringify(q1.tests));
    assert.equal(q2.autoScore, 40, JSON.stringify(q2.tests));
    assert.equal(q3.autoScore, 0);
    assert.ok(q2.tests.some((t: any) => t.hidden && t.passed), 'hidden test not graded');
    assert.equal(q3.ai.status, 'done');
    assert.equal(d.data.total, 70);
  });
  await step('teacher adjusts a score with feedback (audited)', async () => {
    const d = await teacher.get(`/api/teacher/grading/submissions/${subId}`);
    const q3 = d.data.questions.find((x: any) => x.position === 3);
    const bad = await teacher.put(`/api/teacher/grading/answers/${q3.submissionAnswerId}`, { teacherScore: 99, feedback: 'x' });
    assert.equal(bad.status, 422);
    const r = await teacher.put(`/api/teacher/grading/answers/${q3.submissionAnswerId}`, { teacherScore: 5, feedback: 'Good start; implement write() with UTF-8.', acceptedAiSuggestion: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.finalScore, 5);
    assert.equal(r.data.adjusted, true);
    const rv = await teacher.post(`/api/teacher/grading/submissions/${subId}/review`);
    assert.equal(rv.data.gradingStatus, 'reviewed');
    const a = await teacher.get('/api/teacher/audit?category=grade_change');
    assert.ok(a.data.items.some((x: any) => x.details.includes('Score 0 → 5 / 30')));
  });
  await step('student cannot see the score before release', async () => {
    const r = await alex.get(`/api/student/results/${examId}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.released, false);
    assert.equal(r.data.score, undefined);
  });
  await step('end exam → grading; release requires review or force', async () => {
    const e = await teacher.post(`/api/teacher/exams/${examId}/end`, { confirm: true });
    assert.equal(e.status, 200, JSON.stringify(e.data));
    // wait for Sarah's grading to finish
    for (let i = 0; i < 40; i++) {
      const r = await teacher.get(`/api/teacher/exams/${examId}/grading/roster`);
      if (r.data.items.every((x: any) => x.gradingStatus !== 'pending_tests')) break;
      await sleep(1000);
    }
    const r1 = await teacher.post(`/api/teacher/exams/${examId}/results/release`, {});
    assert.equal(r1.status, 409);
    assert.equal(r1.data.error.code, 'REVIEW_INCOMPLETE');
    const r2 = await teacher.post(`/api/teacher/exams/${examId}/results/release`, { force: true });
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
  });
  await step('student sees released score, tests and teacher feedback (no AI text)', async () => {
    const r = await alex.get(`/api/student/results/${examId}`);
    assert.equal(r.data.released, true);
    assert.equal(r.data.score, 75);
    const q3 = r.data.questions.find((x: any) => x.position === 3);
    assert.equal(q3.feedback, 'Good start; implement write() with UTF-8.');
    assert.ok(!JSON.stringify(r.data).includes('heuristic'));
    assert.ok(r.data.facts.rankTopPercent >= 1);
  });
  await step('teacher results analytics + CSV + ZIP exports', async () => {
    const r = await teacher.get(`/api/teacher/exams/${examId}/results`);
    assert.equal(r.status, 200);
    assert.equal(r.data.submittedCount, 2);
    assert.equal(r.data.distribution.reduce((a: number, b: any) => a + b.count, 0), 2);
    const csv = await teacher.get(`/api/teacher/exams/${examId}/results/export.csv`);
    const text = Buffer.from(csv.data).toString('utf8');
    assert.ok(text.includes('S0001'));
    assert.match(csv.headers.get('content-disposition') ?? '', /fx-exam-results\.csv/);
    const zip = await teacher.get(`/api/teacher/exams/${examId}/submissions.zip`);
    assert.equal(zip.status, 200);
    assert.equal(Buffer.from(zip.data).subarray(0, 2).toString(), 'PK');
    const one1 = await teacher.get(`/api/teacher/grading/submissions/${subId}/files.zip`);
    assert.equal(Buffer.from(one1.data).subarray(0, 2).toString(), 'PK');
  });
  await step('audit log + CSV export', async () => {
    const r = await teacher.get('/api/teacher/audit');
    const cats = new Set(r.data.items.map((x: any) => x.category));
    for (const c of ['publish', 'grade_change', 'lockdown', 'settings']) assert.ok(cats.has(c), `missing ${c}`);
    const csv = await teacher.get('/api/teacher/audit/export.csv');
    assert.ok(Buffer.from(csv.data).toString('utf8').includes('time_utc,who,role,event,target,details'));
  });

  console.log('Question bank');
  let qid = '';
  let qdoc: any;
  await step('list + get question', async () => {
    const r = await teacher.get('/api/teacher/questions?language=python');
    assert.equal(r.data.total, 2);
    qid = (await teacher.get('/api/teacher/questions?q=Serializer')).data.items[0].id;
    qdoc = (await teacher.get(`/api/teacher/questions/${qid}`)).data;
    assert.equal(qdoc.files.java.reference.length, 1);
    assert.ok(qdoc.lastValidation?.allPassed);
  });
  await step('save with version, weights warning, version conflict', async () => {
    const body = { ...qdoc, points: 25 };
    const r = await teacher.put(`/api/teacher/questions/${qid}`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.warnings[0].code, 'WEIGHTS_MISMATCH');
    assert.equal(r.data.version, qdoc.version + 1);
    assert.equal(r.data.lastValidation, null, 'validation must reset after edits');
    const stale = await teacher.put(`/api/teacher/questions/${qid}`, body);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
    qdoc = r.data;
  });
  await step('field validation messages', async () => {
    const r = await teacher.put(`/api/teacher/questions/${qid}`, { ...qdoc, title: ' ', languages: [] });
    assert.equal(r.status, 422);
    assert.equal(r.data.error.fieldErrors.title, 'Enter a question title.');
    assert.equal(r.data.error.fieldErrors.languages, 'Choose at least one language.');
  });
  await step('import tests: JUnit XML ok, broken XML gives the clear message', async () => {
    const ok = await teacher.post('/api/teacher/questions/import-tests', { content: '<testsuite name="x"><testcase name="a" weight="7"/><testcase name="b"/></testsuite>' });
    assert.equal(ok.data.count, 2);
    assert.equal(ok.data.tests[0].weight, 7);
    const bad = await teacher.post('/api/teacher/questions/import-tests', { content: '<testsuite name="broken">\n  <testcase name="testOne"' });
    assert.equal(bad.data.error.code, 'IMPORT_INVALID');
    assert.match(bad.data.error.message, /isn't valid JUnit XML/);
  });
  await step('validate reference solutions job', async () => {
    const r = await teacher.post(`/api/teacher/questions/${qid}/validate`, {});
    assert.equal(r.status, 202, JSON.stringify(r.data));
    let v: any;
    for (let i = 0; i < 40; i++) {
      v = (await teacher.get(`/api/teacher/validations/${r.data.jobId}`)).data;
      if (v.status === 'completed') break;
      await sleep(500);
    }
    assert.equal(v.allPassed, true, JSON.stringify(v));
    await sleep(300);
    const d = (await teacher.get(`/api/teacher/questions/${qid}`)).data;
    assert.equal(d.lastValidation?.allPassed, true);
  });
  await step('duplicate + archive', async () => {
    const d = await teacher.post(`/api/teacher/questions/${qid}/duplicate`);
    assert.equal(d.status, 201, JSON.stringify(d.data));
    assert.match(d.data.title, /\(copy\)$/);
    const a = await teacher.post(`/api/teacher/questions/${d.data.id}/archive`);
    assert.equal(a.data.archived, true);
    const list = await teacher.get('/api/teacher/questions?q=copy');
    assert.equal(list.data.total, 0);
  });
  await step('"Test as student" preview session works for the teacher', async () => {
    const p = await teacher.post(`/api/teacher/questions/${qid}/preview`);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    const t2 = new Client();
    t2.token = teacher.token;
    const s = await t2.post(`/api/student/exams/${p.data.examId}/start`, {});
    assert.equal(s.status, 200, JSON.stringify(s.data));
    t2.session = s.data.sessionToken;
    const w = await t2.get(`/api/student/exams/${p.data.examId}/workspace`);
    assert.equal(w.data.questions.length, 1);
    const ex = await teacher.get('/api/teacher/exams');
    assert.ok(!ex.data.items.some((x: any) => x.examId === p.data.examId), 'preview exam leaked into the exam list');
  });

  console.log('Exam wizard');
  let newExam = '';
  await step('create → details → questions → settings → accommodations', async () => {
    const courses = (await teacher.get('/api/teacher/courses')).data.items;
    const fx101 = courses.find((c: any) => c.code === 'FX101');
    const c = await teacher.post('/api/teacher/exams', { courseId: fx101.id, title: 'FX101 Quiz 3', classIds: [fx101.classes[0].id] });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    newExam = c.data.id;
    const startsAt = new Date(Date.now() + 2 * 86400_000).toISOString();
    const d = await teacher.patch(`/api/teacher/exams/${newExam}/details`, { startsAt, durationMinutes: 60, lateJoinMinutes: 15, examType: 'quiz' });
    assert.equal(d.status, 200, JSON.stringify(d.data));
    assert.ok(d.data.details.windowClosesAt);
    const badDur = await teacher.patch(`/api/teacher/exams/${newExam}/details`, { durationMinutes: 3 });
    assert.equal(badDur.status, 422);
    const bank = (await teacher.get('/api/teacher/questions')).data.items;
    const qs = await teacher.put(`/api/teacher/exams/${newExam}/questions`, { items: bank.slice(0, 2).map((b: any) => ({ questionId: b.id, points: 50 })), questionOrder: 'shuffle' });
    assert.equal(qs.status, 200, JSON.stringify(qs.data));
    assert.equal(qs.data.totalPoints, 100);
    const st = await teacher.patch(`/api/teacher/exams/${newExam}/settings`, { allowedLanguages: ['java'], runsPerQuestion: 50 });
    assert.equal(st.status, 200);
    assert.deepEqual(st.data.settings.allowedLanguages, ['java']);
    const studs = (await teacher.get(`/api/teacher/courses/${fx101.id}/students?q=Six`)).data.items;
    const acc = await teacher.put(`/api/teacher/exams/${newExam}/accommodations`, { items: [{ studentId: studs[0].id, extraMinutes: 30 }] });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    assert.equal(acc.data.items[0].extraMinutes, 30);
  });
  await step('publish checks → publish → unpublish', async () => {
    const pc = await teacher.get(`/api/teacher/exams/${newExam}/publish-checks`);
    assert.equal(pc.status, 200);
    assert.equal(pc.data.canPublish, true, JSON.stringify(pc.data.checks));
    const p = await teacher.post(`/api/teacher/exams/${newExam}/publish`, { notifyNow: true, reminder1h: true });
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.status, 'scheduled');
    assert.ok(p.data.notifiedCount >= 1);
    const again = await teacher.post(`/api/teacher/exams/${newExam}/publish`, {});
    assert.equal(again.status, 409);
    const u = await teacher.post(`/api/teacher/exams/${newExam}/unpublish`);
    assert.equal(u.data.status, 'draft');
  });
  await step('publish blocked when a question has never been validated', async () => {
    const fin = await one(`SELECT id FROM exams WHERE short_title = 'FX Draft'`);
    await q(`UPDATE questions SET last_validation = NULL WHERE title = 'BankAccount Class'`);
    const pc = await teacher.get(`/api/teacher/exams/${fin.id}/publish-checks`);
    assert.equal(pc.data.canPublish, false);
    const p = await teacher.post(`/api/teacher/exams/${fin.id}/publish`, {});
    assert.equal(p.status, 422);
    assert.equal(p.data.error.code, 'PUBLISH_CHECKS_FAILED');
  });
  await step('teacher dashboard aggregates', async () => {
    const r = await teacher.get('/api/teacher/dashboard');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.greetingName, 'Test Teacher');
    assert.ok(r.data.exams.length >= 2);
    assert.ok(r.data.questionBank.total >= 3);
    // enum[] columns must arrive as JSON arrays, not the raw "{java,python}" string
    for (const e of r.data.exams) assert.ok(Array.isArray(e.languages), `exam languages: ${JSON.stringify(e.languages)}`);
    if (r.data.liveExam) assert.ok(Array.isArray(r.data.liveExam.languages));
    const bank = await teacher.get('/api/teacher/questions');
    for (const x of bank.data.items) assert.ok(Array.isArray(x.languages));
  });

  console.log('Background jobs');
  await step('practice sandbox needs no integrity box and can restart', async () => {
    const dash = await sarah.get('/api/student/dashboard');
    const pid = dash.data.practice.examId;
    const c = new Client();
    c.token = sarah.token;
    const s = await c.post(`/api/student/exams/${pid}/start`, {});
    assert.equal(s.status, 200, JSON.stringify(s.data));
  });
  await step('deadline passes → server auto-submits the latest saved code', async () => {
    const exam2 = await one(`SELECT id FROM exams WHERE is_practice`);
    const marcus = new Client();
    await marcus.login('S0003', 'student12345', 'student');
    const s = await marcus.post(`/api/student/exams/${exam2.id}/start`, {});
    assert.equal(s.status, 200, JSON.stringify(s.data));
    await q(`UPDATE exam_sessions SET deadline_at = now() - interval '2 minutes' WHERE id = $1`, [s.data.session.id]);
    let st = '';
    for (let i = 0; i < 20; i++) {
      st = (await one(`SELECT status FROM exam_sessions WHERE id = $1`, [s.data.session.id])).status;
      if (st !== 'in_progress') break;
      await sleep(1000);
    }
    assert.equal(st, 'auto_submitted');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  server.close();
  await sleep(500);
  await pool.end().catch(() => undefined);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
