'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { COMPLETED_TURN_MESSAGE_THRESHOLD, MAX_SUMMARY_JOB_ATTEMPTS, enqueueConversationSummary, replayConversationSummaryDeadLetter, runNextConversationSummaryJob } = require('../src/domain/conversation-summary-worker');

test('摘要 worker 仅在 30 个完整回合边界创建，并捕获撤销与源范围', async () => {
  const store = new DevelopmentStore({ accountIds: ['acct_test'] });
  const account = store.account('acct_test');
  const conversation = { conversation_id: 'cnv_summary', account_id: account.account_id, character_id: 'chr_test', status: 'OPEN' };
  store.conversations.set(conversation.conversation_id, conversation);
  for (let index = 0; index < COMPLETED_TURN_MESSAGE_THRESHOLD; index += 1) {
    store.messages.set(`msg_${index}`, { message_id: `msg_${index}`, conversation_id: conversation.conversation_id, actor: index % 2 ? 'ASSISTANT' : 'USER', text: `消息 ${index}`, created_at: `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`, retention_expires_at: '2026-12-01T00:00:00.000Z' });
  }
  const job = enqueueConversationSummary({ store, account, conversation, now: new Date('2026-09-02T00:00:00Z') });
  assert.equal(job.state, 'PENDING');
  const [event] = store.outboxEvents.values();
  assert.deepEqual({ aggregate_type: event.aggregate_type, aggregate_id: event.aggregate_id, event_type: event.event_type, payload: event.payload }, {
    aggregate_type: 'CONVERSATION_SUMMARY_JOB', aggregate_id: job.job_id, event_type: 'conversation.summary_requested.v1',
    payload: { conversation_id: conversation.conversation_id, source_to_id: 'msg_59', captured_revocation_epoch: 0 }
  });
  const generated = await runNextConversationSummaryJob({ store, summaryGenerator: async ({ messages }) => ({ text: `共 ${messages.length} 条消息`, provider: 'spy', modelVersion: 'spy-v1' }), now: new Date('2026-09-02T00:00:00Z') });
  assert.equal(generated.state, 'COMPLETED');
  assert.equal(generated.summary.summary.state, 'ACTIVE');
  assert.equal(generated.summary.summary.source_from_id, 'msg_0');
  assert.equal(generated.summary.summary.source_to_id, 'msg_59');
  assert.equal(generated.summary.summary.retention_expires_at, '2026-12-01T00:00:00.000Z');
  assert.equal((await runNextConversationSummaryJob({ store, summaryGenerator: async () => { throw new Error('不应重试'); }, now: new Date('2026-09-02T00:00:00Z') })).state, 'IDLE');
});

test('源消息撤销会取消尚未运行的摘要任务，不允许晚到写入', () => {
  const store = new DevelopmentStore({ accountIds: ['acct_test'] });
  const account = store.account('acct_test');
  const conversation = { conversation_id: 'cnv_cancel', account_id: account.account_id, status: 'OPEN' };
  store.conversations.set(conversation.conversation_id, conversation);
  for (let index = 0; index < COMPLETED_TURN_MESSAGE_THRESHOLD; index += 1) {
    store.messages.set(`msg_${index}`, { message_id: `msg_${index}`, conversation_id: conversation.conversation_id, actor: 'USER', text: `消息 ${index}`, created_at: `2026-09-01T01:${String(index).padStart(2, '0')}:00.000Z` });
  }
  const job = enqueueConversationSummary({ store, account, conversation, now: new Date('2026-09-02T00:00:00Z') });
  const { cancelConversationSummaryJobs } = require('../src/domain/conversation-summary-worker');
  cancelConversationSummaryJobs(store, conversation.conversation_id, '2026-09-02T00:01:00Z');
  assert.equal(store.conversationSummaryJobs.get(job.job_id).state, 'CANCELLED');
});

test('摘要任务达到八次失败后进入无正文 DLQ，审核员仅能带理由重放一次', async () => {
  const store = new DevelopmentStore({ accountIds: ['acct_test'] });
  const account = store.account('acct_test');
  const conversation = { conversation_id: 'cnv_dlq', account_id: account.account_id, character_id: 'chr_test', status: 'OPEN' };
  store.conversations.set(conversation.conversation_id, conversation);
  for (let index = 0; index < COMPLETED_TURN_MESSAGE_THRESHOLD; index += 1) {
    const messageId = 'msg_' + String(index).padStart(2, '0');
    store.messages.set(messageId, { message_id: messageId, conversation_id: conversation.conversation_id, actor: index % 2 ? 'ASSISTANT' : 'USER', text: '合成消息 ' + index, created_at: '2026-09-01T00:' + String(index).padStart(2, '0') + ':00.000Z' });
  }
  const job = enqueueConversationSummary({ store, account, conversation, now: new Date('2026-09-02T00:00:00Z') });
  let now = new Date('2026-09-02T00:00:00Z');
  for (let attempt = 1; attempt <= MAX_SUMMARY_JOB_ATTEMPTS; attempt += 1) {
    const result = await runNextConversationSummaryJob({ store, summaryGenerator: async () => { throw new Error('upstream unavailable'); }, now });
    assert.equal(result.state, attempt === MAX_SUMMARY_JOB_ATTEMPTS ? 'DLQ' : 'RETRY_SCHEDULED');
    now = new Date(store.conversationSummaryJobs.get(job.job_id).next_attempt_at);
  }
  const exhausted = store.conversationSummaryJobs.get(job.job_id);
  assert.equal(exhausted.attempt_count, MAX_SUMMARY_JOB_ATTEMPTS);
  assert.ok(exhausted.exhausted_at);
  assert.equal(store.conversationSummaryDeadLetters.size, 1);
  const [deadLetter] = store.conversationSummaryDeadLetters.values();
  assert.deepEqual(Object.keys(deadLetter).sort(), [
    'account_id', 'attempt_count', 'conversation_id', 'dead_letter_id', 'error_code', 'job_id',
    'last_replay_reason_sha256', 'last_replayed_at', 'last_replayed_by', 'occurred_at', 'replay_count',
    'source_to_id', 'state'
  ]);
  assert.equal(deadLetter.error_code, 'SUMMARY_GENERATION_FAILED');
  assert.equal((await runNextConversationSummaryJob({ store, summaryGenerator: async () => { throw new Error('不应调用'); }, now })).state, 'IDLE');

  const replayed = replayConversationSummaryDeadLetter({
    store, jobId: job.job_id, reviewerId: 'rev_test', reasonHash: 'a'.repeat(64), now
  });
  assert.equal(replayed.state, 'REPLAY_SCHEDULED');
  assert.equal(replayed.summary_job.attempt_count, MAX_SUMMARY_JOB_ATTEMPTS);
  assert.equal(replayed.dead_letter.replay_count, 1);
  assert.equal(replayed.dead_letter.last_replayed_by, 'rev_test');
  assert.deepEqual([...store.outboxEvents.values()].at(-1).payload, {
    conversation_id: conversation.conversation_id, source_to_id: job.source_to_id, replay_count: 1
  });
  assert.equal(replayConversationSummaryDeadLetter({ store, jobId: job.job_id, reviewerId: 'rev_test', reasonHash: 'b'.repeat(64), now }).state, 'REPLAY_LIMIT_REACHED');
});
