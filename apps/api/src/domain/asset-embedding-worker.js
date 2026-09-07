'use strict';

// 确认关系资产的 Embedding 生命周期（技术设计 6.3.2/7.7/12.4）：
// 确认/修订 → index_state=PENDING → Outbox 事件 → 异步建索引 → READY；
// 索引未就绪的资产仍以确定性词法召回参与上下文（不得丢失召回）；
// 删除/撤销立即失效向量并取消未完成任务。
const DEVELOPMENT_EMBEDDING_MODEL_VERSION = 'deterministic-char-ngram-256-v1';
const EMBEDDING_DIMENSIONS = 256;
const MAX_EMBEDDING_JOB_ATTEMPTS = 5;

// 开发期向量化：真实的确定性字符 2-gram 哈希嵌入（L2 归一化）。它保证形状、
// 流程与可复现性，不提供语义质量——生产必须替换为供应商 embedding 服务，
// 并以新 model_version 全量重建索引（旧版本向量不得与新版本混用）。
function deterministicEmbedding(text) {
  const source = String(text ?? '');
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
  const chars = [...source.toLocaleLowerCase('zh-CN')];
  const grams = [];
  for (let index = 0; index < chars.length; index += 1) {
    grams.push(chars[index]);
    if (index + 1 < chars.length) grams.push(chars[index] + chars[index + 1]);
  }
  for (const gram of grams) {
    let hash = 2166136261;
    for (let offset = 0; offset < gram.length; offset += 1) {
      hash ^= gram.codePointAt(offset);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    vector[hash % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function enqueueAssetEmbedding({ store, asset, now = new Date() } = {}) {
  if (!asset || asset.state !== 'ACTIVE') return null;
  const existing = [...store.assetEmbeddingJobs.values()].find((job) => job.asset_id === asset.asset_id && job.asset_version === asset.version && ['PENDING', 'PROCESSING'].includes(job.state));
  if (existing) return existing;
  const job = Object.freeze({
    job_id: store.next('embjob'), account_id: asset.account_id, character_id: asset.character_id,
    asset_id: asset.asset_id, asset_version: asset.version, index_state_from: asset.index_state || 'PENDING',
    state: 'PENDING', attempt_count: 0, next_attempt_at: now.toISOString(), last_error: null,
    created_at: now.toISOString(), completed_at: null
  });
  store.assetEmbeddingJobs.set(job.job_id, job);
  if (store.outboxEvents) {
    const eventId = store.next('evt');
    store.outboxEvents.set(eventId, Object.freeze({
      event_id: eventId, account_id: asset.account_id, character_id: asset.character_id,
      aggregate_type: 'ASSET_EMBEDDING_JOB', aggregate_id: job.job_id, event_type: 'asset.embedding_requested.v1',
      payload: { asset_id: asset.asset_id, asset_version: asset.version, index_state: 'PENDING' },
      occurred_at: now.toISOString()
    }));
  }
  return job;
}

async function runNextAssetEmbeddingJob({ store, embeddingProvider = deterministicEmbedding, modelVersion = DEVELOPMENT_EMBEDDING_MODEL_VERSION, expectedDimensions = EMBEDDING_DIMENSIONS, now = new Date() } = {}) {
  if (typeof embeddingProvider !== 'function') return { state: 'DISABLED' };
  const job = [...store.assetEmbeddingJobs.values()]
    .filter((item) => item.state === 'PENDING' && !item.exhausted_at && item.next_attempt_at <= now.toISOString())
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
  if (!job) return { state: 'IDLE' };
  store.assetEmbeddingJobs.set(job.job_id, Object.freeze({ ...job, state: 'PROCESSING', attempt_count: job.attempt_count + 1, last_error: null }));
  try {
    const asset = store.assets.get(job.asset_id);
    // Commit-time checks：向量是派生数据，删除/修订/撤销若发生在建索引期间必须落败。
    if (!asset || asset.state !== 'ACTIVE' || asset.version !== job.asset_version) {
      const cancelled = Object.freeze({ ...store.assetEmbeddingJobs.get(job.job_id), state: 'CANCELLED', completed_at: now.toISOString(), last_error: 'asset was deleted, superseded, or changed before embedding' });
      store.assetEmbeddingJobs.set(job.job_id, cancelled);
      return { state: 'CANCELLED', job_id: job.job_id };
    }
    const vector = await embeddingProvider(asset.display_text);
    if (!Array.isArray(vector) || vector.length !== expectedDimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new TypeError('embedding provider returned an invalid vector');
    }
    const updatedAt = now.toISOString();
    store.assetEmbeddings.set(asset.asset_id, Object.freeze({
      asset_id: asset.asset_id, account_id: asset.account_id, character_id: asset.character_id,
      embedding: vector.slice(), embedding_model_version: modelVersion,
      created_at: store.assetEmbeddings.get(asset.asset_id)?.created_at || updatedAt,
      updated_at: updatedAt, version: asset.version
    }));
    asset.index_state = 'READY';
    const completed = Object.freeze({ ...store.assetEmbeddingJobs.get(job.job_id), state: 'COMPLETED', completed_at: updatedAt });
    store.assetEmbeddingJobs.set(job.job_id, completed);
    return { state: 'COMPLETED', job_id: job.job_id, asset_id: asset.asset_id, model_version: modelVersion };
  } catch (error) {
    const current = store.assetEmbeddingJobs.get(job.job_id);
    if (current.attempt_count >= MAX_EMBEDDING_JOB_ATTEMPTS) {
      const exhaustedAt = now.toISOString();
      const exhausted = Object.freeze({ ...current, state: 'PENDING', exhausted_at: exhaustedAt, next_attempt_at: exhaustedAt, last_error: safeError(error) });
      store.assetEmbeddingJobs.set(job.job_id, exhausted);
      recordAssetEmbeddingDeadLetter(store, exhausted, exhaustedAt);
      return { state: 'DLQ', job_id: job.job_id };
    }
    const retrySeconds = Math.min(600, 2 ** Math.min(current.attempt_count, 10));
    store.assetEmbeddingJobs.set(job.job_id, Object.freeze({ ...current, state: 'PENDING', next_attempt_at: new Date(now.getTime() + retrySeconds * 1000).toISOString(), last_error: safeError(error) }));
    return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
  }
}

function recordAssetEmbeddingDeadLetter(store, job, occurredAt) {
  const existing = [...store.assetEmbeddingDeadLetters.values()].find((item) => item.job_id === job.job_id);
  const deadLetter = Object.freeze({
    dead_letter_id: existing?.dead_letter_id || store.next('embdlq'),
    job_id: job.job_id, account_id: job.account_id, asset_id: job.asset_id,
    attempt_count: job.attempt_count, error_code: 'ASSET_EMBEDDING_FAILED',
    occurred_at: existing?.occurred_at || occurredAt, state: 'OPEN',
    replay_count: existing?.replay_count || 0, last_replayed_at: existing?.last_replayed_at || null,
    last_replayed_by: existing?.last_replayed_by || null, last_replay_reason_sha256: existing?.last_replay_reason_sha256 || null
  });
  store.assetEmbeddingDeadLetters.set(deadLetter.dead_letter_id, deadLetter);
  return deadLetter;
}

function replayAssetEmbeddingDeadLetter({ store, jobId, reviewerId, reasonHash, now = new Date() } = {}) {
  const deadLetter = [...store.assetEmbeddingDeadLetters.values()].find((item) => item.job_id === jobId);
  if (!deadLetter) return { state: 'NOT_FOUND' };
  if (deadLetter.replay_count >= 1) return { state: 'REPLAY_LIMIT_REACHED', dead_letter: deadLetter };
  const job = store.assetEmbeddingJobs.get(jobId);
  if (!job || !job.exhausted_at) return { state: 'NOT_EXHAUSTED', dead_letter: deadLetter };
  const asset = store.assets.get(job.asset_id);
  if (!asset || asset.state !== 'ACTIVE' || asset.version !== job.asset_version) return { state: 'SOURCE_REVOKED', dead_letter: deadLetter };
  const replayedAt = now.toISOString();
  store.assetEmbeddingJobs.set(jobId, Object.freeze({ ...job, state: 'PENDING', exhausted_at: null, completed_at: null, next_attempt_at: replayedAt, last_error: 'manual embedding DLQ replay requested' }));
  const updated = Object.freeze({ ...deadLetter, state: 'REPLAYED', replay_count: deadLetter.replay_count + 1, last_replayed_at: replayedAt, last_replayed_by: reviewerId, last_replay_reason_sha256: reasonHash });
  store.assetEmbeddingDeadLetters.set(updated.dead_letter_id, updated);
  if (store.outboxEvents) {
    store.outboxEvents.set(store.next('evt'), Object.freeze({
      event_id: store.next('evt'), account_id: job.account_id, character_id: job.character_id,
      aggregate_type: 'ASSET_EMBEDDING_JOB', aggregate_id: job.job_id, event_type: 'asset.embedding_dlq_replayed.v1',
      payload: { asset_id: job.asset_id, replay_count: updated.replay_count }, occurred_at: replayedAt
    }));
  }
  return { state: 'REPLAY_SCHEDULED', embedding_job: store.assetEmbeddingJobs.get(jobId), dead_letter: updated };
}

// 删除/修订/撤销时立即失效：向量下线、未完成任务取消（技术设计 8.9 的
// VECTOR_INDEX 目标），在线召回即刻不再命中该资产版本。
function invalidateAssetEmbedding(store, assetId, reason, now = new Date().toISOString()) {
  // PostgreSQL 请求作用域中的应用角色只允许创建任务和读取已过滤的
  // 召回结果。派生向量的物理删除/任务取消由专用 Worker 完成；资产状态
  // 本身已经先变为非 ACTIVE，因而在线召回会立即排除它。
  if (store?.assetEmbeddingWritesDeferred) {
    return { vector_removed: false, jobs_cancelled: 0, deferred_to_worker: true };
  }
  const removed = store.assetEmbeddings.delete(assetId);
  let cancelled = 0;
  for (const job of store.assetEmbeddingJobs.values()) {
    if (job.asset_id !== assetId || !['PENDING', 'PROCESSING'].includes(job.state)) continue;
    store.assetEmbeddingJobs.set(job.job_id, Object.freeze({ ...job, state: 'CANCELLED', completed_at: now, last_error: safeError({ message: reason }) }));
    cancelled += 1;
  }
  return { vector_removed: removed, jobs_cancelled: cancelled };
}

function startAssetEmbeddingWorker(store, embeddingProvider, { intervalMs = 5_000, clock = () => new Date(), modelVersion = DEVELOPMENT_EMBEDDING_MODEL_VERSION, expectedDimensions = EMBEDDING_DIMENSIONS } = {}) {
  if (typeof embeddingProvider !== 'function') return { stop() {} };
  const run = () => runNextAssetEmbeddingJob({ store, embeddingProvider, modelVersion, expectedDimensions, now: clock() }).catch(() => {});
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce: run };
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function safeError(error) { return String(error?.message || 'asset embedding worker failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }

module.exports = {
  DEVELOPMENT_EMBEDDING_MODEL_VERSION, EMBEDDING_DIMENSIONS, MAX_EMBEDDING_JOB_ATTEMPTS,
  cosineSimilarity, deterministicEmbedding, enqueueAssetEmbedding, invalidateAssetEmbedding,
  replayAssetEmbeddingDeadLetter, runNextAssetEmbeddingJob, startAssetEmbeddingWorker
};
