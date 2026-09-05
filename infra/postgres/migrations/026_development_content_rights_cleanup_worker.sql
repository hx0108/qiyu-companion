BEGIN;

-- The cleanup worker may see object keys only after a reviewer revokes a
-- reference-image approval. It cannot approve reviews or change media state.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_content_cleanup') THEN
    CREATE ROLE qiyu_content_cleanup NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_content_cleanup') THEN
    RAISE EXCEPTION 'qiyu_content_cleanup must retain BYPASSRLS for forced-RLS cleanup reads';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS content_rights_cleanup_jobs (
  cleanup_event_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'PROCESSING', 'COMPLETED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at timestamptz,
  lease_expires_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1000),
  receipt_json jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS content_rights_cleanup_jobs_ready_idx
  ON content_rights_cleanup_jobs (next_attempt_at, created_at)
  WHERE state IN ('PENDING', 'PROCESSING');

ALTER TABLE content_rights_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_rights_cleanup_jobs FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.enqueue_content_rights_cleanup_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF NEW.event_type = 'content_rights.review_changed.v1'
     AND NEW.payload_json->>'state' = 'REVOKED'
     AND (NEW.payload_json->>'physical_cleanup_required')::boolean IS TRUE
     AND NEW.payload_json->>'subject_type' = 'REFERENCE_IMAGE'
  THEN
    INSERT INTO content_rights_cleanup_jobs (event_id)
    VALUES (NEW.event_id)
    ON CONFLICT (event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app.enqueue_content_rights_cleanup_event() OWNER TO qiyu_content_cleanup;

DROP TRIGGER IF EXISTS content_rights_cleanup_enqueue ON outbox_events;
CREATE TRIGGER content_rights_cleanup_enqueue
  AFTER INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_content_rights_cleanup_event();

-- Covers a short deployment gap between migrations 025 and 026 without
-- backfilling any event that has already been marked consumed.
INSERT INTO content_rights_cleanup_jobs (event_id)
SELECT event_id
  FROM outbox_events
 WHERE event_type = 'content_rights.review_changed.v1'
   AND payload_json->>'state' = 'REVOKED'
   AND (payload_json->>'physical_cleanup_required')::boolean IS TRUE
   AND payload_json->>'subject_type' = 'REFERENCE_IMAGE'
   AND published_at IS NULL
ON CONFLICT (event_id) DO NOTHING;

GRANT USAGE ON SCHEMA app, public TO qiyu_content_cleanup;
GRANT SELECT ON outbox_events, media_assets, media_jobs TO qiyu_content_cleanup;
GRANT SELECT, UPDATE ON content_rights_cleanup_jobs TO qiyu_content_cleanup;
GRANT INSERT ON content_rights_cleanup_jobs TO qiyu_content_cleanup;
REVOKE ALL ON content_rights_cleanup_jobs FROM PUBLIC, qiyu_app, qiyu_reviewer;
REVOKE ALL ON FUNCTION app.enqueue_content_rights_cleanup_event() FROM PUBLIC, qiyu_app, qiyu_reviewer;

INSERT INTO schema_migrations (migration_id) VALUES ('026_development_content_rights_cleanup_worker.sql');
COMMIT;
