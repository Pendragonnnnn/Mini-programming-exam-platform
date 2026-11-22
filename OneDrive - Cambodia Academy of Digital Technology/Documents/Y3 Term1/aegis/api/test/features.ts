/**
 * Feature tests on an EMPTY database: first-run setup, students added by ID with invites,
 * every question type, and C / C++ / JavaScript code. Run: npm test
 */
import './env';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
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
  async req(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.session) headers['X-Exam-Session'] = this.session;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, data: (ct.includes('json') ? await res.json() : await res.text()) as any };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
}

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${String(e?.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (r: { status: number; data: any }, status = 200) => assert.equal(r.status, status, JSON.stringify(r.data).slice(0, 600));

const LIMITS = { timeLimitMs: 3000, memoryLimitMb: 256, networkAccess: false };
const base = (over: any) => ({ difficulty: 'easy', topic: null, instructionsMd: 'Answer the question.', limits: LIMITS, languages: [], files: {}, tests: [], ...over });

async function main() {
  await prepareTestDb();
  await migrate();
  await q(`TRUNCATE users, terms, courses, questions, exams, audit_events, notifications, validation_jobs, outbound_emails CASCADE`);
  const app = createApp();
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  startJobs();

  const t = new Client();
  const s1 = new Client();
  const s2 = new Client();
  let courseId = '';
  let classId = '';
  const links: Record<string, string> = {};
  const qids: Record<string, string> = {};
  let examId = '';

  console.log('First-run setup');
  await step('empty server asks for setup; setup creates the first teacher once', async () => {
    const st = await t.get('/api/auth/setup');
    ok(st);
    assert.equal(st.data.needsSetup, true);
    const bad = await t.post('/api/auth/setup', { fullName: 'Owner', email: 'nope', password: 'x' });
    ok(bad, 422);
    const r = await t.post('/api/auth/setup', { fullName: 'Owner Teacher', email: 'owner@school.test', password: 'owner-pass-1' });
    ok(r, 201);
    t.token = r.data.accessToken;
    assert.equal(r.data.user.role, 'teacher');
    const again = await new Client().post('/api/auth/setup', { fullName: 'X', email: 'x@school.test', password: 'xxxxxxxxx' });
    ok(again, 409);
    assert.equal((await t.get('/api/auth/setup')).data.needsSetup, false);
  });
  await step('dashboard of a new teacher is empty (no demo data)', async () => {
    const d = await t.get('/api/teacher/dashboard');
    ok(d);
    assert.equal(d.data.exams.length, 0);
    assert.equal(d.data.stats.students, 0);
    assert.equal((await t.get('/api/teacher/questions')).data.total, 0);
  });

  console.log('Courses, classes, students by ID');
  await step('create course + class', async () => {
    const c = await t.post('/api/teacher/courses', { code: 'PRG101', title: 'Programming 1', termName: 'Semester 1' });
    ok(c, 201);
    courseId = c.data.id;
    const dup = await t.post('/api/teacher/courses', { code: 'PRG101', title: 'Again', termName: 'Semester 1' });
    ok(dup, 422);
    const cl = await t.post(`/api/teacher/courses/${courseId}/classes`, { code: 'Group A' });
    ok(cl, 201);
    classId = cl.data.id;
    const list = await t.get('/api/teacher/courses');
    assert.equal(list.data.items[0].classes[0].code, 'Group A');
  });
  await step('add students by student ID → accounts + invite links (no SMTP)', async () => {
    const r = await t.post(`/api/teacher/classes/${classId}/students`, {
      students: [{ studentId: 'e20210001', fullName: 'Sok Dara', email: 'dara@students.test' }, { studentId: 'E20210002', fullName: 'Chan Lina' }, { studentId: 'E20210003' }],
    });
    ok(r, 201);
    assert.equal(r.data.created, 3);
    assert.equal(r.data.emailEnabled, false);
    for (const it of r.data.items) {
      assert.ok(it.inviteLink?.includes('/reset?token='), 'invite link missing');
      links[it.studentId] = it.inviteLink;
    }
    assert.equal(r.data.items[0].studentId, 'E20210001', 'IDs are upper-cased');
    assert.equal(r.data.items[2].fullName, 'E20210003', 'name falls back to the ID');
    const dup = await t.post(`/api/teacher/classes/${classId}/students`, { students: [{ studentId: 'E20210001' }, { studentId: 'e20210001' }] });
    ok(dup, 422);
    const again = await t.post(`/api/teacher/classes/${classId}/students`, { students: [{ studentId: 'E20210001' }], sendInvites: false });
    ok(again, 201);
    assert.equal(again.data.alreadyEnrolled, 1);
    const bad = await t.post(`/api/teacher/classes/${classId}/students`, { students: [{ studentId: 'has space' }] });
    ok(bad, 422);
  });
  await step('invited student cannot sign in until they set a password from the link', async () => {
    const r = await s1.post('/api/auth/login', { identifier: 'E20210001', password: 'whatever1', role: 'student' });
    ok(r, 401);
    assert.equal(r.data.error.code, 'ACCOUNT_NOT_SET_UP');
    const token = new URL(links.E20210001!).searchParams.get('token')!;
    const info = await s1.get(`/api/auth/link-info?token=${encodeURIComponent(token)}`);
    ok(info);
    assert.equal(info.data.loginId, 'E20210001');
    assert.equal(info.data.purpose, 'invite');
    ok(await s1.post('/api/auth/reset-password', { token, newPassword: 'short' }), 422);
    ok(await s1.post('/api/auth/reset-password', { token, newPassword: 'dara-pass-1' }), 204);
    ok(await s1.post('/api/auth/reset-password', { token, newPassword: 'dara-pass-2' }), 400);
    const li = await s1.post('/api/auth/login', { identifier: 'e20210001', password: 'dara-pass-1', role: 'student' });
    ok(li);
    s1.token = li.data.accessToken;
    const token2 = new URL(links.E20210002!).searchParams.get('token')!;
    ok(await s2.post('/api/auth/reset-password', { token: token2, newPassword: 'lina-pass-1' }), 204);
    s2.token = (await s2.post('/api/auth/login', { identifier: 'E20210002', password: 'lina-pass-1', role: 'student' })).data.accessToken;
  });
  await step('roster shows invited/active; resend invite; class message notifies students', async () => {
    const r = await t.get(`/api/teacher/classes/${classId}/students`);
    ok(r);
    const by = Object.fromEntries(r.data.items.map((i: any) => [i.studentId, i]));
    assert.equal(by.E20210001.status, 'active');
    assert.equal(by.E20210003.status, 'invited');
    const inv = await t.post(`/api/teacher/students/${by.E20210003.id}/invite`);
    ok(inv);
    assert.ok(inv.data.inviteLink);
    const m = await t.post(`/api/teacher/classes/${classId}/message`, { subject: 'Exam next week', body: 'Bring your laptop.' });
    ok(m, 201);
    assert.equal(m.data.notified, 3);
    const n = await s1.get('/api/notifications');
    assert.ok(n.data.items.some((x: any) => x.title.includes('Exam next week')));
  });
  await step('co-teacher invite', async () => {
    const r = await t.post(`/api/teacher/courses/${courseId}/teachers`, { email: 'co@school.test', fullName: 'Co Teacher' });
    ok(r, 201);
    assert.ok(r.data.inviteLink);
    const l = await t.get(`/api/teacher/courses/${courseId}/teachers`);
    assert.equal(l.data.items.length, 2);
  });

  console.log('Question types');
  async function newQ(type: string, body: any, language?: string) {
    const c = await t.post('/api/teacher/questions', { courseId, type, language });
    ok(c, 201);
    const put = await t.put(`/api/teacher/questions/${c.data.id}`, { version: c.data.version, type, ...body });
    ok(put);
    return put.data;
  }
  await step('single choice, multiple answers, true/false, short answer save with answer keys', async () => {
    const one = await newQ('single_choice', base({ title: 'Capital', points: 2, choice: { options: [{ text: 'Phnom Penh', correct: true }, { text: 'Siem Reap', correct: false }, { text: 'Battambang', correct: false }], shuffle: true } }));
    qids.single = one.id;
    assert.equal(one.type, 'single_choice');
    assert.equal(one.choice.options.length, 3);
    assert.ok(one.lastValidation?.allPassed, 'choice questions count as validated');
    const multi = await newQ('multiple_choice', base({ title: 'Primes', points: 4, choice: { options: [{ text: '2', correct: true }, { text: '3', correct: true }, { text: '4', correct: false }, { text: '5', correct: true }], partialCredit: true } }));
    qids.multi = multi.id;
    const tfNew = await t.post('/api/teacher/questions', { courseId, type: 'true_false' });
    assert.deepEqual(tfNew.data.choice.options.map((o: any) => o.text), ['True', 'False']);
    const tf = await t.put(`/api/teacher/questions/${tfNew.data.id}`, { ...base({ title: 'HTTP is stateless', points: 1 }), version: tfNew.data.version, type: 'true_false', choice: { options: [{ id: 'true', text: 'True', correct: true }, { id: 'false', text: 'False', correct: false }] } });
    ok(tf);
    qids.tf = tf.data.id;
    const sa = await newQ('short_answer', base({ title: 'Keyword', points: 3, choice: { acceptedAnswers: ['public static void main', 'main method'] } }));
    qids.short = sa.id;
  });
  await step('answer-key validation errors', async () => {
    const c = await t.post('/api/teacher/questions', { courseId, type: 'single_choice' });
    const two = await t.put(`/api/teacher/questions/${c.data.id}`, { ...base({ title: 'Bad', points: 1 }), version: c.data.version, type: 'single_choice', choice: { options: [{ text: 'a', correct: true }, { text: 'b', correct: true }] } });
    ok(two, 422);
    assert.equal(two.data.error.fieldErrors['choice.correct'], 'Mark exactly one correct option.');
    const none = await t.put(`/api/teacher/questions/${c.data.id}`, { ...base({ title: 'Bad', points: 1 }), version: c.data.version, type: 'multiple_choice', choice: { options: [{ text: 'a', correct: false }, { text: '', correct: false }] } });
    ok(none, 422);
    const sa = await t.put(`/api/teacher/questions/${c.data.id}`, { ...base({ title: 'Bad', points: 1 }), version: c.data.version, type: 'short_answer', choice: { acceptedAnswers: ['  '] } });
    ok(sa, 422);
    ok(await t.post(`/api/teacher/questions/${c.data.id}/archive`));
  });

  const sumRef: Record<string, string> = {
    c: '#include <stdio.h>\nint main(void){ long a,b; if(scanf("%ld %ld",&a,&b)!=2) return 1; printf("%ld\\n", a+b); return 0; }\n',
    cpp: '#include <iostream>\nint main(){ long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n"; return 0; }\n',
    javascript: "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n",
    java: 'import java.util.Scanner;\npublic class Main { public static void main(String[] x){ Scanner s=new Scanner(System.in); long a=s.nextLong(), b=s.nextLong(); System.out.println(a+b);} }\n',
    python: 'a, b = map(int, input().split())\nprint(a + b)\n',
  };
  const entry: Record<string, string> = { c: 'main.c', cpp: 'main.cpp', javascript: 'main.js', java: 'Main.java', python: 'main.py' };
  await step('stdio coding question in C, C++, JavaScript, Java, Python validates', async () => {
    const files: any = {};
    for (const l of Object.keys(sumRef)) files[l] = { starter: [{ path: entry[l], content: '// write the sum program\n'.replace('//', l === 'python' ? '#' : '//'), readOnly: false, isEntrypoint: true }], reference: [{ path: entry[l], content: sumRef[l] }] };
    const code = await newQ(
      'code',
      base({
        title: 'Sum of two numbers',
        points: 10,
        languages: ['c', 'cpp', 'javascript', 'java', 'python'],
        files,
        tests: [
          { name: 'small', kind: 'stdio', input: '2 3\n', expected: '5', matchType: 'exact', weight: 5, hidden: false },
          { name: 'negative', kind: 'stdio', input: '10 -4\n', expected: '6', matchType: 'exact', weight: 5, hidden: true },
        ],
      }),
      'c',
    );
    qids.sum = code.id;
    const v = await t.post(`/api/teacher/questions/${code.id}/validate`);
    ok(v, 202);
    let st: any;
    for (let i = 0; i < 120; i++) {
      st = await t.get(`/api/teacher/validations/${v.data.jobId}`);
      if (st.data.status === 'completed') break;
      await sleep(500);
    }
    assert.equal(st.data.allPassed, true, JSON.stringify(st.data.byLanguage.map((b: any) => [b.language, b.status, b.passed, b.total, b.compileOutput.slice(0, 200)])));
    assert.equal(st.data.byLanguage.length, 5);
  });
  await step('function-call tests rejected for C/C++, accepted for JavaScript', async () => {
    const c = await t.post('/api/teacher/questions', { courseId, type: 'code', language: 'cpp' });
    const bad = await t.put(`/api/teacher/questions/${c.data.id}`, {
      ...base({ title: 'x', points: 1, languages: ['cpp'], files: { cpp: { starter: [{ path: 'main.cpp', content: 'int main(){}', readOnly: false }], reference: [] } }, tests: [{ name: 'call', kind: 'call', input: 'f()', expected: '1', matchType: 'exact', weight: 1, hidden: false }] }),
      version: c.data.version,
      type: 'code',
    });
    ok(bad, 422);
    assert.match(bad.data.error.message, /STDIN/);
    ok(await t.post(`/api/teacher/questions/${c.data.id}/archive`));
    const js = await newQ(
      'code',
      base({
        title: 'Counter class',
        points: 10,
        languages: ['javascript', 'python'],
        files: {
          javascript: {
            starter: [{ path: 'counter.js', content: 'class Counter {\n  constructor(start) { this.n = start; }\n  inc() { /* TODO */ }\n  value() { return this.n; }\n}\nmodule.exports = { Counter };\n', readOnly: false }],
            reference: [{ path: 'counter.js', content: 'class Counter {\n  constructor(start) { this.n = start; }\n  inc() { this.n++; return this; }\n  value() { return this.n; }\n}\nmodule.exports = { Counter };\n' }],
            setup: 'const c = new Counter(5);',
            setupTarget: 'c',
          },
          python: {
            starter: [{ path: 'counter.py', content: 'class Counter:\n    def __init__(self, start):\n        self.n = start\n    def inc(self):\n        pass\n    def value(self):\n        return self.n\n', readOnly: false }],
            reference: [{ path: 'counter.py', content: 'class Counter:\n    def __init__(self, start):\n        self.n = start\n    def inc(self):\n        self.n += 1\n        return self\n    def value(self):\n        return self.n\n' }],
            setup: 'c = Counter(5)',
            setupTarget: 'c',
          },
        },
        tests: [
          { name: 'inc twice', kind: 'call', input: 'inc()\ninc()\nvalue()', expected: '7', matchType: 'exact', weight: 6, hidden: false },
          { name: 'starts at 5', kind: 'call', input: 'value()', expected: '5', matchType: 'exact', weight: 2, hidden: false },
          { name: 'missing method throws', kind: 'call', input: 'javascript: c.nope()\npython: c.nope()', expected: 'TypeError|AttributeError', matchType: 'exception_class', weight: 2, hidden: true },
        ],
      }),
      'javascript',
    );
    qids.js = js.id;
    const v = await t.post(`/api/teacher/questions/${js.id}/validate`);
    ok(v, 202);
    let st: any;
    for (let i = 0; i < 120; i++) {
      st = await t.get(`/api/teacher/validations/${v.data.jobId}`);
      if (st.data.status === 'completed') break;
      await sleep(500);
    }
    assert.equal(st.data.allPassed, true, JSON.stringify(st.data.byLanguage));
  });
  await step('question bank lists every type with a type filter', async () => {
    const all = await t.get('/api/teacher/questions');
    assert.equal(all.data.total, 6);
    const mc = await t.get('/api/teacher/questions?type=multiple_choice');
    assert.equal(mc.data.total, 1);
    assert.equal(mc.data.items[0].typeLabel, 'Multiple answers');
  });

  console.log('Mixed exam');
  await step('wizard: mixed exam with 45 minutes, publish emails/notifies students', async () => {
    const c = await t.post('/api/teacher/exams', { courseId, title: 'PRG101 Mixed Quiz', classIds: [classId] });
    ok(c, 201);
    examId = c.data.id;
    ok(await t.patch(`/api/teacher/exams/${examId}/details`, { startsAt: new Date(Date.now() + 3600_000).toISOString(), durationMinutes: 45, lateJoinMinutes: 10, examType: 'quiz' }));
    const items = [
      { questionId: qids.single, points: 2 },
      { questionId: qids.multi, points: 4 },
      { questionId: qids.tf, points: 1 },
      { questionId: qids.short, points: 3 },
      { questionId: qids.sum, points: 10 },
      { questionId: qids.js, points: 10 },
    ];
    const qs = await t.put(`/api/teacher/exams/${examId}/questions`, { items, questionOrder: 'fixed' });
    ok(qs);
    assert.equal(qs.data.totalPoints, 30);
    assert.equal(qs.data.items[0].type, 'single_choice');
    const pc = await t.get(`/api/teacher/exams/${examId}/publish-checks`);
    assert.equal(pc.data.canPublish, true, JSON.stringify(pc.data.checks));
    const p = await t.post(`/api/teacher/exams/${examId}/publish`, { notifyNow: true });
    ok(p);
    assert.equal(p.data.notifiedCount, 3);
    // open it now (as if the start time arrived)
    await q(`UPDATE exams SET starts_at = now() - interval '1 minute', status = 'live' WHERE id = $1`, [examId]);
  });
  await step('a choice-only exam needs no languages and no code runner', async () => {
    const c = await t.post('/api/teacher/exams', { courseId, title: 'Theory only', classIds: [classId] });
    const id = c.data.id;
    ok(await t.patch(`/api/teacher/exams/${id}/details`, { startsAt: new Date(Date.now() + 86400_000).toISOString(), durationMinutes: 15 }));
    ok(await t.put(`/api/teacher/exams/${id}/questions`, { items: [{ questionId: qids.single, points: 5 }], questionOrder: 'fixed' }));
    ok(await t.patch(`/api/teacher/exams/${id}/settings`, { allowedLanguages: [] }));
    const pc = await t.get(`/api/teacher/exams/${id}/publish-checks`);
    assert.equal(pc.data.canPublish, true, JSON.stringify(pc.data.checks));
    ok(await t.req('DELETE', `/api/teacher/exams/${id}`), 204);
  });

  let ws: any;
  const byTitle = (title: string) => ws.questions.find((x: any) => x.title === title);
  const save = (c: Client, eqId: string, body: any) => c.put(`/api/student/exams/${examId}/answers/${eqId}`, { baseRevision: 0, clientSavedAt: new Date().toISOString(), ...body });
  async function runAndWait(c: Client, body: any) {
    const r = await c.post(`/api/student/exams/${examId}/runs`, body);
    ok(r, 202);
    for (let i = 0; i < 40; i++) {
      const g = await c.get(`/api/student/exams/${examId}/runs/${r.data.runId}?waitMs=5000`);
      if (!['queued', 'running'].includes(g.data.status)) return g.data;
    }
    throw new Error('run did not finish');
  }
  await step('student workspace: options without the answer key', async () => {
    const d = await s1.get('/api/student/dashboard');
    assert.ok(d.data.upcoming.some((u: any) => u.examId === examId));
    const lobby = await s1.get(`/api/student/exams/${examId}/lobby`);
    ok(lobby);
    const st = await s1.post(`/api/student/exams/${examId}/start`, { integrityAccepted: true });
    ok(st);
    s1.session = st.data.sessionToken;
    ws = (await s1.get(`/api/student/exams/${examId}/workspace`)).data;
    assert.equal(ws.questions.length, 6);
    const single = byTitle('Capital');
    assert.equal(single.type, 'single_choice');
    assert.equal(single.options.length, 3);
    assert.ok(!JSON.stringify(ws).includes('"correct"'), 'answer key leaked');
    assert.ok(!JSON.stringify(ws).includes('main method'), 'accepted answers leaked');
    assert.deepEqual(byTitle('Sum of two numbers').languages, ['c', 'cpp', 'javascript', 'java', 'python']);
  });
  await step('save choice answers; bad option rejected; latest client time wins', async () => {
    const single = byTitle('Capital');
    const pp = single.options.find((o: any) => o.text === 'Phnom Penh').id;
    const sr = single.options.find((o: any) => o.text === 'Siem Reap').id;
    ok(await save(s1, single.examQuestionId, { response: { selected: [sr] } }));
    ok(await save(s1, single.examQuestionId, { response: { selected: [pp] } }));
    ok(await save(s1, single.examQuestionId, { response: { selected: [sr] }, clientSavedAt: new Date(Date.now() - 60_000).toISOString() }));
    ok(await save(s1, single.examQuestionId, { response: { selected: ['nope'] } }), 422);
    ok(await save(s1, single.examQuestionId, { response: { selected: [pp, sr] } }), 422);
    const multi = byTitle('Primes');
    const ids = (txt: string[]) => multi.options.filter((o: any) => txt.includes(o.text)).map((o: any) => o.id);
    ok(await save(s1, multi.examQuestionId, { response: { selected: ids(['2', '3', '4']) } })); // 2 right, 1 wrong → (2-1)/3 → 1 of 4 pts
    const tf = byTitle('HTTP is stateless');
    ok(await save(s1, tf.examQuestionId, { response: { selected: ['true'] } }));
    ok(await save(s1, byTitle('Keyword').examQuestionId, { response: { text: '  Public   STATIC void main ' } }));
    const again = (await s1.get(`/api/student/exams/${examId}/workspace`)).data;
    assert.deepEqual(again.questions.find((x: any) => x.title === 'Capital').answer.response.selected, [pp]);
  });
  await step('C: compile error shows file + line; fixed code passes the sample test', async () => {
    const sum = byTitle('Sum of two numbers');
    const bad = await runAndWait(s1, { examQuestionId: sum.examQuestionId, kind: 'sample_tests', language: 'c', files: { 'main.c': '#include <stdio.h>\nint main(void){\n  int a = \n  return 0;\n}\n' } });
    assert.equal(bad.status, 'compile_error');
    assert.equal(bad.diagnostics[0].path, 'main.c');
    assert.ok(bad.diagnostics[0].line >= 3);
    const good = await runAndWait(s1, { examQuestionId: sum.examQuestionId, kind: 'sample_tests', language: 'c', files: { 'main.c': sumRef.c } });
    assert.equal(good.status, 'completed', JSON.stringify(good.console));
    assert.equal(good.testsPassed, 1);
    assert.equal(good.testsTotal, 1, 'hidden test must not run for students');
  });
  await step('C++ custom input, JavaScript runtime error, infinite loop time limit', async () => {
    const sum = byTitle('Sum of two numbers');
    const r = await runAndWait(s1, { examQuestionId: sum.examQuestionId, kind: 'custom_input', language: 'cpp', files: { 'main.cpp': sumRef.cpp }, stdin: '40 2' });
    assert.equal(r.status, 'completed');
    assert.ok(r.console.some((l: any) => l.stream === 'stdout' && l.text === '42'));
    const js = await runAndWait(s1, { examQuestionId: sum.examQuestionId, kind: 'run', language: 'javascript', files: { 'main.js': 'const x = null;\nconsole.log(x.y);\n' } });
    assert.equal(js.status, 'runtime_error');
    assert.equal(js.diagnostics[0]?.path, 'main.js');
    assert.equal(js.diagnostics[0]?.line, 2);
    const loop = await runAndWait(s1, { examQuestionId: sum.examQuestionId, kind: 'run', language: 'cpp', files: { 'main.cpp': 'int main(){ while(true){} }' } });
    assert.equal(loop.status, 'time_limit');
    // leave the final answer in C++
    ok(await save(s1, sum.examQuestionId, { language: 'cpp', files: { 'main.cpp': sumRef.cpp } }));
  });
  await step('JavaScript function-call tests on the student starter, then fixed', async () => {
    const js = byTitle('Counter class');
    const start = await runAndWait(s1, { examQuestionId: js.examQuestionId, kind: 'sample_tests', language: 'javascript', files: {} });
    assert.equal(start.testsPassed, 1, JSON.stringify(start.tests));
    assert.match(start.tests.find((x: any) => !x.passed).message, /Expected 7 but was 5/);
    const fixed = 'class Counter {\n  constructor(start) { this.n = start; }\n  inc() { this.n += 1; }\n  value() { return this.n; }\n}\nmodule.exports = { Counter };\n';
    const r = await runAndWait(s1, { examQuestionId: js.examQuestionId, kind: 'sample_tests', language: 'javascript', files: { 'counter.js': fixed } });
    assert.equal(r.testsPassed, 2, JSON.stringify(r.tests));
  });
  await step('submit summary counts answered choice questions; submit', async () => {
    const sm = await s1.get(`/api/student/exams/${examId}/submit-summary`);
    ok(sm);
    assert.equal(sm.data.questions.filter((x: any) => x.status === 'answered').length, 4);
    const sub = await s1.post(`/api/student/exams/${examId}/submit`, { confirmFinal: true });
    ok(sub, 202);
  });
  await step('second student submits a choice-only attempt (blank code)', async () => {
    const st = await s2.post(`/api/student/exams/${examId}/start`, { integrityAccepted: true });
    s2.session = st.data.sessionToken;
    const w = (await s2.get(`/api/student/exams/${examId}/workspace`)).data;
    const multi = w.questions.find((x: any) => x.title === 'Primes');
    ok(await save(s2, multi.examQuestionId, { response: { selected: multi.options.filter((o: any) => ['2', '3', '5'].includes(o.text)).map((o: any) => o.id) } }));
    ok(await save(s2, w.questions.find((x: any) => x.title === 'Keyword').examQuestionId, { response: { text: 'MAIN METHOD' } }));
    ok(await s2.post(`/api/student/exams/${examId}/submit`, { confirmFinal: true }), 202);
  });

  console.log('Grading + results');
  let rosterItems: any[] = [];
  await step('auto scores: choice + hidden tests; wrong short answer needs review', async () => {
    for (let i = 0; i < 80; i++) {
      const r = await t.get(`/api/teacher/exams/${examId}/grading/roster`);
      rosterItems = r.data.items;
      if (rosterItems.length === 2 && rosterItems.every((x: any) => x.gradingStatus !== 'pending_tests')) break;
      await sleep(500);
    }
    const dara = rosterItems.find((x: any) => x.fullName === 'Sok Dara');
    const d = await t.get(`/api/teacher/grading/submissions/${dara.submissionId}`);
    ok(d);
    const score = Object.fromEntries(d.data.questions.map((x: any) => [x.title, x.autoScore]));
    assert.deepEqual(score, { Capital: 2, Primes: 1, 'HTTP is stateless': 1, Keyword: 3, 'Sum of two numbers': 10, 'Counter class': 10 });
    const single = d.data.questions.find((x: any) => x.title === 'Capital');
    assert.equal(single.choice.correct, true);
    assert.ok(single.choice.options.find((o: any) => o.text === 'Phnom Penh').selected);
    const sum = d.data.questions.find((x: any) => x.title === 'Sum of two numbers');
    assert.equal(sum.language, 'cpp');
    assert.equal(sum.testsPassed, 2, 'hidden test should pass too');
    const lina = rosterItems.find((x: any) => x.fullName === 'Chan Lina');
    const l = await t.get(`/api/teacher/grading/submissions/${lina.submissionId}`);
    const ls = Object.fromEntries(l.data.questions.map((x: any) => [x.title, x.autoScore]));
    assert.equal(ls.Primes, 4);
    assert.equal(ls.Keyword, 3, 'case-insensitive accepted answer');
    assert.equal(ls['Sum of two numbers'], 0);
  });
  await step('teacher overrides a choice score with feedback, ends the exam and releases', async () => {
    const dara = rosterItems.find((x: any) => x.fullName === 'Sok Dara');
    const d = await t.get(`/api/teacher/grading/submissions/${dara.submissionId}`);
    const primes = d.data.questions.find((x: any) => x.title === 'Primes');
    const put = await t.put(`/api/teacher/grading/answers/${primes.submissionAnswerId}`, { teacherScore: 2, feedback: '4 is not prime.' });
    ok(put);
    assert.equal(put.data.finalScore, 2);
    for (const r of rosterItems) ok(await t.post(`/api/teacher/grading/submissions/${r.submissionId}/review`));
    ok(await t.post(`/api/teacher/exams/${examId}/end`, { confirm: true }));
    const rel = await t.post(`/api/teacher/exams/${examId}/results/release`, {});
    ok(rel);
    const res = await t.get(`/api/teacher/exams/${examId}/results`);
    ok(res);
    assert.equal(res.data.submittedCount, 2);
    assert.ok(res.data.perQuestion.find((p: any) => p.type === 'multiple_choice'));
    const csv = await t.get(`/api/teacher/exams/${examId}/results/export.csv`);
    ok(csv);
    assert.ok(String(csv.data).includes('E20210001'));
    const zip = await t.req('GET', `/api/teacher/exams/${examId}/submissions.zip`);
    ok(zip);
  });
  await step('student result shows each answer, correctness and feedback', async () => {
    const r = await s1.get(`/api/student/results/${examId}`);
    ok(r);
    assert.equal(r.data.released, true);
    assert.equal(r.data.score, 2 + 2 + 1 + 3 + 10 + 10);
    const primes = r.data.questions.find((x: any) => x.title === 'Primes');
    assert.equal(primes.yourAnswer, '2; 3; 4');
    assert.equal(primes.correct, false);
    assert.equal(primes.feedback, '4 is not prime.');
    assert.equal(r.data.questions.find((x: any) => x.title === 'Sum of two numbers').tests.length, 2);
  });
  await step('monitor + live view handle choice answers', async () => {
    const m = await t.get(`/api/teacher/exams/${examId}/monitor`);
    ok(m);
    const row = m.data.rows.find((x: any) => x.fullName === 'Sok Dara');
    assert.equal(row.progress[0], 'done');
    const live = await t.get(`/api/teacher/exams/${examId}/sessions/${row.sessionId}/live`);
    ok(live);
    assert.equal(live.data.answers[0].answerText, 'Phnom Penh');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  server.close();
  await sleep(300);
  await pool.end().catch(() => undefined);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
