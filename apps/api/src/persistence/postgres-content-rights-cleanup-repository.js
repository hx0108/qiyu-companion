'use strict';

const DEFAULT_LEASE_SECONDS = 300;

// This repository is intentionally separate from the application store.  Its
// database login activates qiyu_content_cleanup; it cannot approve reviews or
// mutate user content, and it sees only enough metadata to delete private
// image objects for a revoked reference-image review.
class PostgresContentRightsCleanupRepository {
  constructor({ pool, leaseSeconds = DEFAULT_LEASE_SECONDS }) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 3600) throw new TypeError('leaseSeconds must be an integer between 60 and 3600');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
  }

  async claimNext() {
    const client = await this.pool.connect();
    try {
      await beginCleanupScope(client);
      const claimed = await client.query(`WITH next_job AS (
        SELECT cleanup_event_id
          FROM content_rights_cleanup_jobs
         WHERE (state = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP)
            OR (state = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP)
         ORDER BY next_attempt_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE content_rights_cleanup_jobs AS job
         SET state = 'PROCESSING',
             attempt_count = job.attempt_count + 1,
             last_attempt_at = CURRENT_TIMESTAMP,
             lease_expires_at = CURRENT_TIMESTAMP + ($1 * INTERVAL '1 second'),
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
        FROM next_job
       WHERE job.cleanup_event_id = next_job.cleanup_event_id
       RETURNING job.cleanup_event_id, job.event_id`, [this.leaseSeconds]);
      if (claimed.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }
      const job = claimed.rows[0];
      const assets = await client.query(`SELECT DISTINCT asset.asset_id, asset.object_key
        FROM outbox_events AS event
        JOIN media_assets AS asset ON (
          asset.rights_review_id = (event.payload_json->>'review_id')::uuid
          OR asset.job_id IN (
            SELECT job.job_id FROM media_jobs AS job
             WHERE job.reference_asset_id = (event.payload_json->>'subject_ref')::uuid
          )
        )
       WHERE event.event_id = $1
         AND asset.type IN ('REFERENCE_IMAGE', 'SCENE_IMAGE')
         AND asset.object_key IS NOT NULL
       ORDER BY asset.asset_id ASC`, [job.event_id]);
      await client.query('COMMIT');
      return { event_id: job.event_id, assets: assets.rows };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(eventId, receipt) {
    if (!isUuid(eventId)) throw new TypeError('Invalid cleanup event id');
    if (!receipt || typeof receipt !== 'object') throw new TypeError('Cleanup receipt is required');
    return this.withCleanupScope(async (client) => {
      const updated = await client.query(`UPDATE content_rights_cleanup_jobs
         SET state = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
             lease_expires_at = NULL, receipt_json = $2::jsonb,
             updated_at = CURRENT_TIMESTAMP
       WHERE event_id = $1 AND state = 'PROCESSING'
       RETURNING event_id`, [eventId, JSON.stringify(receipt)]);
      if (updated.rows.length !== 1) throw new Error('Cleanup job is not processing');
      // Do not set outbox_events.published_at here. Physical cleanup is only
      // one subscription; cache invalidation and audit delivery may have their
      // own consumers for the same immutable event.
    });
  }

  async fail(eventId, errorMessage) {
    if (!isUuid(eventId)) throw new TypeError('Invalid cleanup event id');
    if (typeof errorMessage !== 'string' || !errorMessage.trim() || errorMessage.length > 1000) throw new TypeError('Invalid cleanup error');
    return this.withCleanupScope(async (client) => {
      const updated = await client.query(`UPDATE content_rights_cleanup_jobs
         SET state = 'PENDING', lease_expires_at = NULL,
             next_attempt_at = CURRENT_TIMESTAMP + (LEAST(3600, power(2, LEAST(attempt_count, 12))) * INTERVAL '1 second'),
             last_error = $2, updated_at = CURRENT_TIMESTAMP
       WHERE event_id = $1 AND state = 'PROCESSING'
       RETURNING event_id`, [eventId, errorMessage]);
      if (updated.rows.length !== 1) throw new Error('Cleanup job is not processing');
    });
  }

  async withCleanupScope(work) {
    const client = await this.pool.connect();
    try {
      await beginCleanupScope(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function beginCleanupScope(client) {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE qiyu_content_cleanup');
}
async function rollbackQuietly(client) { try { await client.query('ROLLBACK'); } catch {} }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

module.exports = { DEFAULT_LEASE_SECONDS, PostgresContentRightsCleanupRepository };
