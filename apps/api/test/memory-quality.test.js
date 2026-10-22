'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitFact, deriveFactCandidate, contextBridge, groundedSummary } = require('../src/domain/memory-quality');
const { rankAssetsForContext } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { buildMessages } = require('../src/providers/qwen-adapter');

test('仅明确事实形成候选，闲聊/假设/问题减噪且重复确认事实不再提议', () => {
  for (const text of ['你好', '你喜欢咖啡吗？', '如果我住在上海', '我今天很累']) assert.equal(deriveFactCandidate(text), null);
  const candidate = deriveFactCandidate('我住在北京');
  assert.equal(candidate.normalized_value.fact_key, 'user.residence');
  assert.ok(candidate.confidence < 1);
  assert.equal(deriveFactCandidate('我住在北京', { confirmed_assets: [candidate] }), null);
  assert.equal(explicitFact('我不喜欢咖啡').key, explicitFact('我喜欢咖啡').key);
});

test('20/60窗口包含源摘录和近期消息；超长未摘要历史保持有界与查询相关', () => {
  const messages = Array.from({ length: 59 }, (_, i) => ({ message_id: `m${i}`, actor: i % 2 ? 'ASSISTANT' : 'USER', text: i === 0 ? '我住在北京' : `消息${i}` }));
  const bridge = contextBridge(messages, 20, '住在哪里');
  assert.equal(bridge.length, 39);
  assert.equal(bridge[0].text, '我住在北京');
  const prompt = buildMessages('住在哪里', { unsummarized_context: bridge })[0].content;
  assert.match(prompt, /m0\/用户/);
  assert.match(prompt, /助手陈述不是用户事实/);
  const long = [...messages, ...Array.from({ length: 100 }, (_, i) => ({ message_id: `x${i}`, actor: 'USER', text: '其他'.repeat(300) }))];
  const selected = contextBridge(long, 20, '北京');
  assert.ok(selected.length <= 40);
  assert.ok(selected.every((m) => m.text.length <= 100));
  assert.ok(selected.reduce((sum, m) => sum + m.text.length, 0) <= 4000);
  assert.ok(selected.some((m) => m.source_message_id === 'm0'));
  messages[0].text = '其他内容'.repeat(60) + '我不喜欢咖啡';
  assert.match(contextBridge(messages, 20, '咖啡')[0].text, /不喜欢咖啡/);
  assert.match(contextBridge(messages, 20, '继续聊')[0].text, /不喜欢咖啡/);
});

test('源ID和原文双校验拒绝摘要幻觉、来源错配；旧摘要显式标记兼容', () => {
  const messages = [{ message_id: 'm1', actor: 'USER', text: '我现在住在北京，不住上海了' }];
  const grounded = groundedSummary(JSON.stringify({ excerpts: [{ message_id: 'm1', quote: '我现在住在北京' }] }), messages, null);
  assert.equal(grounded, '[m1/用户] 我现在住在北京，不住上海了');
  assert.throws(() => groundedSummary('{"excerpts":[{"message_id":"m1","quote":"我住广州"}]}', messages), /does not match source/);
  assert.throws(() => groundedSummary('{"excerpts":[{"message_id":"other","quote":"北京"}]}', messages), /does not match source/);
  assert.match(groundedSummary('{"excerpts":[{"message_id":"m1","quote":"北京"}]}', messages, '旧版历史'), /旧版摘要\/语义未核对/);
  assert.doesNotMatch(groundedSummary('{"excerpts":[{"message_id":"new","quote":"我住在北京"}]}', [{ message_id: 'new', actor: 'USER', text: '我住在北京' }], '[old/用户] 我住在上海'), /我住在上海/);
  const corrected = [{ message_id: 'old', actor: 'USER', text: '我住在上海' }, { message_id: 'new', actor: 'USER', text: '我住在北京' }, { message_id: 'other', actor: 'USER', text: '你好' }];
  const reverse = groundedSummary('{"excerpts":[{"message_id":"new","quote":"我住在北京"},{"message_id":"old","quote":"我住在上海"}]}', corrected, '[prior/用户] 我住在上海');
  assert.doesNotMatch(reverse, /我住在上海/);
  const missingCorrection = groundedSummary('{"excerpts":[{"message_id":"other","quote":"你好"}]}', corrected, '[prior/用户] 我住在上海');
  assert.match(missingCorrection, /我住在北京/);
  assert.doesNotMatch(missingCorrection, /我住在上海/);
});

test('摘要保留完整源消息的否定、条件与转述主语，不能把局部匹配当作确定事实', () => {
  for (const [text, quote] of [
    ['我不喜欢咖啡', '喜欢咖啡'],
    ['如果明年调岗成功，我住在北京，你会愿意来吗？', '我住在北京'],
    ['我朋友说：“我住在北京。”这不是我的住址。', '我住在北京'],
    ['以前我住在北京，现在我搬到上海了。', '我住在北京']
  ]) {
    assert.equal(groundedSummary(JSON.stringify({ excerpts: [{ message_id: 'm1', quote }] }),
      [{ message_id: 'm1', actor: 'USER', text }]), `[m1/用户] ${text}`);
  }
  assert.throws(() => groundedSummary(JSON.stringify({ excerpts: [{ message_id: 'm1', quote: '咖啡' }] }),
    [{ message_id: 'm1', actor: 'USER', text: '不'.repeat(601) + '咖啡' }]), /too long/);
  const first = groundedSummary(JSON.stringify({ excerpts: [{ message_id: 'm1', quote: '我喜欢咖啡' }] }),
    [{ message_id: 'm1', actor: 'USER', text: '我喜欢咖啡\n这是朋友的话，不是我的喜好。' }]);
  const next = groundedSummary(JSON.stringify({ excerpts: [{ message_id: 'm2', quote: '你好' }] }),
    [{ message_id: 'm2', actor: 'USER', text: '你好' }], first);
  assert.match(next, /我喜欢咖啡 这是朋友的话，不是我的喜好。/);
});

test('摘要预算只丢弃整项，不截断来源使否定或条件尾部消失', () => {
  const messages = Array.from({ length: 4 }, (_, i) => ({
    message_id: `m${i}`, actor: 'USER', text: `朋友${i}说` + '原文'.repeat(200) + '，这不是我的情况。'
  }));
  const summary = groundedSummary(JSON.stringify({ excerpts: messages.map((m) => ({ message_id: m.message_id, quote: '原文' })) }), messages);
  assert.ok(summary.length <= 1200);
  assert.ok(summary.split('\n').length < messages.length);
  assert.ok(summary.split('\n').every((line) => line.endsWith('，这不是我的情况。')));
});

test('互斥事实不作为确定事实召回，用户版本修订后只召回当前版本', async () => {
  const store = new DevelopmentStore();
  const seed = (id, text) => ({ asset_id: id, account_id: 'acct_dev_alice', character_id: 'c1', display_text: `你提到：“${text}”`, type: 'development_note', state: 'ACTIVE', version: 1, index_state: 'PENDING' });
  store.assets.set('a1', seed('a1', '我住在北京'));
  store.assets.set('a2', seed('a2', '我住在上海'));
  assert.deepEqual(await rankAssetsForContext(store, 'acct_dev_alice', 'c1', '住在哪'), []);
  store.assets.get('a1').state = 'SUPERSEDED';
  assert.equal((await rankAssetsForContext(store, 'acct_dev_alice', 'c1', '住在哪'))[0].asset_id, 'a2');
  store.assets.get('a2').state = 'DELETED';
  assert.deepEqual(await rankAssetsForContext(store, 'acct_dev_alice', 'c1', '住在哪'), []);
});

test('无待向量召回资产不调用embedding；供应商卡住250ms后有界词法降级', async () => {
  const store = new DevelopmentStore();
  let calls = 0;
  const provider = { modelVersion: 'test', embed: async () => { calls++; return new Promise(() => {}); } };
  await rankAssetsForContext(store, 'acct_dev_alice', 'c1', '你好', provider);
  assert.equal(calls, 0);
  store.assets.set('a1', { asset_id: 'a1', account_id: 'acct_dev_alice', character_id: 'c1', display_text: '北京', type: 'development_note', state: 'ACTIVE', version: 1, index_state: 'READY' });
  const begin = Date.now();
  assert.equal((await rankAssetsForContext(store, 'acct_dev_alice', 'c1', '北京', provider))[0].asset_id, 'a1');
  assert.equal(calls, 1);
  assert.ok(Date.now() - begin < 1500);
});
