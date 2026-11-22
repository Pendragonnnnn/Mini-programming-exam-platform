# Aegis Exam — secure online exam website

A complete exam website for teachers and students. It starts **empty**: there is no demo data. The first visit shows a one-time setup screen where you create the first teacher account, and you build everything else yourself.

**What teachers do**

- Create **courses** and **classes**.
- Add **students by student ID** (one at a time, a pasted list, or a CSV file). The system creates their accounts and sends each student a personal sign-in link. Students choose their own password, then sign in with their student ID.
- Write coding questions in **Java, Python 3, C, C++ and JavaScript**: starter code, reference solution, sample and hidden tests, and a one-click "Validate solutions". New exams use coding questions only. Legacy non-coding questions remain available for existing exam history.
- Build a coding exam, choose the classes, start time and duration (5–600 minutes), then publish. Students are notified.
- Watch the exam live, extend time, message students, and end the exam.
- Grade coding answers by their tests, with an AI-assistant suggestion. The teacher sets the final grade and adds feedback, then releases the results. Results can be exported as CSV or ZIP.
- Message a whole class, add co-teachers, and read the audit log.

**What students do**

Sign in with their student ID, open the exam lobby, and start the exam. They write, run and test code in the browser; answers save automatically, including offline. After submitting, they see their score, their answers and the teacher's feedback once the teacher releases the results.

```
aegis/
├── api/   Node 20+ · Express · TypeScript · PostgreSQL   (REST API, code runner, background jobs, email)
└── web/   React 18 · Vite · TanStack Query · CodeMirror
```

---

## Run it on your computer (development)

You need **Node 20+** and **PostgreSQL 14+**. If the API uses `RUNNER=local`, its host also needs **Java JDK 17+** (`javac`), **Python 3**, **gcc/g++** and **Node**. Java and JavaScript student runs use the configured server runner; Python, C and C++ Run/sample checks use the browser runtime. The lobby's "Code runner" check shows server-runner readiness.

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

**Windows:** the API's built-in local runner uses `bash`. Install **Git for Windows** (the runner finds `C:\Program Files\Git\bin\bash.exe` automatically), or run the project inside **WSL** or with **Docker** (below). Install the API runner's compilers and put them on its PATH if using `RUNNER=local`.

### First steps after setup

1. **Courses & students** → *New course* (code, title, term) → *Add class* (e.g. "Group A").
2. Paste your students, one per line: `student ID, full name, email`. Only the ID is required. Choose **Add students**.
   - With email set up (see below), each new student gets an email with their sign-in link.
   - Without email, the page lists every student's sign-in link. Use **Copy all** and send the links yourself (Telegram, Google Classroom, …).
3. **Question bank** → *New coding question* → add tests and a reference solution, then choose **Validate solutions**.
4. **New exam** → details & schedule → questions → rules → **Publish & send to students**.
5. During the exam use **Live monitor**. Afterwards use **Grading**, then **Results → Release to students**.

Teachers can edit or permanently delete coding questions from the question bank. Legacy non-coding questions are retained for past exams, but are not available in new exams. Deleting a question preserves completed-exam snapshots; draft and active exam usage must be removed first. Deleting an exam permanently removes its sessions, answers, submissions and grading history; live exams cannot be deleted.

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
docker compose --profile judge0 up -d --build  # app on http://localhost:8080
```

Optional profile: `--profile ai` starts Ollama (then set `AI_PROVIDER=ollama` and run `docker compose exec ollama ollama pull qwen2.5-coder:7b`).

## Temporary public demo (free)

For a short demo, run the Docker Compose app on your own computer and expose only the web port through a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). It needs no domain or Cloudflare account. The generated `trycloudflare.com` hostname changes each time and works only while Docker, your computer, internet connection, and the tunnel process are running.

1. Copy `.env.example` to `.env`. Replace the database password in both `POSTGRES_PASSWORD` and `DATABASE_URL`, and set a unique `JWT_ACCESS_SECRET`. Keep `RUNNER=judge0`.
2. Start the app and sandbox:

   ```powershell
   docker compose --profile judge0 up -d --build
   ```

3. Open `http://localhost:8080` and create the first teacher account before starting the tunnel.
4. In a separate PowerShell terminal, start a tunnel and restrict it to your demo testers' email addresses:

   ```powershell
   cloudflared tunnel --url http://localhost:8080 `
     --allowed-mail you@example.com `
     --allowed-mail teammate@example.com `
     --allowed-mail lecturer@example.edu
   ```

5. Copy the generated HTTPS URL. Set `APP_PUBLIC_URL` in `.env` to that URL before creating student invites or sending emails, then recreate the API:

   ```powershell
   docker compose --profile judge0 up -d --force-recreate api
   ```

Quick Tunnels are for testing, not production: they have no uptime guarantee, the URL is temporary, and anyone not blocked by the email restriction can reach the app. Use only test accounts and non-sensitive data. Stop the tunnel when the demo ends. The bundled Judge0 profile has not yet been tested against a live Judge0 server; verify it with a practice exam before the demonstration.

## Important notes

**Code runner.** `RUNNER=local` compiles and runs student code on the server itself, in a temporary folder with a time limit, but **without a sandbox**. Use it only for development. Production requires `RUNNER=judge0`; the API rejects production startup with the local runner. The bundled Judge0 profile has not yet been tested against a live Judge0 server, so validate it with a non-sensitive practice exam before allowing real students to use it.

**Browser-local checks.** Python, C and C++ **Run** and visible sample tests execute in a dedicated browser worker; Java and JavaScript continue to use the configured server runner. Runtime assets are served by this site, and the first local run downloads roughly 40 MB that the browser can cache. The API still saves the answer and enforces run limits, but it does not execute local requests or trust their reported sample results. Hidden tests and final grading always run on the server. Browser runs have a time limit; C/C++ WebAssembly programs also receive a memory cap, while Pyodide Python cannot enforce the exam's per-run memory limit. The Python runtime is Pyodide's Python 3.14 standard library, and the C/C++ runtime does not support C++ exceptions. Multiple C/C++ source files are compiled as separate translation units in the browser. The server-side final grading remains authoritative.

**Tests for each language.** *Stdio* tests (input → expected output) work for every language. *Call* tests run statements directly against the student's code (`deposit(50)` then `getBalance()`) and are available for Java, Python and JavaScript. C/C++ questions use stdio tests.

**Safe Exam Browser.** With `SEB_REQUIRED=true`, the API refuses exam requests that don't carry valid SEB headers. Put your SEB config key in `SEB_CONFIG_KEY`. This is off in development, so you can test in a normal browser.

**AI grading assistant.** For coding answers only. The default `heuristic` provider needs no model: it summarises the test results. `ollama` asks a local model. Either way it only suggests; the teacher sets the final grade.

**Integrity rules.** Pasting from outside the exam is blocked and logged. A student is flagged after 2 tab switches and auto-submitted after 5. The server auto-submits the latest saved answers 30 seconds after a student's deadline.

**Time.** Teachers schedule exams in their device's local time. The platform stores the absolute instant and displays it in each viewer's local timezone.
