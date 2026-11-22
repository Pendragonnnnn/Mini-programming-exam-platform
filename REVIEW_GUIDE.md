# Aegis Exam — Review Guide

This note summarizes the current branch for a teammate reviewing it after it is pushed to GitHub. It covers the work completed so far, the main files to inspect, and validation gaps. It is not a deployment guide.

## What changed

### Coding-exam focus

- New question creation and new-exam question selection are coding-only.
- Existing non-coding questions are retained for historical exams, shown as legacy/read-only, and are not available in new exams.
- Teachers can edit or permanently delete coding questions from the question bank.
- Teachers can permanently delete exams from **My exams**. A confirmation warns that student sessions, answers, submissions, and grading history are removed.
- Live exams cannot be deleted. Question deletion is blocked while a draft or active exam depends on the question or its code runs are still active. Deleting a question used only by completed exams preserves their saved question snapshots.
- Deletions are audited. No live database records were deleted while implementing or checking these controls.

Main files: [QuestionBank](./web/src/pages/teacher/QuestionBank.tsx), [QuestionEditor](./web/src/pages/teacher/QuestionEditor.tsx), [ExamWizard](./web/src/pages/teacher/ExamWizard.tsx), [teacher routes](./api/src/routes/teacher.ts), and [question-bank routes](./api/src/routes/bank.ts).

### Browser-local code runs

- Python, C, and C++ Run/sample-test execution is performed in the student's browser using a Web Worker and local runtime assets.
- Java and JavaScript continue to use the configured server runner.
- The browser receives visible/sample tests only. Hidden tests and final grading remain server-authoritative.
- Worker time/output limits and a WebAssembly memory limit are applied to local runs. Local runs are accounted for without being treated as final exam scores.

Main files: [local runner](./web/src/lib/localRunner.ts), [runner worker](./web/src/workers/localRunner.worker.ts), [student workspace](./web/src/pages/student/Workspace.tsx), and [student API routes](./api/src/routes/student.ts).

### Setup and student/teacher workflow

- The application starts without seeded demo accounts or sample data; the first teacher account is created through setup.
- Exam timing uses a server-synchronized clock, and the exam/student views receive live updates.
- Demo buttons and demo seeding code were removed. The legacy `is_demo` schema and authentication guards remain intentionally, so any old demo-marked records stay disabled and isolated.
- Pre-push cleanup removed a stray character from `api/.env.example`, an unused Judge0 helper, and aligned the TypeScript deprecation setting with the installed compiler.
- The README documents local development setup, coding-question creation, and the current coding-only behavior.

Relevant files include [authentication](./api/src/routes/auth.ts), [application configuration](./api/src/config.ts), [clock store](./web/src/stores/clock.ts), [student dashboard](./web/src/pages/student/Dashboard.tsx), and [README](./README.md).

## Current branch file inventory

This lists the changed paths in the current worktree so the reviewer can compare them with the GitHub diff. The worktree includes changes from earlier project steps as well as the latest coding-only and deletion work.

- **Repository/config/docs:** `.env.example`, `.gitignore`, `README.md`, `REVIEW_GUIDE.md`.
- **API setup, auth, and management:** `api/.env.example`, `api/package.json`, `api/tsconfig.json`, `api/src/auth.ts`, `api/src/config.ts`, `api/src/server.ts`, `api/src/routes/auth.ts`, `api/src/routes/manage.ts`.
- **API execution, exams, questions, and tests:** `api/src/routes/bank.ts`, `api/src/routes/student.ts`, `api/src/routes/teacher.ts`, `api/src/services/runner/judge0.ts`, `api/test/integration.ts`.
- **Removed demo artifacts:** `api/scripts/create-test-data.ts`, `api/src/services/demo.ts`, `api/test/demo.ts`, `web/src/components/Demo.tsx`.
- **Web runtime/build support:** `web/Dockerfile`, `web/package.json`, `web/package-lock.json`, `web/vite.config.ts`, `web/scripts/copy-local-runtimes.mjs`, `web/src/lib/localRunner.ts`, `web/src/types/clang-wasm.d.ts`, `web/src/workers/localRunner.worker.ts`.
- **Web app and student workflow:** `web/src/App.tsx`, `web/src/pages/Login.tsx`, `web/src/pages/student/Dashboard.tsx`, `web/src/pages/student/Lobby.tsx`, `web/src/pages/student/Workspace.tsx`, `web/src/stores/clock.ts`, `web/src/components/LiveClock.tsx`.
- **Teacher workflow:** `web/src/pages/teacher/Dashboard.tsx`, `web/src/pages/teacher/ExamWizard.tsx`, `web/src/pages/teacher/LiveMonitor.tsx`, `web/src/pages/teacher/QuestionBank.tsx`, `web/src/pages/teacher/QuestionEditor.tsx`.

## Test accounts and fixture data

These are synthetic accounts from [API test fixtures](./api/test/fixtures.ts), not real Gmail accounts:

| Role | Login ID / email | Password | Notes |
|---|---|---|---|
| Teacher | `teacher@test.local` | `teacher12345` | Main fixture teacher; owns the fixture courses. |
| Teacher | `teacher2@test.local` | `teacher12345` | Secondary teacher; useful for checking course access restrictions. |
| Student | `S0001` | `student12345` | Test Student One, class `FX101-A`. |
| Student | `S0002` | `student12345` | Test Student Two, class `FX101-A`. |
| Student | `S0003` | `student12345` | Test Student Three, class `FX101-B`. |
| Student | `S0004` | `student12345` | Test Student Four, class `FX101-B`. |
| Student | `S0005` | `student12345` | Test Student Five, class `FX101-C`. |
| Student | `S0006` | `student12345` | Test Student Six, class `FX101-C`. |
| Student | `S0007` | `student12345` | Test Student Seven, class `FX101-A`. |
| Student | `S0008` | `student12345` | Test Student Eight, class `FX101-B`. |

The fixture emails use the `@students.test.local` domain. Courses `FX101` and `FX100`, classes, questions, and exams are also seeded for API tests. A read-only check of the current local application database (`aegis`) found that **none of these fixture accounts are present there**. The fixture accounts are created in the separate `aegis_test` database by the API test setup, so these credentials will not log into the current local website. For that site, use the teacher and student accounts already configured by the project owner. Never use these fixture passwords on a deployed or public site.

## Create website test users after pulling

The normal application database is intentionally empty and is not included in Git. On a fresh local setup:

1. Follow the [README local setup](./README.md#run-it-on-your-computer-development) to create a PostgreSQL database and start the API and web app.
2. Open the local web app. On first visit, create the teacher account; the person setting it up chooses its email and password.
3. As that teacher, create a course and class, then add a synthetic student (for example, ID `TEST001`, name `Demo Student`, email `demo.student@example.test`).
4. With email delivery not configured, copy that student's sign-in link from the student-creation result. Open the link and set a student password.
5. Sign out and sign in as the student using the student ID and password just set. The teacher-created accounts are now available for testing in that local database.

These are user-created local accounts; they are not the API fixture accounts above. A local database on one computer is not copied when someone pulls the repository.

## Database administrator (DBA) instructions

1. Install/start PostgreSQL and create a dedicated application role and empty database (the [README](./README.md#run-it-on-your-computer-development) shows example commands). Give the application role access only to its own database.
2. Set `DATABASE_URL` in the API's untracked `api/.env` file. Do not commit credentials or copy a production database dump into this review repository.
3. Start the API. It applies the schema migrations automatically; then create the first teacher and students through the website as described above. Avoid inserting users directly into `users`, since account creation also manages password hashing and onboarding.
4. For API tests, configure a separate disposable `TEST_DATABASE_URL` whose database name contains `test` (default: `aegis_test`). The test setup creates it if missing, so the PostgreSQL role needs permission to create databases; alternatively, the DBA can pre-create it and grant the test role ownership/access.
5. **Never point `TEST_DATABASE_URL` at the application or production database.** The API test fixtures truncate and reseed tables in that test database.

## Validation completed

- Web production build passed; the generated build was served successfully at `http://127.0.0.1:4173`.
- Local API health check returned HTTP 200 on port 4000. The new teacher DELETE routes were also confirmed to be registered without changing data.
- The student dashboard and coding-exam lobby loaded in the local browser; the C runner check showed ready. The exam was not started.
- API typecheck and both API/web unused-local checks passed; the API TypeScript deprecation setting was aligned with the installed compiler.
- Web production build passed; it still emits Pyodide warnings about Node built-ins being externalized for browsers.
- Focused integration assertions were added for rejecting live-exam deletion and for question/exam deletion safeguards.

## Validation gaps and review notes

- The full API integration suite was not run: its setup needs permission to create the separate `aegis_test` PostgreSQL database, and the local database role previously lacked that permission.
- Coding-only selection/creation is currently enforced by the teacher UI. The API still accepts legacy question types for compatibility; decide whether it should also reject non-coding types for newly created questions and exams.
- The local preview is for laptop testing only. No public hosting/deployment is configured by this work.

## Suggested review checklist

1. Confirm visible tests cannot expose hidden tests and that final grading still uses the server.
2. Review authorization, active-run guards, audit records, and database cascade/snapshot behavior for both DELETE routes.
3. Confirm legacy non-coding content remains usable in existing exams but cannot be selected for new exams.
4. Run the API integration suite against a disposable test database with the required PostgreSQL permissions.
5. Test a coding exam end-to-end with a teacher and student account before using it for a real exam.
