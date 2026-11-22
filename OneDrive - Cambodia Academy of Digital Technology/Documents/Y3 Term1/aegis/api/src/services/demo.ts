/**
 * DEMO TESTING MODE — development only (DEMO_MODE=true and NODE_ENV=development).
 *
 * Creates two clearly marked demo accounts in their own demo course, so the full student and
 * teacher experience can be tried without touching real people or real courses:
 *   demo_teacher / DemoTeacher123   — teaches only the course DEMO101
 *   demo_student / DemoStudent123   — enrolled only in DEMO101's class
 * Demo rows have users.is_demo / courses.is_demo = true. Outside demo mode they cannot sign in.
 * To turn it off: remove DEMO_MODE from api/.env (or set it to false) and restart the API.
 */
import bcrypt from 'bcryptjs';
import { config } from '../config';
import { one, q, tx, type Db } from '../db';
import { ENABLED_LANGS } from './languages';
import { loadQuestionSpec, saveQuestionSchema, validateQuestionSemantics, writeQuestion } from './questions';

export const DEMO_TEACHER = { username: 'demo_teacher', email: 'demo_teacher@demo.local', password: 'DemoTeacher123', fullName: 'Demo Teacher' };
export const DEMO_STUDENT = { username: 'demo_student', studentId: 'DEMO_STUDENT', password: 'DemoStudent123', fullName: 'Demo Student' };
const COURSE_CODE = 'DEMO101';

const LIMITS = { timeLimitMs: 3000, memoryLimitMb: 256, networkAccess: false as const };
const base = { difficulty: 'easy' as const, topic: 'Demo', limits: LIMITS, languages: [], files: {}, tests: [] };

const SUM: Record<string, [string, string, string]> = {
  java: ['Main.java', 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        // read two numbers and print their sum\n    }\n}\n', 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        long a = in.nextLong(), b = in.nextLong();\n        System.out.println(a + b);\n    }\n}\n'],
  python: ['main.py', '# read two numbers and print their sum\n', 'a, b = map(int, input().split())\nprint(a + b)\n'],
  c: ['main.c', '#include <stdio.h>\n\nint main(void) {\n    // read two numbers and print their sum\n    return 0;\n}\n', '#include <stdio.h>\n\nint main(void) {\n    long a, b;\n    if (scanf("%ld %ld", &a, &b) != 2) return 1;\n    printf("%ld\\n", a + b);\n    return 0;\n}\n'],
  cpp: ['main.cpp', '#include <iostream>\nusing namespace std;\n\nint main() {\n    // read two numbers and print their sum\n    return 0;\n}\n', '#include <iostream>\nusing namespace std;\n\nint main() {\n    long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}\n'],
  javascript: ['main.js', "const input = require('fs').readFileSync(0, 'utf8');\n// read two numbers and print their sum\n", "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n"],
};

// Plain objects; ensureDemo() runs each through the app's own question validator.
const DEMO_QUESTIONS: any[] = [
  { ...base, type: 'single_choice', title: 'Demo: capital city', points: 2, instructionsMd: 'What is the capital city of Cambodia?', choice: { options: [{ text: 'Phnom Penh', correct: true }, { text: 'Siem Reap', correct: false }, { text: 'Battambang', correct: false }, { text: 'Kampot', correct: false }], shuffle: true, partialCredit: false, acceptedAnswers: [], caseSensitive: false, explanation: 'Phnom Penh is the capital.' } },
  { ...base, type: 'multiple_choice', title: 'Demo: prime numbers', points: 4, instructionsMd: 'Select **all** prime numbers.', choice: { options: [{ text: '2', correct: true }, { text: '3', correct: true }, { text: '4', correct: false }, { text: '5', correct: true }, { text: '9', correct: false }], shuffle: false, partialCredit: true, acceptedAnswers: [], caseSensitive: false, explanation: '2, 3 and 5 are prime.' } },
  { ...base, type: 'true_false', title: 'Demo: HTTP is stateless', points: 2, instructionsMd: 'True or false: HTTP is a stateless protocol.', choice: { options: [{ id: 'true', text: 'True', correct: true }, { id: 'false', text: 'False', correct: false }], shuffle: false, partialCredit: false, acceptedAnswers: [], caseSensitive: false, explanation: '' } },
  { ...base, type: 'short_answer', title: 'Demo: Java entry point', points: 2, instructionsMd: 'Which method does every Java program start from? (one or two words)', choice: { options: [], shuffle: false, partialCredit: false, acceptedAnswers: ['main', 'main method'], caseSensitive: false, explanation: '' } },
  {
    ...base,
    type: 'code',
    lang: 'python',
    title: 'Demo: sum of two numbers',
    points: 10,
    instructionsMd: '## Task\nRead two integers from the input and print their sum.\n\n## Example\nInput: `2 3` → Output: `5`',
    languages: ENABLED_LANGS,
    files: Object.fromEntries(Object.entries(SUM).map(([l, [path, starter, solution]]) => [l, { starter: [{ path, content: starter, readOnly: false, isEntrypoint: true }], reference: [{ path, content: solution, readOnly: false, isEntrypoint: true }], setup: '', setupTarget: '' }])) as any,
    tests: [
      { name: 'Small numbers', kind: 'stdio', input: '2 3', expected: '5', matchType: 'exact', weight: 4, hidden: false },
      { name: 'Negative number', kind: 'stdio', input: '10 -4', expected: '6', matchType: 'exact', weight: 3, hidden: false },
      { name: 'Big numbers (hidden)', kind: 'stdio', input: '1000000000 2000000000', expected: '3000000000', matchType: 'exact', weight: 3, hidden: true },
    ],
  },
];

async function upsertDemoUser(c: Db, role: 'teacher' | 'student') {
  const isT = role === 'teacher';
  const hash = await bcrypt.hash(isT ? DEMO_TEACHER.password : DEMO_STUDENT.password, 10);
  const found = isT
    ? await one(`SELECT id FROM users WHERE lower(email) = $1`, [DEMO_TEACHER.email], c)
    : await one(`SELECT id FROM users WHERE upper(student_id) = $1`, [DEMO_STUDENT.studentId], c);
  if (found) {
    // keep the documented password working, and make sure it is (still) marked demo
    await q(`UPDATE users SET password_hash = $2, password_set_at = COALESCE(password_set_at, now()), is_active = true, is_demo = true WHERE id = $1`, [found.id, hash], c);
    return found.id as string;
  }
  const row = isT
    ? await one(`INSERT INTO users(role, email, full_name, password_hash, password_set_at, is_demo) VALUES ('teacher',$1,$2,$3, now(), true) RETURNING id`, [DEMO_TEACHER.email, DEMO_TEACHER.fullName, hash], c)
    : await one(`INSERT INTO users(role, student_id, full_name, password_hash, password_set_at, is_demo) VALUES ('student',$1,$2,$3, now(), true) RETURNING id`, [DEMO_STUDENT.studentId, DEMO_STUDENT.fullName, hash], c);
  return row.id as string;
}

/** Creates (or repairs) the demo accounts, demo course, class and questions. Safe to call often. */
export async function ensureDemo(): Promise<{ teacherId: string; studentId: string; courseId: string; classId: string }> {
  if (!config.demoMode) throw new Error('Demo mode is off');
  return tx(async (c) => {
    await q(`SELECT pg_advisory_xact_lock(hashtext('aegis-demo'))`, [], c);
    const teacherId = await upsertDemoUser(c, 'teacher');
    const studentId = await upsertDemoUser(c, 'student');
    let course = await one(`SELECT id FROM courses WHERE is_demo AND code = $1`, [COURSE_CODE], c);
    if (!course) {
      let term = await one(`SELECT id FROM terms WHERE name = 'Demo term'`, [], c);
      term ??= await one(`INSERT INTO terms(name, starts_on, ends_on) VALUES ('Demo term', current_date, current_date + 365) RETURNING id`, [], c);
      course = await one(`INSERT INTO courses(term_id, code, title, department, is_demo) VALUES ($1,$2,'Demo Course','Demo',true) RETURNING id`, [term.id, COURSE_CODE], c);
    }
    await q(`INSERT INTO course_teachers(course_id, teacher_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [course.id, teacherId], c);
    let cls = await one(`SELECT id FROM classes WHERE course_id = $1 AND code = 'Demo Class'`, [course.id], c);
    cls ??= await one(`INSERT INTO classes(course_id, code) VALUES ($1,'Demo Class') RETURNING id`, [course.id], c);
    await q(`INSERT INTO enrollments(class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [cls.id, studentId], c);

    const have = await one<{ n: number }>(`SELECT count(*)::int AS n FROM questions WHERE course_id = $1`, [course.id], c);
    if (!have!.n) {
      for (const dq of DEMO_QUESTIONS) {
        const { lang: _lang, ...raw } = dq;
        const qrow = await one(`INSERT INTO questions(course_id, owner_id, title, qtype, last_edited_by) VALUES ($1,$2,$3,$4,$2) RETURNING id, version`, [course.id, teacherId, raw.title, raw.type], c);
        const body = saveQuestionSchema.parse({ ...raw, version: qrow.version });
        validateQuestionSemantics(body);
        await writeQuestion(qrow.id, body, teacherId, c);
        // The demo reference solutions are known-good (covered by the API tests), so mark the coding question validated.
        if (body.type === 'code') await q(`UPDATE questions SET last_validation = $2 WHERE id = $1`, [qrow.id, JSON.stringify({ at: new Date().toISOString(), allPassed: true, summary: 'Demo question' })], c);
      }
    }
    return { teacherId, studentId, courseId: course.id, classId: cls.id };
  });
}

/** Makes sure the demo student has an open demo exam they haven't submitted yet (so the demo can be repeated). */
export async function ensureDemoExam(): Promise<string> {
  const d = await ensureDemo();
  return tx(async (c) => {
    await q(`SELECT pg_advisory_xact_lock(hashtext('aegis-demo-exam'))`, [], c);
    const open = await one(
      `SELECT e.id FROM exams e WHERE e.course_id = $1 AND e.status = 'live' AND NOT e.is_practice AND e.preview_question_id IS NULL
         AND e.starts_at + make_interval(mins => e.late_join_minutes) > now()
         AND NOT EXISTS (SELECT 1 FROM exam_sessions s WHERE s.exam_id = e.id AND s.student_id = $2 AND s.submitted_at IS NOT NULL)
       ORDER BY e.starts_at DESC LIMIT 1`,
      [d.courseId, d.studentId],
      c,
    );
    if (open) return open.id as string;
    const n = await one<{ n: number }>(`SELECT count(*)::int + 1 AS n FROM exams WHERE course_id = $1`, [d.courseId], c);
    const e = await one(
      `INSERT INTO exams(course_id, created_by, title, short_title, exam_type, instructions_md, status, starts_at, duration_minutes, late_join_minutes, published_at, seb_required)
       VALUES ($1,$2,$3,'Demo Exam','quiz',$4,'live', now() - interval '1 minute', 30, 120, now(), false) RETURNING id`,
      [d.courseId, d.teacherId, `Demo Exam #${n!.n}`, 'This is a demo exam. Try every question type, run the code, then submit.'],
      c,
    );
    await q(`INSERT INTO exam_classes(exam_id, class_id) VALUES ($1,$2)`, [e.id, d.classId], c);
    for (const l of ENABLED_LANGS) await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,$2)`, [e.id, l], c);
    const qs = await q(`SELECT id, points FROM questions WHERE course_id = $1 AND archived_at IS NULL AND title LIKE 'Demo:%' ORDER BY created_at LIMIT 10`, [d.courseId], c);
    for (const [i, x] of qs.entries()) {
      const spec = (await loadQuestionSpec(x.id, c))!.spec;
      await q(`INSERT INTO exam_questions(exam_id, source_question_id, position, points, snapshot, snapshotted_at) VALUES ($1,$2,$3,$4,$5, now())`, [e.id, x.id, i + 1, x.points, JSON.stringify(spec)], c);
    }
    return e.id as string;
  });
}
