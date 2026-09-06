'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { PostgresAssetEmbeddingRepository } = require('../src/persistence/postgres-asset-embedding-repository');
const { deterministicEmbedding } = require('../src/domain/asset-embedding-worker');

function poolFor(handler) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const call = { sql: String(sql), values };
      calls.push(call);
      return handler(call);
    },
    release() { calls.push({ sql: 'RELEASE', values: [] }); }
  };
  return { calls, async connect() { return client; } };
}

test('embedding worker claims with SKIP LOCKED under its dedicated role and commits only the claimed active version', async () => {
  const job = {
    job_id: 'embjob-1', account_id: 'account-1', character_id: 'character-1', asset_id: 'asset-1',
    asset_version: 2, attempt_count: 1, display_text: '用户喜欢雨天', asset_state: 'ACTIVE', asset_version_current: 2
  };
  const pool = poolFor(({ sql }) => {
    if (sql.startsWith('WITH candidate')) return { rows: [job] };
    if (sql.startsWith('INSERT INTO relationship_asset_embeddings')) return { rows: [{ asset_id: job.asset_id }] };
    return { rows: [] };
  });
  const repository = new PostgresAssetEmbeddingRepository({ pool, leaseSeconds: 45 });

  const outcome = await repository.runOnce({ embeddingProvider: deterministicEmbedding, modelVersion: 'deterministic-char-ngram-256-v1' });

  assert.deepEqual(outcome, { state: 'COMPLETED', job_id: 'embjob-1', asset_id: 'asset-1', model_version: 'deterministic-char-ngram-256-v1' });
  assert.equal(pool.calls.filter((call) => call.sql === 'SET LOCAL ROLE qiyu_asset_embedding_worker').length, 2);
  const claim = pool.calls.find((call) => call.sql.startsWith('WITH candidate'));
  assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(claim.sql, /FROM candidate WHERE job\.job_id = candidate\.job_id/);
  assert.match(claim.sql, /SELECT asset\.display_text FROM relationship_assets AS asset/);
  assert.doesNotMatch(claim.sql, /ON asset\.asset_id = job\.asset_id/);
  assert.deepEqual(claim.values, [45]);
  const write = pool.calls.find((call) => call.sql.startsWith('INSERT INTO relationship_asset_embeddings'));
  assert.match(write.sql, /job\.lease_expires_at > CURRENT_TIMESTAMP/);
  assert.match(write.sql, /asset\.state = 'ACTIVE'/);
  assert.match(write.sql, /asset\.version = job\.asset_version/);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 2);
});

test('idle embedding worker cleans only vectors and jobs whose source asset is revoked or superseded', async () => {
  const pool = poolFor(() => ({ rows: [] }));
  const repository = new PostgresAssetEmbeddingRepository({ pool });
  const outcome = await repository.runOnce({ embeddingProvider: deterministicEmbedding, modelVersion: 'deterministic-char-ngram-256-v1' });

  assert.deepEqual(outcome, { state: 'IDLE' });
  const cleanup = pool.calls.find((call) => call.sql.startsWith('UPDATE asset_embedding_jobs AS job'));
  assert.match(cleanup.sql, /job\.state = 'PENDING'/);
  assert.match(cleanup.sql, /asset\.state <> 'ACTIVE'/);
  const deleteVectors = pool.calls.find((call) => call.sql.startsWith('DELETE FROM relationship_asset_embeddings'));
  assert.match(deleteVectors.sql, /asset\.version <> embedding\.version/);
});

test('embedding worker migration forces RLS and removes API mutation grants', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/043_asset_embedding_worker_boundary.sql'), 'utf8');
  assert.match(migration, /CREATE ROLE qiyu_asset_embedding_worker NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(migration, /ALTER TABLE asset_embedding_jobs FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /USING hnsw \(\(embedding::vector\(256\)\) vector_cosine_ops\)/);
  assert.match(migration, /REVOKE ALL ON asset_embedding_jobs, asset_embedding_dead_letters FROM qiyu_app/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON relationship_asset_embeddings FROM qiyu_app/);
  assert.match(migration, /GRANT SELECT, INSERT ON asset_embedding_jobs TO qiyu_app/);
  assert.match(migration, /GRANT SELECT, UPDATE ON asset_embedding_jobs TO qiyu_asset_embedding_worker/);
});

test('derived index-state progress does not create a new relationship-memory version', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/044_asset_index_state_version_boundary.sql'), 'utf8');
  assert.match(migration, /CREATE OR REPLACE FUNCTION app\.touch_relationship_asset_row\(\)/);
  assert.match(migration, /NEW\.version := OLD\.version;/);
  assert.match(migration, /DROP TRIGGER IF EXISTS relationship_assets_touch_version/);
  assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM relationship_asset_embeddings/);
});
