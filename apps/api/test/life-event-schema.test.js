'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LIFE_EVENT_DOMAINS, LIFE_EVENT_KINDS, LIFE_EVENT_TIME_PRECISIONS,
  isValidIanaTimezone, resolveTimePrecision,
  validateLifeEventCandidateOutput, validateLifeEventRevisionFields
} = require('../src/domain/life-event-schema');

// —— 提取器输出校验（模型产出只是候选，字段合法性由本层裁决）——

test('life-event-schema: 合法完整候选通过并归一化 ISO 日期', () => {
  const result = validateLifeEventCandidateOutput({
    title: '周五的产品经理面试',
    domain: 'REAL_LIFE',
    event_kind: 'INTERVIEW',
    scheduled_at: '2026-10-02T14:30:00Z',
    timezone: 'Asia/Shanghai'
  });
  assert.equal(result.valid, true);
  assert.equal(result.value.title, '周五的产品经理面试');
  assert.equal(result.value.domain, 'REAL_LIFE');
  assert.equal(result.value.time_precision, 'MINUTE');
  assert.equal(result.value.scheduled_at, '2026-10-02T14:30:00.000Z');
  assert.equal(result.value.timezone, 'Asia/Shanghai');
  assert.equal(result.value.needs_time_confirmation, false);
});

test('life-event-schema: 缺 title / 超长 title / 非法 domain / 非法 kind 逐项报错', () => {
  const missing = validateLifeEventCandidateOutput({ domain: 'REAL_LIFE' });
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.errors.map((item) => item.field), ['title']);

  const tooLong = validateLifeEventCandidateOutput({ title: 'x'.repeat(81), domain: 'REAL_LIFE' });
  assert.equal(tooLong.valid, false);
  assert.equal(tooLong.errors[0].field, 'title');

  const badDomain = validateLifeEventCandidateOutput({ title: '读《三体》', domain: 'SHARED' });
  assert.equal(badDomain.valid, false);
  assert.ok(badDomain.errors.some((item) => item.field === 'domain'));

  const badKind = validateLifeEventCandidateOutput({ title: '读《三体》', domain: 'REAL_LIFE', event_kind: 'SPORT' });
  assert.equal(badKind.valid, false);
  assert.ok(badKind.errors.some((item) => item.field === 'event_kind'));
});

test('life-event-schema: 含糊日期（只有 raw_time_text 无 ISO）→ needs_time_confirmation', () => {
  const result = validateLifeEventCandidateOutput({
    title: '下周和朋友的聚餐',
    domain: 'REAL_LIFE',
    event_kind: 'OTHER',
    raw_time_text: '周五晚上'
  });
  assert.equal(result.valid, true);
  assert.equal(result.value.scheduled_at, null);
  assert.equal(result.value.time_precision, 'UNKNOWN');
  assert.equal(result.value.needs_time_confirmation, true);
  assert.equal(result.value.raw_time_text, '周五晚上');
});

test('life-event-schema: 模型自报 time_uncertain 也置 needs_time_confirmation', () => {
  const result = validateLifeEventCandidateOutput({ title: '面试', domain: 'REAL_LIFE', scheduled_at: '2026-10-02', time_uncertain: true });
  assert.equal(result.value.needs_time_confirmation, true);
});

test('life-event-schema: 虚构归属 FICTIONAL_SHARED 合法且不强制日期', () => {
  const result = validateLifeEventCandidateOutput({ title: '共写的科幻短篇', domain: 'FICTIONAL_SHARED', event_kind: 'CREATION' });
  assert.equal(result.valid, true);
  assert.equal(result.value.needs_time_confirmation, false);
});

test('life-event-schema: resolveTimePrecision 按时段有无推导 DATE/MINUTE/UNKNOWN', () => {
  assert.equal(resolveTimePrecision('2026-10-02'), 'DATE');
  assert.equal(resolveTimePrecision('2026-10-02T00:00:00Z'), 'MINUTE'); // 显式午夜=确切时刻
  assert.equal(resolveTimePrecision('2026-10-02T14:30'), 'MINUTE');
  assert.equal(resolveTimePrecision(null), 'UNKNOWN');
  assert.ok(LIFE_EVENT_TIME_PRECISIONS.includes('UNKNOWN'));
});

test('life-event-schema: isValidIanaTimezone 只认 IANA 名单', () => {
  assert.equal(isValidIanaTimezone('Asia/Shanghai'), true);
  assert.equal(isValidIanaTimezone('UTC'), true);
  assert.equal(isValidIanaTimezone('不是时区'), false);
  assert.equal(isValidIanaTimezone(42), false);
});

// —— 修订字段校验（PATCH / confirm-edited 共用）——

test('life-event-schema: 修订允许字段白名单外的键直接报错（防拼写错静默丢失）', () => {
  const result = validateLifeEventRevisionFields({ titel: '拼错的键' }, { current: { title: '面试', domain: 'REAL_LIFE' } });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((item) => item.field === 'titel'));
});

test('life-event-schema: domain 变更必须携带 domain_change_confirmed', () => {
  const denied = validateLifeEventRevisionFields({ domain: 'FICTIONAL_SHARED' }, { current: { domain: 'REAL_LIFE' } });
  assert.equal(denied.ok, false);
  assert.equal(denied.domain_change_required, true);
  assert.ok(denied.errors.some((item) => item.field === 'domain_change_confirmed'));

  const allowed = validateLifeEventRevisionFields({ domain: 'FICTIONAL_SHARED', domain_change_confirmed: true }, { current: { domain: 'REAL_LIFE' } });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.domain, 'FICTIONAL_SHARED');
});

test('life-event-schema: 清空 scheduled_at → 精度归 UNKNOWN 且需补时间', () => {
  const result = validateLifeEventRevisionFields({ scheduled_at: null }, {
    current: { title: '面试', domain: 'REAL_LIFE', scheduled_at: '2026-10-02T00:00:00.000Z', time_precision: 'MINUTE', clarification_required: false }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.scheduled_at, null);
  assert.equal(result.value.time_precision, 'UNKNOWN');
  assert.equal(result.value.clarification_required, true);
});

test('life-event-schema: status 只认四个枚举值', () => {
  const bad = validateLifeEventRevisionFields({ status: 'DONE' }, { current: { domain: 'REAL_LIFE' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((item) => item.field === 'status'));
  const good = validateLifeEventRevisionFields({ status: 'COMPLETED' }, { current: { domain: 'REAL_LIFE' } });
  assert.equal(good.ok, true);
  assert.equal(good.value.status, 'COMPLETED');
});

test('life-event-schema: 枚举常量冻结且与迁移 CHECK 对齐', () => {
  assert.deepEqual(LIFE_EVENT_DOMAINS, ['REAL_LIFE', 'FICTIONAL_SHARED']);
  assert.deepEqual(LIFE_EVENT_KINDS, ['INTERVIEW', 'READING', 'CREATION', 'OTHER']);
  assert.equal(Object.isFrozen(LIFE_EVENT_DOMAINS), true);
});

test('life-event-schema: 确定性机构名脱敏——后缀型机构名从模型 title 中删除（2026-09-30 真实验收发现）', () => {
  const { sanitizeLifeEventTitle, validateLifeEventCandidateOutput } = require('../src/domain/life-event-schema');
  assert.equal(sanitizeLifeEventTitle('周五下午阿里巴巴面试'), '周五下午阿里巴巴面试'); // 无后缀专名：确定性规则抓不到，由用户确认环节兜底
  assert.equal(sanitizeLifeEventTitle('下个月协和医院小手术'), '下个月小手术');
  assert.equal(sanitizeLifeEventTitle('周三去腾讯有限公司签约'), '周三去签约');
  assert.equal(sanitizeLifeEventTitle('在招商银行开户'), '在开户');
  assert.equal(sanitizeLifeEventTitle('普通候选不含机构'), '普通候选不含机构');
  // 模型输出校验路径自动脱敏（用户修订路径不脱敏——自己的数据自己决定）。
  const sanitized = validateLifeEventCandidateOutput({ title: '下个月协和医院小手术', domain: 'REAL_LIFE' });
  assert.equal(sanitized.valid, true);
  assert.equal(sanitized.value.title, '下个月小手术');
  // 脱敏后为空 → 候选无效丢弃。
  const emptied = validateLifeEventCandidateOutput({ title: '协和医院', domain: 'REAL_LIFE' });
  assert.equal(emptied.valid, false);
});
