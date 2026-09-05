BEGIN;

-- Emergency contact (PRD 3.9 / AC-19): minimum fields, independent-purpose
-- consent, never used for growth/marketing. Dev slice stores plaintext phone
-- for local verification only; production must apply masking/HSM decisions.
CREATE TABLE IF NOT EXISTS emergency_contacts (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id),
  contact_name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL,
  consent_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE emergency_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY emergency_contacts_scope ON emergency_contacts FOR ALL TO qiyu_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);

-- Complaints / reports / appeals (tech design 8.9): user-submitted with
-- optional resource reference; full private chat is never attached by default.
CREATE TABLE IF NOT EXISTS complaints (
  complaint_id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  kind text NOT NULL CHECK (kind IN ('REPORT_CONTENT', 'SERVICE_COMPLAINT', 'APPEAL')),
  target_resource_id text,
  description text NOT NULL,
  state text NOT NULL DEFAULT 'SUBMITTED' CHECK (state IN ('SUBMITTED', 'IN_REVIEW', 'RESOLVED')),
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS complaints_account_idx ON complaints (account_id, created_at DESC);
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
CREATE POLICY complaints_scope ON complaints FOR ALL TO qiyu_app
  USING (account_id = current_setting('app.current_account', true)::uuid)
  WITH CHECK (account_id = current_setting('app.current_account', true)::uuid);

INSERT INTO schema_migrations (migration_id) VALUES ('013_development_safety_contact_complaints.sql');

COMMIT;
