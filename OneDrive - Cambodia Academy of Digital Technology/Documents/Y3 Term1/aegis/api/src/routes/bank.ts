import { Router, type Request } from 'express';
import { z } from 'zod';
import { assertTeachesCourse, authenticate, requireRole, teacherCourseIds } from '../auth';
import { one, q, tx } from '../db';
import { conflict, h, invalid, notFound } from '../errors';
import { referenceFiles } from '../services/grading';
import { emptyChoice, langSchema, loadQuestionSpec, parseImport, QUESTION_TYPE_LABEL, questionDto, saveQuestionSchema, validateQuestionSemantics, weightsWarning, writeQuestion } from '../services/questions';
import { ENABLED_LANGS, LANGS } from '../services/languages';
import type { Lang, QuestionSpec } from '../services/runner';
import { createRun, kick } from '../services/runs';

export const bankRouter = Router();
bankRouter.use('/teacher', authenticate, requireRole('teacher'));

async function ownQuestion(req: Request, id: string) {
  const row = await one(`SELECT * FROM questions WHERE id = $1`, [id]);
  if (!row) throw notFound('NOT_FOUND', 'Question not found.');
  const ok = await one(`SELECT 1 FROM course_teachers WHERE course_id = $1 AND teacher_id = $2`, [row.course_id, req.user!.id]);
  if (!ok) throw notFound('NOT_FOUND', 'Question not found.');
  return row;
}

bankRouter.get(
  '/teacher/questions',
  h(async (req, res) => {
    const courseIds = await teacherCourseIds(req.user!.id);
    const pageSize = Math.min(200, Number(req.query.pageSize) || 50);
    const page = Math.max(1, Number(req.query.page) || 1);
    const params = [
      courseIds,
      String(req.query.q ?? ''),
      req.query.courseId ? String(req.query.courseId) : null,
      req.query.courseCode ? String(req.query.courseCode) : null,
      req.query.difficulty ? String(req.query.difficulty) : null,
      req.query.language ? String(req.query.language) : null,
      req.query.includeArchived === 'true',
      req.query.type ? String(req.query.type) : null,
    ];
    const where = `qs.course_id = ANY($1::uuid[])
      AND ($2 = '' OR qs.title ILIKE '%' || $2 || '%' OR COALESCE(qs.topic,'') ILIKE '%' || $2 || '%')
      AND ($3::uuid IS NULL OR qs.course_id = $3)
      AND ($4::text IS NULL OR c.code = $4)
      AND ($5::text IS NULL OR qs.difficulty::text = $5)
      AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM question_languages ql WHERE ql.question_id = qs.id AND ql.language::text = $6))
      AND ($7 OR qs.archived_at IS NULL)
      AND ($8::text IS NULL OR qs.qtype::text = $8)`;
    const rows = await q(
      `SELECT qs.*, c.code AS course_code,
         (SELECT array_agg(language ORDER BY sort_order) FROM question_languages WHERE question_id = qs.id) AS langs,
         (SELECT count(*)::int FROM test_cases WHERE question_id = qs.id) AS tests,
         (SELECT count(DISTINCT eq.exam_id)::int FROM exam_questions eq JOIN exams e ON e.id = eq.exam_id WHERE eq.source_question_id = qs.id AND e.preview_question_id IS NULL) AS used
       FROM questions qs JOIN courses c ON c.id = qs.course_id WHERE ${where}
       ORDER BY ${req.query.sort === 'title' ? 'qs.title' : 'qs.updated_at DESC'} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params,
    );
    const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM questions qs JOIN courses c ON c.id = qs.course_id WHERE ${where}`, params);
    res.json({
      items: rows.map((r: any) => ({
        id: r.id,
        courseCode: r.course_code,
        type: r.qtype,
        typeLabel: QUESTION_TYPE_LABEL[r.qtype as keyof typeof QUESTION_TYPE_LABEL],
        title: r.title,
        topic: r.topic,
        difficulty: r.difficulty,
        languages: r.langs ?? [],
        points: r.points,
        testCount: r.tests,
        archived: !!r.archived_at,
        usedInExams: r.used,
        updatedAt: r.updated_at,
        validated: !!r.last_validation?.allPassed,
      })),
      page,
      pageSize,
      total: total!.n,
    });
  }),
);

bankRouter.post(
  '/teacher/questions',
  h(async (req, res) => {
    const b = z
      .object({
        courseId: z.string().uuid(),
        type: z.enum(['code', 'single_choice', 'multiple_choice', 'true_false', 'short_answer']).default('code'),
        language: langSchema.default('java'),
      })
      .parse(req.body);
    await assertTeachesCourse(req.user!.id, b.courseId);
    const row = await tx(async (c) => {
      const qrow = await one(`INSERT INTO questions(course_id, owner_id, title, qtype, last_edited_by) VALUES ($1,$2,'Untitled question',$3,$2) RETURNING id`, [b.courseId, req.user!.id, b.type], c);
      if (b.type === 'code') {
        const info = LANGS[b.language];
        await q(`INSERT INTO question_languages(question_id, language, sort_order) VALUES ($1,$2,0)`, [qrow.id, b.language], c);
        await q(`INSERT INTO question_files(question_id, language, kind, path, content, is_entrypoint) VALUES ($1,$2,'starter',$3,$4,true)`, [qrow.id, b.language, info.entry, info.starter], c);
      } else {
        const choice = emptyChoice();
        if (b.type === 'true_false') choice.options = [{ id: 'true', text: 'True', correct: true }, { id: 'false', text: 'False', correct: false }];
        await q(`UPDATE questions SET choice = $2, points = 1 WHERE id = $1`, [qrow.id, JSON.stringify(choice)], c);
      }
      return qrow;
    });
    res.status(201).json(await questionDto(row.id, req.user!.id));
  }),
);

bankRouter.get(
  '/teacher/questions/:id',
  h(async (req, res) => {
    await ownQuestion(req, String(req.params.id));
    res.json(await questionDto(String(req.params.id), req.user!.id));
  }),
);

bankRouter.put(
  '/teacher/questions/:id',
  h(async (req, res) => {
    const row = await ownQuestion(req, String(req.params.id));
    const b = saveQuestionSchema.parse(req.body);
    validateQuestionSemantics(b);
    await tx(async (c) => {
      const cur = await one(`SELECT version, last_edited_by FROM questions WHERE id = $1 FOR UPDATE`, [row.id], c);
      if (cur.version !== b.version) {
        const by = cur.last_edited_by ? await one(`SELECT full_name FROM users WHERE id = $1`, [cur.last_edited_by], c) : null;
        throw conflict('VERSION_CONFLICT', `This question was changed${by ? ` by ${by.full_name}` : ''} after you opened it. Reload to see the latest version.`, { currentVersion: cur.version, updatedBy: by?.full_name ?? null });
      }
      await writeQuestion(row.id, b, req.user!.id, c);
    });
    const dto = await questionDto(row.id, req.user!.id);
    const w = b.type === 'code' ? weightsWarning(b.points, b.tests) : null;
    res.json({ ...dto, warnings: w ? [w] : [] });
  }),
);

bankRouter.post(
  '/teacher/questions/:id/duplicate',
  h(async (req, res) => {
    const row = await ownQuestion(req, String(req.params.id));
    const loaded = await loadQuestionSpec(row.id);
    const dto = await questionDto(row.id, req.user!.id);
    const newId = await tx(async (c) => {
      const n = await one(`INSERT INTO questions(course_id, owner_id, last_edited_by) VALUES ($1,$2,$2) RETURNING id`, [row.course_id, req.user!.id], c);
      await writeQuestion(
        n.id,
        {
          version: 1,
          type: row.qtype,
          choice: loaded!.spec.choice,
          title: `${row.title} (copy)`,
          difficulty: row.difficulty,
          points: row.points,
          topic: row.topic,
          languages: loaded!.spec.languages,
          instructionsMd: row.instructions_md,
          limits: { timeLimitMs: row.time_limit_ms, memoryLimitMb: row.memory_limit_mb, networkAccess: false },
          files: Object.fromEntries(
            Object.entries(dto!.files)
              .filter(([l]) => (ENABLED_LANGS as string[]).includes(l))
              .map(([l, f]: [string, any]) => [l, { starter: f.starter, reference: f.reference, setup: f.setup, setupTarget: f.setupTarget }]),
          ) as any,
          tests: loaded!.spec.tests.map(({ id: _id, ...t }) => t),
        },
        req.user!.id,
        c,
      );
      return n.id;
    });
    res.status(201).json(await questionDto(newId, req.user!.id));
  }),
);

bankRouter.post(
  '/teacher/questions/:id/archive',
  h(async (req, res) => {
    const row = await ownQuestion(req, String(req.params.id));
    await q(`UPDATE questions SET archived_at = now() WHERE id = $1`, [row.id]);
    res.json({ archived: true });
  }),
);

bankRouter.post(
  '/teacher/questions/:id/unarchive',
  h(async (req, res) => {
    const row = await ownQuestion(req, String(req.params.id));
    await q(`UPDATE questions SET archived_at = NULL WHERE id = $1`, [row.id]);
    res.json({ archived: false });
  }),
);

bankRouter.post(
  '/teacher/questions/import-tests',
  h(async (req, res) => {
    const b = z.object({ content: z.string().max(500_000), format: z.enum(['auto', 'junit', 'json']).default('auto'), hidden: z.boolean().default(false) }).parse(req.body);
    const tests = parseImport(b.content, b.hidden);
    res.json({ tests, count: tests.length });
  }),
);

/** Runs every reference solution against every test. Optional unsaved draft. */
bankRouter.post(
  '/teacher/questions/:id/validate',
  h(async (req, res) => {
    const row = await ownQuestion(req, String(req.params.id));
    if (row.qtype !== 'code' && !(req.body?.draft && req.body.draft.type === 'code')) throw invalid('Only coding questions have reference solutions to validate.', {});
    let spec: QuestionSpec;
    let isDraft = false;
    if (req.body?.draft) {
      const d = saveQuestionSchema.parse(req.body.draft);
      validateQuestionSemantics(d);
      isDraft = true;
      spec = {
        type: 'code',
        title: d.title,
        topic: d.topic,
        difficulty: d.difficulty,
        instructionsMd: d.instructionsMd,
        points: d.points,
        limits: { timeLimitMs: d.limits.timeLimitMs, memoryLimitMb: d.limits.memoryLimitMb },
        languages: d.languages,
        files: Object.fromEntries(Object.entries(d.files).map(([l, f]) => [l, { starter: f.starter.map((s) => ({ ...s, isEntrypoint: s.isEntrypoint ?? false })), reference: f.reference }])),
        setup: Object.fromEntries(Object.entries(d.files).filter(([, f]) => f.setup?.trim()).map(([l, f]) => [l, { code: f.setup!, target: f.setupTarget ?? '' }])),
        tests: d.tests.map((t, i) => ({ ...t, id: t.id ?? `draft-${i}`, sortOrder: i })),
      };
    } else {
      spec = (await loadQuestionSpec(row.id))!.spec;
    }
    if (!spec.tests.length) throw invalid('Add at least one test case first.', { tests: 'Add at least one test case first.' });
    const langs = spec.languages.filter((l) => (spec.files[l]?.reference?.length ?? 0) > 0);
    if (!langs.length) throw invalid('Add a reference solution for at least one language.', { reference: 'Add a reference solution.' });
    const job = await tx(async (c) => {
      const j = await one(`INSERT INTO validation_jobs(question_id, requested_by, version, is_draft) VALUES ($1,$2,$3,$4) RETURNING id`, [row.id, req.user!.id, row.version, isDraft], c);
      for (const l of langs) {
        await createRun({ kind: 'reference_validation', requestedBy: req.user!.id, language: l as Lang, files: referenceFiles(spec, l as Lang), spec, questionId: row.id, validationJobId: j.id, priority: 2 }, c);
      }
      return j;
    });
    kick();
    res.status(202).json({ jobId: job.id, languages: langs, missing: spec.languages.filter((l) => !langs.includes(l)) });
  }),
);

bankRouter.get(
  '/teacher/validations/:jobId',
  h(async (req, res) => {
    const job = await one(`SELECT * FROM validation_jobs WHERE id = $1`, [req.params.jobId]);
    if (!job) throw notFound('NOT_FOUND', 'Validation not found.');
    await ownQuestion(req, job.question_id);
    const runs = await q(`SELECT * FROM code_runs WHERE validation_job_id = $1 ORDER BY language`, [job.id]);
    const running = runs.some((r: any) => r.status === 'queued' || r.status === 'running');
    const byLanguage = [];
    for (const r of runs) {
      const tests = await q(`SELECT name, outcome, message, time_ms FROM test_results WHERE run_id = $1 ORDER BY sort_order`, [r.id]);
      byLanguage.push({
        language: r.language,
        status: r.status,
        passed: r.tests_passed ?? 0,
        total: r.tests_total ?? 0,
        compileOutput: r.compile_output ?? '',
        tests: tests.map((t: any) => ({ name: t.name, passed: t.outcome === 'pass', message: t.message ?? '', timeMs: t.time_ms })),
      });
    }
    const allPassed = !running && byLanguage.length > 0 && byLanguage.every((b) => b.status === 'completed' && b.total > 0 && b.passed === b.total);
    const total = byLanguage[0]?.total ?? 0;
    res.json({
      status: running ? 'running' : 'completed',
      allPassed: running ? null : allPassed,
      summary: running
        ? 'Running reference solutions…'
        : allPassed
          ? `All ${byLanguage.length} reference solution${byLanguage.length === 1 ? '' : 's'} pass ${total} / ${total} tests`
          : `Some reference solutions fail: ${byLanguage.filter((b) => !(b.status === 'completed' && b.passed === b.total)).map((b) => `${b.language} ${b.passed}/${b.total}`).join(', ')}`,
      byLanguage,
    });
  }),
);

/** "Test as student": a hidden draft exam with just this question, opened through the student workspace. */
bankRouter.post(
  '/teacher/questions/:id/preview',
  h(async (req, res) => {
    const row = await ownQuestion(req, String(req.params.id));
    const examId = await tx(async (c) => {
      let e = await one(`SELECT id FROM exams WHERE preview_question_id = $1 AND created_by = $2`, [row.id, req.user!.id], c);
      if (!e) {
        e = await one(
          `INSERT INTO exams(course_id, created_by, title, short_title, exam_type, status, preview_question_id, duration_minutes, seb_required)
           VALUES ($1,$2,$3,$4,'practice','draft',$5,180,false) RETURNING id`,
          [row.course_id, req.user!.id, `Preview: ${row.title}`, 'Question preview', row.id],
          c,
        );
        for (const l of ENABLED_LANGS) await q(`INSERT INTO exam_languages(exam_id, language) VALUES ($1,$2)`, [e.id, l], c);
        await q(`INSERT INTO exam_questions(exam_id, source_question_id, position, points, snapshot) VALUES ($1,$2,1,$3,'{}')`, [e.id, row.id, row.points], c);
      }
      await q(`UPDATE exam_questions SET snapshotted_at = NULL, points = $2 WHERE exam_id = $1`, [e.id, row.points], c);
      await q(`DELETE FROM exam_sessions WHERE exam_id = $1 AND student_id = $2`, [e.id, req.user!.id], c);
      return e.id;
    });
    res.json({ examId, previewUrl: `/student/exams/${examId}/workspace?preview=1` });
  }),
);
