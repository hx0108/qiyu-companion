'use strict';

const { randomUUID } = require('node:crypto');
const { evaluateFollowupPublish } = require('../domain/followup-service');
const { composeFollowupText } = require('../domain/followup-composer');

// 六项能力 A2 跟进调度 PG repository（方案 §4.2）：内存 Worker（domain/
// followup-worker）的同语义 SQL 实现。恰一胜防线三层：claimDueBatch 用
// FOR UPDATE SKIP LOCKED（两连接领取不相交）；publish 用账户行 FOR UPDATE
// 串行化 + evaluateFollowupPublish 域决策（决策唯一写者，与内存共用）+
// 每日槽位 ON CONFLICT DO NOTHING；最终 LEASED→PUBLISHED 守卫 UPDATE 0 行
// 即 throw（事务整体回滚=迟到的输家零投递）。角色 qiyu_followup_worker
// BYPASSRLS（迁移 065），不降级。

const DEFAULT_LEASE_SECONDS = 300;
const MAX_FOLLOWUP_ATTEMPTS = 3;
const MEMORY_REFS_VERSION = 'memory-refs.v1';

class PostgresFollowupRepository {
  constructor({ pool, leaseSeconds = DEFAULT_LEASE_SECONDS }) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
  }

  // 领取到期批量：PENDING 已到期（due_at 与 next_attempt_at 都已到）或 LEASED
  // 租约过期（Worker 崩溃后的重启恢复）。附带事件标题与角色名供事务外措辞。
  async claimDueBatch({ workerId, limit = 50, now = new Date() } = {}) {
    return this.withWorkerScope(async (client) => {
      const claimed = await client.query(`WITH next_job AS (
        SELECT job_id FROM followup_jobs
         WHERE (state = 'PENDING' AND next_attempt_at <= $1::timestamptz AND due_at <= $1::timestamptz)
            OR (state = 'LEASED' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1::timestamptz)
         ORDER BY next_attempt_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE followup_jobs AS job
         SET state = 'LEASED', attempts = job.attempts + 1, lease_owner = $3,
             lease_expires_at = $1::timestamptz + ($4 * INTERVAL '1 second'), last_error = NULL
        FROM next_job WHERE job.job_id = next_job.job_id
      RETURNING job.job_id, job.account_id, job.character_id, job.event_id, job.event_version, job.grant_id,
        job.followup_kind, job.due_at, job.expires_at, job.local_date, job.attempts,
        (SELECT e.title FROM life_events e WHERE e.event_id = job.event_id AND e.account_id = job.account_id) AS event_title,
        (SELECT c.display_name FROM characters c WHERE c.character_id = job.character_id AND c.account_id = job.account_id) AS character_name`,
      [now.toISOString(), limit, workerId, this.leaseSeconds]);
      return claimed.rows.map(mapJobRow);
    });
  }

  // 发布事务（短事务）：账户行 FOR UPDATE → 重读事件/许可/账户/审计 →
  // evaluateFollowupPublish 决策 → DEFER/CANCEL/EXPIRE 终态化或 PUBLISH
  // （抢槽 → 三表插入 → 守卫置 PUBLISHED）。
  async publish(job, composed, { now = new Date() } = {}) {
    return this.withWorkerScope(async (client) => {
      const nowIso = now.toISOString();
      // 并发串行化不靠账户行锁（worker 角色最小授权无 UPDATE，FOR UPDATE 会
      // 被拒）——真正的闸门是每日槽位 ON CONFLICT 原子竞争：双 Worker 同投
      // 恰一胜，输家 EXPIRED。这里只读决策快照。
      const accountRows = await client.query(`SELECT a.account_id, a.account_status, a.age_status, a.retention_policy_id, a.proactive_preferences_json,
        c.user_pause_state, c.safety_mode,
        (SELECT state FROM required_notices n WHERE n.account_id = a.account_id AND n.deleted_at IS NULL ORDER BY n.due_at ASC LIMIT 1) AS notice_state
        FROM accounts a LEFT JOIN account_interaction_controls c ON c.account_id = a.account_id
       WHERE a.account_id = $1`, [job.account_id]);
      const accountRow = accountRows.rows[0] ?? null;
      const eventRows = await client.query(`SELECT version, deleted_at, title FROM life_events WHERE event_id = $1 AND account_id = $2`, [job.event_id, job.account_id]);
      const eventRow = eventRows.rows[0] ?? null;
      const grantRows = await client.query(`SELECT state FROM followup_grants WHERE grant_id = $1 AND account_id = $2`, [job.grant_id, job.account_id]);
      const grantRow = grantRows.rows[0] ?? null;
      const sentRows = await client.query(`SELECT sent_at FROM proactive_messages WHERE account_id = $1 AND kind = 'NORMAL'`, [job.account_id]);
      const decision = evaluateFollowupPublish({
        event: eventRow ? { version: Number(eventRow.version), deleted_at: eventRow.deleted_at ? dateTimeValue(eventRow.deleted_at) : null, title: eventRow.title } : null,
        grant: grantRow ? { state: grantRow.state } : null,
        job,
        account: accountRow ? {
          account_id: job.account_id, account_status: accountRow.account_status, age_status: accountRow.age_status,
          user_pause_state: accountRow.user_pause_state, safety_mode: accountRow.safety_mode,
          required_notice: { state: accountRow.notice_state ?? 'DUE' }
        } : null,
        preferences: parsePreferences(accountRow?.proactive_preferences_json),
        sentAt: sentRows.rows.map((row) => dateTimeValue(row.sent_at)),
        now
      });
      if (decision.action === 'DEFER') {
        await guardUpdate(client, job.job_id, `state = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = $2::timestamptz, last_error = $3`, [decision.defer_until ?? job.due_at, `deferred: ${decision.reason}`]);
        return { state: 'DEFERRED', job_id: job.job_id, reason: decision.reason, defer_until: decision.defer_until };
      }
      if (decision.action === 'CANCEL' || decision.action === 'EXPIRE') {
        const terminal = decision.action === 'EXPIRE' ? 'EXPIRED' : 'CANCELLED';
        await guardUpdate(client, job.job_id, `state = $2::text, lease_owner = NULL, lease_expires_at = NULL, last_error = $3`,
          [terminal, `${decision.action.toLowerCase()}: ${decision.reason}`]);
        return { state: terminal, job_id: job.job_id, reason: decision.reason };
      }
      // PUBLISH：每日一条槽位原子竞争（占用 → EXPIRED 不补发过时提醒）。
      const slot = await client.query(`INSERT INTO proactive_daily_slots (account_id, local_date, claimed_by)
        VALUES ($1, $2::date, $3) ON CONFLICT (account_id, local_date) DO NOTHING`, [job.account_id, job.local_date, job.job_id]);
      if (slot.rowCount !== 1) {
        await guardUpdate(client, job.job_id, `state = 'EXPIRED', lease_owner = NULL, lease_expires_at = NULL, last_error = 'expire: daily slot taken'`, []);
        return { state: 'EXPIRED', job_id: job.job_id, reason: 'DAILY_LIMIT_REACHED' };
      }
      const conversation = await ensureConversation(client, job, nowIso, retentionDays(accountRow?.retention_policy_id));
      const messageId = randomUUID();
      // provider 固定 proactive-followup（与内存 Worker 对齐，前端据此打「主动」
      // 角标）；模型来源记 model_version 与 operation_metrics，不进 provider。
      await client.query(`INSERT INTO messages (message_id, conversation_id, actor, content_ciphertext, created_at, retention_expires_at, provider, model_version, ai_generated, attachments)
        VALUES ($1, $2, 'ASSISTANT', convert_to($3, 'UTF8'), $4::timestamptz, $4::timestamptz + make_interval(days => $5), $6, $7, $8, '[]'::jsonb)`, [
        messageId, conversation.conversation_id, composed.text, nowIso, retentionDays(accountRow?.retention_policy_id),
        'proactive-followup', composed.model_version ?? 'followup-template-v1',
        composed.provider !== 'template' && composed.provider !== 'template-fallback'
      ]);
      await client.query(`INSERT INTO message_memory_refs (ref_id, message_id, account_id, character_id, conversation_id, refs_json, context_bundle_version, created_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)`, [
        randomUUID(), messageId, job.account_id, job.character_id, conversation.conversation_id,
        JSON.stringify({ refs: [{ kind: 'LIFE_EVENT', id: job.event_id, version: job.event_version }] }), MEMORY_REFS_VERSION, nowIso
      ]);
      await client.query(`INSERT INTO proactive_messages (message_id, account_id, character_id, event_id, kind, template_slot, text, sent_at)
        VALUES ($1, $2, $3, $4, 'NORMAL', $5, $6, $7::timestamptz)`, [
        randomUUID(), job.account_id, job.character_id, job.event_id, composed.template_slot, composed.text, nowIso
      ]);
      // 恰一胜终局：守卫 UPDATE 0 行（任务已被改期取消/另一 Worker 已发布）
      // → throw 回滚整个事务，消息与审计一并消失（零投递）。
      const published = await client.query(`UPDATE followup_jobs SET state = 'PUBLISHED', lease_owner = NULL,
        lease_expires_at = NULL, published_at = $2::timestamptz
        WHERE job_id = $1 AND state = 'LEASED'`, [job.job_id, nowIso]);
      if (published.rowCount !== 1) throw new Error(`followup job ${job.job_id} is not leased by this worker`);
      await client.query(`INSERT INTO operation_metrics (metric_id, account_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome)
        VALUES ($1, $2, 'FOLLOWUP_DISPATCH', $3, $4, 0, 0, 0, 'COMPLETED')`, [
        randomUUID(), job.account_id, safeMetricValue(composed.provider, 'unknown'), nullableMetricValue(composed.model_version)
      ]);
      return { state: 'PUBLISHED', job_id: job.job_id, message_id: messageId, conversation_id: conversation.conversation_id, provider: composed.provider };
    });
  }

  // 失败退避（照内存 failFollowupJob）：attempts 耗尽或超 expires → FAILED，
  // 否则 PENDING + 指数退避（≤600s）。任务不在 LEASED 时 throw（租约已易主）。
  async fail(jobId, errorMessage, { now = new Date() } = {}) {
    return this.withWorkerScope(async (client) => {
      // $1/$4 分开：PG 按首次引用统一推断参数类型，job_id(uuid) 与时刻
      // (timestamptz) 不能共用一个占位符。
      const updated = await client.query(`UPDATE followup_jobs
        SET state = CASE WHEN attempts >= $2 OR expires_at <= $1::timestamptz THEN 'FAILED' ELSE 'PENDING' END,
          lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = CASE WHEN attempts >= $2 OR expires_at <= $1::timestamptz THEN next_attempt_at
            ELSE $1::timestamptz + (LEAST(600, power(2, LEAST(attempts, 10))) * INTERVAL '1 second') END,
          last_error = $3
        WHERE job_id = $4 AND state = 'LEASED'
        RETURNING state`, [now.toISOString(), MAX_FOLLOWUP_ATTEMPTS, safeError(errorMessage), jobId]);
      if (!updated.rows.length) throw new Error(`followup job ${jobId} is not leased`);
      return { state: updated.rows[0].state, job_id: jobId };
    });
  }

  // 单任务三段式（内存 runNextFollowupJob 的 PG 对应物）：领取 1 条 → 事务外
  // 措辞（composer 为 null 时走模板回退）→ publish；发布异常走 fail 退避。
  async runNext({ composer = null, workerId = 'followup-worker', now = new Date() } = {}) {
    const [job] = await this.claimDueBatch({ workerId, limit: 1, now });
    if (!job) return { state: 'IDLE' };
    try {
      const composed = await composeFollowupText({
        event: { title: job.event_title ?? '你确认过的事', scheduled_at: null },
        character: job.character_name ? { name: job.character_name } : null,
        followupKind: job.followup_kind,
        model: composer,
        now
      });
      return await this.publish(job, composed, { now });
    } catch (error) {
      await this.fail(job.job_id, error, { now });
      return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
    }
  }

  async withWorkerScope(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE qiyu_followup_worker');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 连接已坏时回滚无效 */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function guardUpdate(client, jobId, setClause, params) {
  const updated = await client.query(`UPDATE followup_jobs SET ${setClause} WHERE job_id = $1 AND state = 'LEASED'`,
    [jobId, ...params]);
  if (updated.rowCount !== 1) throw new Error(`followup job ${jobId} is not leased by this worker`);
}

// 投递会话：最新非删除会话优先，无则新建（主动消息也要有落点）。
async function ensureConversation(client, job, nowIso, retentionDaysValue) {
  const existing = await client.query(`SELECT conversation_id FROM conversations
    WHERE account_id = $1 AND character_id = $2 AND status <> 'DELETED'
    ORDER BY created_at DESC, conversation_id DESC LIMIT 1`, [job.account_id, job.character_id]);
  if (existing.rows.length) return existing.rows[0];
  const conversationId = randomUUID();
  await client.query(`INSERT INTO conversations (conversation_id, account_id, character_id, status, created_at, retention_expires_at)
    VALUES ($1, $2, $3, 'ACTIVE', $4::timestamptz, $4::timestamptz + make_interval(days => $5))`,
  [conversationId, job.account_id, job.character_id, nowIso, retentionDaysValue]);
  return { conversation_id: conversationId };
}

function mapJobRow(row) {
  return {
    job_id: row.job_id, account_id: row.account_id, character_id: row.character_id,
    event_id: row.event_id, event_version: Number(row.event_version), grant_id: row.grant_id,
    followup_kind: row.followup_kind, due_at: dateTimeValue(row.due_at), expires_at: dateTimeValue(row.expires_at),
    local_date: databaseDate(row.local_date), attempts: Number(row.attempts),
    event_title: row.event_title ?? null, character_name: row.character_name ?? null
  };
}

// pg 会把 jsonb 自动解析为对象（字符串分支只覆盖显式 cast 的 ::text 读取），
// 两种形态都要接受——否则用户静默偏好在 PG 路径被静默忽略成默认值。
function parsePreferences(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

function retentionDays(policyId) { return policyId === 'RETENTION_30D' ? 30 : 90; }
function databaseDate(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return String(value).slice(0, 10);
}
function dateTimeValue(value) { return value instanceof Date ? value.toISOString() : String(value); }
function safeError(error) { return String(error?.message || 'followup dispatch failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }
function safeMetricValue(value, fallback) { const normalized = String(value || '').trim(); return normalized && normalized.length <= 80 ? normalized : fallback; }
function nullableMetricValue(value) { const normalized = String(value || '').trim(); return normalized && normalized.length <= 160 ? normalized : null; }

module.exports = { DEFAULT_LEASE_SECONDS, MAX_FOLLOWUP_ATTEMPTS, PostgresFollowupRepository };
