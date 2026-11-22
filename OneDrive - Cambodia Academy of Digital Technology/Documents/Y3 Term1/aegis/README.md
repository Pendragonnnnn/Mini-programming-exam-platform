# Aegis Exam — secure online exam website

A complete exam website for teachers and students. It starts **empty**: there is no demo data. The first visit shows a one-time setup screen where you create the first teacher account, and you build everything else yourself.

**What teachers do**

- Create **courses** and **classes**.
- Add **students by student ID** (one at a time, a pasted list, or a CSV file). The system creates their accounts and sends each student a personal sign-in link. Students choose their own password, then sign in with their student ID.
- Write questions of five types:
  - **Multiple choice**: one correct answer.
  - **Multiple answers**: several correct answers, with optional partial credit.
  - **True / False**.
  - **Short answer**: accepted answers with optional case sensitivity; answers that don't match go to the teacher for review.
  - **Coding** in **Java, Python 3, C, C++ and JavaScript**: starter code, reference solution, sample and hidden tests, and a one-click "Validate solutions".
- Build an exam with any mix of question types, choose the classes, the start time and the duration (5–600 minutes), then publish. Students are notified.
- Watch the exam live, extend time, message students, and end the exam.
- Grade the exam. Choice questions are scored automatically and coding questions by their tests, with an AI-assistant suggestion. The teacher sets the final grade and adds feedback, then releases the results. Results can be exported as CSV or ZIP.
- Message a whole class, add co-teachers, and read the audit log.

**What students do**

Sign in with their student ID, open the exam lobby, and start the exam. They answer choice questions and write, run and test code in the browser; answers save automatically, including offline. After submitting, they see their score, their answers and the teacher's feedback once the teacher releases the results.

```
aegis/
├── api/   Node 20+ · Express · TypeScript · PostgreSQL   (REST API, code runner, background jobs, email)
└── web/   React 18 · Vite · TanStack Query · CodeMirror
```

---

## Run it on your computer (development)

You need **Node 20+** and **PostgreSQL 14+**. To run student code with the built-in runner you also need the compilers on your PATH: **Java JDK 17+** (`javac`), **Python 3**, **gcc/g++** (C/C++) and **Node** (JavaScript). The lobby's "Code runner" check shows which languages are ready.

```bash
# 1. database (once)
createuser -P aegis            # password: aegis
createdb -O aegis aegis

# 2. API  → http://localhost:4000   (creates the tables automatically on start)
cd api
npm install
npm run dev

# 3. website → http://localhost:5173   (in a second terminal)
cd web
npm install
npm run dev
```

Open **http://localhost:5173**. The first time, you see **"Welcome to Aegis Exam"**. Create your teacher account there, and the app takes you to **Courses & students**.

**Windows:** the built-in code runner uses `bash`. Install **Git for Windows** (the runner finds `C:\Program Files\Git\bin\bash.exe` automatically), or run the project inside **WSL** or with **Docker** (below). Install Python, a JDK, MinGW gcc/g++ and Node, and put them on your PATH.

### First steps after setup

1. **Courses & students** → *New course* (code, title, term) → *Add class* (e.g. "Group A").
2. Paste your students, one per line: `student ID, full name, email`. Only the ID is required. Choose **Add students**.
   - With email set up (see below), each new student gets an email with their sign-in link.
   - Without email, the page lists every student's sign-in link. Use **Copy all** and send the links yourself (Telegram, Google Classroom, …).
3. **Question bank** → *New question* → choose the type. For coding questions, add tests and a reference solution, then choose **Validate solutions**.
4. **New exam** → details & schedule → questions → rules → **Publish & send to students**.
5. During the exam use **Live monitor**. Afterwards use **Grading**, then **Results → Release to students**.

## Test data (for trying it out)

With the API running, open a second terminal:

```bash
cd api
npm run test-data
```

This creates (through the app's own API) the teacher `teacher@test.com` / `teacher123`, course TEST101 with class "Test Group", students **S001–S005** with password `student123`, one question of each type, and an exam that starts in 2 minutes. If you already created your own teacher, use `npm run test-data -- --email YOUR_EMAIL --password YOUR_PASSWORD`. To go back to an empty site, recreate the `aegis` database.

## Demo testing mode (local development only)

To try the whole student and teacher experience with one click, create `api/.env` containing:

```
DEMO_MODE=true
NODE_ENV=development
```

Restart the API. It prints `DEMO MODE is ON`, and the login page gets a **Demo accounts** box:

| Button | Typed login | Can do |
|---|---|---|
| **Demo Student** | Student tab: `demo_student` / `DemoStudent123` | dashboard, open demo exam, take it, history, results |
| **Demo Teacher** | Teacher tab: `demo_teacher` / `DemoTeacher123` | course DEMO101 with 5 ready questions, exams, monitor, grading, results |

Every demo session shows an orange **DEMO MODE** badge with **Switch role** (back to the login page). Each time the demo student signs in, they get an open demo exam they haven't taken yet, so the demo can be repeated.

**Safety:**
- Demo mode needs BOTH settings, so it is always off when `NODE_ENV=production` (the Docker setup uses production).
- Demo accounts are marked in the database and refuse to sign in when demo mode is off. Sessions that are already open stop working too.
- Demo accounts see only the demo course. A demo teacher cannot add real students or teachers, and real teachers cannot add demo accounts.
- To turn it off, remove the two lines (or set `DEMO_MODE=false`) and restart the API.

**If login shows `POST /api/auth/login · 500`:** the API is not running, or it lost its database. The development web server answers 500 when it can't reach the API. Start the API (`cd api`, `npm run dev`), start PostgreSQL, and check `DATABASE_URL`. The login page now says this in plain words.

## Email (optional)

Set these in `api/.env` (see `api/.env.example`) to send invites, password resets, "new exam" and "results ready" emails:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.address@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM="Aegis Exam <your.address@gmail.com>"
```

Without `SMTP_HOST` everything still works: notifications appear inside the app, and teachers copy the sign-in links from the Students page.

## Tests

```bash
cd api && npm test        # 74 end-to-end API tests on a SEPARATE database "aegis_test" (created automatically)
cd api && npm run typecheck
cd web && npx tsc -b --noEmit && npx vite build
```

The tests never touch your real `aegis` database. They use `TEST_DATABASE_URL` (default `postgres://aegis:aegis@127.0.0.1:5432/aegis_test`), and their test data lives only in `api/test/`.

## Deploy with Docker

```bash
cp .env.example .env                    # change every secret
docker compose up -d --build            # app on http://localhost:8080
```

Optional profiles: `--profile judge0` starts the Judge0 sandbox (then set `RUNNER=judge0`), and `--profile ai` starts Ollama (then set `AI_PROVIDER=ollama` and run `docker compose exec ollama ollama pull qwen2.5-coder:7b`).

## Important notes

**Code runner.** `RUNNER=local` compiles and runs student code on the server itself, in a temporary folder with a time limit, but **without a sandbox**. Use it for development, class demos and trusted practice. For real exams, use `RUNNER=judge0`. Note that the Judge0 setup has not yet been tested against a live Judge0 server: run a practice exam on it first.

**Tests for each language.** *Stdio* tests (input → expected output) work for every language. *Call* tests run statements directly against the student's code (`deposit(50)` then `getBalance()`) and are available for Java, Python and JavaScript. C/C++ questions use stdio tests.

**Safe Exam Browser.** With `SEB_REQUIRED=true`, the API refuses exam requests that don't carry valid SEB headers. Put your SEB config key in `SEB_CONFIG_KEY`. This is off in development, so you can test in a normal browser.

**AI grading assistant.** For coding answers only. The default `heuristic` provider needs no model: it summarises the test results. `ollama` asks a local model. Either way it only suggests; the teacher sets the final grade.

**Integrity rules.** Pasting from outside the exam is blocked and logged. A student is flagged after 2 tab switches and auto-submitted after 5. The server auto-submits the latest saved answers 30 seconds after a student's deadline.

**Time.** Exams are scheduled in UTC; the wizard shows Phnom Penh time (UTC+7) next to it.
