BEGIN;

-- qiyu_app creates and reads pending reviews only. A deployment administrator
-- provisions login identities as members of this NOLOGIN reviewer role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_reviewer') THEN
    CREATE ROLE qiyu_reviewer NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_rights_service') THEN
    CREATE ROLE qiyu_rights_service NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_rights_service') THEN
    RAISE EXCEPTION 'qiyu_rights_service must retain BYPASSRLS for the forced-RLS decision function';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS content_rights_reviewer_identities (
  database_role name PRIMARY KEY,
  reviewer_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS content_rights_review_decisions (
  decision_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  review_id uuid NOT NULL REFERENCES content_rights_reviews(review_id),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  reviewer_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (review_id)
);
CREATE INDEX IF NOT EXISTS content_rights_review_decisions_account_idx
  ON content_rights_review_decisions (account_id, decided_at DESC);

ALTER TABLE content_rights_reviewer_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_rights_reviewer_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY content_rights_reviewer_identities_self ON content_rights_reviewer_identities
  FOR SELECT TO qiyu_reviewer USING (database_role = session_user::name);

ALTER TABLE content_rights_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_rights_review_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY content_rights_review_decisions_reviewer_read ON content_rights_review_decisions
  FOR SELECT TO qiyu_reviewer USING (reviewer_id = (
    SELECT reviewer_id FROM content_rights_reviewer_identities WHERE database_role = session_user::name AND state = 'ACTIVE'
  ));

-- A user-facing account cannot call this function: it needs both membership
-- and an active server-side reviewer identity. It performs a single locked
-- transition, propagates availability only for approved reference media, and
-- emits the immutable event that later workers consume for revocation/cache
-- invalidation.
CREATE OR REPLACE FUNCTION app.decide_content_rights_review(
  p_review_id uuid,
  p_decision text,
  p_reason text
) RETURNS content_rights_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  review_row content_rights_reviews%ROWTYPE;
  identity_row content_rights_reviewer_identities%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'qiyu_reviewer', 'member') THEN
    RAISE EXCEPTION 'reviewer role is required';
  END IF;
  SELECT * INTO identity_row FROM content_rights_reviewer_identities
    WHERE database_role = session_user::name AND state = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'active reviewer identity is required'; END IF;
  IF p_decision NOT IN ('APPROVED', 'REJECTED') THEN RAISE EXCEPTION 'decision must be APPROVED or REJECTED'; END IF;
  IF length(trim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'decision reason must be 1-1000 characters'; END IF;

  SELECT * INTO review_row FROM content_rights_reviews WHERE review_id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'content-rights review not found'; END IF;
  IF review_row.state <> 'REVIEW_REQUIRED' THEN RAISE EXCEPTION 'review is not pending'; END IF;

  UPDATE content_rights_reviews
     SET state = p_decision, reviewer_id = identity_row.reviewer_id,
         decision_reason = trim(p_reason), updated_at = CURRENT_TIMESTAMP
   WHERE review_id = p_review_id
   RETURNING * INTO review_row;
  INSERT INTO content_rights_review_decisions (review_id, account_id, reviewer_id, decision, reason)
    VALUES (review_row.review_id, review_row.account_id, identity_row.reviewer_id, p_decision, trim(p_reason));

  IF review_row.subject_type = 'OC_TEXT' THEN
    UPDATE oc_imports SET state = p_decision WHERE import_id = review_row.subject_ref AND account_id = review_row.account_id;
  ELSIF review_row.subject_type = 'REFERENCE_IMAGE' THEN
    UPDATE media_assets SET state = CASE WHEN p_decision = 'APPROVED' THEN 'AVAILABLE' ELSE 'BLOCKED' END
      WHERE asset_id = review_row.subject_ref AND account_id = review_row.account_id AND type = 'REFERENCE_IMAGE';
  END IF;

  INSERT INTO outbox_events (account_id, character_id, aggregate_type, aggregate_id, event_type, payload_json)
    VALUES (review_row.account_id, NULL, 'CONTENT_RIGHTS_REVIEW', review_row.review_id, 'content_rights.review_changed.v1',
      jsonb_build_object('review_id', review_row.review_id, 'subject_type', review_row.subject_type, 'subject_ref', review_row.subject_ref, 'state', p_decision));
  INSERT INTO audit_events (account_id, actor_type, actor_id, action, resource_type, resource_id, reason_code)
    VALUES (review_row.account_id, 'ADMIN', identity_row.reviewer_id::text, 'CONTENT_RIGHTS_REVIEW_DECIDED', 'CONTENT_RIGHTS_REVIEW', review_row.review_id::text, p_decision);
  RETURN review_row;
END;
$$;

-- The function owner is an unloginable, narrow service role.  It bypasses RLS
-- only inside this reviewed function; reviewers cannot SET ROLE to it and do
-- not receive direct UPDATE privileges on the source tables.
ALTER FUNCTION app.decide_content_rights_review(uuid, text, text) OWNER TO qiyu_rights_service;
GRANT USAGE ON SCHEMA app, public TO qiyu_rights_service;
GRANT SELECT ON content_rights_reviewer_identities, content_rights_reviews TO qiyu_rights_service;
GRANT UPDATE (state, reviewer_id, decision_reason, updated_at) ON content_rights_reviews TO qiyu_rights_service;
GRANT UPDATE (state) ON oc_imports, media_assets TO qiyu_rights_service;
GRANT INSERT ON content_rights_review_decisions, outbox_events, audit_events TO qiyu_rights_service;

REVOKE ALL ON content_rights_reviewer_identities, content_rights_review_decisions FROM PUBLIC, qiyu_app;
REVOKE ALL ON FUNCTION app.decide_content_rights_review(uuid, text, text) FROM PUBLIC, qiyu_app;
GRANT SELECT ON content_rights_reviewer_identities, content_rights_review_decisions TO qiyu_reviewer;
GRANT EXECUTE ON FUNCTION app.decide_content_rights_review(uuid, text, text) TO qiyu_reviewer;

INSERT INTO schema_migrations (migration_id) VALUES ('024_development_content_rights_reviewer_boundary.sql');
COMMIT;
