BEGIN;

-- A later rights finding must immediately prevent new use and online reads,
-- while preserving the review and audit evidence. Physical object deletion is
-- driven by the emitted Outbox event and must be retried by a separate worker.
CREATE OR REPLACE FUNCTION app.revoke_content_rights_review(
  p_review_id uuid,
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
  IF length(trim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'revocation reason must be 1-1000 characters'; END IF;

  SELECT * INTO review_row FROM content_rights_reviews WHERE review_id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'content-rights review not found'; END IF;
  IF review_row.state <> 'APPROVED' THEN RAISE EXCEPTION 'only an approved review can be revoked'; END IF;

  UPDATE content_rights_reviews
     SET state = 'REVOKED', reviewer_id = identity_row.reviewer_id,
         decision_reason = trim(p_reason), updated_at = CURRENT_TIMESTAMP
   WHERE review_id = p_review_id
   RETURNING * INTO review_row;

  IF review_row.subject_type = 'OC_TEXT' THEN
    UPDATE oc_imports SET state = 'REVOKED' WHERE import_id = review_row.subject_ref AND account_id = review_row.account_id;
  ELSIF review_row.subject_type = 'REFERENCE_IMAGE' THEN
    -- Online serving checks AVAILABLE, so both the source and all completed
    -- derived scene assets are immediately fail-closed before object cleanup.
    UPDATE media_assets SET state = 'DELETED', deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
      WHERE asset_id = review_row.subject_ref AND account_id = review_row.account_id AND type = 'REFERENCE_IMAGE';
    UPDATE media_assets AS derived SET state = 'DELETED', deleted_at = COALESCE(derived.deleted_at, CURRENT_TIMESTAMP)
      FROM media_jobs AS job
      WHERE derived.job_id = job.job_id AND job.reference_asset_id = review_row.subject_ref
        AND derived.account_id = review_row.account_id AND derived.type = 'SCENE_IMAGE' AND derived.state = 'AVAILABLE';
  END IF;

  INSERT INTO outbox_events (account_id, character_id, aggregate_type, aggregate_id, event_type, payload_json)
    VALUES (review_row.account_id, NULL, 'CONTENT_RIGHTS_REVIEW', review_row.review_id, 'content_rights.review_changed.v1',
      jsonb_build_object('review_id', review_row.review_id, 'subject_type', review_row.subject_type, 'subject_ref', review_row.subject_ref, 'state', 'REVOKED', 'physical_cleanup_required', true));
  INSERT INTO audit_events (account_id, actor_type, actor_id, action, resource_type, resource_id, reason_code)
    VALUES (review_row.account_id, 'ADMIN', identity_row.reviewer_id::text, 'CONTENT_RIGHTS_REVIEW_REVOKED', 'CONTENT_RIGHTS_REVIEW', review_row.review_id::text, 'REVOKED');
  RETURN review_row;
END;
$$;

ALTER FUNCTION app.revoke_content_rights_review(uuid, text) OWNER TO qiyu_rights_service;
GRANT EXECUTE ON FUNCTION app.revoke_content_rights_review(uuid, text) TO qiyu_reviewer;
REVOKE ALL ON FUNCTION app.revoke_content_rights_review(uuid, text) FROM PUBLIC, qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('025_development_content_rights_revocation.sql');
COMMIT;
