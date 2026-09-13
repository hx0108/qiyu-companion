'use strict';

// 向量模型版本迁移（沉淀方向三运维）：embedding 模型/维度变更（如
// deterministic-char-ngram-256-v1 → Qwen text-embedding-v4）后，把仍停留在
// 旧版本的已索引资产重置为 PENDING，由 Embedding Worker（run-workers.js）
// 以当前模型重建向量。旧版本向量按 model_version 隔离，不会被召回误用。
// 幂等：只触碰当前版本缺失的 READY 资产；重复执行安全。
// 用法：DATABASE_URL=... node scripts/reindex-asset-embeddings.js --confirm REINDEX

const { Client } = require('pg');
const { createQwenEmbeddingProvider } = require('../src/providers/qwen-adapter');
const { DEVELOPMENT_EMBEDDING_MODEL_VERSION } = require('../src/domain/asset-embedding-worker');

function currentModelVersion() {
  const provider = createQwenEmbeddingProvider(process.env);
  return provider ? provider.modelVersion : DEVELOPMENT_EMBEDDING_MODEL_VERSION;
}

function parseOptions(argv = process.argv.slice(2)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!argv.includes('--confirm') || argv[argv.indexOf('--confirm') + 1] !== 'REINDEX') {
    throw new Error('Refusing to reindex. Re-run with --confirm REINDEX.');
  }
  return { modelVersion: currentModelVersion() };
}

async function main() {
  const { modelVersion } = parseOptions();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `UPDATE relationship_assets asset SET index_state = 'PENDING'
       WHERE asset.index_state = 'READY' AND asset.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM relationship_asset_embeddings emb
           WHERE emb.asset_id = asset.asset_id AND emb.version = asset.version
             AND emb.embedding_model_version = $1)
       RETURNING asset.asset_id`, [modelVersion]);
    console.log(JSON.stringify({ operation: 'asset_embedding_reindex', model_version: modelVersion, assets_reset: result.rowCount }, null, 2));
  } finally { await client.end().catch(() => {}); }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`向量重索引失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { currentModelVersion };
