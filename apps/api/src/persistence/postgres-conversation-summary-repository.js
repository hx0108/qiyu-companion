'use strict';

const { randomUUID } = require('node:crypto');
const { createSummary, validSummary } = require('../domain/conversation-summary');

const DEFAULT_LEASE_SECONDS = 300;

class PostgresConversationSummaryRepository {
  constructor({ pool, leaseSeconds = DEFAULT_LEASE_SECONDS }) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 3600) throw new TypeError('leaseSeconds must be an integer between 60 and 3600');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
  }

  async claimNext() {
    return this.withWorkerScope(async (client) => {
      const claimed = await client.query(`WITH next_job AS (
        SELECT job_id FROM conversation_summary_jobs
         WHERE exhausted_at IS NULL AND ((state = 'PENDING' AND next_attempt_at <= CURRENT_TIMESTAMP)
            OR (state = 'PROCESSING' AND lease_expires_at <= CURRENT_TIMESTAMP)
         )
         ORDER BY next_attempt_at ASC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE conversation_summary_jobs AS job
           SET state = 'PROCESSING', attempt_count = job.attempt_count + 1,
               last_attempt_at = CURRENT_TIMESTAMP, lease_expires_at = CURRENT_TIMESTAMP + ($1 * INTERVAL '1 second'), last_error = NULL
          FROM next_job WHERE job.job_id = next_job.job_id
      RETURNING job_id, account_id, conversation_id, source_to_id, captured_revocation_epoch`, [this.leaseSeconds]);
      if (!claimed.rows.length) return null;
      const job = claimed.rows[0];
      const source = await sourceMessages(client, job.conversation_id, job.source_to_id);
      const summaries = await client.query(`SELECT summary_id, account_id, conversation_id, source_from_id, source_to_id, convert_from(summary_ciphertext, 'UTF8') AS text,
        model_route_id, prompt_version, source_checksum, revocation_epoch, state, created_at, invalidated_at, retention_expires_at
        FROM conversation_summaries WHERE conversation_id = $1 AND state = 'ACTIVE'`, [job.conversation_id]);
      const previous = validSummary(summaries.rows.map(mapSummary), source, job.conversation_id, Number(job.captured_revocation_epoch));
      const pending = previous ? source.slice(source.findIndex((message) => message.message_id === previous.source_to_id) + 1) : source;
      return { ...job, previous_summary: previous, pending_messages: pending.map(({ message_id, actor, text }) => ({ message_id, actor, text })) };
    });
  }

  async complete(job, generated, latencyMs = 0) {
    return this.withWorkerScope(async (client) => {
      const guard = await client.query(`SELECT a.account_status, a.revocation_epoch, c.status
        FROM accounts a JOIN conversations c ON c.account_id = a.account_id
       WHERE a.account_id = $1 AND c.conversation_id = $2 FOR UPDATE`, [job.account_id, job.conversation_id]);
      const current = guard.rows[0];
      const source = await sourceMessages(client, job.conversation_id, job.source_to_id);
      if (!current || current.account_status !== 'OPEN' || current.status === 'DELETED' || Number(current.revocation_epoch) !== Number(job.captured_revocation_epoch) || !source.length || source.at(-1).message_id !== job.source_to_id) {
        await client.query(`UPDATE conversation_summary_jobs SET state = 'CANCELLED', completed_at = CURRENT_TIMESTAMP,
          lease_expires_at = NULL, last_error = 'source revoked before summary commit' WHERE job_id = $1 AND state = 'PROCESSING'`, [job.job_id]);
        return { state: 'CANCELLED' };
      }
      const expiry = source.map((message) => message.retention_expires_at).filter(Boolean).sort()[0];
      const summary = createSummary({ summaryId: randomUUID(), accountId: job.account_id, conversationId: job.conversation_id, messages: source,
        revocationEpoch: Number(job.captured_revocation_epoch), text: generated.text, modelRouteId: generated.modelVersion,
        promptVersion: generated.promptVersion || 'conversation-summary.v1', retentionExpiresAt: expiry, createdAt: new Date().toISOString() });
      await client.query(`UPDATE conversation_summaries SET state = 'SUPERSEDED'
        WHERE account_id = $1 AND conversation_id = $2 AND state = 'ACTIVE'`, [job.account_id, job.conversation_id]);
      await client.query(`INSERT INTO conversation_summaries (summary_id, account_id, conversation_id, source_from_id, source_to_id, summary_ciphertext, model_route_id, prompt_version, source_checksum, revocation_epoch, state, created_at, retention_expires_at)
        VALUES ($1, $2, $3, $4, $5, convert_to($6, 'UTF8'), $7, $8, $9, $10, 'ACTIVE', $11::timestamptz, $12::timestamptz)`, [summary.summary_id, summary.account_id, summary.conversation_id, summary.source_from_id, summary.source_to_id, summary.text, summary.model_route_id, summary.prompt_version, summary.source_checksum, summary.revocation_epoch, summary.created_at, summary.retention_expires_at]);
      await client.query(`UPDATE conversation_summary_jobs SET state = 'COMPLETED', completed_at = CURRENT_TIMESTAMP, lease_expires_at = NULL
        WHERE job_id = $1 AND state = 'PROCESSING'`, [job.job_id]);
      await persistSummaryOperationMetric(client, { job, generated, latencyMs, outcome: 'COMPLETED' });
      return { state: 'COMPLETED', summary_id: summary.summary_id };
    });
  }

  async fail(jobId, errorMessage, latencyMs = 0) {
    return this.withWorkerScope(async (client) => {
      const updated = await client.query(`UPDATE conversation_summary_jobs SET state = 'PENDING', lease_expires_at = NULL,
        next_attempt_at = CASE WHEN attempt_count >= 8 THEN CURRENT_TIMESTAMP ELSE CURRENT_TIMESTAMP + (LEAST(3600, power(2, LEAST(attempt_count, 12))) * INTERVAL '1 second') END,
        exhausted_at = CASE WHEN attempt_count >= 8 THEN CURRENT_TIMESTAMP ELSE NULL END, last_error = $2
        WHERE job_id = $1 AND state = 'PROCESSING'
        RETURNING job_id, account_id, conversation_id, source_to_id, attempt_count, exhausted_at`, [jobId, errorMessage]);
      if (!updated.rows.length) throw new Error('Conversation summary job is not processing');
      const job = updated.rows[0];
      if (job.exhausted_at) await client.query(`INSERT INTO conversation_summary_dead_letters (job_id, account_id, conversation_id, source_to_id, attempt_count, error_code)
        VALUES ($1, $2, $3, $4, $5, 'SUMMARY_GENERATION_FAILED') ON CONFLICT (job_id) DO NOTHING`, [job.job_id, job.account_id, job.conversation_id, job.source_to_id, job.attempt_count]);
      await persistSummaryOperationMetric(client, { job, latencyMs, outcome: 'FAILED' });
    });
  }

  async withWorkerScope(work) { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query('SET LOCAL ROLE qiyu_conversation_summary_worker'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); } }
}

async function sourceMessages(client, conversationId, sourceToId) {
  const result = await client.query(`SELECT m.message_id, m.conversation_id, m.actor, convert_from(m.content_ciphertext, 'UTF8') AS text, m.created_at, m.retention_expires_at
    FROM messages m JOIN messages boundary ON boundary.message_id = $2 AND boundary.conversation_id = $1
   WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
     AND (m.created_at, m.message_id) <= (boundary.created_at, boundary.message_id)
   ORDER BY m.created_at ASC, m.message_id ASC`, [conversationId, sourceToId]);
  return result.rows.map((row) => ({ ...row, created_at: value(row.created_at), retention_expires_at: value(row.retention_expires_at) }));
}
function mapSummary(row) { return { ...row, revocation_epoch: Number(row.revocation_epoch), created_at: value(row.created_at), invalidated_at: row.invalidated_at ? value(row.invalidated_at) : null, retention_expires_at: value(row.retention_expires_at) }; }
function value(input) { return input instanceof Date ? input.toISOString() : String(input); }
async function persistSummaryOperationMetric(client, { job, generated = null, latencyMs = 0, outcome }) {
  const usage = generated?.usage || {};
  await client.query(`INSERT INTO operation_metrics (metric_id, account_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome)
    VALUES ($1, $2, 'CONVERSATION_SUMMARY_GENERATION', $3, $4, $5, $6, $7, $8)`, [
    randomUUID(), job.account_id, safeMetricValue(generated?.provider, 'unknown'), nullableMetricValue(generated?.modelVersion),
    usageNumber(usage.input_tokens ?? usage.prompt_tokens), usageNumber(usage.output_tokens ?? usage.completion_tokens), usageNumber(latencyMs), outcome
  ]);
}
function safeMetricValue(value, fallback) { const normalized = String(value || '').trim(); return normalized && normalized.length <= 80 ? normalized : fallback; }
function nullableMetricValue(value) { const normalized = String(value || '').trim(); return normalized && normalized.length <= 160 ? normalized : null; }
function usageNumber(value) { return Math.max(0, Number(value) || 0); }
module.exports = { DEFAULT_LEASE_SECONDS, PostgresConversationSummaryRepository };
