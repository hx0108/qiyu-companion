BEGIN;
ALTER TABLE memory_candidates ADD COLUMN rejected_at timestamptz;
ALTER TABLE memory_candidates ADD COLUMN rejection_undo_until timestamptz;
ALTER TABLE memory_candidates ADD CONSTRAINT memory_candidate_rejection_undo_pair CHECK ((rejected_at IS NULL) = (rejection_undo_until IS NULL));
ALTER TABLE memory_candidates ADD CONSTRAINT memory_candidate_rejection_undo_order CHECK (rejection_undo_until IS NULL OR rejection_undo_until > rejected_at);
INSERT INTO schema_migrations (migration_id) VALUES ('054_memory_rejection_undo.sql');
COMMIT;
