'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeFollowupText } = require('../src/domain/followup-composer');

const EVENT = { event_id: 'levt_1', title: '周五的产品经理面试', scheduled_at: '2026-10-02T06:30:00.000Z', status: 'PLANNED' };
const CHARACTER = { name: '栖夏' };

test('followup-composer: 无模型走固定模板（CONFIRMED_APPOINTMENT 槽）', async () => {
  const result = await composeFollowupText({ event: EVENT, character: CHARACTER, followupKind: 'BEFORE_EVENT' });
  assert.equal(result.provider, 'template');
  assert.equal(result.template_slot, 'CONFIRMED_APPOINTMENT');
  assert.equal(result.text, '到你们约定的时间了：「周五的产品经理面试」。');
  assert.equal(result.model_version, 'followup-template-v1');
});

test('followup-composer: AFTER_EVENT 走 CONFIRMED_REALITY_ACTION 槽', async () => {
  const result = await composeFollowupText({ event: EVENT, character: CHARACTER, followupKind: 'AFTER_EVENT' });
  assert.equal(result.template_slot, 'CONFIRMED_REALITY_ACTION');
  assert.match(result.text, /周五的产品经理面试/);
});

test('followup-composer: 模型成功（含事件标题）用模型措辞；抛错回退', async () => {
  const good = async () => ({ text: '「周五的产品经理面试」要开始啦，深呼吸，按你练过的来就好。', provider: 'qwen', modelVersion: 'qwen3.8-flash' });
  const composed = await composeFollowupText({ event: EVENT, character: CHARACTER, followupKind: 'BEFORE_EVENT', model: good });
  assert.equal(composed.provider, 'qwen');
  assert.equal(composed.model_version, 'qwen3.8-flash');
  assert.match(composed.text, /周五的产品经理面试/);

  const throwing = async () => { throw new Error('upstream 500'); };
  const fallback = await composeFollowupText({ event: EVENT, character: CHARACTER, followupKind: 'BEFORE_EVENT', model: throwing });
  assert.equal(fallback.provider, 'template-fallback');
  assert.equal(fallback.fallback_reason, 'MODEL_ERROR');
});

test('followup-composer: 模型输出不含事件标题（脱 fact）回退固定模板', async () => {
  const offTopic = async () => ({ text: '加油！你可以的！', provider: 'qwen', modelVersion: 'm' });
  const result = await composeFollowupText({ event: EVENT, character: CHARACTER, followupKind: 'BEFORE_EVENT', model: offTopic });
  assert.equal(result.provider, 'template-fallback');
  assert.equal(result.fallback_reason, 'MISSING_EVENT_TITLE');
  assert.equal(result.text, '到你们约定的时间了：「周五的产品经理面试」。');
});
