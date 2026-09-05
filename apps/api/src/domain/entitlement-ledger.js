'use strict';

const CAPABILITIES = new Set(['IMAGE_GENERATION', 'SYNTHESIZE_TTS', 'TRANSCRIBE_ASR']);
const ACTIONS = new Set(['GRANT', 'RESERVE', 'COMMIT', 'RELEASE']);
const GRANT_SOURCES = new Set(['PAYMENT_VERIFIED', 'TRIAL_GRANTED']);

class EntitlementLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function grant(entries, input) {
  const common = validatedCommon(input, 'GRANT');
  if (!GRANT_SOURCES.has(input.source)) {
    throw new EntitlementLedgerError('ENTITLEMENT_GRANT_SOURCE_INVALID', '权益只能由已验证支付事件或受控试用发放');
  }
  if (!nonEmpty(input.sourceEventId)) {
    throw new EntitlementLedgerError('VALIDATION_ERROR', 'sourceEventId 不能为空');
  }
  return appendIdempotently(entries, {
    ...common,
    job_id: null,
    source: input.source,
    source_event_id: input.sourceEventId,
    reserved_quantity: null
  });
}

function reserve(entries, input) {
  const common = validatedCommon(input, 'RESERVE');
  requireJobId(input.jobId);
  const existing = findByIdempotency(entries, common.account_id, common.idempotency_key);
  if (existing) return existing;
  const jobEntries = entriesForJob(entries, common.account_id, input.jobId, common.capability);
  if (jobEntries.length) throw new EntitlementLedgerError('ENTITLEMENT_JOB_ALREADY_FINALIZED', '该任务已经存在额度账本记录');
  const balance = balanceFor(entries, common.account_id, common.entitlement_id, common.capability);
  if (balance.available_quantity < common.quantity) {
    throw new EntitlementLedgerError('ENTITLEMENT_QUOTA_EXCEEDED', '当前媒体额度不足');
  }
  return append(entries, { ...common, job_id: input.jobId, source: null, source_event_id: null, reserved_quantity: null });
}

function commit(entries, input) {
  const common = validatedCommon(input, 'COMMIT');
  requireJobId(input.jobId);
  const existing = findByIdempotency(entries, common.account_id, common.idempotency_key);
  if (existing) return existing;
  const reservation = reservationFor(entries, common.account_id, input.jobId, common.entitlement_id, common.capability);
  if (!reservation) throw new EntitlementLedgerError('ENTITLEMENT_RESERVATION_REQUIRED', '提交额度前必须存在预留记录');
  if (hasTerminalAction(entries, common.account_id, input.jobId, common.capability)) {
    throw new EntitlementLedgerError('ENTITLEMENT_JOB_ALREADY_FINALIZED', '该任务额度已经结算');
  }
  if (common.quantity > reservation.quantity) {
    throw new EntitlementLedgerError('ENTITLEMENT_COMMIT_EXCEEDS_RESERVE', '实际用量不能超过预留额度');
  }
  return append(entries, { ...common, job_id: input.jobId, source: null, source_event_id: null, reserved_quantity: reservation.quantity });
}

function release(entries, input) {
  const common = validatedCommon(input, 'RELEASE');
  requireJobId(input.jobId);
  const existing = findByIdempotency(entries, common.account_id, common.idempotency_key);
  if (existing) return existing;
  const reservation = reservationFor(entries, common.account_id, input.jobId, common.entitlement_id, common.capability);
  if (!reservation) throw new EntitlementLedgerError('ENTITLEMENT_RESERVATION_REQUIRED', '返还额度前必须存在预留记录');
  if (hasTerminalAction(entries, common.account_id, input.jobId, common.capability)) {
    throw new EntitlementLedgerError('ENTITLEMENT_JOB_ALREADY_FINALIZED', '该任务额度已经结算');
  }
  if (common.quantity !== reservation.quantity) {
    throw new EntitlementLedgerError('ENTITLEMENT_RELEASE_MISMATCH', '返还额度必须等于已预留额度');
  }
  return append(entries, { ...common, job_id: input.jobId, source: null, source_event_id: null, reserved_quantity: reservation.quantity });
}

function balanceFor(entries, accountId, entitlementId, capability) {
  requireScope(accountId, entitlementId, capability);
  const scoped = entries.filter((entry) => entry.account_id === accountId && entry.entitlement_id === entitlementId && entry.capability === capability);
  const grantedQuantity = sum(scoped.filter((entry) => entry.action === 'GRANT'), 'quantity');
  const committedQuantity = sum(scoped.filter((entry) => entry.action === 'COMMIT'), 'quantity');
  const reservedQuantity = scoped.filter((entry) => entry.action === 'RESERVE').reduce((total, reservation) => {
    return hasTerminalAction(entries, accountId, reservation.job_id, capability) ? total : total + reservation.quantity;
  }, 0);
  return Object.freeze({ granted_quantity: grantedQuantity, committed_quantity: committedQuantity, reserved_quantity: reservedQuantity, available_quantity: grantedQuantity - committedQuantity - reservedQuantity });
}

function appendIdempotently(entries, entry) {
  const existing = findByIdempotency(entries, entry.account_id, entry.idempotency_key);
  if (existing) return existing;
  return append(entries, entry);
}

function append(entries, entry) {
  const immutable = Object.freeze({ ...entry });
  entries.push(immutable);
  return immutable;
}

function validatedCommon(input, action) {
  if (!ACTIONS.has(action)) throw new TypeError('Unsupported entitlement ledger action');
  const accountId = input?.accountId;
  const entitlementId = input?.entitlementId;
  const capability = input?.capability;
  const quantity = input?.quantity;
  const idempotencyKey = input?.idempotencyKey;
  requireScope(accountId, entitlementId, capability);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new EntitlementLedgerError('VALIDATION_ERROR', 'quantity 必须是正整数');
  if (!nonEmpty(idempotencyKey)) throw new EntitlementLedgerError('VALIDATION_ERROR', 'idempotencyKey 不能为空');
  return {
    entitlement_ledger_id: nonEmpty(input.entryId) ? input.entryId : null,
    account_id: accountId,
    entitlement_id: entitlementId,
    capability,
    action,
    quantity,
    idempotency_key: idempotencyKey,
    created_at: input.createdAt || new Date().toISOString()
  };
}

function requireScope(accountId, entitlementId, capability) {
  if (!nonEmpty(accountId) || !nonEmpty(entitlementId) || !CAPABILITIES.has(capability)) {
    throw new EntitlementLedgerError('VALIDATION_ERROR', '权益账本范围无效');
  }
}
function requireJobId(jobId) { if (!nonEmpty(jobId)) throw new EntitlementLedgerError('VALIDATION_ERROR', 'jobId 不能为空'); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
function sum(entries, field) { return entries.reduce((total, entry) => total + entry[field], 0); }
function findByIdempotency(entries, accountId, idempotencyKey) { return entries.find((entry) => entry.account_id === accountId && entry.idempotency_key === idempotencyKey); }
function entriesForJob(entries, accountId, jobId, capability) { return entries.filter((entry) => entry.account_id === accountId && entry.job_id === jobId && entry.capability === capability); }
function reservationFor(entries, accountId, jobId, entitlementId, capability) { return entries.find((entry) => entry.account_id === accountId && entry.job_id === jobId && entry.entitlement_id === entitlementId && entry.capability === capability && entry.action === 'RESERVE'); }
function hasTerminalAction(entries, accountId, jobId, capability) { return entries.some((entry) => entry.account_id === accountId && entry.job_id === jobId && entry.capability === capability && (entry.action === 'COMMIT' || entry.action === 'RELEASE')); }

module.exports = { CAPABILITIES, EntitlementLedgerError, balanceFor, commit, grant, release, reserve };
