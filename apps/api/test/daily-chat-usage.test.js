'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  DAILY_BILLED_INPUT_TOKEN_LIMIT,
  DAILY_CHAT_ROUND_LIMIT,
  DailyChatUsageError,
  commitDailyChatUsage,
  currentDailyChatUsage,
  releaseDailyChatUsage,
  reserveDailyChatUsage,
  usageDate
} = require('../src/domain/daily-chat-usage');

const NOW = new Date('2026-09-04T12:00:00.000Z');

test('普通对话预留后只在成功时结算实际输入 Token，失败释放轮次和 Token 预留', () => {
  const store = new DevelopmentStore();
  const reservation = reserveDailyChatUsage(store, { accountId: 'acct_dev_alice', now: NOW, estimatedInputTokens: 3200 });
  assert.deepEqual(currentDailyChatUsage(store, 'acct_dev_alice', NOW), {
    usage_date: usageDate(NOW), chat_rounds: 1, billed_input_tokens: 0, reserved_input_tokens: 3200,
    remaining_chat_rounds: 99, remaining_billed_input_tokens: DAILY_BILLED_INPUT_TOKEN_LIMIT - 3200,
    resets_at: '2026-09-05T16:00:00.000Z'
  });
  commitDailyChatUsage(store, reservation, { billedInputTokens: 27 });
  assert.equal(currentDailyChatUsage(store, 'acct_dev_alice', NOW).billed_input_tokens, 27);
  const retry = reserveDailyChatUsage(store, { accountId: 'acct_dev_alice', now: NOW, estimatedInputTokens: 3200 });
  releaseDailyChatUsage(store, retry);
  assert.deepEqual(currentDailyChatUsage(store, 'acct_dev_alice', NOW), {
    usage_date: usageDate(NOW), chat_rounds: 1, billed_input_tokens: 27, reserved_input_tokens: 0,
    remaining_chat_rounds: 99, remaining_billed_input_tokens: DAILY_BILLED_INPUT_TOKEN_LIMIT - 27,
    resets_at: '2026-09-05T16:00:00.000Z'
  });
});

test('轮次和 Token 上限均在供应商调用前确定性阻断', () => {
  const store = new DevelopmentStore();
  const key = `acct_dev_alice:${usageDate(NOW)}`;
  store.dailyChatUsage.set(key, { account_id: 'acct_dev_alice', usage_date: usageDate(NOW), chat_rounds: DAILY_CHAT_ROUND_LIMIT, billed_input_tokens: 0, reserved_input_tokens: 0 });
  assert.throws(() => reserveDailyChatUsage(store, { accountId: 'acct_dev_alice', now: NOW }), (error) => error instanceof DailyChatUsageError && error.code === 'DAILY_CHAT_LIMIT_REACHED');
  store.dailyChatUsage.set(key, { account_id: 'acct_dev_alice', usage_date: usageDate(NOW), chat_rounds: 0, billed_input_tokens: DAILY_BILLED_INPUT_TOKEN_LIMIT - 100, reserved_input_tokens: 0 });
  assert.throws(() => reserveDailyChatUsage(store, { accountId: 'acct_dev_alice', now: NOW, estimatedInputTokens: 101 }), (error) => error instanceof DailyChatUsageError && error.code === 'TOKEN_LIMIT_REACHED');
});
