BEGIN;

-- The application may enqueue/index-read only. A dedicated worker owns
-- claiming, retries, vector mutation and no-content dead-letter handling.
ALTER TABLE asset_embedding_jobs
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE asset_embedding_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_embedding_dead_letters FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_asset_embedding_worker') THEN
    CREATE ROLE qiyu_asset_embedding_worker NOLOGIN NOINHERIT BYPASSRLS;
  ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'qiyu_asset_embedding_worker') THEN
    RAISE EXCEPTION 'qiyu_asset_embedding_worker must retain BYPASSRLS';
  END IF;
  EXECUTE format('GRANT qiyu_asset_embedding_worker TO %I', current_user);
END
$$;

-- This development index uses a fixed, versioned 256-dimensional vector.
ALTER TABLE relationship_asset_embeddings
  ADD CONSTRAINT relationship_asset_embeddings_dimension_256
  CHECK (embedding IS NULL OR vector_dims(embedding) = 256) NOT VALID;
ALTER TABLE relationship_asset_embeddings
  VALIDATE CONSTRAINT relationship_asset_embeddings_dimension_256;
CREATE INDEX IF NOT EXISTS relationship_asset_embeddings_active_cosine_256_idx
  ON relationship_asset_embeddings
  USING hnsw ((embedding::vector(256)) vector_cosine_ops)
  WHERE deleted_at IS NULL;

REVOKE ALL ON asset_embedding_jobs, asset_embedding_dead_letters FROM qiyu_app;
REVOKE INSERT, UPDATE, DELETE ON relationship_asset_embeddings FROM qiyu_app;
GRANT SELECT, INSERT ON asset_embedding_jobs TO qiyu_app;
GRANT SELECT ON asset_embedding_dead_letters, relationship_asset_embeddings TO qiyu_app;

GRANT SELECT ON accounts, relationship_assets TO qiyu_asset_embedding_worker;
GRANT SELECT, UPDATE ON asset_embedding_jobs TO qiyu_asset_embedding_worker;
GRANT SELECT, INSERT, UPDATE ON asset_embedding_dead_letters TO qiyu_asset_embedding_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON relationship_asset_embeddings TO qiyu_asset_embedding_worker;
GRANT UPDATE (index_state) ON relationship_assets TO qiyu_asset_embedding_worker;

INSERT INTO schema_migrations (migration_id) VALUES ('043_asset_embedding_worker_boundary.sql');
COMMIT;
