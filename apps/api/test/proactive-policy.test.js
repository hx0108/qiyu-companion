'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProactiveDispatch } = require('../src/domain/proactive-policy');

const now = new Date('2026-09-05T13:00:00.000Z'); // China local 21:00
const preferences = { enabled: true, quietStartHour: 23, quietEndHour: 8, timezoneOffsetMinutes: 480 };

test('主动互动只允许用户订阅或用户确认事件，且每日普通触发最多一次', () => {
  assert.deepEqual(evaluateProactiveDispatch({ preferences, trigger: { type: 'CONFIRMED_ANNIVERSARY' }, now }), { allowed: true, kind: 'NORMAL', template_slot: 'CONFIRMED_ANNIVERSARY' });
  assert.deepEqual(evaluateProactiveDispatch({ preferences, trigger: { type: 'CONFIRMED_ANNIVERSARY' }, sentAt: ['2026-09-05T01:00:00.000Z'], now }), { allowed: false, reason: 'DAILY_LIMIT_REACHED' });
  assert.deepEqual(evaluateProactiveDispatch({ preferences, trigger: { type: 'CHURN_PREDICTION' }, now }), { allowed: false, reason: 'TRIGGER_FORBIDDEN' });
});

test('用户退出或静默时段阻断普通互动，但安全与数据权利通知可独立送达', () => {
  assert.deepEqual(evaluateProactiveDispatch({ preferences: { ...preferences, enabled: false }, trigger: { type: 'SUBSCRIBED_MORNING' }, now }), { allowed: false, reason: 'USER_OPTED_OUT' });
  assert.deepEqual(evaluateProactiveDispatch({ preferences, trigger: { type: 'SUBSCRIBED_EVENING' }, now: new Date('2026-09-05T16:00:00.000Z') }), { allowed: false, reason: 'QUIET_HOURS' });
  assert.deepEqual(evaluateProactiveDispatch({ preferences: { enabled: false }, trigger: { type: 'DATA_RIGHTS_NOTICE' }, now }), { allowed: true, kind: 'SYSTEM', template_slot: 'DATA_RIGHTS_NOTICE' });
});
