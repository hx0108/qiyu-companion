'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SubscriptionLifecycle, SubscriptionLifecycleError } = require('../src/domain/subscription-lifecycle');

const product = Object.freeze({ sku: 'qiyu_public_monthly_v1', price_fen: 3900, currency: 'CNY' });
function create(lifecycle = new SubscriptionLifecycle()) { return { lifecycle, ...lifecycle.createCheckout({ orderId: 'order-1', subscriptionId: 'sub-1', accountId: 'acct-1', product, channel: 'ALIPAY_H5', disclosureVersion: 'subscription_v1', createdAt: '2026-09-04T00:00:00.000Z' }) }; }
function event(type, overrides = {}) { return { verified: true, providerEventId: `event-${type}`, type, accountId: 'acct-1', subscriptionId: 'sub-1', transactionRef: 'transaction-1', sku: product.sku, effectiveAt: '2026-09-04T00:10:00.000Z', periodStart: '2026-09-04T00:10:00.000Z', periodEnd: '2026-10-04T00:10:00.000Z', ...overrides }; }

test('支付订单仅使用服务端商品价格，默认不自动续费并记录告知版本', () => {
  const { order, subscription } = create();
  assert.equal(order.amount_fen, 3900);
  assert.equal(order.auto_renew, false);
  assert.equal(subscription.state, 'PENDING');
  assert.equal(subscription.disclosure_version, 'subscription_v1');
});

test('已验证首次购买仅激活一次，并返回可供追加权益账本使用的稳定来源事件', () => {
  const { lifecycle } = create();
  const first = lifecycle.applyVerifiedEvent(event('PURCHASE_SUCCEEDED'));
  const replay = lifecycle.applyVerifiedEvent(event('PURCHASE_SUCCEEDED'));
  assert.equal(first.outcome, 'APPLIED');
  assert.equal(first.subscription.state, 'ACTIVE');
  assert.deepEqual(first.entitlement_grant, { entitlement_id: 'sub-1:2026-10-04T00:10:00.000Z', source_event_id: 'event-PURCHASE_SUCCEEDED' });
  assert.equal(replay, first);
  assert.equal(lifecycle.events.size, 1);
  assert.doesNotMatch(JSON.stringify([...lifecycle.events.values()]), /transaction-1/);
  assert.doesNotMatch(JSON.stringify(first.subscription), /transaction-1/);
});

test('未验签、未知、跨账户交易和重复事件载荷变化均不会发放权益', () => {
  const { lifecycle } = create();
  assert.throws(() => lifecycle.applyVerifiedEvent({ ...event('PURCHASE_SUCCEEDED'), verified: false }), (error) => error instanceof SubscriptionLifecycleError && error.code === 'PAYMENT_EVENT_UNVERIFIED');
  const unknown = lifecycle.applyVerifiedEvent(event('UNRECOGNIZED_CHANNEL_EVENT'));
  assert.deepEqual(unknown, { outcome: 'QUARANTINED', reason: 'PAYMENT_EVENT_UNKNOWN', subscription: null, entitlement_grant: null });
  const first = lifecycle.applyVerifiedEvent(event('PURCHASE_SUCCEEDED', { providerEventId: 'event-account-conflict', transactionRef: 'transaction-owned-by-other' }));
  assert.equal(first.outcome, 'APPLIED');
  lifecycle.createCheckout({ orderId: 'order-2', subscriptionId: 'sub-2', accountId: 'acct-2', product, channel: 'WECHAT_H5', disclosureVersion: 'subscription_v1' });
  const crossAccount = lifecycle.applyVerifiedEvent(event('PURCHASE_SUCCEEDED', { providerEventId: 'event-cross-account', accountId: 'acct-2', subscriptionId: 'sub-2', transactionRef: 'transaction-owned-by-other' }));
  assert.equal(crossAccount.reason, 'PAYMENT_EVENT_TRANSACTION_ACCOUNT_CONFLICT');
  assert.throws(() => lifecycle.applyVerifiedEvent(event('PURCHASE_SUCCEEDED', { providerEventId: 'event-account-conflict', effectiveAt: '2026-09-04T00:11:00.000Z' })), (error) => error.code === 'PAYMENT_EVENT_REPLAY_CONFLICT');
});

test('取消保留当期权益，到期才降级；扣款失败、宽限、恢复与退款遵循确定性状态机', () => {
  const { lifecycle } = create();
  lifecycle.applyVerifiedEvent(event('PURCHASE_SUCCEEDED'));
  const cancelled = lifecycle.applyVerifiedEvent(event('CANCELLED', { providerEventId: 'event-cancel', effectiveAt: '2026-09-10T00:00:00.000Z' }));
  assert.equal(cancelled.subscription.state, 'CANCEL_AT_PERIOD_END');
  assert.equal(cancelled.subscription.period_end, '2026-10-04T00:10:00.000Z');
  const expired = lifecycle.applyVerifiedEvent(event('EXPIRED', { providerEventId: 'event-expired', effectiveAt: '2026-10-04T00:10:01.000Z' }));
  assert.equal(expired.subscription.state, 'EXPIRED');
  const restored = lifecycle.applyVerifiedEvent(event('RESTORED', { providerEventId: 'event-restored', effectiveAt: '2026-10-04T00:11:00.000Z', periodStart: '2026-10-04T00:11:00.000Z', periodEnd: '2026-11-04T00:11:00.000Z' }));
  assert.equal(restored.subscription.state, 'ACTIVE');
  const failed = lifecycle.applyVerifiedEvent(event('PAYMENT_FAILED', { providerEventId: 'event-failed', effectiveAt: '2026-11-04T00:11:01.000Z' }));
  assert.equal(failed.subscription.state, 'BILLING_RETRY');
  const grace = lifecycle.applyVerifiedEvent(event('GRACE_STARTED', { providerEventId: 'event-grace', effectiveAt: '2026-11-04T00:12:00.000Z', gracePeriodEnd: '2026-11-10T00:00:00.000Z' }));
  assert.equal(grace.subscription.state, 'GRACE_PERIOD');
  const refunded = lifecycle.applyVerifiedEvent(event('REFUND_FULL', { providerEventId: 'event-refund', effectiveAt: '2026-11-05T00:00:00.000Z' }));
  assert.equal(refunded.subscription.state, 'REFUNDED');
  assert.equal(refunded.entitlement_grant, null);
});
