'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPersonaStreamGuard, guardPersonaReply } = require('../src/domain/persona-output-guard');
const { QwenAdapter } = require('../src/providers/qwen-adapter');

test('完整安全句立即放行；未完成身份声明跨片段缓冲，不等待整轮终稿', async () => {
  const visible = [];
  const guard = createPersonaStreamGuard({ name: '小栖' }, async (text) => { visible.push(text); return true; });
  await guard.push('我在呢。');
  assert.deepEqual(visible, ['我在呢。']);
  await guard.push('我是栖语的');
  assert.deepEqual(visible, ['我在呢。']);
  await assert.rejects(() => guard.push('AI助手。'), { code: 'OOC_STREAM_REPAIR_REQUIRED' });
  assert.deepEqual(visible, ['我在呢。']);
});

test('终稿身份仍复核，repair失败最多一次且不携带记忆候选', async () => {
  let repairs = 0;
  const result = await guardPersonaReply({ reply_text: '我是AI助手。', memory_candidate: {} }, {
    text: '你好', contextPack: { character: { name: '小栖' } },
    replyGenerator: async () => { repairs += 1; throw new Error('provider unavailable'); }
  });
  assert.equal(repairs, 1);
  assert.equal(result.provider, 'ooc-guard');
  assert.equal(result.memory_candidate, null);
  const guard = createPersonaStreamGuard({ name: '小栖' }, async () => true);
  await assert.rejects(() => guard.finish('我是AI助手。'), { code: 'OOC_STREAM_REPAIR_REQUIRED' });
});

test('真实Qwen流适配器保留人格拦截语义，不包装成网络失败或多次重试', async () => {
  const adapter = new QwenAdapter({ apiKey: 'test-key', fetchImpl: async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: '我是AI助手。' } }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } }
  ) });
  const guard = createPersonaStreamGuard({ name: '小栖' }, async () => { throw new Error('must not expose'); });
  await assert.rejects(() => adapter.generateStream({ text: '你好', onFragment: guard.push }), { code: 'OOC_STREAM_REPAIR_REQUIRED' });
});

test('首个60字无标点安全片段即放行前缀，仅保留短尾部保护跨片段身份', async () => {
  const visible = [];
  const guard = createPersonaStreamGuard({ name: '小栖' }, async (text) => { visible.push(text); return true; });
  await guard.push('慢慢听你说'.repeat(12));
  assert.equal(visible.join('').length, 28);
  await guard.finish('慢慢听你说'.repeat(12));
  assert.equal(visible.join(''), '慢慢听你说'.repeat(12));

  for (const declaration of ['我是栖语的', '作为一个']) {
    const snippets = [];
    const guarded = createPersonaStreamGuard({ name: '小栖' }, async (text) => { snippets.push(text); return true; });
    await guarded.push('慢慢听你说'.repeat(5) + declaration + ' '.repeat(30));
    assert.doesNotMatch(snippets.join(''), /我是|作为/);
    await assert.rejects(() => guarded.push('AI助手。'), { code: 'OOC_STREAM_REPAIR_REQUIRED' });
    assert.doesNotMatch(snippets.join(''), /我是|作为|AI助手/);
  }
});
