'use strict';
// 六项能力 A3：plan-composer 三路回退单测——模型未配置/抛错/输出不合法都
// 回落固定三步草案（可编辑、接受前不建立计划）；只听模式不调模型不生成待办。
const test = require('node:test');
const assert = require('node:assert/strict');
const { composePlanProposal } = require('../src/domain/plan-composer');

const EVENT = { event_id: 'levt_1', title: '周五的产品经理面试', scheduled_at: '2026-10-02T06:30:00.000Z' };
const NOW = new Date('2026-10-01T08:00:00.000Z');

test('模型未配置 → 模板三步兜底（标题带事件名）', async () => {
  const proposal = await composePlanProposal({ templateVersion: 'INTERVIEW_PREP_V1', supportMode: 'PRACTICE_TOGETHER', event: EVENT, model: null, now: NOW });
  assert.equal(proposal.provider, 'template');
  assert.equal(proposal.steps.length, 3);
  assert.match(proposal.title, /周五的产品经理面试/);
});

test('模型抛错 → 模板兜底 fallback_reason=MODEL_ERROR', async () => {
  const model = async () => { throw new Error('provider down'); };
  const proposal = await composePlanProposal({ supportMode: 'PRACTICE_TOGETHER', event: EVENT, model, now: NOW });
  assert.equal(proposal.provider, 'template-fallback');
  assert.equal(proposal.fallback_reason, 'MODEL_ERROR');
  assert.equal(proposal.steps.length, 3);
});

test('模型输出不合法（HTML/步骤越界）→ 模板兜底 fallback_reason 带 VALIDATION 前缀', async () => {
  const unsafe = async () => ({ title: '好计划', steps: [{ title: '看 <b>资料</b>', estimated_minutes: 20 }] });
  const proposal = await composePlanProposal({ supportMode: 'PRACTICE_TOGETHER', event: EVENT, model: unsafe, now: NOW });
  assert.equal(proposal.provider, 'template-fallback');
  assert.match(proposal.fallback_reason, /^VALIDATION:/);

  const tooMany = async () => ({ title: '好计划', steps: Array.from({ length: 6 }, (_, index) => ({ title: `步骤${index + 1}`, estimated_minutes: 10 })) });
  const bounded = await composePlanProposal({ supportMode: 'PRACTICE_TOGETHER', event: EVENT, model: tooMany, now: NOW });
  assert.equal(bounded.provider, 'template-fallback');
  assert.equal(bounded.steps.length, 3);
});

test('模型输出合法 → 透传（provider/model_version 记录模型来源）', async () => {
  const model = async () => ({ title: '面试前的小准备', steps: [{ title: '练一次自我介绍', estimated_minutes: 15 }], provider: 'qwen', modelVersion: 'qwen3.8-flash' });
  const proposal = await composePlanProposal({ supportMode: 'PRACTICE_TOGETHER', event: EVENT, model, now: NOW });
  assert.equal(proposal.provider, 'qwen');
  assert.equal(proposal.model_version, 'qwen3.8-flash');
  assert.equal(proposal.steps.length, 1);
});

test('只听模式：不调模型、零步骤、listen_only 标注', async () => {
  let called = false;
  const model = async () => { called = true; return { title: 'x', steps: [{ title: 'y' }] }; };
  const proposal = await composePlanProposal({ supportMode: 'LISTEN_ONLY', event: EVENT, model, now: NOW });
  assert.equal(called, false, '只听不生成待办，不调模型');
  assert.deepEqual(proposal.steps, []);
  assert.equal(proposal.listen_only, true);
});
