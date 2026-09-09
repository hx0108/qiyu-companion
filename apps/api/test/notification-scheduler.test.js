'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { scheduleAccountNotifications } = require('../src/domain/notification-scheduler');

test('notification scheduler emits lifecycle notices once per account event', () => {
  const store = new DevelopmentStore();
  const account = store.accounts.get('acct_dev_alice');
  const now = new Date('2026-09-09T00:00:00.000Z');
  account.safety_mode = 'R2_CRISIS';
  account.revocation_epoch = 7;

  store.subscriptions.set('sub_trial', {
    subscription_id: 'sub_trial', account_id: account.account_id, channel: 'DEVELOPMENT_TRIAL',
    state: 'TRIAL', auto_renew: false, refund_status: 'NONE', period_end: '2026-09-09T12:00:00.000Z'
  });
  store.subscriptions.set('sub_paid', {
    subscription_id: 'sub_paid', account_id: account.account_id, channel: 'TENCENT_PAY',
    state: 'ACTIVE', auto_renew: true, refund_status: 'PARTIAL', period_end: '2026-09-12T00:00:00.000Z'
  });
  store.paymentEvents.set('evt_renewed', {
    provider_event_id: 'evt_renewed', account_id: account.account_id, subscription_id: 'sub_paid',
    event_type: 'RENEWAL_SUCCEEDED', outcome: 'APPLIED'
  });
  store.deletionJobs.set('del_done', {
    deletion_job_id: 'del_done', account_id: account.account_id, scope: 'ACCOUNT', state: 'COMPLETED'
  });

  const first = scheduleAccountNotifications(store, account, now);
  assert.deepEqual(new Set(first.map((item) => item.type)), new Set([
    'TRIAL_ENDING', 'SUBSCRIPTION_RENEWAL_REMINDER', 'SUBSCRIPTION_RENEWED',
    'REFUND_STATUS_CHANGED', 'ACCOUNT_DELETION_COMPLETED', 'SAFETY_SUPPORT_STARTED'
  ]));
  assert.equal(scheduleAccountNotifications(store, account, now).length, 0);
  assert.equal([...store.notifications.values()].every((item) => item.dedupe_key && item.account_id === account.account_id), true);
});

test('notification scheduler does not leak another account lifecycle', () => {
  const store = new DevelopmentStore();
  store.subscriptions.set('sub_bob', {
    subscription_id: 'sub_bob', account_id: 'acct_dev_bob', channel: 'DEVELOPMENT_TRIAL',
    state: 'TRIAL', auto_renew: false, refund_status: 'NONE', period_end: '2026-09-09T12:00:00.000Z'
  });
  assert.equal(scheduleAccountNotifications(store, store.accounts.get('acct_dev_alice'), new Date('2026-09-09T00:00:00.000Z')).length, 0);
});
