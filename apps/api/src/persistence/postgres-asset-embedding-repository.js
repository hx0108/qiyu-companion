'use strict';

const { EMBEDDING_DIMENSIONS, MAX_EMBEDDING_JOB_ATTEMPTS } = require('../domain/asset-embedding-worker');

// The API may enqueue work but never claims, retries, mutates or physically
// removes vectors. This repository is the only PostgreSQL consumer that does.
class PostgresAssetEmbeddingRepository {
  constructor({ pool, leaseSeconds = 60 } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
    this.leaseSeconds = Number.isInteger(leaseSeconds) && leaseSeconds >= 10 && leaseSeconds <= 600 ? leaseSeconds : 60;
  }

  async runOnce({ embeddingProvider, modelVersion, expectedDimensions = EMBEDDING_DIMENSIONS } = {}) {
    if (typeof embeddingProvider !== 'function' || !nonBlank(modelVersion)) return { state: 'DISABLED' };
    const job = await this.claimNext();
    if (!job) {
      await this.cleanupRevoked();
      return { state: 'IDLE' };
    }
    if (job.asset_state !== 'ACTIVE' || Number(job.asset_version_current) !== Number(job.asset_version)) {
      await this.cancel(job.job_id, 'asset was deleted, superseded, or changed before embedding');
      return { state: 'CANCELLED', job_id: job.job_id };
    }
    try {
      const embedding = await embeddingProvider(job.display_text);
      assertEmbedding(embedding, expectedDimensions);
      const completed = await this.complete(job, embedding, modelVersion);
      return completed
        ? { state: 'COMPLETED', job_id: job.job_id, asset_id: job.asset_id, model_version: modelVersion }
        : { state: 'CANCELLED', job_id: job.job_id };
    } catch (error) {
      return this.fail(job, safeError(error));
    }
  }

  async claimNext() {
    return this.transaction(async (client) => {
      const result = await client.query(
        'WITH candidate AS (' +
        ' SELECT job_id FROM asset_embedding_jobs' +
        ' WHERE exhausted_at IS NULL' +
        " AND ((state = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP)" +
        " OR (state = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP))" +
        ' ORDER BY next_attempt_at ASC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1' +
        ')' +
        ' UPDATE asset_embedding_jobs AS job' +
        " SET state = 'PROCESSING', attempt_count = job.attempt_count + 1," +
        " last_attempt_at = CURRENT_TIMESTAMP, lease_expires_at = CURRENT_TIMESTAMP + ($1 * INTERVAL '1 second'), last_error = NULL" +
        ' FROM candidate' +
        ' WHERE job.job_id = candidate.job_id' +
        ' RETURNING job.job_id, job.account_id, job.character_id, job.asset_id, job.asset_version, job.attempt_count,' +
        ' (SELECT asset.display_text FROM relationship_assets AS asset WHERE asset.asset_id = job.asset_id) AS display_text,' +
        ' (SELECT asset.state FROM relationship_assets AS asset WHERE asset.asset_id = job.asset_id) AS asset_state,' +
        ' (SELECT asset.version FROM relationship_assets AS asset WHERE asset.asset_id = job.asset_id) AS asset_version_current',
        [this.leaseSeconds]
      );
      return result.rows[0] || null;
    });
  }

  async complete(job, embedding, modelVersion) {
    const vector = vectorLiteral(embedding);
    return this.transaction(async (client) => {
      const written = await client.query(
        'INSERT INTO relationship_asset_embeddings (asset_id, account_id, character_id, embedding, embedding_model_version, created_at, updated_at, version)' +
        " SELECT asset.asset_id, asset.account_id, asset.character_id, $2::vector, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, asset.version" +
        ' FROM asset_embedding_jobs AS job JOIN relationship_assets AS asset ON asset.asset_id = job.asset_id' +
        " WHERE job.job_id = $1 AND job.state = 'PROCESSING' AND job.lease_expires_at > CURRENT_TIMESTAMP" +
        " AND asset.state = 'ACTIVE' AND asset.deleted_at IS NULL AND asset.version = job.asset_version" +
        ' ON CONFLICT (asset_id) DO UPDATE SET embedding = EXCLUDED.embedding,' +
        ' embedding_model_version = EXCLUDED.embedding_model_version, updated_at = CURRENT_TIMESTAMP, version = EXCLUDED.version' +
        ' RETURNING asset_id',
        [job.job_id, vector, modelVersion]
      );
      if (written.rows.length !== 1) {
        await client.query(
          "UPDATE asset_embedding_jobs SET state = 'CANCELLED', completed_at = CURRENT_TIMESTAMP, lease_expires_at = NULL," +
          " last_error = 'asset was revoked before embedding commit' WHERE job_id = $1 AND state = 'PROCESSING'",
          [job.job_id]
        );
        await client.query('DELETE FROM relationship_asset_embeddings WHERE asset_id = $1 AND account_id = $2', [job.asset_id, job.account_id]);
        return false;
      }
      await client.query(
        "UPDATE relationship_assets SET index_state = 'READY'" +
        " WHERE asset_id = $1 AND account_id = $2 AND character_id = $3 AND state = 'ACTIVE' AND version = $4",
        [job.asset_id, job.account_id, job.character_id, job.asset_version]
      );
      await client.query(
        "UPDATE asset_embedding_jobs SET state = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, lease_expires_at = NULL" +
        " WHERE job_id = $1 AND state = 'PROCESSING'",
        [job.job_id]
      );
      return true;
    });
  }

  async fail(job, errorMessage) {
    return this.transaction(async (client) => {
      const found = await client.query(
        "SELECT job_id, account_id, asset_id, attempt_count FROM asset_embedding_jobs" +
        " WHERE job_id = $1 AND state = 'PROCESSING' FOR UPDATE",
        [job.job_id]
      );
      const current = found.rows[0];
      if (!current) return { state: 'CANCELLED', job_id: job.job_id };
      if (Number(current.attempt_count) >= MAX_EMBEDDING_JOB_ATTEMPTS) {
        await client.query(
          "UPDATE asset_embedding_jobs SET state = 'PENDING', exhausted_at = CURRENT_TIMESTAMP, next_attempt_at = CURRENT_TIMESTAMP," +
          ' lease_expires_at = NULL, last_error = $2 WHERE job_id = $1',
          [job.job_id, errorMessage]
        );
        await client.query(
          "INSERT INTO asset_embedding_dead_letters (job_id, account_id, asset_id, attempt_count, error_code, state)" +
          " VALUES ($1, $2, $3, $4, 'ASSET_EMBEDDING_FAILED', 'OPEN') ON CONFLICT (job_id) DO NOTHING",
          [job.job_id, current.account_id, current.asset_id, current.attempt_count]
        );
        return { state: 'DLQ', job_id: job.job_id };
      }
      await client.query(
        "UPDATE asset_embedding_jobs SET state = 'PENDING', lease_expires_at = NULL," +
        " next_attempt_at = CURRENT_TIMESTAMP + (LEAST(600, power(2, attempt_count)::integer) * INTERVAL '1 second')," +
        ' last_error = $2 WHERE job_id = $1',
        [job.job_id, errorMessage]
      );
      return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
    });
  }

  async cancel(jobId, errorMessage) {
    return this.transaction((client) => client.query(
      "UPDATE asset_embedding_jobs SET state = 'CANCELLED', completed_at = CURRENT_TIMESTAMP," +
      " lease_expires_at = NULL, last_error = $2 WHERE job_id = $1 AND state = 'PROCESSING'",
      [jobId, errorMessage]
    ));
  }

  async cleanupRevoked() {
    return this.transaction(async (client) => {
      const jobs = await client.query(
        "UPDATE asset_embedding_jobs AS job SET state = 'CANCELLED', completed_at = CURRENT_TIMESTAMP," +
        " lease_expires_at = NULL, last_error = 'asset was revoked before embedding could run'" +
        " FROM relationship_assets AS asset WHERE job.asset_id = asset.asset_id AND job.state = 'PENDING'" +
        " AND (asset.state <> 'ACTIVE' OR asset.deleted_at IS NOT NULL OR asset.version <> job.asset_version)" +
        ' RETURNING job.job_id'
      );
      const vectors = await client.query(
        'DELETE FROM relationship_asset_embeddings AS embedding USING relationship_assets AS asset' +
        ' WHERE embedding.asset_id = asset.asset_id' +
        " AND (asset.state <> 'ACTIVE' OR asset.deleted_at IS NOT NULL OR asset.version <> embedding.version)" +
        ' RETURNING embedding.asset_id'
      );
      return { jobs_cancelled: jobs.rows.length, vectors_removed: vectors.rows.length };
    });
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE qiyu_asset_embedding_worker');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

function assertEmbedding(value, expectedDimensions = EMBEDDING_DIMENSIONS) {
  if (!Array.isArray(value) || value.length !== expectedDimensions || value.some((item) => !Number.isFinite(item))) {
    throw new TypeError('embedding provider returned an invalid vector');
  }
}
function vectorLiteral(vector) { return '[' + vector.join(',') + ']'; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function safeError(error) { return String(error?.message || 'asset embedding worker failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }

module.exports = { PostgresAssetEmbeddingRepository };
