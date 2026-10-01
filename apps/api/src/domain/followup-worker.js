'use strict';

const { composeFollowupText } = require('./followup-composer');
const { evaluateFollowupPublish, claimDailySlot, transitionFollowupJob, bumpFollowupSuppression, FOLLOWUP_JOB_IN_FLIGHT_STATES } = require('./followup-service');
const { recordMessageMemoryRefs, buildMemoryRefs } = require('./memory-reference-service');
const { recordOperationMetric } = require('./operation-metrics');

// 六项能力 A2 跟进 Worker（方案 §4.2 调度任务）：租约领取 → 事务外模型措辞 →
// 短事务发布（重读事件/许可/账户 → evaluateFollowupPublish → 抢每日槽位 →
// 双写聊天流消息+来源引用+主动消息审计 → CAS 置 PUBLISHED）。决策唯一写者是
// evaluateFollowupPublish 域函数；双 Worker 恰一胜靠 CAS + 槽位原子竞争；
// 进程重启恢复靠租约过期重领。PG 模式由 postgres-followup-repository 的
// SKIP LOCKED + 守卫 UPDATE 承担同语义。

const FOLLOWUP_WORKER_INTERVAL_MS = 60_000;
const FOLLOWUP_BATCH_LIMIT = 50;
const FOLLOWUP_LEASE_SECONDS = 300;
const MAX_FOLLOWUP_ATTEMPTS = 3;

// 领取到期任务：PENDING 且 due_at/next_attempt_at 已到，或 LEASED 且租约过期
//（Worker 崩溃后的重启恢复）。CAS 置 LEASED（attempts+1、租约字段）。
function claimDueFollowupJobs(store, now = new Date(), { workerId = 'followup-worker', limit = FOLLOWUP_BATCH_LIMIT } = {}) {
  const nowIso = now.toISOString();
  const candidates = [...store.followupJobs.values()]
    .filter((job) => job.state === 'PENDING' && job.next_attempt_at <= nowIso && job.due_at <= nowIso)
    .concat([...store.followupJobs.values()].filter((job) => job.state === 'LEASED' && job.lease_expires_at && job.lease_expires_at <= nowIso))
    .sort((left, right) => (left.next_attempt_at < right.next_attempt_at ? -1 : 1))
    .slice(0, limit);
  const claimed = [];
  for (const candidate of candidates) {
    const leased = transitionFollowupJob(store, candidate.job_id, [candidate.state], {
      state: 'LEASED',
      attempts: candidate.attempts + 1,
      lease_owner: workerId,
      lease_expires_at: new Date(now.getTime() + FOLLOWUP_LEASE_SECONDS * 1000).toISOString(),
      last_error: null
    });
    if (leased) claimed.push(leased);
  }
  return claimed;
}

// 单任务三段式。返回 { state, job_id, reason? }；state ∈ PUBLISHED / DEFERRED /
// CANCELLED / EXPIRED / RETRY_SCHEDULED / FAILED / SKIPPED_NOT_DUE。
async function runNextFollowupJob({ store, composer = null, workerId = 'followup-worker', now = new Date() } = {}) {
  const [job] = claimDueFollowupJobs(store, now, { workerId, limit: 1 });
  if (!job) return { state: 'IDLE' };
  return publishFollowupJob({ store, job, composer, workerId, now });
}

// 发布事务核心（内存模式同步执行；语义与 PG repository.publish 对齐）。
async function publishFollowupJob({ store, job, composer, workerId, now = new Date() }) {
  const nowIso = now.toISOString();
  // 1) 事务外措辞（模型可秒级耗时，租约兜底）。
  let composed;
  try {
    composed = await composeFollowupText({
      event: { title: followupEventTitle(store, job), scheduled_at: null },
      character: store.characters.get(job.character_id) ? { name: store.characters.get(job.character_id).name } : null,
      followupKind: job.followup_kind,
      model: composer,
      now
    });
  } catch {
    composed = { text: null, provider: 'error' };
  }
  // 2) 短事务：重读当前快照 → 决策。
  const event = store.lifeEvents.get(job.event_id) ?? null;
  const grant = store.followupGrants.get(job.grant_id) ?? null;
  const account = store.accounts.get(job.account_id) ?? null;
  const sentAt = [...store.proactiveMessages.values()]
    .filter((item) => item.account_id === job.account_id && item.kind === 'NORMAL')
    .map((item) => item.sent_at);
  const decision = evaluateFollowupPublish({
    event, grant, job, account,
    preferences: account?.proactive_preferences ?? {},
    sentAt, now
  });
  if (decision.action === 'DEFER') {
    bumpFollowupSuppression(store, 'DEFER', decision.reason);
    const deferred = transitionFollowupJob(store, job.job_id, ['LEASED'], {
      state: 'PENDING', lease_owner: null, lease_expires_at: null,
      next_attempt_at: decision.defer_until ?? job.due_at, // 静默顺延不耗 attempts
      last_error: `deferred: ${decision.reason}`
    });
    return deferred ? { state: 'DEFERRED', job_id: job.job_id, reason: decision.reason, defer_until: decision.defer_until } : { state: 'SUPERSEDED', job_id: job.job_id };
  }
  if (decision.action === 'CANCEL' || decision.action === 'EXPIRE') {
    bumpFollowupSuppression(store, decision.action, decision.reason);
    const terminal = decision.action === 'EXPIRE' ? 'EXPIRED' : 'CANCELLED';
    const done = transitionFollowupJob(store, job.job_id, ['LEASED'], {
      state: terminal, lease_owner: null, lease_expires_at: null, last_error: `${decision.action.toLowerCase()}: ${decision.reason}`
    });
    return done ? { state: terminal, job_id: job.job_id, reason: decision.reason } : { state: 'SUPERSEDED', job_id: job.job_id };
  }
  // 3) PUBLISH：先抢每日槽位（占用→EXPIRED 不补发过时提醒）。
  if (!claimDailySlot(store, job.account_id, job.local_date, job.job_id)) {
    bumpFollowupSuppression(store, 'EXPIRE', 'DAILY_LIMIT_REACHED');
    const done = transitionFollowupJob(store, job.job_id, ['LEASED'], {
      state: 'EXPIRED', lease_owner: null, lease_expires_at: null, last_error: 'expire: daily slot taken'
    });
    return done ? { state: 'EXPIRED', job_id: job.job_id, reason: 'DAILY_LIMIT_REACHED' } : { state: 'SUPERSEDED', job_id: job.job_id };
  }
  const conversation = ensureFollowupConversation(store, job, now);
  const assistantMessage = {
    message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT',
    text: composed.text, provider: 'proactive-followup', model_version: composed.model_version ?? 'followup-template-v1',
    ai_generated: composed.provider !== 'template' && composed.provider !== 'template-fallback',
    created_at: nowIso, retention_expires_at: new Date(now.getTime() + (account?.raw_interaction_retention_days ?? 90) * 86400000).toISOString()
  };
  store.messages.set(assistantMessage.message_id, assistantMessage);
  // 来源引用：本轮注入的就是这个事件（版本绑定，之后修订/删除走不可用标记）。
  recordMessageMemoryRefs({
    store, account, conversation,
    message: assistantMessage,
    refs: [{ kind: 'LIFE_EVENT', id: job.event_id, version: job.event_version }]
  });
  // 主动消息审计（每日一条频控统计源 + 模板槽留痕）。
  const audit = {
    message_id: store.next('pmsg'), account_id: job.account_id, character_id: job.character_id,
    event_id: job.event_id, kind: 'NORMAL', template_slot: composed.template_slot,
    text: composed.text, sent_at: nowIso
  };
  store.proactiveMessages.set(audit.message_id, audit);
  // 4) CAS 置 PUBLISHED（双 Worker 输家在此放弃——迟到的消息分支不落地）。
  const published = transitionFollowupJob(store, job.job_id, ['LEASED'], {
    state: 'PUBLISHED', lease_owner: null, lease_expires_at: null, published_at: nowIso
  });
  if (!published) {
    // 竞态输家：回滚本分支的消息与审计（内存模式可安全撤销——消息尚未被
    // 任何客户端读取；PG 模式同事务回滚）。
    store.messages.delete(assistantMessage.message_id);
    store.proactiveMessages.delete(audit.message_id);
    return { state: 'SUPERSEDED', job_id: job.job_id };
  }
  recordOperationMetric(store, {
    accountId: job.account_id, capability: 'FOLLOWUP_DISPATCH', provider: composed.provider,
    modelVersion: composed.model_version, outcome: 'COMPLETED'
  });
  return { state: 'PUBLISHED', job_id: job.job_id, message_id: assistantMessage.message_id, provider: composed.provider };
}

// 措辞用事件标题：重读当前投影（事件被删时决策层会 CANCEL，措辞自然作废）。
function followupEventTitle(store, job) {
  return store.lifeEvents.get(job.event_id)?.title ?? '你确认过的事';
}

// 投递会话：取 (account, character) 最新非删除会话；无则新建（用户可能从未
// 在该角色下聊过——主动消息也要有落点）。
function ensureFollowupConversation(store, job, now) {
  const existing = [...store.conversations.values()]
    .filter((item) => item.account_id === job.account_id && item.character_id === job.character_id && item.status !== 'DELETED')
    .sort((left, right) => (left.created_at < right.created_at ? 1 : -1))[0];
  if (existing) return existing;
  const created = { conversation_id: store.next('cnv'), account_id: job.account_id, character_id: job.character_id, status: 'OPEN', created_at: now.toISOString() };
  store.conversations.set(created.conversation_id, created);
  return created;
}

// 重试与失败（措辞异常之外的发布异常由调用方捕获走此路径）。
function failFollowupJob(store, job, error, now = new Date()) {
  const current = store.followupJobs.get(job.job_id);
  if (!current || current.state !== 'LEASED') return { state: 'SUPERSEDED', job_id: job.job_id };
  if (current.attempts >= MAX_FOLLOWUP_ATTEMPTS || new Date(current.expires_at).getTime() <= now.getTime()) {
    store.followupJobs.set(job.job_id, Object.freeze({ ...current, state: 'FAILED', lease_owner: null, lease_expires_at: null, last_error: safeError(error) }));
    return { state: 'FAILED', job_id: job.job_id };
  }
  const retrySeconds = Math.min(600, 2 ** Math.min(current.attempts, 10));
  store.followupJobs.set(job.job_id, Object.freeze({ ...current, state: 'PENDING', lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(now.getTime() + retrySeconds * 1000).toISOString(), last_error: safeError(error) }));
  return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
}

function safeError(error) { return String(error?.message || 'followup dispatch failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }

function startFollowupWorker(store, composer = null, { intervalMs = FOLLOWUP_WORKER_INTERVAL_MS, workerId = 'followup-worker', clock = () => new Date() } = {}) {
  const run = () => { runNextFollowupJob({ store, composer, workerId, now: clock() }).catch(() => {}); };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce: run };
}

module.exports = {
  FOLLOWUP_WORKER_INTERVAL_MS, FOLLOWUP_BATCH_LIMIT, FOLLOWUP_LEASE_SECONDS, MAX_FOLLOWUP_ATTEMPTS,
  claimDueFollowupJobs, runNextFollowupJob, publishFollowupJob, failFollowupJob, startFollowupWorker
};
