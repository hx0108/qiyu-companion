'use strict';

// 本轮记忆引用（六项能力 A1，方案 §4.3）：助手消息发出时把它实际注入上下文
// 的资产/事件固化为一份快照（UNIQUE message_id）。读取时对来源当前状态逐项
// 重验——旧版本、已删除、跨账户的来源只返回不可用标记，不回正文。引用是弱
// 引用：消息保留期物理删除后由 clearExpiredMessageMemoryLinks 清理联动。

const MEMORY_REFS_VERSION = 'memory-refs.v1';
const MEMORY_REFS_CAP = 20;

// 从本轮 contextPack 构建引用集（P1.7 起 confirmed_assets 携带 asset_id、
// 新增 active_life_events）。上限 20 项，超出按数组序截断（调用方已按召回
// 权重排序，排最后的先丢）。
function buildMemoryRefs(contextPack) {
  const refs = [];
  const assets = Array.isArray(contextPack?.confirmed_assets) ? contextPack.confirmed_assets : [];
  for (const asset of assets) {
    if (refs.length >= MEMORY_REFS_CAP) break;
    if (!asset?.asset_id) continue;
    refs.push({ kind: 'ASSET', id: asset.asset_id, version: asset.version ?? 1 });
  }
  const events = Array.isArray(contextPack?.active_life_events) ? contextPack.active_life_events : [];
  for (const event of events) {
    if (refs.length >= MEMORY_REFS_CAP) break;
    if (!event?.event_id) continue;
    refs.push({ kind: 'LIFE_EVENT', id: event.event_id, version: event.version ?? 1 });
  }
  return refs;
}

// 落库一条助手消息的引用快照。空引用不落行（读取侧无记录=空列表）。
// 同一消息重复写入按 message_id 覆盖（内存实现为删旧插新，PG 侧 ON CONFLICT）。
function recordMessageMemoryRefs({ store, account, conversation, message, refs, contextBundleVersion = MEMORY_REFS_VERSION, now = new Date() } = {}) {
  if (!message?.message_id || !Array.isArray(refs) || refs.length === 0) return null;
  for (const [refId, record] of [...store.messageMemoryRefs]) {
    if (record.message_id === message.message_id) store.messageMemoryRefs.delete(refId);
  }
  const record = {
    ref_id: store.next('mmref'), message_id: message.message_id,
    account_id: account.account_id, character_id: conversation?.character_id ?? message.character_id ?? null,
    conversation_id: conversation?.conversation_id ?? message.conversation_id ?? null,
    refs_json: { refs: refs.slice(0, MEMORY_REFS_CAP) },
    context_bundle_version: contextBundleVersion,
    created_at: now.toISOString()
  };
  store.messageMemoryRefs.set(record.ref_id, record);
  return record;
}

// 逐项对来源当前状态解析。available:false 的项绝不回正文（display_text/title），
// 只带 reason 与（若存在）当前版本线索，前端引导用户去看当前值。
function resolveMemoryRef(store, accountId, ref) {
  if (ref?.kind === 'LIFE_EVENT') {
    const event = store.lifeEvents?.get(ref.id);
    if (!event || event.account_id !== accountId) return { kind: 'LIFE_EVENT', id: ref.id, version: ref.version ?? null, available: false, reason: 'MISSING' };
    if (event.deleted_at) return { kind: 'LIFE_EVENT', id: ref.id, version: ref.version ?? null, available: false, reason: 'DELETED' };
    if (ref.version !== undefined && ref.version !== null && ref.version !== event.version) {
      return { kind: 'LIFE_EVENT', id: ref.id, version: ref.version, available: false, reason: 'SUPERSEDED', current_version: event.version };
    }
    return { kind: 'LIFE_EVENT', id: event.event_id, version: event.version, available: true, reason: null, title: event.title, status: event.status, scheduled_at: event.scheduled_at ?? null, time_precision: event.time_precision };
  }
  if (ref?.kind === 'ASSET') {
    const asset = store.assets.get(ref.id);
    if (!asset || asset.account_id !== accountId) return { kind: 'ASSET', id: ref.id, version: ref.version ?? null, available: false, reason: 'MISSING' };
    if (asset.state === 'DELETED') return { kind: 'ASSET', id: ref.id, version: ref.version ?? null, available: false, reason: 'DELETED' };
    if (asset.state === 'SUPERSEDED') return { kind: 'ASSET', id: ref.id, version: ref.version ?? null, available: false, reason: 'SUPERSEDED', current_asset_id: asset.superseded_by ?? null };
    if (ref.version !== undefined && ref.version !== null && ref.version !== asset.version) {
      return { kind: 'ASSET', id: ref.id, version: ref.version, available: false, reason: 'SUPERSEDED', current_version: asset.version };
    }
    return { kind: 'ASSET', id: asset.asset_id, version: asset.version, available: true, reason: null, display_text: asset.display_text, type: asset.type };
  }
  return { kind: ref?.kind ?? 'UNKNOWN', id: ref?.id ?? null, version: ref?.version ?? null, available: false, reason: 'UNSUPPORTED' };
}

// GET /messages/{messageId}/memory-references。跨账户/不存在统一 null，
// 由路由层转 404 RESOURCE_NOT_FOUND。
function messageMemoryReferences({ store, accountId, messageId }) {
  const record = [...store.messageMemoryRefs.values()].find((item) => item.message_id === messageId && item.account_id === accountId);
  if (!record) return null;
  const refs = Array.isArray(record.refs_json?.refs) ? record.refs_json.refs : [];
  return {
    message_id: record.message_id,
    context_bundle_version: record.context_bundle_version,
    created_at: record.created_at,
    references: refs.map((ref) => resolveMemoryRef(store, accountId, ref))
  };
}

// 消息保留期到期联动（retention sweep 调用）：
// 1) 引用快照删除；2) 事件 source_message_id 置空（事件本体保留）；
// 3) 挂在这些消息上的候选 → EXPIRED；4) 未跑的提取任务 → CANCELLED。
function clearExpiredMessageMemoryLinks({ store, expiredMessageIds, now = new Date() } = {}) {
  const ids = new Set(expiredMessageIds ?? []);
  if (ids.size === 0) return { refs_removed: 0, sources_cleared: 0, candidates_expired: 0, jobs_cancelled: 0 };
  const nowIso = now.toISOString();
  let refsRemoved = 0;
  for (const [refId, record] of [...store.messageMemoryRefs]) {
    if (ids.has(record.message_id)) { store.messageMemoryRefs.delete(refId); refsRemoved += 1; }
  }
  let sourcesCleared = 0;
  for (const event of store.lifeEvents?.values() ?? []) {
    if (event.source_message_id && ids.has(event.source_message_id)) {
      event.source_message_id = null;
      event.updated_at = nowIso;
      sourcesCleared += 1;
    }
  }
  let candidatesExpired = 0;
  for (const candidate of store.candidates.values()) {
    if (candidate.source_message_id && ids.has(candidate.source_message_id) && candidate.state === 'CANDIDATE') {
      candidate.state = 'EXPIRED';
      candidatesExpired += 1;
    }
  }
  let jobsCancelled = 0;
  for (const job of store.lifeEventExtractionJobs?.values() ?? []) {
    if (ids.has(job.message_id) && ['PENDING', 'PROCESSING'].includes(job.state)) {
      job.state = 'CANCELLED';
      job.completed_at = nowIso;
      job.last_error = 'source message retention expired';
      jobsCancelled += 1;
    }
  }
  return { refs_removed: refsRemoved, sources_cleared: sourcesCleared, candidates_expired: candidatesExpired, jobs_cancelled: jobsCancelled };
}

module.exports = { MEMORY_REFS_VERSION, MEMORY_REFS_CAP, buildMemoryRefs, recordMessageMemoryRefs, messageMemoryReferences, resolveMemoryRef, clearExpiredMessageMemoryLinks };
