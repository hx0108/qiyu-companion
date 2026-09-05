'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSummary, invalidateSummaries, validSummary } = require('../src/domain/conversation-summary');
const messages = [
  { message_id: 'm1', conversation_id: 'c1', actor: 'USER', text: '你好', created_at: '2026-09-01T00:00:00Z' },
  { message_id: 'm2', conversation_id: 'c1', actor: 'ASSISTANT', text: '你好呀', created_at: '2026-09-01T00:01:00Z' }
];
test('摘要绑定连续源消息与撤销纪元，源内容变化后不可再使用', () => {
  const summary = createSummary({ summaryId: 's1', accountId: 'a1', conversationId: 'c1', messages, revocationEpoch: 0, text: '一次问候', modelRouteId: 'qwen3.8-flash', promptVersion: 'conversation-summary.v1', retentionExpiresAt: '2026-12-01T00:00:00Z' });
  assert.equal(validSummary([summary], messages, 'c1', 0).summary_id, 's1');
  assert.equal(validSummary([summary], [{ ...messages[0], text: '已篡改' }, messages[1]], 'c1', 0), null);
  assert.equal(validSummary([summary], messages, 'c1', 1), null);
});
test('删除命中摘要源区间会立即失效', () => {
  const summary = createSummary({ summaryId: 's1', accountId: 'a1', conversationId: 'c1', messages, revocationEpoch: 0, text: '一次问候', modelRouteId: 'qwen3.8-flash', promptVersion: 'conversation-summary.v1', retentionExpiresAt: '2026-12-01T00:00:00Z' });
  const [invalidated] = invalidateSummaries([summary], messages, 'c1', ['m2']);
  assert.equal(invalidated.state, 'INVALIDATED');
});

test('过期摘要不会被重新送入模型上下文', () => {
  const summary = createSummary({ summaryId: 's1', accountId: 'a1', conversationId: 'c1', messages, revocationEpoch: 0, text: '一次问候', modelRouteId: 'qwen3.8-flash', promptVersion: 'conversation-summary.v1', retentionExpiresAt: '2026-09-01T00:00:00Z' });
  assert.equal(validSummary([summary], messages, 'c1', 0, '2026-09-02T00:00:00Z'), null);
});
