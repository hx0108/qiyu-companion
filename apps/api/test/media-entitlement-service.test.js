'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { EntitlementLedgerError, balanceFor } = require('../src/domain/entitlement-ledger');
const { MediaEntitlementService } = require('../src/domain/media-entitlement-service');

function activeSubscription() { return { subscription_id: 'sub_1', account_id: 'acct_dev_alice', state: 'ACTIVE', period_end: '2026-10-04T00:00:00.000Z' }; }
function product() { return { image_quota: 2, tts_minutes: 30, asr_minutes: 15 }; }

test('已验证订阅周期只追加一次各媒体额度，并为图片任务预留、提交与返还', () => {
  const store = new DevelopmentStore();
  store.subscriptions.set('sub_1', activeSubscription());
  const service = new MediaEntitlementService({ store, now: () => new Date('2026-09-04T00:00:00.000Z') });
  const first = service.grantSubscriptionCycle({ subscription: activeSubscription(), product: product(), sourceEventId: 'payment-event-1' });
  const replay = service.grantSubscriptionCycle({ subscription: activeSubscription(), product: product(), sourceEventId: 'payment-event-1' });
  assert.equal(first.entitlement_id, 'sub_1:2026-10-04T00:00:00.000Z');
  assert.equal(replay.grants[0].entitlement_ledger_id, first.grants[0].entitlement_ledger_id);
  const reserved = service.reserveImage({ accountId: 'acct_dev_alice', jobId: 'img_1' });
  assert.equal(reserved.action, 'RESERVE');
  assert.deepEqual(balanceFor([...store.entitlementLedgers.values()], 'acct_dev_alice', first.entitlement_id, 'IMAGE_GENERATION'), { granted_quantity: 2, committed_quantity: 0, reserved_quantity: 1, available_quantity: 1 });
  service.commitImage({ accountId: 'acct_dev_alice', jobId: 'img_1' });
  service.reserveImage({ accountId: 'acct_dev_alice', jobId: 'img_2' });
  service.releaseImage({ accountId: 'acct_dev_alice', jobId: 'img_2' });
  assert.deepEqual(balanceFor([...store.entitlementLedgers.values()], 'acct_dev_alice', first.entitlement_id, 'IMAGE_GENERATION'), { granted_quantity: 2, committed_quantity: 1, reserved_quantity: 0, available_quantity: 1 });
});

test('没有有效订阅或额度耗尽时，图片任务在调用供应商前被拒绝', () => {
  const store = new DevelopmentStore();
  const service = new MediaEntitlementService({ store, now: () => new Date('2026-09-04T00:00:00.000Z') });
  assert.throws(() => service.reserveImage({ accountId: 'acct_dev_alice', jobId: 'img_missing' }), (error) => error instanceof EntitlementLedgerError && error.code === 'ENTITLEMENT_QUOTA_EXCEEDED');
  store.subscriptions.set('sub_1', activeSubscription());
  service.grantSubscriptionCycle({ subscription: activeSubscription(), product: { image_quota: 1, tts_minutes: 30, asr_minutes: 15 }, sourceEventId: 'payment-event-1' });
  service.reserveImage({ accountId: 'acct_dev_alice', jobId: 'img_full' });
  assert.throws(() => service.reserveImage({ accountId: 'acct_dev_alice', jobId: 'img_over' }), (error) => error.code === 'ENTITLEMENT_QUOTA_EXCEEDED');
});
