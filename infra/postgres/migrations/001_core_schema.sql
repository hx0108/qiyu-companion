BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts (
  account_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_status text NOT NULL DEFAULT 'OPEN'
    CHECK (account_status IN ('OPEN', 'SUSPENDED', 'CLOSING', 'CLOSED')),
  phone_hash bytea UNIQUE,
  retention_policy_id text NOT NULL DEFAULT 'RETENTION_30D'
    CHECK (retention_policy_id IN ('RETENTION_30D', 'RETENTION_90D')),
  revocation_epoch bigint NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz
);

-- This table stores only the minimum decision assertion and an opaque
-- verification transaction reference. It intentionally has no document image,
-- face template, biometric sample, date-of-birth, or provider evidence payload.
CREATE TABLE age_decisions (
  age_decision_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  age_status text NOT NULL DEFAULT 'AGE_UNVERIFIED'
    CHECK (age_status IN ('AGE_UNVERIFIED', 'AGE_PASS', 'AGE_REVIEW', 'AGE_DENIED_MINOR')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  method text NOT NULL CHECK (method IN ('SELF_ASSERTION', 'VERIFICATION_TRANSACTION', 'MANUAL_REVIEW')),
  decision_assertion text NOT NULL CHECK (length(decision_assertion) BETWEEN 1 AND 160),
  transaction_id text UNIQUE,
  policy_version text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > decided_at)
);
CREATE UNIQUE INDEX one_current_age_decision_per_account_idx
  ON age_decisions (account_id) WHERE is_current AND deleted_at IS NULL;
CREATE INDEX age_decisions_account_status_idx
  ON age_decisions (account_id, age_status, decided_at DESC) WHERE deleted_at IS NULL;
COMMENT ON TABLE age_decisions IS
  'Minimal age-decision facts only; verification documents, face templates, biometrics, DOB, and provider payloads are prohibited.';

CREATE TABLE account_interaction_controls (
  account_id uuid PRIMARY KEY REFERENCES accounts(account_id),
  user_pause_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (user_pause_state IN ('ACTIVE', 'USER_PAUSED')),
  safety_mode text NOT NULL DEFAULT 'R0_NORMAL'
    CHECK (safety_mode IN ('R0_NORMAL', 'R1_SUPPORT', 'R2_CRISIS')),
  service_mode text NOT NULL DEFAULT 'FULL'
    CHECK (service_mode IN ('FULL', 'TEXT_DEGRADED', 'SAFETY_ONLY', 'DATA_RIGHTS_ONLY')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz
);

CREATE TABLE required_notices (
  notice_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  type text NOT NULL CHECK (type IN ('AI_IDENTITY', 'DURATION_REMINDER', 'PRIVACY', 'AGE_GATE', 'PAYMENT')),
  notice_version text NOT NULL,
  due_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at timestamptz,
  displayed_at timestamptz,
  delivery_channel text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'DELIVERED', 'DISPLAYED', 'DISMISSED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (account_id, type, notice_version)
);
CREATE INDEX required_notices_account_due_idx ON required_notices (account_id, due_at) WHERE deleted_at IS NULL;

CREATE TABLE characters (
  character_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_kind text NOT NULL DEFAULT 'CORE' CHECK (character_kind IN ('CORE')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED', 'DELETED')),
  active_persona_version_id uuid,
  reference_asset_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (character_id, account_id)
);
CREATE UNIQUE INDEX one_active_core_character_per_account_idx
  ON characters (account_id)
  WHERE character_kind = 'CORE' AND status = 'ACTIVE' AND deleted_at IS NULL;
CREATE INDEX characters_account_status_idx ON characters (account_id, status) WHERE deleted_at IS NULL;

CREATE TABLE conversations (
  conversation_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL,
  character_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED', 'DELETED')),
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
CREATE INDEX conversations_account_character_created_idx
  ON conversations (account_id, character_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE messages (
  message_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  conversation_id uuid NOT NULL REFERENCES conversations(conversation_id),
  actor text NOT NULL CHECK (actor IN ('USER', 'ASSISTANT', 'SYSTEM')),
  content_ciphertext bytea NOT NULL,
  content_type text NOT NULL DEFAULT 'TEXT' CHECK (content_type IN ('TEXT', 'IMAGE', 'AUDIO', 'SYSTEM')),
  safety_level text NOT NULL DEFAULT 'R0' CHECK (safety_level IN ('R0', 'R1', 'R2')),
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz
);
CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE memory_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL,
  character_id uuid NOT NULL,
  type text NOT NULL,
  normalized_value text NOT NULL,
  display_text text NOT NULL,
  evidence_message_ids uuid[] NOT NULL DEFAULT '{}',
  sensitivity text NOT NULL DEFAULT 'NORMAL' CHECK (sensitivity IN ('NORMAL', 'SENSITIVE', 'HIGH_RISK')),
  state text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'DELETED')),
  last_transition_actor text NOT NULL DEFAULT 'SYSTEM' CHECK (last_transition_actor IN ('USER', 'SYSTEM', 'MODEL', 'ADMIN')),
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (candidate_id, account_id, character_id),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
CREATE INDEX memory_candidates_account_character_state_idx
  ON memory_candidates (account_id, character_id, state, expires_at) WHERE deleted_at IS NULL;

CREATE TABLE relationship_assets (
  asset_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL,
  character_id uuid NOT NULL,
  type text NOT NULL,
  value_json jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'ACTIVE', 'SUPERSEDED', 'DELETED')),
  source_candidate_id uuid,
  provenance_ids uuid[] NOT NULL DEFAULT '{}',
  activation_actor text NOT NULL DEFAULT 'SYSTEM' CHECK (activation_actor IN ('USER', 'SYSTEM', 'MODEL', 'ADMIN')),
  valid_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until timestamptz,
  superseded_by uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  CHECK (state <> 'ACTIVE' OR activation_actor = 'USER'),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id),
  FOREIGN KEY (source_candidate_id, account_id, character_id)
    REFERENCES memory_candidates(candidate_id, account_id, character_id),
  FOREIGN KEY (superseded_by) REFERENCES relationship_assets(asset_id),
  UNIQUE (asset_id, account_id, character_id)
);
CREATE INDEX relationship_assets_active_recall_idx
  ON relationship_assets (account_id, character_id, valid_from DESC)
  WHERE state = 'ACTIVE' AND deleted_at IS NULL;

CREATE TABLE relationship_asset_embeddings (
  asset_id uuid PRIMARY KEY REFERENCES relationship_assets(asset_id),
  account_id uuid NOT NULL,
  character_id uuid NOT NULL,
  embedding vector,
  embedding_model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (asset_id, account_id, character_id)
    REFERENCES relationship_assets(asset_id, account_id, character_id)
);
CREATE INDEX relationship_asset_embeddings_scope_idx
  ON relationship_asset_embeddings (account_id, character_id, asset_id) WHERE deleted_at IS NULL;

CREATE TABLE deletion_jobs (
  deletion_job_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  scope text NOT NULL CHECK (scope IN ('ACCOUNT', 'CONVERSATION', 'MESSAGE', 'MEMORY', 'MEDIA')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED')),
  online_disabled_at timestamptz,
  backup_deadline timestamptz,
  receipt_version text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (deletion_job_id, account_id)
);
CREATE INDEX deletion_jobs_account_state_idx ON deletion_jobs (account_id, state, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE deletion_targets (
  deletion_target_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  deletion_job_id uuid NOT NULL,
  account_id uuid NOT NULL,
  target_type text NOT NULL,
  target_ref text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_receipt text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (deletion_job_id, account_id) REFERENCES deletion_jobs(deletion_job_id, account_id),
  UNIQUE (deletion_job_id, target_type, target_ref)
);
CREATE INDEX deletion_targets_account_job_state_idx ON deletion_targets (account_id, deletion_job_id, state) WHERE deleted_at IS NULL;

CREATE TABLE idempotency_keys (
  idempotency_key_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  request_method text NOT NULL,
  request_path text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash bytea NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (account_id, request_method, request_path, idempotency_key)
);
CREATE INDEX idempotency_keys_account_created_idx ON idempotency_keys (account_id, created_at DESC);

CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  character_id uuid,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL AND deleted_at IS NULL;
CREATE INDEX outbox_events_account_character_idx ON outbox_events (account_id, character_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE audit_events (
  audit_event_id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  account_id uuid,
  character_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM', 'ADMIN', 'PROVIDER')),
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  FOREIGN KEY (character_id, account_id) REFERENCES characters(character_id, account_id)
);
CREATE INDEX audit_events_account_character_occurred_idx ON audit_events (account_id, character_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION app.touch_versioned_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_memory_candidate_confirmation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = 'CONFIRMED' AND NEW.last_transition_actor <> 'USER' THEN
    RAISE EXCEPTION 'memory candidate confirmation requires a user action';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.protect_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.character_id IS DISTINCT FROM OLD.character_id
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'outbox event payload is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.prevent_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only';
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'account_interaction_controls', 'required_notices', 'characters',
    'age_decisions', 'conversations', 'messages', 'memory_candidates', 'relationship_assets',
    'relationship_asset_embeddings', 'deletion_jobs', 'deletion_targets',
    'idempotency_keys', 'outbox_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_versioned_row()',
      table_name || '_touch_version', table_name);
  END LOOP;
END;
$$;

CREATE TRIGGER memory_candidates_user_confirmation
  BEFORE INSERT OR UPDATE ON memory_candidates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_memory_candidate_confirmation();
CREATE TRIGGER outbox_events_immutable
  BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION app.protect_outbox_event();
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION app.prevent_audit_mutation();

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO qiyu_app;
REVOKE DELETE ON audit_events FROM qiyu_app;
REVOKE ALL ON schema_migrations FROM qiyu_app;

INSERT INTO schema_migrations (migration_id) VALUES ('001_core_schema.sql');

COMMIT;
