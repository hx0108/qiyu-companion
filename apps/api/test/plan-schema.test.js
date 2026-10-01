'use strict';
// 六项能力 A3：plan-schema 受控字段校验单测。硬门禁锚点（§9.1）：
// 模型提议携带 HTML/链接 → 拒绝；步骤数/时长越界 → 拒绝；支持方式白名单；
// accept 的 followup 子对象复用 A2 全量裁决（不因计划附带而放松）。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAN_TEMPLATES, SUPPORT_MODES, DRAFT_TTL_DAYS,
  validatePlanDraftRequest, validatePlanProposalOutput, validateStepPatch, validateAcceptRequest
} = require('../src/domain/plan-schema');

const EVENT = { event_id: 'e1', title: '面试', status: 'PLANNED', timezone: 'Asia/Shanghai', scheduled_at: '2026-10-10T02:00:00.000Z', deleted_at: null };

test('计划草案请求：模板与支持方式白名单；事件可选但取消态拒绝', () => {
  const okResult = validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'PRACTICE_TOGETHER' }, { event: EVENT });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.value.event_id, 'e1');

  assert.equal(validatePlanDraftRequest({ template_version: 'READING_PREP_V9', support_mode: 'PRACTICE_TOGETHER' }, {}).ok, false, '未知模板拒绝');
  assert.equal(validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'WHATEVER' }, {}).ok, false, '未知支持方式拒绝');
  const cancelled = validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'LISTEN_ONLY' }, { event: { ...EVENT, status: 'CANCELLED' } });
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.errors.some((item) => item.field === 'event_id'), '取消事件不能再开计划');
  const deleted = validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'LISTEN_ONLY' }, { event: { ...EVENT, deleted_at: '2026-10-01T00:00:00Z' } });
  assert.equal(deleted.ok, false, '已删事件拒绝');
  assert.equal(validatePlanDraftRequest({ template_version: 'INTERVIEW_PREP_V1', support_mode: 'BREAK_DOWN_STEPS' }, { event: null }).ok, true, '没有事件也可新建');
});

test('模型提议输出：步骤数 1-5、时长 5-180、HTML/链接/控制字符一律拒绝', () => {
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [{ title: '练自我介绍', estimated_minutes: 20 }] }).ok, true);
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [] }).ok, false, '零步骤拒绝');
  const six = { title: 'x', steps: Array.from({ length: 6 }, () => ({ title: '步骤' })) };
  assert.equal(validatePlanProposalOutput(six).ok, false, '超过 5 步拒绝');
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [{ title: '练<b>自我介绍</b>', estimated_minutes: 20 }] }).ok, false, 'HTML 拒绝');
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [{ title: '看 https://evil.example 的资料', estimated_minutes: 20 }] }).ok, false, '链接拒绝');
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [{ title: 'javascript:alert(1)', estimated_minutes: 20 }] }).ok, false, '脚本协议拒绝');
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [{ title: '步骤', estimated_minutes: 3 }] }).ok, false, '时长下界拒绝');
  assert.equal(validatePlanProposalOutput({ title: '面试准备', steps: [{ title: '步骤', estimated_minutes: 181 }] }).ok, false, '时长上界拒绝');
  assert.equal(validatePlanProposalOutput({ title: 'a'.repeat(81), steps: [{ title: '步骤' }] }).ok, false, '标题超长拒绝');
});

test('步骤 PATCH 白名单：只收 title/estimated_minutes/state；非法值拒绝', () => {
  const okResult = validateStepPatch({ title: '改后的步骤', state: 'DONE' });
  assert.equal(okResult.ok, true);
  assert.deepEqual(okResult.value, { title: '改后的步骤', state: 'DONE' });
  assert.equal(validateStepPatch({ step_order: 2 }).ok, true, '未知字段直接忽略（白名单外不报错不透传）');
  assert.equal(validateStepPatch({ step_order: 2 }).value.step_order, undefined);
  assert.equal(validateStepPatch({ state: 'DONE!' }).ok, false);
  assert.equal(validateStepPatch({ estimated_minutes: 2 }).ok, false);
  assert.equal(validateStepPatch({ title: '<script>' }).ok, false);
});

test('accept 请求：expected_version 必填；followup 子对象复用 A2 裁决（时区缺失/过时 due_at 均拒绝）', () => {
  assert.equal(validateAcceptRequest({ expected_version: 1 }, { event: EVENT }).ok, true);
  assert.equal(validateAcceptRequest({}, { event: EVENT }).ok, false, '缺 expected_version 拒绝');
  const noTz = validateAcceptRequest({ expected_version: 1, followup: { followup_kind: 'BEFORE_EVENT' } }, { event: { ...EVENT, timezone: null } });
  assert.equal(noTz.ok, false);
  assert.ok(noTz.errors.some((item) => item.field === 'followup.timezone'), '时区缺失透传 A2 拒绝');
  const past = validateAcceptRequest({ expected_version: 1, followup: { followup_kind: 'BEFORE_EVENT', due_at: '2020-01-01T00:00:00Z' } }, { event: EVENT });
  assert.equal(past.ok, false, '过时 due_at 不补发');
  const defaulted = validateAcceptRequest({ expected_version: 1, followup: { followup_kind: 'BEFORE_EVENT' } }, { event: EVENT });
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.value.followup.due_at, '2026-10-10T02:00:00.000Z', '缺省派生=事件准点');
});

test('常量登记：首批唯一模板 INTERVIEW_PREP_V1、三支持方式、草案 30 天', () => {
  assert.deepEqual(Object.keys(PLAN_TEMPLATES), ['INTERVIEW_PREP_V1']);
  assert.equal(PLAN_TEMPLATES.INTERVIEW_PREP_V1.fallback_steps.length, 3, '兜底固定三步');
  assert.deepEqual(SUPPORT_MODES, ['PRACTICE_TOGETHER', 'BREAK_DOWN_STEPS', 'LISTEN_ONLY']);
  assert.equal(DRAFT_TTL_DAYS, 30);
});
