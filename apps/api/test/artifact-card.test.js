'use strict';
// 六项能力 A3：artifact-card 卡片组件单测。硬门禁锚点（§4.5/§9.1）：卡片
// 只允许文本、受控步骤与服务端动作 ID——HTML/脚本/链接/未知动作/跨账户
// 引用全部拒绝；动作可用集按源状态收敛；Markdown 导出不含可执行结构。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeCardTextField, sanitizeCardSteps, validateCardActions,
  buildEventCard, buildReadingLogCard, buildPlanCard, renderCardMarkdown
} = require('../src/domain/artifact-card');

const CARD = { artifact_id: 'art_1' };
const EVENT = { event_id: 'levt_1', version: 2, title: '周五的产品经理面试', domain: 'REAL_LIFE', status: 'PLANNED', scheduled_at: '2026-10-02T06:30:00.000Z', timezone: 'Asia/Shanghai' };

test('卡片文本消毒：HTML 起始符/链接协议/控制字符/超长全部拒绝（不是转义放行）', () => {
  assert.equal(sanitizeCardTextField('正常文本', '标题').ok, true);
  assert.equal(sanitizeCardTextField('<b>加粗</b>', '标题').ok, false);
  assert.equal(sanitizeCardTextField('看 https://evil.example', '标题').ok, false);
  assert.equal(sanitizeCardTextField('javascript:alert(1)', '标题').ok, false);
  assert.equal(sanitizeCardTextField('带\u0002控制符', '标题').ok, false);
  assert.equal(sanitizeCardTextField('x'.repeat(201), '标题').ok, false);
  assert.equal(sanitizeCardTextField('   ', '标题').ok, false, '空白拒绝');
});

test('EVENT_V1：字段投影 + 虚构域打 fictional 标签（不伪装现实经历）', () => {
  const real = buildEventCard({ card: CARD, event: EVENT });
  assert.equal(real.ok, true);
  assert.equal(real.value.schema_version, 'EVENT_V1');
  assert.equal(real.value.source.version, 2);
  assert.equal(real.value.fictional, false);
  assert.deepEqual(real.value.actions, ['OPEN_EVENT']);

  const fictional = buildEventCard({ card: CARD, event: { ...EVENT, domain: 'FICTIONAL_SHARED', title: '魔法学院的入学考核' } });
  assert.equal(fictional.value.fictional, true);

  const unsafe = buildEventCard({ card: CARD, event: { ...EVENT, title: '面试<link>' } });
  assert.equal(unsafe.ok, false, '事件标题不合法整卡拒绝');
});

test('READING_LOG_V1：阅读记录是事件视图，带独立内容确认提示', () => {
  const card = buildReadingLogCard({ card: CARD, event: { ...EVENT, event_kind: 'READING', title: '一起读《小王子》' } });
  assert.equal(card.ok, true);
  assert.match(card.value.note, /单独确认/);
});

test('PLAN_V1：步骤受控 + 动作可用集按计划状态收敛', () => {
  const steps = [
    { step_id: 'cstep_1', title: '练自我介绍', estimated_minutes: 20, state: 'TODO' },
    { step_id: 'cstep_2', title: '梳理故事', estimated_minutes: 30, state: 'DONE' }
  ];
  const draft = buildPlanCard({ card: CARD, plan: { plan_id: 'cpl_1', version: 1, state: 'DRAFT', title: '面试准备', support_mode: 'PRACTICE_TOGETHER' }, steps });
  assert.deepEqual(draft.value.actions, ['OPEN_PLAN', 'ACCEPT_PLAN']);
  const active = buildPlanCard({ card: CARD, plan: { plan_id: 'cpl_1', version: 2, state: 'ACTIVE', title: '面试准备', support_mode: 'PRACTICE_TOGETHER' }, steps });
  assert.deepEqual(active.value.actions, ['OPEN_PLAN', 'PAUSE_PLAN', 'COMPLETE_PLAN', 'CANCEL_PLAN']);
  const paused = buildPlanCard({ card: CARD, plan: { plan_id: 'cpl_1', version: 3, state: 'PAUSED', title: '面试准备', support_mode: 'PRACTICE_TOGETHER' }, steps });
  assert.deepEqual(paused.value.actions, ['OPEN_PLAN', 'RESUME_PLAN', 'CANCEL_PLAN']);
  const done = buildPlanCard({ card: CARD, plan: { plan_id: 'cpl_1', version: 4, state: 'COMPLETED', title: '面试准备', support_mode: 'PRACTICE_TOGETHER' }, steps });
  assert.deepEqual(done.value.actions, ['OPEN_PLAN']);

  assert.equal(sanitizeCardSteps([{ step_id: 's', title: '<x>', state: 'TODO' }]).ok, false, '步骤标题 HTML 拒绝');
  assert.equal(sanitizeCardSteps([{ step_id: 's', title: '步骤', state: 'DONE!' }]).ok, false, '非法状态拒绝');
  assert.equal(sanitizeCardSteps([]).ok, false, '空步骤拒绝');
});

test('未知动作拒绝：白名单外动作 ID 一律 400 形态', () => {
  assert.equal(validateCardActions(['OPEN_PLAN']).ok, true);
  assert.equal(validateCardActions(['EXECUTE_SHELL']).ok, false, '发明动作拒绝');
  assert.equal(validateCardActions([]).ok, false, '空动作集拒绝');
});

test('Markdown 导出：计划步骤勾选形态 + 免责尾注；不含链接与脚本形态', () => {
  const card = buildPlanCard({ card: CARD, plan: { plan_id: 'cpl_1', version: 2, state: 'ACTIVE', title: '面试准备', support_mode: 'PRACTICE_TOGETHER' }, steps: [
    { step_id: 'cstep_1', title: '练自我介绍', estimated_minutes: 20, state: 'DONE' },
    { step_id: 'cstep_2', title: '梳理故事', estimated_minutes: 30, state: 'SKIPPED' },
    { step_id: 'cstep_3', title: '准备问题', estimated_minutes: 15, state: 'TODO' }
  ] }).value;
  const markdown = renderCardMarkdown(card);
  assert.match(markdown, /# 面试准备/);
  assert.match(markdown, /- \[x\] 练自我介绍（约 20 分钟）/);
  assert.match(markdown, /- \[-\] 梳理故事/);
  assert.match(markdown, /- \[ \] 准备问题/);
  assert.match(markdown, /以应用内当前状态为准/);
  assert.doesNotMatch(markdown, /https?:\/\//);
  assert.doesNotMatch(markdown, /</);
});
