-- Demo testing mode (DEMO_MODE=true + NODE_ENV=development only). Demo rows are marked so they can
-- never sign in outside demo mode and never mix with real people.
ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE courses ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
