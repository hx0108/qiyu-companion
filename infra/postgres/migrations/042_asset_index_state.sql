BEGIN;

-- 资产索引状态持久化（技术设计 6.3.2：CANDIDATE 确认 → PENDING → READY）。
-- 041 之前确认的存量资产行标记为 PENDING，由向量 Worker 回填建索引。
ALTER TABLE relationship_assets ADD COLUMN IF NOT EXISTS index_state text NOT NULL DEFAULT 'PENDING'
  CHECK (index_state IN ('PENDING', 'READY'));

INSERT INTO schema_migrations (migration_id) VALUES ('042_asset_index_state.sql');

COMMIT;
