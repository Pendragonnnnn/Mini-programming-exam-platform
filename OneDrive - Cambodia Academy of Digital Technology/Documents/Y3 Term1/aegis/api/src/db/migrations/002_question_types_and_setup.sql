-- Question types (multiple choice, multiple answer, true/false, short answer) next to coding questions,
-- flexible exam durations, and per-answer responses for non-code questions.

CREATE TYPE question_type AS ENUM ('code', 'single_choice', 'multiple_choice', 'true_false', 'short_answer');

ALTER TABLE questions ADD COLUMN qtype question_type NOT NULL DEFAULT 'code';
-- { options: [{id, text, correct}], shuffle, partialCredit, acceptedAnswers: [], caseSensitive, explanation }
ALTER TABLE questions ADD COLUMN choice jsonb NOT NULL DEFAULT '{}';

ALTER TABLE session_answers ALTER COLUMN language DROP NOT NULL;
ALTER TABLE session_answers ADD COLUMN response jsonb;

ALTER TABLE answer_snapshots ALTER COLUMN language DROP NOT NULL;
ALTER TABLE answer_snapshots ADD COLUMN response jsonb;

ALTER TABLE submission_answers ALTER COLUMN language DROP NOT NULL;
ALTER TABLE submission_answers ADD COLUMN response jsonb;

-- Any duration between 5 minutes and 10 hours.
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_duration_minutes_check;
ALTER TABLE exams ADD CONSTRAINT exams_duration_minutes_check CHECK (duration_minutes BETWEEN 5 AND 600);
ALTER TABLE exams ALTER COLUMN late_join_minutes SET DEFAULT 15;

-- Teachers may set points up to 1000 per question.
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_points_check;
ALTER TABLE questions ADD CONSTRAINT questions_points_check CHECK (points BETWEEN 0 AND 1000);
ALTER TABLE questions ALTER COLUMN points SET DEFAULT 10;
ALTER TABLE exam_questions DROP CONSTRAINT IF EXISTS exam_questions_points_check;
ALTER TABLE exam_questions ADD CONSTRAINT exam_questions_points_check CHECK (points BETWEEN 0 AND 1000);
