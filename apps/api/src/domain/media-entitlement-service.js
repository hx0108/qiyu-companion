'use strict';

const { balanceFor, commit, grant, release, reserve, EntitlementLedgerError } = require('./entitlement-ledger');

const SUBSCRIPTION_ENTITLEMENTS = Object.freeze([
  Object.freeze({ capability: 'IMAGE_GENERATION', productField: 'image_quota', unit: 'IMAGES', factor: 1 }),
  Object.freeze({ capability: 'SYNTHESIZE_TTS', productField: 'tts_minutes', unit: 'SECONDS', factor: 60 }),
  Object.freeze({ capability: 'TRANSCRIBE_ASR', productField: 'asr_minutes', unit: 'SECONDS', factor: 60 })
]);

class MediaEntitlementService {
  constructor({ store, now = () => new Date(), activeSubscriptionStates = ['TRIAL', 'ACTIVE'] } = {}) {
    if (!store || !store.entitlementLedgers || !store.subscriptions || typeof store.next !== 'function') throw new TypeError('MediaEntitlementService requires a compatible store');
    this.store = store;
    this.now = now;
    this.activeSubscriptionStates = new Set(activeSubscriptionStates);
  }

  grantSubscriptionCycle({ subscription, product, sourceEventId }) {
    if (!subscription || !this.activeSubscriptionStates.has(subscription.state) || !validTimestamp(subscription.period_end)) {
      throw new EntitlementLedgerError('ENTITLEMENT_SUBSCRIPTION_INACTIVE', '订阅未处于可发放权益的状态');
    }
    if (!nonEmpty(sourceEventId)) throw new EntitlementLedgerError('VALIDATION_ERROR', 'sourceEventId 不能为空');
    const entitlementId = `${subscription.subscription_id}:${subscription.period_end}`;
    const entries = ledgerEntries(this.store);
    const grants = [];
    for (const definition of SUBSCRIPTION_ENTITLEMENTS) {
      const productQuantity = product?.[definition.productField];
      // 试用档只承诺 PRD 明示的图片和角色语音额度；未承诺的能力以 0
      // 表示且不写入虚假的账本记录。正式订阅仍要求每种额度均为正数。
      if (!Number.isInteger(productQuantity) || productQuantity < 0 || (productQuantity === 0 && subscription.state !== 'TRIAL')) {
        throw new EntitlementLedgerError('SUBSCRIPTION_PRODUCT_INVALID', '订阅商品额度无效');
      }
      if (productQuantity === 0) continue;
      const quantity = productQuantity * definition.factor;
      const entry = grant(entries, {
        entryId: this.store.next('ent'), accountId: subscription.account_id, entitlementId, capability: definition.capability, quantity,
        idempotencyKey: `${sourceEventId}:GRANT:${definition.capability}`, source: subscription.state === 'TRIAL' ? 'TRIAL_GRANTED' : 'PAYMENT_VERIFIED', sourceEventId
      });
      this.store.entitlementLedgers.set(entry.entitlement_ledger_id, entry);
      grants.push(entry);
    }
    return Object.freeze({ entitlement_id: entitlementId, grants: Object.freeze(grants) });
  }

  // 汇总账户在有效期内的各能力余额（GET /entitlements 用）。同一能力跨订阅周期合并展示，
  // resets_at 取最近一个仍在有效期内的周期截止时间。
  entitlementBalances(accountId, now = this.now()) {
    const entries = ledgerEntries(this.store);
    const activeEntitlements = [...this.store.subscriptions.values()]
      .filter((subscription) => subscription.account_id === accountId && this.activeSubscriptionStates.has(subscription.state) && validTimestamp(subscription.period_end) && new Date(subscription.period_end) > now)
      .map((subscription) => ({ entitlementId: `${subscription.subscription_id}:${subscription.period_end}`, resetsAt: subscription.period_end }))
      .sort((a, b) => (a.resetsAt < b.resetsAt ? -1 : 1));
    return SUBSCRIPTION_ENTITLEMENTS.map((definition) => {
      let granted = 0, committed = 0, reserved = 0;
      for (const { entitlementId } of activeEntitlements) {
        const balance = balanceFor(entries, accountId, entitlementId, definition.capability);
        granted += balance.granted_quantity;
        committed += balance.committed_quantity;
        reserved += balance.reserved_quantity;
      }
      return Object.freeze({
        capability: definition.capability, unit: definition.unit,
        granted_quantity: granted, committed_quantity: committed, reserved_quantity: reserved,
        available_quantity: granted - committed - reserved,
        resets_at: activeEntitlements.length > 0 ? activeEntitlements[activeEntitlements.length - 1].resetsAt : null
      });
    });
  }

  reserveImage({ accountId, jobId }) { return this.reserve({ accountId, jobId, capability: 'IMAGE_GENERATION', quantity: 1 }); }
  commitImage({ accountId, jobId }) { return this.commit({ accountId, jobId, capability: 'IMAGE_GENERATION', quantity: 1 }); }
  releaseImage({ accountId, jobId }) { return this.release({ accountId, jobId, capability: 'IMAGE_GENERATION' }); }

  reserve({ accountId, jobId, capability, quantity }) {
    const entitlementId = selectEntitlement(this.store, this.activeSubscriptionStates, accountId, capability, quantity, this.now());
    const entries = ledgerEntries(this.store);
    const entry = reserve(entries, { entryId: this.store.next('ent'), accountId, entitlementId, capability, jobId, quantity, idempotencyKey: `${jobId}:RESERVE` });
    this.store.entitlementLedgers.set(entry.entitlement_ledger_id, entry);
    return entry;
  }

  commit({ accountId, jobId, capability, quantity }) {
    const reservation = reservationFor(this.store, accountId, jobId, capability);
    if (!reservation) throw new EntitlementLedgerError('ENTITLEMENT_RESERVATION_REQUIRED', '媒体任务没有可提交的额度预留');
    const entries = ledgerEntries(this.store);
    const entry = commit(entries, { entryId: this.store.next('ent'), accountId, entitlementId: reservation.entitlement_id, capability, jobId, quantity, idempotencyKey: `${jobId}:COMMIT` });
    this.store.entitlementLedgers.set(entry.entitlement_ledger_id, entry);
    return entry;
  }

  release({ accountId, jobId, capability }) {
    const reservation = reservationFor(this.store, accountId, jobId, capability);
    if (!reservation) throw new EntitlementLedgerError('ENTITLEMENT_RESERVATION_REQUIRED', '媒体任务没有可返还的额度预留');
    const entries = ledgerEntries(this.store);
    const entry = release(entries, { entryId: this.store.next('ent'), accountId, entitlementId: reservation.entitlement_id, capability, jobId, quantity: reservation.quantity, idempotencyKey: `${jobId}:RELEASE` });
    this.store.entitlementLedgers.set(entry.entitlement_ledger_id, entry);
    return entry;
  }
}

function selectEntitlement(store, activeStates, accountId, capability, quantity, now) {
  const candidates = [...store.subscriptions.values()]
    .filter((subscription) => subscription.account_id === accountId && activeStates.has(subscription.state) && validTimestamp(subscription.period_end) && new Date(subscription.period_end) > now)
    .map((subscription) => ({ entitlementId: `${subscription.subscription_id}:${subscription.period_end}`, resetsAt: subscription.period_end }))
    // 先消耗更早到期的权益。这样试用和付费周期重叠时，试用成本仍能被准确归因。
    .sort((a, b) => a.resetsAt.localeCompare(b.resetsAt));
  const entries = ledgerEntries(store);
  for (const { entitlementId } of candidates) {
    const balance = balanceFor(entries, accountId, entitlementId, capability);
    if (balance.available_quantity >= quantity) return entitlementId;
  }
  throw new EntitlementLedgerError('ENTITLEMENT_QUOTA_EXCEEDED', '当前订阅没有可用媒体额度');
}
function reservationFor(store, accountId, jobId, capability) { return ledgerEntries(store).find((entry) => entry.account_id === accountId && entry.job_id === jobId && entry.capability === capability && entry.action === 'RESERVE'); }
function ledgerEntries(store) { return [...store.entitlementLedgers.values()]; }
function validTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

module.exports = { MediaEntitlementService, SUBSCRIPTION_ENTITLEMENTS };
