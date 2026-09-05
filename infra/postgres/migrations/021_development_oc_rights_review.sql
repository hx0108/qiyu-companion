BEGIN;

CREATE TABLE IF NOT EXISTS oc_imports (
  import_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  -- Development isolation only: these are UTF-8 bytes, not encryption. A
  -- production migration must use envelope encryption and managed keys.
  source_bytes bytea NOT NULL,
  declaration_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUARANTINED', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'REVOKED')),
  proposed_persona jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS content_rights_reviews (
  review_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  subject_type text NOT NULL CHECK (subject_type IN ('OC_TEXT', 'REFERENCE_IMAGE', 'VOICE')), subject_ref uuid NOT NULL,
  declaration_version text NOT NULL, risk_codes text[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('DECLARED', 'QUARANTINED', 'AUTOMATED_SCREENING', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'REVOKED')),
  reviewer_id uuid, decision_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS content_rights_appeals (
  appeal_id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(account_id), review_id uuid NOT NULL REFERENCES content_rights_reviews(review_id),
  statement text NOT NULL, state text NOT NULL CHECK (state IN ('SUBMITTED', 'IN_REVIEW', 'RESOLVED', 'REJECTED')), created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS oc_imports_account_expiry_idx ON oc_imports (account_id, retention_expires_at);
CREATE INDEX IF NOT EXISTS content_rights_reviews_account_subject_idx ON content_rights_reviews (account_id, subject_ref);
ALTER TABLE oc_imports ENABLE ROW LEVEL SECURITY; ALTER TABLE oc_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY oc_imports_scope ON oc_imports FOR ALL TO qiyu_app USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
ALTER TABLE content_rights_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE content_rights_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY content_rights_reviews_scope ON content_rights_reviews FOR SELECT TO qiyu_app USING (account_id = app.current_account_id());
CREATE POLICY content_rights_reviews_initial_insert ON content_rights_reviews FOR INSERT TO qiyu_app WITH CHECK (
  account_id = app.current_account_id() AND state = 'REVIEW_REQUIRED' AND reviewer_id IS NULL
);
ALTER TABLE content_rights_appeals ENABLE ROW LEVEL SECURITY; ALTER TABLE content_rights_appeals FORCE ROW LEVEL SECURITY;
CREATE POLICY content_rights_appeals_scope ON content_rights_appeals FOR ALL TO qiyu_app USING (account_id = app.current_account_id()) WITH CHECK (account_id = app.current_account_id());
GRANT SELECT, INSERT ON oc_imports TO qiyu_app;
GRANT SELECT, INSERT ON content_rights_reviews TO qiyu_app;
GRANT SELECT, INSERT ON content_rights_appeals TO qiyu_app;
INSERT INTO schema_migrations (migration_id) VALUES ('021_development_oc_rights_review.sql');
COMMIT;
