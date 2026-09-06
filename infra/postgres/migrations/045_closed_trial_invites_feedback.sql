BEGIN;

-- Closed beta credentials are opaque, operator-issued and stored as hashes.
-- They are deliberately separate from public registration and contain no PII.
CREATE TABLE trial_invites (
  invite_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  invite_code_hash bytea NOT NULL UNIQUE CHECK (octet_length(invite_code_hash) = 32),
  initial_secret_hash text NOT NULL CHECK (length(initial_secret_hash) BETWEEN 40 AND 512),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  account_id uuid UNIQUE REFERENCES accounts(account_id),
  expires_at timestamptz,
  first_claimed_at timestamptz,
  last_login_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE trial_sessions (
  session_id uuid PRIMARY KEY,
  invite_id uuid NOT NULL REFERENCES trial_invites(invite_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  access_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(access_token_hash) = 32),
  refresh_token_hash bytea NOT NULL UNIQUE CHECK (octet_length(refresh_token_hash) = 32),
  expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (refresh_expires_at > expires_at)
);
CREATE INDEX trial_sessions_access_active_idx ON trial_sessions (access_token_hash, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX trial_sessions_refresh_active_idx ON trial_sessions (refresh_token_hash, refresh_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE trial_feedback (
  feedback_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  category text NOT NULL CHECK (category IN ('ONBOARDING', 'PERSONA', 'MEMORY', 'SAFETY', 'USABILITY', 'OTHER')),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1200),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX trial_feedback_account_created_idx ON trial_feedback (account_id, created_at DESC);

ALTER TABLE trial_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY trial_feedback_scope ON trial_feedback FOR SELECT TO qiyu_app
  USING (account_id = app.current_account_id());
CREATE POLICY trial_feedback_insert_scope ON trial_feedback FOR INSERT TO qiyu_app
  WITH CHECK (account_id = app.current_account_id());

REVOKE ALL ON trial_invites, trial_sessions FROM qiyu_app;
GRANT SELECT, INSERT ON trial_feedback TO qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('045_closed_trial_invites_feedback.sql');
COMMIT;
