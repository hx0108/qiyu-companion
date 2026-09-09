'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicPushEnvelope } = require('../src/domain/push-privacy-policy');

test('push envelope never exposes private notification content on the lock screen', () => {
  const envelope = publicPushEnvelope({ notification_id: 'ntf_1', title: '退款成功', body: '私密详情', account_id: 'acct_1' });
  assert.deepEqual(envelope, { notification_id: 'ntf_1', title: '栖语有一条账户通知', body: '打开栖语后查看详情。', route: '/notifications', privacy: 'NO_SENSITIVE_CONTENT', collapse_key: 'qiyu-account-notice' });
  assert.equal(JSON.stringify(envelope).includes('退款成功'), false);
  assert.equal(JSON.stringify(envelope).includes('acct_1'), false);
});
