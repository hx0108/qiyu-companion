'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EntitlementLedgerError, balanceFor, commit, grant, release, reserve } = require('../src/domain/entitlement-ledger');

function paymentGrant(entries, quantity = 15) {
  return grant(entries, {
    entryId: 'ledger-grant-1', accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', quantity,
    idempotencyKey: 'payment-event-1:GRANT', source: 'PAYMENT_VERIFIED', sourceEventId: 'payment-event-1', createdAt: '2026-09-04T00:00:00.000Z'
  });
}

test('权益账本仅允许支付验签或受控试用作为发放来源', () => {
  const entries = [];
  const trial = grant(entries, {
    entryId: 'ledger-trial-1', accountId: 'acct-1', entitlementId: 'trial-period-1', capability: 'IMAGE_GENERATION', quantity: 3,
    idempotencyKey: 'trial-1:GRANT', source: 'TRIAL_GRANTED', sourceEventId: 'trial-1'
  });
  assert.equal(trial.source, 'TRIAL_GRANTED');
  assert.throws(() => grant(entries, {
    entryId: 'ledger-invalid-1', accountId: 'acct-1', entitlementId: 'trial-period-2', capability: 'IMAGE_GENERATION', quantity: 3,
    idempotencyKey: 'invalid-1:GRANT', source: 'MANUAL_GRANT', sourceEventId: 'invalid-1'
  }), (error) => error instanceof EntitlementLedgerError && error.code === 'ENTITLEMENT_GRANT_SOURCE_INVALID');
});

test('权益账本以追加记录完成预留、按实际量提交，并自动释放多预留部分', () => {
  const entries = [];
  paymentGrant(entries, 15);
  reserve(entries, { entryId: 'ledger-reserve-1', accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 3, idempotencyKey: 'job-1:RESERVE' });
  assert.deepEqual(balanceFor(entries, 'acct-1', 'sub-period-1', 'IMAGE_GENERATION'), { granted_quantity: 15, committed_quantity: 0, reserved_quantity: 3, available_quantity: 12 });
  commit(entries, { entryId: 'ledger-commit-1', accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 1, idempotencyKey: 'job-1:COMMIT' });
  assert.deepEqual(balanceFor(entries, 'acct-1', 'sub-period-1', 'IMAGE_GENERATION'), { granted_quantity: 15, committed_quantity: 1, reserved_quantity: 0, available_quantity: 14 });
  assert.deepEqual(entries.map((entry) => entry.action), ['GRANT', 'RESERVE', 'COMMIT']);
  assert.equal(entries[2].reserved_quantity, 3);
});

test('重复预留或提交使用同一幂等键只返回原账本记录', () => {
  const entries = [];
  paymentGrant(entries, 2);
  const reserved = reserve(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 1, idempotencyKey: 'job-1:RESERVE' });
  assert.equal(reserve(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 1, idempotencyKey: 'job-1:RESERVE' }), reserved);
  const committed = commit(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 1, idempotencyKey: 'job-1:COMMIT' });
  assert.equal(commit(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 1, idempotencyKey: 'job-1:COMMIT' }), committed);
  assert.equal(entries.length, 3);
});

test('失败或审核拒绝用 RELEASE 全额返还预留额度，且不会允许重复终结', () => {
  const entries = [];
  paymentGrant(entries, 1);
  reserve(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-2', quantity: 1, idempotencyKey: 'job-2:RESERVE' });
  release(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-2', quantity: 1, idempotencyKey: 'job-2:RELEASE' });
  assert.deepEqual(balanceFor(entries, 'acct-1', 'sub-period-1', 'IMAGE_GENERATION'), { granted_quantity: 1, committed_quantity: 0, reserved_quantity: 0, available_quantity: 1 });
  assert.throws(() => commit(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-2', quantity: 1, idempotencyKey: 'job-2:COMMIT' }), (error) => error instanceof EntitlementLedgerError && error.code === 'ENTITLEMENT_JOB_ALREADY_FINALIZED');
});

test('未验证支付、余额不足、越过预留量都会被确定性拒绝', () => {
  const entries = [];
  assert.throws(() => grant(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', quantity: 1, idempotencyKey: 'forged:GRANT', source: 'CLIENT', sourceEventId: 'forged' }), (error) => error.code === 'ENTITLEMENT_GRANT_SOURCE_INVALID');
  paymentGrant(entries, 1);
  assert.throws(() => reserve(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-too-large', quantity: 2, idempotencyKey: 'job-too-large:RESERVE' }), (error) => error.code === 'ENTITLEMENT_QUOTA_EXCEEDED');
  reserve(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 1, idempotencyKey: 'job-1:RESERVE' });
  assert.throws(() => commit(entries, { accountId: 'acct-1', entitlementId: 'sub-period-1', capability: 'IMAGE_GENERATION', jobId: 'job-1', quantity: 2, idempotencyKey: 'job-1:COMMIT' }), (error) => error.code === 'ENTITLEMENT_COMMIT_EXCEEDS_RESERVE');
});
