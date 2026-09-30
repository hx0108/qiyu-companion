'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FOLLOWUP_KINDS, FOLLOWUP_KIND_TO_TRIGGER,
  DEFAULT_BEFORE_OFFSET_MINUTES, DEFAULT_AFTER_OFFSET_MINUTES,
  validateFollowupGrantRequest, validateFollowupComposerOutput
} = require('../src/domain/followup-schema');

const NOW = new Date('2026-10-01T08:00:00.000Z');
const EVENT = { event_id: 'levt_1', version: 2, timezone: 'Asia/Shanghai', clarification_required: false, status: 'PLANNED', scheduled_at: '2026-10-02T06:30:00.000Z', title: '周五的产品经理面试' };

test('followup-schema: 默认派生——事前=事件准点、事后=事件后 2 小时、窗口 24h', () => {
  const before = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: EVENT, now: NOW });
  assert.equal(before.ok, true);
  assert.equal(before.value.due_at, EVENT.scheduled_at);
  assert.equal(before.value.allowed_from, NOW.toISOString());
  assert.equal(before.value.expires_at, '2026-10-03T06:30:00.000Z');

  const after = validateFollowupGrantRequest({ followup_kind: 'AFTER_EVENT' }, { event: EVENT, now: NOW });
  assert.equal(after.value.due_at, '2026-10-02T08:30:00.000Z');
  assert.equal(DEFAULT_BEFORE_OFFSET_MINUTES, 0);
  assert.equal(DEFAULT_AFTER_OFFSET_MINUTES, 120);
});

test('followup-schema: 时区为空不调度；时间待确认不开提醒；已取消事件拒绝', () => {
  const noTz = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: { ...EVENT, timezone: null }, now: NOW });
  assert.equal(noTz.ok, false);
  assert.ok(noTz.errors.some((item) => item.field === 'timezone'));

  const vague = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: { ...EVENT, clarification_required: true }, now: NOW });
  assert.equal(vague.ok, false);
  assert.ok(vague.errors.some((item) => item.field === 'scheduled_at'));

  const cancelled = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: { ...EVENT, status: 'CANCELLED' }, now: NOW });
  assert.equal(cancelled.ok, false);
  assert.ok(cancelled.errors.some((item) => item.field === 'status'));
});

test('followup-schema: 过时 due_at 不补发；无确切时间事件必须显式给 due_at', () => {
  const past = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT', due_at: '2026-09-30T00:00:00Z' }, { event: EVENT, now: NOW });
  assert.equal(past.ok, false);
  assert.ok(past.errors.some((item) => item.field === 'due_at' && /不补发/.test(item.reason)));

  const noSchedule = { ...EVENT, scheduled_at: null };
  const missing = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: noSchedule, now: NOW });
  assert.equal(missing.ok, false);
  const explicit = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT', due_at: '2026-10-02T10:00:00Z' }, { event: noSchedule, now: NOW });
  assert.equal(explicit.ok, true);
});

test('followup-schema: BEFORE_EVENT 只适用计划中事件；kind 枚举与触发映射', () => {
  const done = validateFollowupGrantRequest({ followup_kind: 'BEFORE_EVENT' }, { event: { ...EVENT, status: 'COMPLETED' }, now: NOW });
  assert.equal(done.ok, false);
  assert.ok(done.errors.some((item) => item.field === 'followup_kind' && /计划中/.test(item.reason)));

  const badKind = validateFollowupGrantRequest({ followup_kind: 'SOMETIME' }, { event: EVENT, now: NOW });
  assert.equal(badKind.ok, false);
  assert.deepEqual(FOLLOWUP_KINDS, ['BEFORE_EVENT', 'AFTER_EVENT']);
  assert.equal(FOLLOWUP_KIND_TO_TRIGGER.BEFORE_EVENT, 'CONFIRMED_APPOINTMENT');
  assert.equal(FOLLOWUP_KIND_TO_TRIGGER.AFTER_EVENT, 'CONFIRMED_REALITY_ACTION');
});

test('followup-composer-output: 空/超长/不含事件标题都拒绝（模型不许脱 fact）', () => {
  assert.equal(validateFollowupComposerOutput({ text: '' }, { eventTitle: '面试' }).ok, false);
  assert.equal(validateFollowupComposerOutput({ text: 'x'.repeat(201) }, { eventTitle: 'x' }).ok, false);
  assert.equal(validateFollowupComposerOutput({ text: '加油加油加油' }, { eventTitle: '面试' }).ok, false);
  assert.equal(validateFollowupComposerOutput({ text: '「面试」加油，按你的节奏来' }, { eventTitle: '面试' }).ok, true);
});
