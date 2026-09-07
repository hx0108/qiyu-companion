'use strict';

// 资产向量索引重建（P1-4）：embedding 模型版本切换后，旧版本向量与新查询
// 向量空间不可比（召回按 embedding_model_version 过滤，旧向量不再参与语义
// 排序，只回退词法）。本脚本把所有仍 ACTIVE 但缺少当前版本向量的资产重新
// 入队，随后由 run-workers.js 的向量队列以新 model_version 全量重建。
//
// 用法（worker 角色连接，与 run-workers 同一环境）：
//   DATABASE_URL=... QIYU_LLM_PROVIDER=qwen QWEN_API_KEY=... \
//   node scripts/rebuild-asset-embedding-index.js [--dry-run]
// 幂等：已持有当前版本向量的资产不会被重复入队。

const pg = require('pg');
const { createQwenEmbeddingProvider } = require('../src/providers/qwen-adapter');
const { DEVELOPMENT_EMBEDDING_MODEL_VERSION } = require('../src/domain/asset-embedding-worker');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const embeddingProvider = createQwenEmbeddingProvider(process.env) || null;
  const modelVersion = embeddingProvider ? embeddingProvider.modelVersion : DEVELOPMENT_EMBEDDING_MODEL_VERSION;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const stale = await pool.query(`
      SELECT asset.asset_id, asset.account_id, asset.character_id, asset.version,
        COALESCE(embedding.embedding_model_version, '<无向量>') AS stored_model_version
      FROM relationship_assets asset
      LEFT JOIN relationship_asset_embeddings embedding
        ON embedding.asset_id = asset.asset_id AND embedding.version = asset.version AND embedding.deleted_at IS NULL
      WHERE asset.state = 'ACTIVE' AND asset.deleted_at IS NULL
        AND (embedding.asset_id IS NULL OR embedding.embedding_model_version <> $1)`,
      [modelVersion]);
    console.log(`目标 model_version：${modelVersion}；需重建资产：${stale.rows.length} 条。`);
    if (dryRun || stale.rows.length === 0) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE qiyu_asset_embedding_worker');
      for (const row of stale.rows) {
        const enqueued = await client.query(`
          INSERT INTO asset_embedding_jobs (account_id, character_id, asset_id, asset_version, state, next_attempt_at)
          SELECT $1, $2, $3, $4, 'PENDING', CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
            SELECT 1 FROM asset_embedding_jobs job
            WHERE job.asset_id = $3 AND job.asset_version = $4 AND job.state IN ('PENDING', 'PROCESSING'))`,
          [row.account_id, row.character_id, row.asset_id, row.version]);
        if (enqueued.rowCount === 1) {
          // 入队即视为待重算；在线召回对 PENDING 资产自动回退词法，不丢失召回。
          await client.query(`UPDATE relationship_assets SET index_state = 'PENDING' WHERE asset_id = $1 AND version = $2`, [row.asset_id, row.version]);
        }
      }
      await client.query('COMMIT');
      console.log(`已重新入队并置为 PENDING；由 run-workers 的向量队列完成重建（原存储版本：${[...new Set(stale.rows.map((row) => row.stored_model_version))].join('、')}）。`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => { console.error('重建入队失败：', error.message); process.exit(1); });
