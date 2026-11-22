-- Students are added by teachers with their student ID; email is optional (needed only to send invites).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_teacher_email CHECK (role <> 'teacher' OR email IS NOT NULL);
-- NULL until the person chooses their own password (from an invite link).
ALTER TABLE users ADD COLUMN password_set_at timestamptz;
UPDATE users SET password_set_at = created_at;

-- Invite links reuse the password reset table.
ALTER TABLE password_resets ADD COLUMN purpose text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset', 'invite'));

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'teacher_message';

CREATE TABLE outbound_emails (
  id bigserial PRIMARY KEY,
  to_address text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'logged')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
