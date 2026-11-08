'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { automaticMemoryCandidate, decideAutomaticMemory } = require('../src/domain/automatic-memory-policy');

test('explicit communication preferences are eligible for automatic memory', () => {
  assert.equal(automaticMemoryCandidate('我希望你回答直接一点。').normalized_value.fact_value, 'direct');
  assert.equal(automaticMemoryCandidate('我希望你回答简洁一点').normalized_value.fact_value, 'concise');
  assert.equal(automaticMemoryCandidate('我希望你回答详细一点').normalized_value.fact_value, 'detailed');
  assert.equal(automaticMemoryCandidate('我喜欢喝热美式').normalized_value.fact_key, 'user.preference.drink:hot_americano');
  assert.equal(automaticMemoryCandidate('我最近在准备面试').expires_in_days, 30);
});

test('automatic memory is opt-in, scoped, deduplicated and never overrides a conflict', () => {
  const base = { text: '我希望你回答直接一点', accountId: 'a', characterId: 'c', assets: [] };
  assert.equal(decideAutomaticMemory(base).action, 'NONE');
  assert.equal(decideAutomaticMemory({ ...base, enabled: true }).action, 'AUTOMATIC');
  const asset = { account_id: 'a', character_id: 'c', state: 'ACTIVE', origin: 'AUTOMATIC', value: { fact_key: 'communication.response_style', fact_value: 'direct' } };
  assert.equal(decideAutomaticMemory({ ...base, enabled: true, assets: [asset] }).action, 'EXISTING');
  assert.equal(decideAutomaticMemory({ ...base, enabled: true, assets: [{ ...asset, value: { ...asset.value, fact_value: 'concise' } }] }).action, 'CONFIRM');
  assert.equal(decideAutomaticMemory({ ...base, enabled: true, assets: [{ ...asset, account_id: 'other' }] }).action, 'AUTOMATIC');
});

test('deleted or revised automatic memories require confirmation before reuse', () => {
  const base = { text: '我希望你回答直接一点', enabled: true, accountId: 'a', characterId: 'c' };
  for (const state of ['DELETED', 'SUPERSEDED']) {
    const assets = [{ account_id: 'a', character_id: 'c', state, origin: 'AUTOMATIC', value: { fact_key: 'communication.response_style', fact_value: 'direct' } }];
    assert.equal(decideAutomaticMemory({ ...base, assets }).action, 'CONFIRM');
  }
});

test('a rejected candidate is not silently recorded if circumstances change', () => {
  const rejected = { account_id: 'a', character_id: 'c', state: 'REJECTED', normalized_value: { fact_key: 'communication.response_style', fact_value: 'direct' } };
  assert.equal(decideAutomaticMemory({ text: '我希望你回答直接一点', enabled: true, accountId: 'a', characterId: 'c', assets: [], candidates: [rejected] }).action, 'REJECTED');
  assert.equal(decideAutomaticMemory({ text: '我希望你回答直接一点', enabled: true, accountId: 'other', characterId: 'c', assets: [], candidates: [rejected] }).action, 'AUTOMATIC');
});

test('ambiguous, sensitive, negated and third-party statements are not eligible', () => {
  for (const text of ['我不希望你回答直接一点', '我朋友说我希望你回答直接一点', '如果我希望你回答直接一点', '我希望你回答直接一点吗？', '我朋友最近在准备面试', '我喜欢咖啡', '不要记住我希望你回答直接一点', '我希望你回答直接一点，我患有疾病']) {
    assert.equal(automaticMemoryCandidate(text), null, text);
  }
});
