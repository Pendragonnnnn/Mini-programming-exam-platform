import { z } from 'zod';
import { one, q, type Db, pool } from '../db';
import { invalid } from '../errors';
import crypto from 'node:crypto';
import type { ChoiceSpec, Lang, QuestionSpec, QuestionType, TestSpec } from './runner';
import { ENABLED_LANGS, LANGS } from './languages';

export { ENABLED_LANGS, LANG_LABEL } from './languages';

export const QUESTION_TYPES: QuestionType[] = ['code', 'single_choice', 'multiple_choice', 'true_false', 'short_answer'];
export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  code: 'Coding',
  single_choice: 'Multiple choice (one answer)',
  multiple_choice: 'Multiple answers',
  true_false: 'True / False',
  short_answer: 'Short answer',
};

export const emptyChoice = (): ChoiceSpec => ({ options: [], shuffle: false, partialCredit: false, acceptedAnswers: [], caseSensitive: false, explanation: '' });

/** Normalise stored choice JSON (older rows may be '{}'). */
export function normChoice(c: any): ChoiceSpec {
  const d = emptyChoice();
  if (!c || typeof c !== 'object') return d;
  return {
    options: Array.isArray(c.options) ? c.options.map((o: any) => ({ id: String(o.id), text: String(o.text ?? ''), correct: !!o.correct })) : [],
    shuffle: !!c.shuffle,
    partialCredit: !!c.partialCredit,
    acceptedAnswers: Array.isArray(c.acceptedAnswers) ? c.acceptedAnswers.map(String) : [],
    caseSensitive: !!c.caseSensitive,
    explanation: typeof c.explanation === 'string' ? c.explanation : '',
  };
}

export const isCode = (spec: { type?: QuestionType }) => (spec.type ?? 'code') === 'code';

const pathSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_\-./]+$/, 'Use letters, numbers, - _ . / only.')
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.startsWith('__aegis') && !p.startsWith('__AegisT'), 'Invalid file path.');

export const langSchema = z.enum(ENABLED_LANGS as [Lang, ...Lang[]]);

const choiceSchema = z.object({
  options: z
    .array(z.object({ id: z.string().max(40).optional(), text: z.string().max(2000), correct: z.boolean() }))
    .max(20, 'Use at most 20 options.')
    .default([]),
  shuffle: z.boolean().default(false),
  partialCredit: z.boolean().default(false),
  acceptedAnswers: z.array(z.string().max(500)).max(30).default([]),
  caseSensitive: z.boolean().default(false),
  explanation: z.string().max(5000).default(''),
});

export const saveQuestionSchema = z.object({
  version: z.number().int().min(1),
  type: z.enum(['code', 'single_choice', 'multiple_choice', 'true_false', 'short_answer']).default('code'),
  title: z.string().trim().min(1, 'Enter a question title.').max(200),
  difficulty: z.enum(['easy', 'intermediate', 'advanced']),
  points: z.number().int().min(0).max(1000),
  topic: z.string().max(120).nullable(),
  languages: z.array(langSchema).default([]),
  choice: choiceSchema.optional(),
  instructionsMd: z.string().max(50_000),
  limits: z.object({
    timeLimitMs: z.number().int().min(500).max(10_000),
    memoryLimitMb: z.number().int().min(64).max(1024),
    networkAccess: z.literal(false).default(false),
  }),
  files: z.record(
    langSchema,
    z.object({
      starter: z.array(z.object({ path: pathSchema, content: z.string().max(200_000, 'File is larger than 200 KB.'), readOnly: z.boolean(), isEntrypoint: z.boolean().default(false) })).max(20),
      reference: z.array(z.object({ path: pathSchema, content: z.string().max(200_000) })).max(20),
      setup: z.string().max(5_000).optional(),
      setupTarget: z.string().regex(/^([A-Za-z_][A-Za-z0-9_]*)?$/, 'Use a variable name like account, or leave it empty.').optional(),
    }),
  ),
  tests: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().max(200),
        kind: z.enum(['stdio', 'call']),
        input: z.string().max(20_000),
        expected: z.string().max(20_000),
        matchType: z.enum(['exact', 'token', 'exception_class', 'float_tolerance']),
        floatTolerance: z.number().positive().max(1000).default(0.01),
        weight: z.number().int().min(0).max(1000),
        hidden: z.boolean(),
        sortOrder: z.number().int().min(0).default(0),
      }),
    )
    .max(100)
    .default([]),
}).superRefine((b, ctx) => {
  if (b.type === 'code' && !b.languages.length) ctx.addIssue({ code: 'custom', path: ['languages'], message: 'Choose at least one language.' });
});
export type SaveQuestion = z.infer<typeof saveQuestionSchema>;

export function validateQuestionSemantics(b: SaveQuestion) {
  const fe: Record<string, string> = {};
  if (b.type === 'code') {
    if (!b.languages.length) fe.languages = 'Choose at least one language.';
    b.tests.forEach((t, i) => {
      if (!t.name.trim()) fe[`tests[${i}].name`] = `Test #${i + 1} is missing a name.`;
      if (t.kind === 'call') {
        const noCall = b.languages.filter((l) => !LANGS[l].callTests);
        if (noCall.length) fe[`tests[${i}].kind`] = `Test #${i + 1} is a function-call test, but ${noCall.map((l) => LANGS[l].label).join(' and ')} only support STDIN/STDOUT tests.`;
      }
    });
    for (const lang of Object.keys(b.files) as Lang[]) {
      const info = LANGS[lang];
      const paths = new Set<string>();
      b.files[lang]!.starter.forEach((f, i) => {
        if (paths.has(f.path)) fe[`files.${lang}.starter[${i}].path`] = `Two files are named ${f.path}.`;
        paths.add(f.path);
        if (!info.exts.some((x) => f.path.endsWith(x))) fe[`files.${lang}.starter[${i}].path`] = `${info.label} files must end in ${info.exts.join(' or ')}`;
      });
      b.files[lang]!.reference.forEach((f, i) => {
        if (!info.exts.some((x) => f.path.endsWith(x))) fe[`files.${lang}.reference[${i}].path`] = `${info.label} files must end in ${info.exts.join(' or ')}`;
      });
    }
  } else {
    const c = b.choice ?? emptyChoice();
    if (b.type === 'short_answer') {
      if (!c.acceptedAnswers.some((a) => a.trim())) fe['choice.acceptedAnswers'] = 'Add at least one accepted answer.';
    } else {
      const opts = c.options;
      if (opts.length < 2) fe['choice.options'] = 'Add at least two options.';
      opts.forEach((o, i) => {
        if (!o.text.trim()) fe[`choice.options[${i}].text`] = `Option ${i + 1} is empty.`;
      });
      const correct = opts.filter((o) => o.correct).length;
      if (b.type === 'multiple_choice' && correct < 1) fe['choice.correct'] = 'Mark at least one correct option.';
      if ((b.type === 'single_choice' || b.type === 'true_false') && correct !== 1) fe['choice.correct'] = 'Mark exactly one correct option.';
      if (b.type === 'true_false' && opts.length !== 2) fe['choice.options'] = 'A true/false question has exactly two options.';
    }
  }
  if (Object.keys(fe).length) throw invalid(Object.values(fe)[0]!, fe);
}

export function weightsWarning(points: number, tests: { weight: number }[]) {
  const total = tests.reduce((a, t) => a + t.weight, 0);
  return total === points ? null : { code: 'WEIGHTS_MISMATCH', message: `Test weights add up to ${total} pts, but the question is worth ${points} pts.` };
}

/** Load a bank question as a frozen spec (used for snapshots and validation runs). */
export async function loadQuestionSpec(id: string, db: Db = pool): Promise<{ spec: QuestionSpec; row: any } | null> {
  const row = await one(`SELECT * FROM questions WHERE id = $1`, [id], db);
  if (!row) return null;
  const langs = await q<{ language: Lang }>(`SELECT language FROM question_languages WHERE question_id = $1 ORDER BY sort_order, language`, [id], db);
  const files = await q(`SELECT * FROM question_files WHERE question_id = $1 ORDER BY language, kind, sort_order, path`, [id], db);
  const tests = await q(`SELECT * FROM test_cases WHERE question_id = $1 ORDER BY sort_order, name`, [id], db);
  const spec: QuestionSpec = {
    type: row.qtype ?? 'code',
    choice: normChoice(row.choice),
    title: row.title,
    topic: row.topic,
    difficulty: row.difficulty,
    instructionsMd: row.instructions_md,
    points: row.points,
    limits: { timeLimitMs: row.time_limit_ms, memoryLimitMb: row.memory_limit_mb },
    languages: langs.map((l) => l.language),
    files: {},
    setup: row.setup ?? {},
    tests: tests.map(
      (t): TestSpec => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        input: t.input,
        expected: t.expected,
        matchType: t.match_type,
        floatTolerance: Number(t.float_tolerance),
        weight: t.weight,
        hidden: t.is_hidden,
        sortOrder: t.sort_order,
      }),
    ),
  };
  for (const f of files) {
    const l = f.language as Lang;
    spec.files[l] ??= { starter: [], reference: [] };
    if (f.kind === 'starter') spec.files[l]!.starter.push({ path: f.path, content: f.content, readOnly: f.read_only, isEntrypoint: f.is_entrypoint });
    else spec.files[l]!.reference.push({ path: f.path, content: f.content });
  }
  return { spec, row };
}

/** API shape for GET /teacher/questions/:id */
export async function questionDto(id: string, meId: string, db: Db = pool) {
  const loaded = await loadQuestionSpec(id, db);
  if (!loaded) return null;
  const { spec, row } = loaded;
  const course = await one(`SELECT id, code FROM courses WHERE id = $1`, [row.course_id], db);
  const used = await one<{ n: number }>(`SELECT count(DISTINCT eq.exam_id)::int AS n FROM exam_questions eq JOIN exams e ON e.id = eq.exam_id WHERE eq.source_question_id = $1 AND e.preview_question_id IS NULL`, [id], db);
  const editor = row.last_edited_by ? await one(`SELECT id, full_name FROM users WHERE id = $1`, [row.last_edited_by], db) : null;
  const files: Record<string, any> = {};
  for (const lang of new Set([...spec.languages, ...(Object.keys(spec.files) as Lang[])])) {
    files[lang] = {
      starter: spec.files[lang]?.starter ?? [],
      reference: spec.files[lang]?.reference ?? [],
      setup: spec.setup?.[lang]?.code ?? '',
      setupTarget: spec.setup?.[lang]?.target ?? '',
    };
  }
  return {
    id: row.id,
    version: row.version,
    course: { id: course.id, code: course.code },
    type: spec.type ?? 'code',
    choice: spec.choice ?? emptyChoice(),
    title: row.title,
    difficulty: row.difficulty,
    points: row.points,
    topic: row.topic,
    languages: spec.languages,
    instructionsMd: row.instructions_md,
    limits: { timeLimitMs: row.time_limit_ms, memoryLimitMb: row.memory_limit_mb, networkAccess: false },
    files,
    tests: spec.tests,
    archived: !!row.archived_at,
    usedInExams: used!.n,
    lastEditedBy: editor ? { id: editor.id, name: editor.full_name, isMe: editor.id === meId } : null,
    updatedAt: row.updated_at,
    lastValidation: row.last_validation,
  };
}

/** Replace the editable parts of a question (inside a transaction). */
export async function writeQuestion(id: string, b: SaveQuestion, userId: string, db: Db) {
  b = { ...b };
  const setup: Record<string, { code: string; target: string }> = {};
  for (const [lang, f] of Object.entries(b.files)) {
    if (b.type === 'code' && f.setup && f.setup.trim()) setup[lang] = { code: f.setup, target: f.setupTarget ?? '' };
  }
  const code = b.type === 'code';
  let choice = emptyChoice();
  if (!code && b.choice) {
    choice = {
      ...b.choice,
      options: (b.type === 'short_answer' ? [] : b.choice.options).map((o) => ({ id: o.id && /^[\w-]+$/.test(o.id) ? o.id : crypto.randomBytes(4).toString('hex'), text: o.text, correct: o.correct })),
      acceptedAnswers: b.type === 'short_answer' ? b.choice.acceptedAnswers.map((a) => a.trim()).filter(Boolean) : [],
    };
  }
  // Non-code questions are "validated" by their answer key; code questions need a reference run.
  const lastValidation = code ? null : JSON.stringify({ at: new Date().toISOString(), allPassed: true, summary: 'Answer key set' });
  await q(
    `UPDATE questions SET qtype=$11, choice=$12, title=$2, difficulty=$3, points=$4, topic=$5, instructions_md=$6, time_limit_ms=$7, memory_limit_mb=$8, setup=$9,
            version = version + 1, last_edited_by=$10, last_validation = $13, updated_at = now()
     WHERE id = $1`,
    [id, b.title.trim(), b.difficulty, b.points, b.topic, b.instructionsMd, b.limits.timeLimitMs, b.limits.memoryLimitMb, JSON.stringify(setup), userId, b.type, JSON.stringify(choice), lastValidation],
    db,
  );
  if (!code) b = { ...b, languages: [], files: {}, tests: [] };
  await q(`DELETE FROM question_languages WHERE question_id = $1`, [id], db);
  for (const [i, l] of b.languages.entries()) await q(`INSERT INTO question_languages(question_id, language, sort_order) VALUES ($1,$2,$3)`, [id, l, i], db);
  await q(`DELETE FROM question_files WHERE question_id = $1`, [id], db);
  for (const [lang, f] of Object.entries(b.files)) {
    for (const [i, s] of f.starter.entries())
      await q(`INSERT INTO question_files(question_id, language, kind, path, content, read_only, sort_order, is_entrypoint) VALUES ($1,$2,'starter',$3,$4,$5,$6,$7)`, [id, lang, s.path, s.content, s.readOnly, i, s.isEntrypoint], db);
    for (const [i, r] of f.reference.entries())
      await q(`INSERT INTO question_files(question_id, language, kind, path, content, sort_order) VALUES ($1,$2,'reference',$3,$4,$5)`, [id, lang, r.path, r.content, i], db);
  }
  const keep = b.tests.filter((t) => t.id).map((t) => t.id!);
  await q(`DELETE FROM test_cases WHERE question_id = $1 AND NOT (id = ANY($2::uuid[]))`, [id, keep], db);
  for (const [i, t] of b.tests.entries()) {
    const vals = [t.name.trim(), t.kind, t.input, t.expected, t.matchType, t.floatTolerance, t.weight, t.hidden, i];
    if (t.id) {
      const upd = await one(
        `UPDATE test_cases SET name=$3, kind=$4, input=$5, expected=$6, match_type=$7, float_tolerance=$8, weight=$9, is_hidden=$10, sort_order=$11 WHERE id=$1 AND question_id=$2 RETURNING id`,
        [t.id, id, ...vals],
        db,
      );
      if (upd) continue;
    }
    await q(`INSERT INTO test_cases(question_id, name, kind, input, expected, match_type, float_tolerance, weight, is_hidden, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, ...vals], db);
  }
}

// ---------- test import (JUnit XML / JSON) ----------
export function parseImport(content: string, hidden: boolean) {
  const t = content.trim();
  const fail = (m: string) => invalid(m, { content: m }, 'IMPORT_INVALID');
  if (!t) throw fail('Paste JUnit XML or JSON, or choose a file.');
  const mk = (name: string, weight: number, input = '', expected = '', match = 'exact') => ({
    name,
    weight,
    input,
    expected,
    matchType: (['exact', 'token', 'exception_class', 'float_tolerance'].includes(match) ? match : 'exact') as TestSpec['matchType'],
    kind: 'call' as const,
    hidden,
  });
  if (t[0] === '<') {
    if (!/<testsuite[\s>]/.test(t) || !/<\/testsuite>/.test(t)) throw fail("Couldn't read this file: it isn't valid JUnit XML (the <testsuite> element is missing or not closed).");
    const out: ReturnType<typeof mk>[] = [];
    const re = /<testcase\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const nm = /name="([^"]+)"/.exec(m[1]!);
      const w = /weight="(\d+)"/.exec(m[1]!);
      if (nm) out.push(mk(nm[1]!, w ? parseInt(w[1]!, 10) : 5));
    }
    if (!out.length) throw fail('No <testcase> elements found in this file.');
    return out;
  }
  let j: any;
  try {
    j = JSON.parse(t);
  } catch (e: any) {
    throw fail(`Couldn't read this file: ${e.message}`);
  }
  const arr = Array.isArray(j) ? j : j?.tests;
  if (!Array.isArray(arr) || !arr.length) throw fail('This JSON has no tests. Expected an array of { name, input, expected, weight }.');
  const badIdx = arr.findIndex((x: any) => !x || !x.name);
  if (badIdx > -1) throw fail(`Test #${badIdx + 1} is missing a name.`);
  return arr.map((x: any) => mk(String(x.name), Number(x.weight) || 5, x.input ? String(x.input) : '', x.expected !== undefined ? String(x.expected) : '', x.match ?? 'exact'));
}
