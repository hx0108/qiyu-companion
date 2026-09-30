'use strict';

const { enqueueAssetEmbedding, invalidateAssetEmbedding } = require('./asset-embedding-worker');
const { validateLifeEventCandidateOutput, validateLifeEventRevisionFields } = require('./life-event-schema');
const { registerDeletionTargets, completeDeletionTarget } = require('./deletion-orchestration');

// 生活事件投影（六项能力 A1，方案 §4.1）的唯一写者。语义事实源仍是
// relationship_assets 版本链（type='life_event'），life_events 只是已确认事件
// 的可查询投影与生命周期记录——除本模块外任何代码不得写 store.lifeEvents。

const LIFE_EVENT_LIST_DEFAULT = 20;
const LIFE_EVENT_LIST_MAX = 50;
const DELETION_RECEIPT_VERSION = 'qiyu-deletion-receipt-v1';

// 与 app.js 的 apiError 同语义（status/code/expose），让路由层 catch-all 直接透出。
function httpError(status, code, message, details) {
  const error = new Error(message);
  Object.assign(error, { status, code, expose: true, details });
  return error;
}

function schemaError(errors) {
  const missingFields = errors.map((item) => item.field);
  return httpError(400, 'VALIDATION_ERROR', `生活事件字段不合法：${errors.map((item) => `${item.field} ${item.reason}`).join('；')}`, { missing_fields: missingFields, field_errors: errors });
}

// 候选 normalized_value.life_event 的受控读取（提取 Worker 写入，此处不信形状）。
function candidateControlledValue(candidate) {
  const raw = candidate?.normalized_value?.life_event;
  const validation = validateLifeEventCandidateOutput(raw ?? {});
  if (!validation.valid) throw schemaError(validation.errors);
  return validation.value;
}

function formatScheduledAt(scheduledAt, timePrecision) {
  if (!scheduledAt) return '';
  const date = new Date(scheduledAt);
  if (timePrecision === 'MINUTE') {
    const packed = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
    return `（${packed}）`;
  }
  return `（${date.toISOString().slice(0, 10)}）`;
}

function lifeEventDisplayText(controlled) {
  const prefix = controlled.domain === 'FICTIONAL_SHARED' ? '共同虚构' : '生活事件';
  return `${prefix}：${controlled.title}${formatScheduledAt(controlled.scheduled_at, controlled.time_precision)}`;
}

// 确认候选 → 固化受控 normalized_value + 建资产 + 写投影（version=1）。
// editedFields 为 confirm-edited 提交的完整 body.life_event（缺字段按候选值校验）。
// 由 resolveCandidate 在候选状态机校验后调用，此处不再重复候选状态判断。
function confirmLifeEventFromCandidate({ store, account, candidate, editedFields = null, now = new Date() } = {}) {
  const base = candidateControlledValue(candidate);
  let controlled = base;
  if (editedFields !== null) {
    // confirm-edited：以候选受控值为底、合并用户修订后整体重校验（不允许只改
    // 展示文本而留旧时间——修订后的字段集必须整体合法）。
    const merged = {
      title: editedFields.title ?? base.title,
      event_kind: editedFields.event_kind ?? base.event_kind,
      domain: editedFields.domain ?? base.domain,
      scheduled_at: editedFields.scheduled_at ?? base.scheduled_at,
      timezone: editedFields.timezone ?? base.timezone,
      status: editedFields.status ?? base.status,
      // 含糊候选的"待补时间"标记只在用户没给出确切日期时预置；给了日期由
      // schema 的"补全即解除"规则处理。
      clarification_required: editedFields.clarification_required ?? (base.needs_time_confirmation && editedFields.scheduled_at === undefined ? true : undefined)
    };
    const revision = validateLifeEventRevisionFields(merged, {
      current: { ...base, clarification_required: base.needs_time_confirmation }
    });
    if (!revision.ok) throw schemaError(revision.errors);
    controlled = { ...base, ...revision.value };
  }
  const displayText = editedFields === null
    ? (candidate.display_text || lifeEventDisplayText(controlled))
    : lifeEventDisplayText(controlled);
  const nowIso = now.toISOString();
  const normalizedValue = {
    text: displayText,
    life_event: {
      domain: controlled.domain, event_kind: controlled.event_kind, title: controlled.title,
      scheduled_at: controlled.scheduled_at ?? null, timezone: controlled.timezone ?? null,
      time_precision: controlled.time_precision, status: controlled.status ?? 'PLANNED',
      // 修订路径以合并后的 clarification_required 为准（补全日期即解除）；
      // 直接确认路径保留候选的"待补时间"判定。
      needs_time_confirmation: editedFields === null
        ? base.needs_time_confirmation === true
        : controlled.clarification_required === true
    }
  };
  const asset = {
    asset_id: store.next('ras'), account_id: account.account_id, character_id: candidate.character_id,
    type: 'life_event', value: normalizedValue, display_text: displayText, state: 'ACTIVE', version: 1,
    index_state: 'PENDING', source_candidate_id: candidate.candidate_id, created_at: nowIso
  };
  store.assets.set(asset.asset_id, asset);
  enqueueAssetEmbedding({ store, asset });
  const event = {
    event_id: store.next('levt'), account_id: account.account_id, character_id: candidate.character_id,
    current_asset_id: asset.asset_id, asset_version: asset.version, version: 1,
    domain: normalizedValue.life_event.domain, event_kind: normalizedValue.life_event.event_kind,
    title: normalizedValue.life_event.title, scheduled_at: normalizedValue.life_event.scheduled_at,
    timezone: normalizedValue.life_event.timezone, time_precision: normalizedValue.life_event.time_precision,
    status: normalizedValue.life_event.status,
    clarification_required: normalizedValue.life_event.needs_time_confirmation,
    source_message_id: candidate.source_message_id ?? null,
    created_at: nowIso, updated_at: nowIso, deleted_at: null
  };
  store.lifeEvents.set(event.event_id, event);
  return { asset, event };
}

function publicLifeEvent(event) {
  return {
    event_id: event.event_id, character_id: event.character_id,
    current_asset_id: event.current_asset_id, asset_version: event.asset_version, version: event.version,
    domain: event.domain, event_kind: event.event_kind, title: event.title,
    scheduled_at: event.scheduled_at, timezone: event.timezone, time_precision: event.time_precision,
    status: event.status, clarification_required: event.clarification_required === true,
    source_message_id: event.source_message_id ?? null,
    created_at: event.created_at, updated_at: event.updated_at
  };
}

function findLifeEvent(store, accountId, eventId) {
  const event = store.lifeEvents.get(eventId);
  if (!event || event.account_id !== accountId || event.deleted_at) return null;
  return event;
}

function getLifeEvent({ store, accountId, eventId }) {
  const event = findLifeEvent(store, accountId, eventId);
  if (!event) throw httpError(404, 'RESOURCE_NOT_FOUND', '生活事件不存在');
  return publicLifeEvent(event);
}

// 列表：updated_at 新→旧稳定排序，cursor = 上一页最后一条 event_id，隐藏已删除。
function listLifeEvents({ store, accountId, characterId = null, cursor = null, limit = LIFE_EVENT_LIST_DEFAULT }) {
  const size = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), LIFE_EVENT_LIST_MAX) : LIFE_EVENT_LIST_DEFAULT;
  const items = [...store.lifeEvents.values()]
    .filter((event) => event.account_id === accountId && !event.deleted_at)
    .filter((event) => !characterId || event.character_id === characterId)
    .sort((left, right) => (left.updated_at === right.updated_at ? String(right.event_id).localeCompare(String(left.event_id)) : left.updated_at < right.updated_at ? 1 : -1));
  const startIndex = cursor ? items.findIndex((event) => event.event_id === cursor) + 1 : 0;
  const page = items.slice(startIndex, startIndex + size);
  const nextCursor = startIndex + size < items.length ? page.at(-1).event_id : null;
  return { events: page.map(publicLifeEvent), next_cursor: nextCursor };
}

// 修订（PATCH）：旧资产转 SUPERSEDED、新资产接链（复用 reviseAsset 语义），
// 投影 version+1。日期经过不自动改完成状态——status 只随显式 PATCH 变化。
function reviseLifeEvent({ store, account, event, patch, expectedVersion, now = new Date() } = {}) {
  if (event.deleted_at) throw httpError(409, 'STATE_TRANSITION_INVALID', '生活事件已删除，不能修订');
  if (expectedVersion !== event.version) {
    throw httpError(409, 'VERSION_CONFLICT', '生活事件版本冲突');
  }
  const revision = validateLifeEventRevisionFields(patch, {
    current: {
      title: event.title, event_kind: event.event_kind, domain: event.domain,
      scheduled_at: event.scheduled_at, timezone: event.timezone, time_precision: event.time_precision,
      status: event.status, clarification_required: event.clarification_required
    }
  });
  if (!revision.ok) throw schemaError(revision.errors);
  const controlled = revision.value;
  const nowIso = now.toISOString();
  const previousAsset = store.assets.get(event.current_asset_id);
  if (previousAsset && previousAsset.state === 'ACTIVE') {
    previousAsset.state = 'SUPERSEDED';
    previousAsset.superseded_at = nowIso;
    invalidateAssetEmbedding(store, previousAsset.asset_id, 'life event superseded by revision');
  }
  const displayText = lifeEventDisplayText(controlled);
  const replacement = {
    asset_id: store.next('ras'), account_id: event.account_id, character_id: event.character_id,
    type: 'life_event',
    value: { text: displayText, life_event: { domain: controlled.domain, event_kind: controlled.event_kind, title: controlled.title, scheduled_at: controlled.scheduled_at, timezone: controlled.timezone, time_precision: controlled.time_precision, status: controlled.status, needs_time_confirmation: controlled.clarification_required } },
    display_text: displayText, state: 'ACTIVE', version: 1, index_state: 'PENDING',
    source_candidate_id: previousAsset?.source_candidate_id ?? null,
    supersedes_asset_id: event.current_asset_id, superseded_by: null, created_at: nowIso
  };
  if (previousAsset) previousAsset.superseded_by = replacement.asset_id;
  store.assets.set(replacement.asset_id, replacement);
  enqueueAssetEmbedding({ store, asset: replacement });
  Object.assign(event, {
    current_asset_id: replacement.asset_id, asset_version: replacement.version, version: event.version + 1,
    domain: controlled.domain, event_kind: controlled.event_kind, title: controlled.title,
    scheduled_at: controlled.scheduled_at, timezone: controlled.timezone, time_precision: controlled.time_precision,
    status: controlled.status, clarification_required: controlled.clarification_required,
    updated_at: nowIso
  });
  return { event: publicLifeEvent(event), asset: replacement };
}

// 删除：镜像 deleteAsset 语义（软删资产 + revocation_epoch+1 + 向量下线 +
// 删除账本/回执），另置空投影可见性（deleted_at）并新增 LIFE_EVENT 目标域。
// 幂等：已删除直接返回既有回执，不重复抬 epoch。
function deleteLifeEvent({ store, account, event, now = new Date() } = {}) {
  const existingJob = [...store.deletionJobs.values()].find((job) => job.scope === 'LIFE_EVENT' && job.event_id === event.event_id);
  if (event.deleted_at) {
    return { event: { ...publicLifeEvent(event), deleted: true }, deletion_job: existingJob || null, deletion_receipt: existingJob ? deletionReceiptOf(store, existingJob) : null };
  }
  const nowIso = now.toISOString();
  const asset = store.assets.get(event.current_asset_id);
  if (asset && asset.state !== 'DELETED') {
    asset.state = 'DELETED';
    asset.deleted_at = nowIso;
  }
  account.revocation_epoch += 1;
  const embeddingCleanup = asset ? invalidateAssetEmbedding(store, asset.asset_id, 'life event deleted by user') : { deferred_to_worker: false, vector_removed: false, jobs_cancelled: 0 };
  const vectorState = embeddingCleanup.deferred_to_worker ? 'PENDING_WORKER_CLEANUP' : (embeddingCleanup.vector_removed ? 'INVALIDATED' : 'NOT_INDEXED');
  event.deleted_at = nowIso;
  event.updated_at = nowIso;
  const deletionJob = {
    deletion_job_id: store.next('del'), account_id: account.account_id, asset_id: asset?.asset_id ?? null,
    event_id: event.event_id, scope: 'LIFE_EVENT', state: 'COMPLETED', revocation_epoch: account.revocation_epoch,
    physical_cleanup_state: 'ROWS_CLEANED_INLINE', created_at: nowIso,
    note: '生活事件已删除；关联资产软删、向量下线，事件从列表/详情/注入中即刻不可见。',
    targets: [
      { type: 'LIFE_EVENT', state: 'COMPLETED' },
      { type: 'RELATIONSHIP_ASSET', state: 'COMPLETED' },
      { type: 'VECTOR_INDEX', state: vectorState, cancelled_jobs: embeddingCleanup.jobs_cancelled }
    ]
  };
  store.deletionJobs.set(deletionJob.deletion_job_id, deletionJob);
  registerDeletionTargets(store, deletionJob, [
    { target_type: 'LIFE_EVENT', target_ref: event.event_id },
    { target_type: 'RELATIONSHIP_ASSET', target_ref: asset?.asset_id ?? 'NONE' },
    { target_type: 'RELATIONSHIP_ASSET_EMBEDDINGS', target_ref: asset?.asset_id ?? 'NONE' }
  ], nowIso);
  completeDeletionTarget(store, deletionJob, 'LIFE_EVENT', event.event_id, { cleaned_inline: true, completed_at: nowIso }, nowIso);
  completeDeletionTarget(store, deletionJob, 'RELATIONSHIP_ASSET', asset?.asset_id ?? 'NONE', { soft_deleted: true, completed_at: nowIso }, nowIso);
  completeDeletionTarget(store, deletionJob, 'RELATIONSHIP_ASSET_EMBEDDINGS', asset?.asset_id ?? 'NONE', { vector_state: vectorState, completed_at: nowIso }, nowIso);
  return { event: { ...publicLifeEvent(event), deleted: true }, deletion_job: deletionJob, deletion_receipt: deletionReceiptOf(store, deletionJob) };
}

function deletionReceiptOf(store, deletionJob) {
  const targets = [...store.deletionTargets.values()]
    .filter((target) => target.deletion_job_id === deletionJob.deletion_job_id)
    .map(({ target_type, target_ref, state, attempts, provider_receipt, last_error_code, updated_at }) => ({ target_type, target_ref, state, attempts, provider_receipt, last_error_code, updated_at }));
  return {
    receipt_version: DELETION_RECEIPT_VERSION,
    state: deletionJob.state,
    physical_cleanup_state: deletionJob.physical_cleanup_state,
    completed_targets: targets.filter((target) => target.state === 'COMPLETED').length,
    failed_targets: targets.filter((target) => target.state === 'FAILED').length,
    targets
  };
}

module.exports = {
  LIFE_EVENT_LIST_DEFAULT, LIFE_EVENT_LIST_MAX,
  confirmLifeEventFromCandidate, listLifeEvents, getLifeEvent, reviseLifeEvent, deleteLifeEvent,
  publicLifeEvent, findLifeEvent, lifeEventDisplayText
};
