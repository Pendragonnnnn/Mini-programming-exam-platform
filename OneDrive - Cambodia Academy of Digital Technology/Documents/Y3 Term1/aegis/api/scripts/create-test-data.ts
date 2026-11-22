/**
 * Creates TEST data through the app's own API, for trying the website out.
 * The API must be running (npm run dev). Usage:
 *
 *   npm run test-data
 *   npm run test-data -- --email you@school.edu --password yourpass     (if you already made your own teacher)
 *
 * It creates: a teacher (only on an empty server), course TEST101 with class "Test Group",
 * 5 students S001…S005 (password student123), 5 questions (one of each type, coding in 5 languages)
 * and a published exam that starts 2 minutes from now.
 */
const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TEACHER = { fullName: 'Test Teacher', email: arg('email') ?? 'teacher@test.com', password: arg('password') ?? 'teacher123' };
const STUDENT_PASSWORD = 'student123';
const STUDENTS = [
  ['S001', 'Student One'],
  ['S002', 'Student Two'],
  ['S003', 'Student Three'],
  ['S004', 'Student Four'],
  ['S005', 'Student Five'],
];

let token = '';
async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Can't reach the API at ${API}. Start it first: cd api; npm run dev`);
  }
  const data: any = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${data?.error?.message ?? res.statusText}`), { status: res.status, data });
  return data;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMITS = { timeLimitMs: 3000, memoryLimitMb: 256, networkAccess: false };

async function main() {
  // 1. teacher
  const setup = await call('GET', '/auth/setup');
  if (setup.needsSetup) {
    token = (await call('POST', '/auth/setup', TEACHER)).accessToken;
    console.log(`✓ Created teacher ${TEACHER.email}`);
  } else {
    try {
      token = (await call('POST', '/auth/login', { identifier: TEACHER.email, password: TEACHER.password, role: 'teacher' })).accessToken;
      console.log(`✓ Signed in as teacher ${TEACHER.email}`);
    } catch {
      throw new Error(`This server already has a teacher. Run again with your own teacher login:\n  npm run test-data -- --email YOUR_EMAIL --password YOUR_PASSWORD`);
    }
  }

  // 2. course + class
  let course = (await call('GET', '/teacher/courses')).items.find((c: any) => c.code === 'TEST101');
  if (!course) {
    await call('POST', '/teacher/courses', { code: 'TEST101', title: 'Test Course', termName: 'Test Term' });
    course = (await call('GET', '/teacher/courses')).items.find((c: any) => c.code === 'TEST101');
  }
  let cls = course.classes.find((c: any) => c.code === 'Test Group');
  if (!cls) cls = await call('POST', `/teacher/courses/${course.id}/classes`, { code: 'Test Group' });
  console.log('✓ Course TEST101 · class "Test Group"');

  // 3. students: create, then use each invite link to set the password
  const added = await call('POST', `/teacher/classes/${cls.id}/students`, { students: STUDENTS.map(([studentId, fullName]) => ({ studentId, fullName })), sendInvites: true });
  for (const s of added.items) {
    if (s.inviteLink) {
      const inviteToken = new URL(s.inviteLink).searchParams.get('token');
      await call('POST', '/auth/reset-password', { token: inviteToken, newPassword: STUDENT_PASSWORD });
    }
  }
  console.log(`✓ Students ${STUDENTS.map((s) => s[0]).join(', ')} (password ${STUDENT_PASSWORD})`);

  // 4. questions
  const q = async (type: string, body: any, language?: string) => {
    const c = await call('POST', '/teacher/questions', { courseId: course.id, type, language });
    return call('PUT', `/teacher/questions/${c.id}`, { version: c.version, type, difficulty: 'easy', topic: 'Test', limits: LIMITS, languages: [], files: {}, tests: [], ...body });
  };
  const single = await q('single_choice', { title: 'Capital of Cambodia', points: 2, instructionsMd: 'What is the capital city of Cambodia?', choice: { options: [{ text: 'Phnom Penh', correct: true }, { text: 'Siem Reap', correct: false }, { text: 'Battambang', correct: false }, { text: 'Kampot', correct: false }], shuffle: true, explanation: 'Phnom Penh is the capital.' } });
  const multi = await q('multiple_choice', { title: 'Prime numbers', points: 4, instructionsMd: 'Select **all** prime numbers.', choice: { options: [{ text: '2', correct: true }, { text: '3', correct: true }, { text: '4', correct: false }, { text: '5', correct: true }, { text: '9', correct: false }], partialCredit: true } });
  const tf = await q('true_false', { title: 'HTTP is stateless', points: 2, instructionsMd: 'True or false: HTTP is a stateless protocol.', choice: { options: [{ id: 'true', text: 'True', correct: true }, { id: 'false', text: 'False', correct: false }] } });
  const short = await q('short_answer', { title: 'Java entry point', points: 2, instructionsMd: 'Which method does every Java program start from? (one or two words)', choice: { acceptedAnswers: ['main', 'main method'], caseSensitive: false } });
  const ref: Record<string, [string, string, string]> = {
    java: ['Main.java', 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        // read two numbers and print their sum\n    }\n}\n', 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        long a = in.nextLong(), b = in.nextLong();\n        System.out.println(a + b);\n    }\n}\n'],
    python: ['main.py', '# read two numbers and print their sum\n', 'a, b = map(int, input().split())\nprint(a + b)\n'],
    c: ['main.c', '#include <stdio.h>\n\nint main(void) {\n    // read two numbers and print their sum\n    return 0;\n}\n', '#include <stdio.h>\n\nint main(void) {\n    long a, b;\n    if (scanf("%ld %ld", &a, &b) != 2) return 1;\n    printf("%ld\\n", a + b);\n    return 0;\n}\n'],
    cpp: ['main.cpp', '#include <iostream>\nusing namespace std;\n\nint main() {\n    // read two numbers and print their sum\n    return 0;\n}\n', '#include <iostream>\nusing namespace std;\n\nint main() {\n    long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}\n'],
    javascript: ['main.js', "const input = require('fs').readFileSync(0, 'utf8');\n// read two numbers and print their sum\n", "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n"],
  };
  const code = await q(
    'code',
    {
      title: 'Sum of two numbers',
      points: 10,
      instructionsMd: '## Task\nRead two integers from the input and print their sum.\n\n## Example\nInput: `2 3` → Output: `5`',
      languages: Object.keys(ref),
      files: Object.fromEntries(Object.entries(ref).map(([l, [path, starter, solution]]) => [l, { starter: [{ path, content: starter, readOnly: false, isEntrypoint: true }], reference: [{ path, content: solution }] }])),
      tests: [
        { name: 'Small numbers', kind: 'stdio', input: '2 3', expected: '5', matchType: 'exact', weight: 4, hidden: false },
        { name: 'Negative number', kind: 'stdio', input: '10 -4', expected: '6', matchType: 'exact', weight: 3, hidden: false },
        { name: 'Big numbers (hidden)', kind: 'stdio', input: '1000000000 2000000000', expected: '3000000000', matchType: 'exact', weight: 3, hidden: true },
      ],
    },
    'python',
  );
  console.log('✓ Questions: multiple choice, multiple answers, true/false, short answer, coding (Java, Python, C, C++, JavaScript)');

  // 5. check the coding question's reference solutions (needs the compilers on this computer)
  const job = await call('POST', `/teacher/questions/${code.id}/validate`);
  let v: any;
  for (let i = 0; i < 120; i++) {
    v = await call('GET', `/teacher/validations/${job.jobId}`);
    if (v.status === 'completed') break;
    await sleep(1000);
  }
  const ok = v.byLanguage.filter((b: any) => b.status === 'completed' && b.passed === b.total).map((b: any) => b.language);
  const bad = v.byLanguage.filter((b: any) => !ok.includes(b.language)).map((b: any) => b.language);
  console.log(v.allPassed ? '✓ Coding question validated in all 5 languages' : `! Coding question works in: ${ok.join(', ') || 'none'}. Not working on this computer: ${bad.join(', ')} (that compiler is missing)`);

  // 6. exam starting in 2 minutes
  const startsAt = new Date(Date.now() + 2 * 60_000);
  startsAt.setSeconds(0, 0);
  const exam = await call('POST', '/teacher/exams', { courseId: course.id, title: `Test Exam ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`, shortTitle: 'Test Exam', classIds: [cls.id] });
  await call('PATCH', `/teacher/exams/${exam.id}/details`, { startsAt: startsAt.toISOString(), durationMinutes: 30, lateJoinMinutes: 30, examType: 'quiz', instructionsMd: 'Test exam. Answer every question, then submit.' });
  await call('PUT', `/teacher/exams/${exam.id}/questions`, {
    items: [single, multi, tf, short, code].map((x) => ({ questionId: x.id, points: x.points })),
    questionOrder: 'fixed',
  });
  if (bad.length) await call('PATCH', `/teacher/exams/${exam.id}/settings`, { allowedLanguages: ok });
  let published = false;
  try {
    await call('POST', `/teacher/exams/${exam.id}/publish`, { notifyNow: true, reminder1h: false });
    published = true;
  } catch (e: any) {
    const checks = e.data?.error?.details?.checks?.filter((c: any) => c.status === 'error').map((c: any) => c.message) ?? [];
    console.log(`! The exam was saved as a draft but not published: ${checks.join(' ') || e.message}`);
  }
  if (published) console.log(`✓ Exam "Test Exam" published — starts ${startsAt.toLocaleTimeString()} (your time), 30 minutes`);

  console.log(`
Done. Sign in at http://localhost:5173
  Teacher : ${TEACHER.email} / ${setup.needsSetup || !arg('password') ? TEACHER.password : '(your password)'}   (Teacher tab)
  Students: S001 … S005 / ${STUDENT_PASSWORD}   (Student tab)
The students see the exam on their dashboard now; "Start exam" unlocks at the start time.
Tip: use an Incognito window for the student so you stay signed in as the teacher.`);
}

main().catch((e) => {
  console.error('✗ ' + e.message);
  process.exit(1);
});
