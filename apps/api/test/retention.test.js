'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { applyRawInteractionRetention } = require('../src/domain/retention');
const { createSummary } = require('../src/domain/conversation-summary');

test('原始互动超过保留期后清除消息和未确认候选，但保留用户确认的关系资产', () => {
  const store = new DevelopmentStore({ accountIds: ['acct_test'] });
  const account = store.account('acct_test');
  const conversation = { conversation_id: 'cnv_old', account_id: account.account_id, status: 'OPEN' };
  store.conversations.set(conversation.conversation_id, conversation);
  const oldMessage = { message_id: 'msg_old', conversation_id: conversation.conversation_id, actor: 'USER', text: '将到期的原文', created_at: '2026-01-01T00:00:00.000Z', retention_expires_at: '2026-04-01T00:00:00.000Z' };
  store.messages.set('msg_old', oldMessage);
  const summary = createSummary({ summaryId: 'sum_old', accountId: account.account_id, conversationId: conversation.conversation_id, messages: [oldMessage], revocationEpoch: 0, text: '旧摘要', modelRouteId: 'qwen3.8-flash', promptVersion: 'conversation-summary.v1', retentionExpiresAt: oldMessage.retention_expires_at });
  store.conversationSummaries.set(summary.summary_id, summary);
  store.candidates.set('memc_old', { candidate_id: 'memc_old', account_id: account.account_id, source_message_id: 'msg_old', state: 'CANDIDATE' });
  store.assets.set('ras_confirmed', { asset_id: 'ras_confirmed', account_id: account.account_id, source_candidate_id: 'memc_confirmed', state: 'ACTIVE' });
  const result = applyRawInteractionRetention(store, account, new Date('2026-05-01T00:00:00.000Z'));
  assert.equal(result.expired_message_count, 1);
  assert.equal(store.messages.has('msg_old'), false);
  assert.equal(store.conversationSummaries.get('sum_old').state, 'INVALIDATED');
  assert.equal(store.candidates.get('memc_old').state, 'EXPIRED');
  assert.equal(store.assets.get('ras_confirmed').state, 'ACTIVE');
});
