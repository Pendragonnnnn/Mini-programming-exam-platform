-- Aegis web exam: initial schema (BACKEND_SPEC_PART1 §3)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('student', 'teacher');
CREATE TYPE exam_type AS ENUM ('quiz', 'midterm', 'final', 'lab', 'practice');
CREATE TYPE exam_status AS ENUM ('draft', 'scheduled', 'live', 'grading', 'completed', 'archived');
CREATE TYPE question_order AS ENUM ('fixed', 'shuffle', 'pool');
CREATE TYPE difficulty AS ENUM ('easy', 'intermediate', 'advanced');
CREATE TYPE language AS ENUM ('java', 'python', 'flutter', 'dart', 'cpp', 'javascript', 'typescript', 'go', 'rust',
  'kotlin', 'csharp', 'sql', 'c', 'swift', 'php', 'ruby', 'scala', 'r', 'haskell', 'bash');
CREATE TYPE test_kind AS ENUM ('stdio', 'call');
CREATE TYPE match_type AS ENUM ('exact', 'token', 'exception_class', 'float_tolerance');
CREATE TYPE session_status AS ENUM ('not_started', 'in_progress', 'submitted', 'auto_submitted', 'force_submitted');
CREATE TYPE run_kind AS ENUM ('run', 'custom_input', 'sample_tests', 'final_grading', 'reference_validation');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'completed', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit', 'internal_error');
CREATE TYPE test_outcome AS ENUM ('pass', 'fail', 'error', 'timeout');
CREATE TYPE grading_status AS ENUM ('pending_tests', 'needs_review', 'reviewed');
CREATE TYPE ai_status AS ENUM ('queued', 'running', 'done', 'failed', 'disabled');
CREATE TYPE proctor_event_type AS ENUM ('tab_switch', 'fullscreen_exit', 'paste_blocked', 'connection_lost', 'connection_restored', 'session_takeover', 'heartbeat_gap');
CREATE TYPE audit_category AS ENUM ('publish', 'grade_change', 'lockdown', 'settings');
CREATE TYPE message_scope AS ENUM ('all', 'direct');
CREATE TYPE notification_type AS ENUM ('proctor_flag', 'submission', 'student_question', 'exam_published', 'exam_reminder', 'results_released');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL,
  email citext NOT NULL UNIQUE,
  student_id text UNIQUE,
  full_name text NOT NULL,
  display_name text,
  title text,
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role <> 'student' OR student_id IS NOT NULL)
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  family_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  starts_on date NOT NULL,
  ends_on date NOT NULL
);

CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id uuid NOT NULL REFERENCES terms(id),
  code text NOT NULL,
  title text NOT NULL,
  department text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term_id, code)
);

CREATE TABLE course_teachers (
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (course_id, teacher_id)
);

CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  code text NOT NULL,
  UNIQUE (course_id, code)
);

CREATE TABLE enrollments (
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES users(id),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, student_id)
);
CREATE INDEX enrollments_student_idx ON enrollments(student_id);

CREATE TABLE class_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  label text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL DEFAULT 'Untitled question',
  topic text,
  difficulty difficulty NOT NULL DEFAULT 'intermediate',
  points integer NOT NULL DEFAULT 40 CHECK (points BETWEEN 0 AND 100),
  instructions_md text NOT NULL DEFAULT '',
  time_limit_ms integer NOT NULL DEFAULT 2000,
  memory_limit_mb integer NOT NULL DEFAULT 256,
  network_access boolean NOT NULL DEFAULT false,
  -- per-language test fixture: { "java": { "code": "...", "target": "account" } }
  setup jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  last_edited_by uuid REFERENCES users(id),
  last_validation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_course_idx ON questions(course_id) WHERE archived_at IS NULL;

CREATE TABLE question_languages (
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  language language NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, language)
);

CREATE TABLE question_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  language language NOT NULL,
  kind text NOT NULL CHECK (kind IN ('starter', 'reference')),
  path text NOT NULL,
  content text NOT NULL DEFAULT '',
  read_only boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0,
  is_entrypoint boolean NOT NULL DEFAULT false,
  UNIQUE (question_id, language, kind, path)
);

CREATE TABLE test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind test_kind NOT NULL DEFAULT 'call',
  input text NOT NULL DEFAULT '',
  expected text NOT NULL DEFAULT '',
  match_type match_type NOT NULL DEFAULT 'exact',
  float_tolerance numeric(10,6) NOT NULL DEFAULT 0.01,
  weight integer NOT NULL DEFAULT 5 CHECK (weight >= 0),
  is_hidden boolean NOT NULL DEFAULT false,
  sort_order smallint NOT NULL DEFAULT 0
);

CREATE TABLE exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id),
  created_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  short_title text,
  exam_type exam_type NOT NULL DEFAULT 'midterm',
  instructions_md text NOT NULL DEFAULT '',
  status exam_status NOT NULL DEFAULT 'draft',
  is_practice boolean NOT NULL DEFAULT false,
  -- hidden draft exam used by "Test as student" in the question editor
  preview_question_id uuid,
  starts_at timestamptz,
  duration_minutes integer CHECK (duration_minutes IN (60, 90, 120, 180)),
  late_join_minutes integer NOT NULL DEFAULT 15,
  global_extension_minutes integer NOT NULL DEFAULT 0,
  question_order question_order NOT NULL DEFAULT 'fixed',
  pool_size integer,
  allow_run boolean NOT NULL DEFAULT true,
  show_sample_tests boolean NOT NULL DEFAULT true,
  run_hidden_on_submit boolean NOT NULL DEFAULT true,
  runs_per_question integer,
  time_limit_ms integer NOT NULL DEFAULT 2000,
  memory_limit_mb integer NOT NULL DEFAULT 256,
  auto_submit_on_timeout boolean NOT NULL DEFAULT true,
  auto_grade_with_tests boolean NOT NULL DEFAULT true,
  release_after_review boolean NOT NULL DEFAULT true,
  notify_now boolean NOT NULL DEFAULT true,
  notify_reminder_1h boolean NOT NULL DEFAULT true,
  reminder_sent_at timestamptz,
  published_at timestamptz,
  ended_at timestamptz,
  results_released_at timestamptz,
  seb_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exams_course_status_idx ON exams(course_id, status);
CREATE INDEX exams_starts_idx ON exams(starts_at);

CREATE TABLE exam_classes (
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_id uuid NOT NULL REFERENCES classes(id),
  PRIMARY KEY (exam_id, class_id)
);
CREATE INDEX exam_classes_class_idx ON exam_classes(class_id);

CREATE TABLE exam_languages (
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  language language NOT NULL,
  PRIMARY KEY (exam_id, language)
);

CREATE TABLE exam_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  source_question_id uuid REFERENCES questions(id) ON DELETE SET NULL,
  source_version integer,
  position smallint NOT NULL,
  points integer NOT NULL CHECK (points BETWEEN 0 AND 100),
  snapshot jsonb NOT NULL,
  snapshotted_at timestamptz,
  UNIQUE (exam_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE exam_accommodations (
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES users(id),
  extra_minutes integer NOT NULL CHECK (extra_minutes > 0),
  reason text,
  PRIMARY KEY (exam_id, student_id)
);

CREATE TABLE exam_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES users(id),
  status session_status NOT NULL DEFAULT 'not_started',
  integrity_accepted_at timestamptz,
  started_at timestamptz,
  deadline_at timestamptz,
  live_extension_minutes integer NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  submit_reason text CHECK (submit_reason IN ('student', 'timeout', 'teacher_ended', 'tab_switch_limit')),
  active_client_token_hash text,
  last_seen_at timestamptz,
  current_question_position smallint,
  question_order uuid[],
  tab_switch_count integer NOT NULL DEFAULT 0,
  is_flagged boolean NOT NULL DEFAULT false,
  is_preview boolean NOT NULL DEFAULT false,
  seb_version text,
  client_ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, student_id)
);
CREATE INDEX exam_sessions_exam_status_idx ON exam_sessions(exam_id, status);

CREATE TABLE session_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  exam_question_id uuid NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  language language NOT NULL,
  files jsonb NOT NULL DEFAULT '{}',
  file_times jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0,
  client_saved_at timestamptz,
  server_saved_at timestamptz,
  last_sample_passed integer NOT NULL DEFAULT 0,
  last_sample_total integer NOT NULL DEFAULT 0,
  last_sample_run_id uuid,
  started boolean NOT NULL DEFAULT false,
  run_count integer NOT NULL DEFAULT 0,
  UNIQUE (session_id, exam_question_id)
);
CREATE INDEX session_answers_session_idx ON session_answers(session_id);

CREATE TABLE answer_snapshots (
  id bigserial PRIMARY KEY,
  answer_id uuid NOT NULL REFERENCES session_answers(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  language language NOT NULL,
  files jsonb NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE code_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind run_kind NOT NULL,
  session_id uuid REFERENCES exam_sessions(id) ON DELETE CASCADE,
  answer_id uuid REFERENCES session_answers(id) ON DELETE SET NULL,
  submission_answer_id uuid,
  question_id uuid REFERENCES questions(id) ON DELETE CASCADE,
  exam_question_id uuid REFERENCES exam_questions(id) ON DELETE CASCADE,
  validation_job_id uuid,
  requested_by uuid NOT NULL REFERENCES users(id),
  language language NOT NULL,
  files jsonb NOT NULL,
  -- the question definition used for this run (tests, setup, limits)
  spec jsonb NOT NULL,
  stdin text,
  status run_status NOT NULL DEFAULT 'queued',
  priority smallint NOT NULL DEFAULT 5,
  command text,
  compile_output text,
  diagnostics jsonb NOT NULL DEFAULT '[]',
  console jsonb NOT NULL DEFAULT '[]',
  stdout text,
  stderr text,
  exit_code integer,
  time_ms integer,
  memory_kb integer,
  tests_passed integer,
  tests_total integer,
  attempts smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX code_runs_queue_idx ON code_runs(status, priority, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX code_runs_session_idx ON code_runs(session_id, created_at DESC);

CREATE TABLE test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES code_runs(id) ON DELETE CASCADE,
  test_case_ref text NOT NULL,
  name text NOT NULL,
  is_hidden boolean NOT NULL,
  outcome test_outcome NOT NULL,
  points_awarded integer NOT NULL DEFAULT 0,
  points_possible integer NOT NULL,
  time_ms integer,
  actual_output text,
  message text,
  sort_order smallint NOT NULL DEFAULT 0
);
CREATE INDEX test_results_run_idx ON test_results(run_id);

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE REFERENCES exam_sessions(id) ON DELETE CASCADE,
  submitted_at timestamptz NOT NULL,
  reason text NOT NULL,
  time_used_seconds integer NOT NULL,
  grading_status grading_status NOT NULL DEFAULT 'pending_tests',
  auto_total integer,
  final_total integer,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id)
);
CREATE INDEX submissions_grading_idx ON submissions(grading_status);

CREATE TABLE submission_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  exam_question_id uuid NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
  language language NOT NULL,
  files jsonb NOT NULL,
  grading_run_id uuid REFERENCES code_runs(id),
  auto_score integer,
  teacher_score integer,
  final_score integer GENERATED ALWAYS AS (COALESCE(teacher_score, auto_score, 0)) STORED,
  max_score integer NOT NULL,
  feedback text,
  highlight_lines jsonb,
  UNIQUE (submission_id, exam_question_id)
);

CREATE TABLE ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_answer_id uuid NOT NULL REFERENCES submission_answers(id) ON DELETE CASCADE,
  status ai_status NOT NULL DEFAULT 'queued',
  model text,
  suggested_score integer,
  suggested_feedback text,
  rationale text,
  requirement_checks jsonb,
  highlight_lines jsonb,
  error text,
  accepted boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ai_suggestions_answer_idx ON ai_suggestions(submission_answer_id, created_at DESC);

CREATE TABLE grade_changes (
  id bigserial PRIMARY KEY,
  submission_answer_id uuid NOT NULL REFERENCES submission_answers(id) ON DELETE CASCADE,
  changed_by uuid NOT NULL REFERENCES users(id),
  old_score integer,
  new_score integer,
  feedback_changed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE proctor_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  type proctor_event_type NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  detail jsonb
);
CREATE INDEX proctor_events_session_idx ON proctor_events(session_id, occurred_at);

CREATE TABLE exam_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  scope message_scope NOT NULL,
  recipient_id uuid REFERENCES users(id),
  exam_question_id uuid REFERENCES exam_questions(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope = 'all' OR recipient_id IS NOT NULL)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  title text NOT NULL,
  actor_name text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id),
  actor_label text NOT NULL,
  actor_role text NOT NULL,
  category audit_category NOT NULL,
  action text NOT NULL,
  exam_id uuid REFERENCES exams(id) ON DELETE SET NULL,
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  target_label text NOT NULL,
  details text NOT NULL,
  meta jsonb
);
CREATE INDEX audit_exam_idx ON audit_events(exam_id, occurred_at DESC);
CREATE INDEX audit_category_idx ON audit_events(category, occurred_at DESC);

CREATE TABLE validation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  version integer,
  is_draft boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
