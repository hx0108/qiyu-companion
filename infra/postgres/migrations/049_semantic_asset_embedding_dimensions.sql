BEGIN;

-- P1-4 语义 Embedding：Qwen text-embedding（1024 维等）取代确定性 256 维开发
-- 嵌入。摘除 043 的固定 256 维 CHECK 与 HNSW 索引——pgvector 的 HNSW 索引
-- 要求固定维度，无法服务混合/可变维度列；封测量级（账户内数百条资产）用
-- 精确余弦扫描（ORDER BY embedding <=> query）足够，重建语义索引推迟到
-- 固定生产模型版本后再按该维度单列建回。
-- 跨版本向量不混算：查询路径按 embedding_model_version 过滤（见
-- postgres-store.rankActiveAssetsByVector），切换模型后须运行
-- scripts/rebuild-asset-embedding-index.js 以新版本全量重建。
ALTER TABLE relationship_asset_embeddings
  DROP CONSTRAINT IF EXISTS relationship_asset_embeddings_dimension_256;
DROP INDEX IF EXISTS relationship_asset_embeddings_active_cosine_256_idx;

INSERT INTO schema_migrations (migration_id) VALUES ('049_semantic_asset_embedding_dimensions.sql');
COMMIT;
