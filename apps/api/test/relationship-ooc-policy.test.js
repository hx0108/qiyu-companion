'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectOoc } = require('../src/domain/ooc-policy');
const { createPersonaStreamGuard, guardPersonaReply } = require('../src/domain/persona-output-guard');

const lover = { name: '小栖', persona: { relationship_to_user: '男女朋友' } };

test('身份冲突优先于可恢复的关系冲突', () => {
  assert.equal(detectOoc('我叫李明，我们只是好朋友。', lover).code, 'OOC_CHARACTER_NAME_CONFLICT');
  assert.equal(detectOoc('我是AI助手，我们只是好朋友。', lover).code, 'OOC_GENERIC_ASSISTANT_IDENTITY');
});

test('明确恋人配置不能自称只是朋友或否认当前恋人关系', () => {
  for (const reply of ['我们是好朋友。', '你是我的好朋友。', '我是你的好朋友。', '我们只是好朋友。', '我和你仅仅是普通朋友。', '我只是你的好朋友。', '我不是你的男朋友。', '我们不是恋人。', '你不是我的女朋友。']) {
    assert.equal(detectOoc(reply, lover).code, 'OOC_RELATIONSHIP_CONFLICT', reply);
  }
  for (const relationship of ['恋人', '情侣', '你的男朋友', '与用户是女朋友', '男女朋友关系']) {
    assert.equal(detectOoc('我们只是普通朋友。', { persona: { relationship_to_user: relationship } }).code, 'OOC_RELATIONSHIP_CONFLICT', relationship);
  }
});

test('关系门禁保留否定普通朋友、他人、引用、过去、条件与分手回应', () => {
  for (const reply of ['我们不是普通朋友，我们是恋人。', '我们不只是好朋友。', '他只是我的好朋友。', '你和小明只是朋友。', '你说“我们只是好朋友”，让我有些意外。', '我们以前只是好朋友。', '如果我们只是好朋友，你会怎么想？', '我们分手后只是朋友，我尊重你的决定。', '我不是你的男朋友吗？', '我只是你的好朋友吗？']) {
    assert.equal(detectOoc(reply, lover).decision, 'PASS', reply);
  }
  for (const relationship of ['', '温柔可靠的朋友', '不是恋人', '曾经是恋人现在是朋友', '恋人或朋友由用户决定', '希望未来成为恋人']) {
    assert.equal(detectOoc('我们只是好朋友。', { persona: { relationship_to_user: relationship } }).decision, 'PASS', relationship);
  }
});

test('只有用户明确当前分手或降级意愿允许简单朋友回复，引用和假设不授权', () => {
  for (const userText of ['我们分手吧。', '我想和你分手', '我们只做朋友吧', '我决定结束我们的恋爱关系', '我不想再做你的女朋友了']) {
    assert.equal(detectOoc('好，我们只是朋友。', lover, { userText }).decision, 'PASS', userText);
  }
  for (const userText of ['我们的关系是什么？', '如果我们分手，你会怎么办？', '她说我们分手吧', '“我们分手吧”这句台词怎么样', '我不想和你分手', '我想和前男友分手', '你想和我分手吗？']) {
    assert.equal(detectOoc('好，我们只是朋友。', lover, { userText }).code, 'OOC_RELATIONSHIP_CONFLICT', userText);
  }
  for (const reply of ['你说想分手。我们只是朋友。', '他的分手很遗憾，我们只是朋友。', '“我们分手吧”。我们只是朋友。']) {
    assert.equal(detectOoc(reply, lover, { userText: '我们的关系是什么？' }).code, 'OOC_RELATIONSHIP_CONFLICT', reply);
  }
});

test('完整及流式人格门禁透传用户关系变更，普通关系询问仍拦截', async () => {
  const userText = '我们分手吧';
  let repairs = 0;
  const result = await guardPersonaReply({ reply_text: '好，我们只是朋友。' }, {
    text: userText, contextPack: { character: lover }, replyGenerator: async () => { repairs += 1; throw new Error('must not repair'); }
  });
  assert.equal(result.reply_text, '好，我们只是朋友。');
  assert.equal(repairs, 0);
  const seen = [];
  const guard = createPersonaStreamGuard(lover, async (text) => { seen.push(text); return true; }, { userText });
  await guard.push('好，我们只是朋友。');
  await guard.finish('好，我们只是朋友。');
  assert.equal(seen.join(''), '好，我们只是朋友。');
});

test('共享人格门禁对关系冲突只修复一次，跨片段不放行错误关系句', async () => {
  let repaired = 0;
  const result = await guardPersonaReply({ reply_text: '我们只是好朋友。' }, {
    text: '我们的关系是什么', contextPack: { character: lover }, replyGenerator: async () => {
      repaired += 1;
      return { reply_text: '我们是恋人，我在呢。' };
    }
  });
  assert.equal(repaired, 1);
  assert.equal(result.reply_text, '我们是恋人，我在呢。');
  const seen = [];
  const guard = createPersonaStreamGuard(lover, async (text) => { seen.push(text); return true; });
  await guard.push('我们只');
  await assert.rejects(() => guard.push('是好朋友。'), { code: 'OOC_STREAM_REPAIR_REQUIRED', oocCode: 'OOC_RELATIONSHIP_CONFLICT' });
  assert.deepEqual(seen, []);
});

test('关系修复仍失败时保留确定性兜底并丢弃记忆候选', async () => {
  let repairs = 0;
  const result = await guardPersonaReply({ reply_text: '我们只是好朋友。', memory_candidate: { value: 'bad' } }, {
    text: '你是我的什么人', contextPack: { character: lover }, replyGenerator: async () => {
      repairs += 1;
      return { reply_text: '我们不是恋人。', memory_candidate: { value: 'bad' } };
    }
  });
  assert.equal(repairs, 1);
  assert.equal(result.ooc_guard, 'OOC_RELATIONSHIP_CONFLICT');
  assert.equal(result.memory_candidate, null);
});
