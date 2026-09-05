'use strict';

const { createHash } = require('node:crypto');

const SUBSCRIPTION_STATES = new Set(['PENDING', 'TRIAL', 'ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END', 'EXPIRED', 'REFUNDED', 'REVOKED']);
const PAYMENT_EVENTS = new Set(['PURCHASE_SUCCEEDED', 'RENEWAL_SUCCEEDED', 'PAYMENT_FAILED', 'GRACE_STARTED', 'CANCELLED', 'EXPIRED', 'RESTORED', 'REFUND_FULL', 'REFUND_PARTIAL', 'REVOKED', 'PRODUCT_CHANGED']);
const ENTITLEMENT_GRANT_EVENTS = new Set(['PURCHASE_SUCCEEDED', 'RENEWAL_SUCCEEDED', 'RESTORED']);

class SubscriptionLifecycleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class SubscriptionLifecycle {
  constructor({ subscriptions, orders, events, quarantinedEvents, transactionOwners } = {}) {
    this.subscriptions = subscriptions || new Map();
    this.orders = orders || new Map();
    this.events = events || new Map();
    this.quarantinedEvents = quarantinedEvents || new Map();
    this.transactionOwners = transactionOwners || new Map();
  }

  createCheckout({ orderId, subscriptionId, accountId, product, channel, autoRenew = false, disclosureVersion, createdAt }) {
    requireId(orderId, 'orderId'); requireId(subscriptionId, 'subscriptionId'); requireId(accountId, 'accountId'); requireId(channel, 'channel'); requireId(disclosureVersion, 'disclosureVersion');
    if (this.orders.has(orderId) || this.subscriptions.has(subscriptionId)) throw new SubscriptionLifecycleError('SUBSCRIPTION_ALREADY_EXISTS', '订单或订阅已存在');
    validateServerProduct(product);
    if (typeof autoRenew !== 'boolean') throw new SubscriptionLifecycleError('VALIDATION_ERROR', 'autoRenew 必须为布尔值');
    const now = createdAt || new Date().toISOString();
    const subscription = Object.freeze({ subscription_id: subscriptionId, account_id: accountId, sku: product.sku, state: 'PENDING', channel, auto_renew: autoRenew, disclosure_version: disclosureVersion, period_start: null, period_end: null, grace_period_end: null, refund_status: 'NONE', transaction_ref_hash: null, created_at: now, updated_at: now });
    const order = Object.freeze({ order_id: orderId, account_id: accountId, subscription_id: subscriptionId, sku: product.sku, amount_fen: product.price_fen, currency: product.currency, state: 'PENDING_PAYMENT', channel, auto_renew: autoRenew, disclosure_version: disclosureVersion, created_at: now });
    this.subscriptions.set(subscriptionId, subscription); this.orders.set(orderId, order);
    return { subscription, order };
  }

  applyVerifiedEvent(event) {
    validateEvent(event);
    const fingerprint = eventFingerprint(event);
    const eventHash = sha256(fingerprint);
    const previous = this.events.get(event.providerEventId);
    if (previous) {
      if (previous.event_hash !== eventHash) throw new SubscriptionLifecycleError('PAYMENT_EVENT_REPLAY_CONFLICT', '同一渠道事件标识的载荷不一致');
      return previous.result;
    }
    if (!PAYMENT_EVENTS.has(event.type)) return this.quarantine(event, 'PAYMENT_EVENT_UNKNOWN');
    const subscription = this.subscriptions.get(event.subscriptionId);
    if (!subscription || subscription.account_id !== event.accountId) return this.quarantine(event, 'PAYMENT_EVENT_SUBSCRIPTION_MISMATCH');
    const transactionRefHash = sha256(event.transactionRef);
    const owner = this.transactionOwners.get(transactionRefHash);
    if (owner && owner !== event.accountId) return this.quarantine(event, 'PAYMENT_EVENT_TRANSACTION_ACCOUNT_CONFLICT');
    if (event.sku !== subscription.sku) return this.quarantine(event, 'PAYMENT_EVENT_PRODUCT_MISMATCH');
    const next = transition(subscription, event, transactionRefHash);
    if (!next) return this.quarantine(event, 'PAYMENT_EVENT_STATE_INVALID');
    this.transactionOwners.set(transactionRefHash, event.accountId);
    this.subscriptions.set(subscription.subscription_id, next.subscription);
    const result = Object.freeze({ outcome: 'APPLIED', subscription: next.subscription, entitlement_grant: next.grant ? Object.freeze({ entitlement_id: `${subscription.subscription_id}:${event.periodEnd}`, source_event_id: event.providerEventId }) : null });
    this.events.set(event.providerEventId, eventRecord(event, eventHash, transactionRefHash, result));
    return result;
  }

  quarantine(event, reason) {
    const result = Object.freeze({ outcome: 'QUARANTINED', reason, subscription: null, entitlement_grant: null });
    const eventHash = sha256(eventFingerprint(event));
    const transactionRefHash = sha256(event.transactionRef);
    this.events.set(event.providerEventId, eventRecord(event, eventHash, transactionRefHash, result));
    this.quarantinedEvents.set(event.providerEventId, Object.freeze({ provider_event_id: event.providerEventId, type: event.type, transaction_ref_hash: transactionRefHash, reason, received_at: event.effectiveAt }));
    return result;
  }
}

function transition(subscription, event, transactionRefHash) {
  const now = event.effectiveAt;
  const period = periodFrom(event);
  const base = { ...subscription, updated_at: now, transaction_ref_hash: transactionRefHash };
  if (event.type === 'PURCHASE_SUCCEEDED' && subscription.state === 'PENDING') return applied({ ...base, state: 'ACTIVE', period_start: period.start, period_end: period.end, grace_period_end: null, refund_status: 'NONE' }, true);
  if (event.type === 'RENEWAL_SUCCEEDED' && ['ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END'].includes(subscription.state)) return applied({ ...base, state: 'ACTIVE', period_start: period.start, period_end: period.end, grace_period_end: null, refund_status: 'NONE' }, true);
  if (event.type === 'PAYMENT_FAILED' && ['ACTIVE', 'GRACE_PERIOD'].includes(subscription.state)) return applied({ ...base, state: 'BILLING_RETRY' });
  if (event.type === 'GRACE_STARTED' && ['ACTIVE', 'BILLING_RETRY'].includes(subscription.state) && validTimestamp(event.gracePeriodEnd)) return applied({ ...base, state: 'GRACE_PERIOD', grace_period_end: event.gracePeriodEnd });
  if (event.type === 'CANCELLED' && ['ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD'].includes(subscription.state)) return applied({ ...base, state: 'CANCEL_AT_PERIOD_END', auto_renew: false });
  if (event.type === 'EXPIRED' && ['ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END'].includes(subscription.state)) return applied({ ...base, state: 'EXPIRED', grace_period_end: null });
  if (event.type === 'RESTORED' && ['EXPIRED', 'REFUNDED', 'REVOKED'].includes(subscription.state)) return applied({ ...base, state: 'ACTIVE', period_start: period.start, period_end: period.end, grace_period_end: null, refund_status: 'NONE' }, true);
  if (event.type === 'REFUND_PARTIAL' && !['PENDING', 'REVOKED'].includes(subscription.state)) return applied({ ...base, refund_status: 'PARTIAL' });
  if (event.type === 'REFUND_FULL' && !['PENDING', 'REVOKED'].includes(subscription.state)) return applied({ ...base, state: 'REFUNDED', auto_renew: false, refund_status: 'FULL', grace_period_end: null });
  if (event.type === 'REVOKED' && subscription.state !== 'PENDING') return applied({ ...base, state: 'REVOKED', auto_renew: false, grace_period_end: null });
  if (event.type === 'PRODUCT_CHANGED' && ['ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END'].includes(subscription.state)) return applied(base);
  return null;
}

function applied(subscription, grant = false) { return { subscription: Object.freeze(subscription), grant }; }
function eventRecord(event, eventHash, transactionRefHash, result) {
  return Object.freeze({ provider_event_id: event.providerEventId, account_id: event.accountId, subscription_id: event.subscriptionId, event_type: event.type, transaction_ref_hash: transactionRefHash, event_hash: eventHash, outcome: result.outcome, quarantine_reason: result.reason || null, effective_at: event.effectiveAt, result });
}
function periodFrom(event) { if (!validTimestamp(event.periodStart) || !validTimestamp(event.periodEnd) || event.periodStart >= event.periodEnd) throw new SubscriptionLifecycleError('PAYMENT_EVENT_PERIOD_INVALID', '支付事件订阅周期无效'); return { start: event.periodStart, end: event.periodEnd }; }
function validateServerProduct(product) { if (!product || !nonEmpty(product.sku) || !Number.isInteger(product.price_fen) || product.price_fen <= 0 || product.currency !== 'CNY') throw new SubscriptionLifecycleError('SUBSCRIPTION_PRODUCT_INVALID', '服务端商品配置无效'); }
function validateEvent(event) { if (!event || event.verified !== true) throw new SubscriptionLifecycleError('PAYMENT_EVENT_UNVERIFIED', '未验签支付事件不能改变订阅或权益'); for (const field of ['providerEventId', 'type', 'accountId', 'subscriptionId', 'transactionRef', 'sku', 'effectiveAt']) requireId(event[field], field); if (!validTimestamp(event.effectiveAt)) throw new SubscriptionLifecycleError('PAYMENT_EVENT_TIMESTAMP_INVALID', '支付事件时间无效'); }
function eventFingerprint(event) { return JSON.stringify([event.type, event.accountId, event.subscriptionId, sha256(event.transactionRef), event.sku, event.effectiveAt, event.periodStart || null, event.periodEnd || null, event.gracePeriodEnd || null]); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function validTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function requireId(value, field) { if (!nonEmpty(value)) throw new SubscriptionLifecycleError('VALIDATION_ERROR', `${field} 不能为空`); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

module.exports = { ENTITLEMENT_GRANT_EVENTS, PAYMENT_EVENTS, SUBSCRIPTION_STATES, SubscriptionLifecycle, SubscriptionLifecycleError };
