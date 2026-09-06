'use strict';

class DevelopmentStore {
  constructor({ accountIds = ['acct_dev_alice', 'acct_dev_bob'] } = {}) {
    this.accounts = new Map(accountIds.map((accountId) => [accountId, account(accountId)]));
    this.characters = new Map();
    this.conversations = new Map();
    this.messages = new Map();
    this.conversationSummaries = new Map();
    this.conversationSummaryJobs = new Map();
    this.assetEmbeddingJobs = new Map();
    this.assetEmbeddings = new Map();
    this.assetEmbeddingDeadLetters = new Map();
    this.conversationSummaryDeadLetters = new Map();
    this.outboxEvents = new Map();
    this.candidates = new Map();
    this.assets = new Map();
    this.mediaJobs = new Map();
    this.mediaAssets = new Map();
    this.entitlementLedgers = new Map();
    this.subscriptions = new Map();
    this.subscriptionOrders = new Map();
    this.paymentEvents = new Map();
    this.paymentEventQuarantines = new Map();
    this.paymentTransactionOwners = new Map();
    this.dailyChatUsage = new Map();
    this.operationMetrics = new Map();
    this.deletionJobs = new Map();
    this.complaints = new Map();
    this.proactiveEvents = new Map();
    this.proactiveMessages = new Map();
    this.worldStates = new Map();
    this.worldStateEvents = new Map();
    this.messageFeedback = new Map();
    this.trialFeedback = new Map();
    this.ocImports = new Map();
    this.contentRightsReviews = new Map();
    this.contentRightsAppeals = new Map();
    this.contentRightsDecisions = new Map();
    this.ageReviewDecisions = new Map();
    this.idempotency = new Map();
    this.sequence = 0;
  }

  next(prefix) {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(6, '0')}`;
  }

  account(accountId) { return this.accounts.get(accountId); }

  noticeFor(accountId) {
    const account = this.account(accountId);
    return account.required_notice;
  }

  activeCharacter(accountId) {
    return [...this.characters.values()].find((item) => item.account_id === accountId && item.status === 'ACTIVE');
  }

  idempotencyKey(accountId, method, pathname, key) {
    return `${accountId}:${method}:${pathname}:${key}`;
  }
}

function account(accountId) {
  return {
    account_id: accountId,
    account_status: 'OPEN',
    age_status: 'AGE_UNVERIFIED',
    age_reason_codes: [],
    declared_date_of_birth: null,
    age_review_requested_at: null,
    raw_interaction_retention_days: 90,
    user_pause_state: 'ACTIVE',
    safety_mode: 'R0_NORMAL',
    service_mode: 'FULL',
    revocation_epoch: 0,
    emergency_contact: null,
    interaction_activity: { first_heartbeat_at: null, last_heartbeat_at: null, last_reminder_at: null },
    proactive_preferences: { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 0 },
    required_notice: {
      notice_id: `ntc_${accountId}`,
      type: 'AI_IDENTITY_FIRST_SESSION',
      notice_version: 'ai_identity_m1.0',
      state: 'DUE',
      displayed_at: null
    }
  };
}

module.exports = { DevelopmentStore };
