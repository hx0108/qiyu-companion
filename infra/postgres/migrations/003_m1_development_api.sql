BEGIN;

-- This migration only carries the existing M1 development API's explicit
-- fields into the already versioned core schema. It does not enable a
-- production runtime or store real user data.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS age_status text NOT NULL DEFAULT 'AGE_UNVERIFIED'
    CHECK (age_status IN ('AGE_UNVERIFIED', 'AGE_PASS', 'AGE_REVIEW', 'AGE_DENIED_MINOR'));
ALTER TABLE characters ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_version text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'mock';
ALTER TABLE memory_candidates ADD COLUMN IF NOT EXISTS source_message_id uuid;

ALTER TABLE memory_candidates DROP CONSTRAINT IF EXISTS memory_candidates_state_check;
UPDATE memory_candidates SET state = 'CANDIDATE' WHERE state = 'PROPOSED';
ALTER TABLE memory_candidates ALTER COLUMN state SET DEFAULT 'CANDIDATE';
ALTER TABLE memory_candidates ADD CONSTRAINT memory_candidates_state_check
  CHECK (state IN ('CANDIDATE', 'CONFIRMED', 'CONFIRMED_EDITED', 'REJECTED', 'EXPIRED', 'DELETED'));

ALTER TABLE relationship_assets ADD COLUMN IF NOT EXISTS display_text text NOT NULL DEFAULT '';
ALTER TABLE deletion_jobs ADD COLUMN IF NOT EXISTS asset_id uuid;
ALTER TABLE deletion_jobs ADD COLUMN IF NOT EXISTS revocation_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE deletion_jobs ADD COLUMN IF NOT EXISTS physical_cleanup_state text NOT NULL DEFAULT 'PENDING_DEVELOPMENT';
ALTER TABLE deletion_jobs ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE deletion_jobs DROP CONSTRAINT IF EXISTS deletion_jobs_scope_check;
ALTER TABLE deletion_jobs ADD CONSTRAINT deletion_jobs_scope_check
  CHECK (scope IN ('ACCOUNT', 'CONVERSATION', 'MESSAGE', 'MEMORY', 'MEDIA', 'RELATIONSHIP_ASSET'));
ALTER TABLE deletion_jobs DROP CONSTRAINT IF EXISTS deletion_jobs_state_check;
ALTER TABLE deletion_jobs ADD CONSTRAINT deletion_jobs_state_check
  CHECK (state IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'ONLINE_DISABLED'));

CREATE OR REPLACE FUNCTION app.enforce_memory_candidate_confirmation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IN ('CONFIRMED', 'CONFIRMED_EDITED') AND NEW.last_transition_actor <> 'USER' THEN
    RAISE EXCEPTION 'memory candidate confirmation requires a user action';
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (migration_id) VALUES ('003_m1_development_api.sql');
COMMIT;
