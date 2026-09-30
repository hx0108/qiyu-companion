'use strict';

const { recordOperationMetric } = require('./operation-metrics');
const { validateLifeEventCandidateOutput } = require('./life-event-schema');
const { lifeEventDisplayText } = require('./life-event-service');

// 生活事件提取 Worker（六项能力 A1，方案 §4.1）：用户消息落库后入队，由独立
// Worker 完成第二次模型调用与候选写入——聊天主链路只记确定性任务，提取失败
// 不阻塞对话（三通道同语义）。结构克隆 conversation-summary-worker 三件套。

const LIFE_EVENT_EXTRACTION_PROMPT_VERSION = 'life-event-extraction.v1';
const MAX_LIFE_EVENT_JOB_ATTEMPTS = 3;
const MAX_LIFE_EVENT_CANDIDATES = 3;
const MAX_PROCESSING_PER_ACCOUNT = 2;

// 入队：每条用户消息最多一个提取任务（去重按 message_id），捕获当前
// revocation_epoch 供 Worker 重验。纯 store 写，不 await 模型。
function enqueueLifeEventExtraction({ store, account, conversation, message, now = new Date() } = {}) {
  if (!message?.message_id) return null;
  const existing = [...store.lifeEventExtractionJobs.values()].find((job) => job.message_id === message.message_id && ['PENDING', 'PROCESSING'].includes(job.state));
  if (existing) return existing;
  const job = Object.freeze({
    job_id: store.next('lexjob'), account_id: account.account_id,
    character_id: conversation?.character_id ?? message.character_id ?? null,
    conversation_id: conversation?.conversation_id ?? message.conversation_id ?? null,
    message_id: message.message_id, captured_revocation_epoch: account.revocation_epoch,
    state: 'PENDING', attempt_count: 0, next_attempt_at: now.toISOString(),
    exhausted_at: null, last_error: null, created_at: now.toISOString(), completed_at: null
  });
  store.lifeEventExtractionJobs.set(job.job_id, job);
  if (store.outboxEvents) {
    const event = Object.freeze({
      event_id: store.next('evt'), account_id: job.account_id, character_id: job.character_id,
      aggregate_type: 'LIFE_EVENT_EXTRACTION_JOB', aggregate_id: job.job_id,
      event_type: 'life_event.extraction_requested.v1',
      payload: { conversation_id: job.conversation_id, message_id: job.message_id, captured_revocation_epoch: job.captured_revocation_epoch },
      occurred_at: now.toISOString()
    });
    store.outboxEvents.set(event.event_id, event);
  }
  return job;
}

// 认领前提（PG 侧同语义行锁）：同账户 PROCESSING 未超上限，防止单账户刷爆
// 模型预算。挑最旧到期的 PENDING。
function claimableJob(store, now) {
  const processingByAccount = new Map();
  for (const job of store.lifeEventExtractionJobs.values()) {
    if (job.state === 'PROCESSING') processingByAccount.set(job.account_id, (processingByAccount.get(job.account_id) ?? 0) + 1);
  }
  return [...store.lifeEventExtractionJobs.values()]
    .filter((job) => job.state === 'PENDING' && !job.exhausted_at && job.next_attempt_at <= now.toISOString())
    .filter((job) => (processingByAccount.get(job.account_id) ?? 0) < MAX_PROCESSING_PER_ACCOUNT)
    .sort((left, right) => (left.created_at === right.created_at ? String(left.job_id).localeCompare(String(right.job_id)) : left.created_at < right.created_at ? -1 : 1))[0] ?? null;
}

// 提取前置/提交时双重重验：账户注销、消息删除/过期、epoch 变化（记忆被撤销）
// 都意味着这条消息的派生结果不该再落地——任务直接 CANCELLED，迟到结果丢弃。
function extractionSourceValid(store, job) {
  const account = store.accounts.get(job.account_id);
  if (!account || account.account_status !== 'OPEN' || account.revocation_epoch !== job.captured_revocation_epoch) return false;
  const message = store.messages.get(job.message_id);
  return Boolean(message && !message.deleted_at);
}

async function runNextLifeEventExtractionJob({ store, extractionGenerator, now = new Date() } = {}) {
  if (typeof extractionGenerator !== 'function') return { state: 'DISABLED' };
  const job = claimableJob(store, now);
  if (!job) return { state: 'IDLE' };
  store.lifeEventExtractionJobs.set(job.job_id, Object.freeze({ ...job, state: 'PROCESSING', attempt_count: job.attempt_count + 1, last_error: null }));
  try {
    if (!extractionSourceValid(store, job)) {
      store.lifeEventExtractionJobs.set(job.job_id, Object.freeze({ ...store.lifeEventExtractionJobs.get(job.job_id), state: 'CANCELLED', completed_at: now.toISOString(), last_error: 'source message revoked or account changed before extraction' }));
      return { state: 'CANCELLED', job_id: job.job_id };
    }
    const outcome = await extractionGenerator({
      text: store.messages.get(job.message_id)?.text,
      character: store.characters.get(job.character_id) ? { name: store.characters.get(job.character_id).name } : null,
      recentContext: [],
      timezone: null
    });
    // 提交时重验：模型调用在途期间来源可能已被撤销。
    if (!extractionSourceValid(store, job)) {
      store.lifeEventExtractionJobs.set(job.job_id, Object.freeze({ ...store.lifeEventExtractionJobs.get(job.job_id), state: 'CANCELLED', completed_at: now.toISOString(), last_error: 'source revoked while extraction in flight' }));
      return { state: 'CANCELLED', job_id: job.job_id };
    }
    const rawCandidates = Array.isArray(outcome?.candidates) ? outcome.candidates.slice(0, MAX_LIFE_EVENT_CANDIDATES) : [];
    const created = [];
    for (const raw of rawCandidates) {
      const validation = validateLifeEventCandidateOutput(raw, { now });
      if (!validation.valid) continue; // 单条不合法丢弃，不让一条脏数据拖垮整批
      const controlled = validation.value;
      const candidate = {
        candidate_id: store.next('memc'), account_id: job.account_id, character_id: job.character_id,
        state: 'CANDIDATE', version: 1, type: 'life_event',
        normalized_value: {
          life_event: {
            title: controlled.title, domain: controlled.domain, event_kind: controlled.event_kind,
            scheduled_at: controlled.scheduled_at, timezone: controlled.timezone,
            raw_time_text: controlled.raw_time_text, time_uncertain: controlled.needs_time_confirmation
          }
        },
        display_text: lifeEventDisplayText(controlled),
        provider: outcome.provider || 'unknown', expires_at: new Date(now.getTime() + 30 * 86400000).toISOString(),
        source_message_id: job.message_id, conflicts_with: []
      };
      store.candidates.set(candidate.candidate_id, candidate);
      created.push(candidate);
    }
    const current = store.lifeEventExtractionJobs.get(job.job_id);
    store.lifeEventExtractionJobs.set(job.job_id, Object.freeze({ ...current, state: 'COMPLETED', completed_at: now.toISOString() }));
    if (outcome?.usage && outcome.provider) {
      recordOperationMetric(store, {
        accountId: job.account_id, capability: 'LIFE_EVENT_EXTRACTION', provider: outcome.provider,
        modelVersion: outcome.modelVersion, inputTokens: outcome.usage.prompt_tokens, outputTokens: outcome.usage.completion_tokens,
        outcome: 'COMPLETED'
      });
    }
    return { state: 'COMPLETED', job_id: job.job_id, candidate_ids: created.map((candidate) => candidate.candidate_id) };
  } catch (error) {
    const current = store.lifeEventExtractionJobs.get(job.job_id);
    if (current.attempt_count >= MAX_LIFE_EVENT_JOB_ATTEMPTS) {
      // FAILED 留在本表（不建独立死信表，方案 §6.1）：供内部任务台查询与人工重放。
      store.lifeEventExtractionJobs.set(job.job_id, Object.freeze({ ...current, state: 'FAILED', exhausted_at: now.toISOString(), last_error: safeError(error) }));
      return { state: 'FAILED', job_id: job.job_id };
    }
    const retrySeconds = Math.min(600, 2 ** Math.min(current.attempt_count, 10));
    store.lifeEventExtractionJobs.set(job.job_id, Object.freeze({ ...current, state: 'PENDING', next_attempt_at: new Date(now.getTime() + retrySeconds * 1000).toISOString(), last_error: safeError(error) }));
    return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
  }
}

function safeError(error) { return String(error?.message || 'life event extraction failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }

// 仅内存模式：server.js 在 LIFE_EVENTS 开关开启且未配 Postgres 时启动；
// timer.unref() 保证不阻塞进程退出。PG 模式由独立 Worker 进程 drain。
function startLifeEventExtractionWorker(store, extractionGenerator, { intervalMs = 5_000, clock = () => new Date() } = {}) {
  if (typeof extractionGenerator !== 'function') return { stop() {} };
  const run = () => runNextLifeEventExtractionJob({ store, extractionGenerator, now: clock() }).catch(() => {});
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce: run };
}

module.exports = {
  LIFE_EVENT_EXTRACTION_PROMPT_VERSION, MAX_LIFE_EVENT_JOB_ATTEMPTS, MAX_LIFE_EVENT_CANDIDATES, MAX_PROCESSING_PER_ACCOUNT,
  enqueueLifeEventExtraction, runNextLifeEventExtractionJob, startLifeEventExtractionWorker
};
