'use strict';

const NORMAL_TRIGGER_TYPES = new Set(['SUBSCRIBED_MORNING', 'SUBSCRIBED_EVENING', 'CONFIRMED_ANNIVERSARY', 'CONFIRMED_BIRTHDAY', 'CONFIRMED_APPOINTMENT', 'CONFIRMED_REALITY_ACTION']);
const SYSTEM_TRIGGER_TYPES = new Set(['SERVICE_NOTICE', 'SAFETY_NOTICE', 'DATA_RIGHTS_NOTICE']);

// This policy owns the irreversible decision to send. A language model receives
// only a template slot after this returns allowed=true; it cannot increase
// frequency, infer churn, or bypass the user's quiet hours.
function evaluateProactiveDispatch({ preferences, trigger, sentAt = [], now = new Date() } = {}) {
  if (!trigger || typeof trigger.type !== 'string') return denied('TRIGGER_INVALID');
  if (SYSTEM_TRIGGER_TYPES.has(trigger.type)) return { allowed: true, kind: 'SYSTEM', template_slot: trigger.type };
  if (!NORMAL_TRIGGER_TYPES.has(trigger.type)) return denied('TRIGGER_FORBIDDEN');
  if (!preferences || preferences.enabled !== true) return denied('USER_OPTED_OUT');
  if (isQuietHour(preferences, now)) return denied('QUIET_HOURS');
  const dayStart = localDayStart(now, preferences.timezoneOffsetMinutes);
  const normalSentToday = sentAt.filter((value) => {
    const sent = new Date(value);
    return !Number.isNaN(sent.getTime()) && sent >= dayStart && sent <= now;
  }).length;
  if (normalSentToday >= 1) return denied('DAILY_LIMIT_REACHED');
  return { allowed: true, kind: 'NORMAL', template_slot: trigger.type };
}

function isQuietHour(preferences, now) {
  const start = preferences.quietStartHour;
  const end = preferences.quietEndHour;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23 || start === end) return false;
  const hour = localHour(now, preferences.timezoneOffsetMinutes);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
function localHour(date, offset = 0) { return new Date(date.getTime() + validOffset(offset) * 60000).getUTCHours(); }
function localDayStart(date, offset = 0) {
  const adjusted = new Date(date.getTime() + validOffset(offset) * 60000);
  adjusted.setUTCHours(0, 0, 0, 0);
  return new Date(adjusted.getTime() - validOffset(offset) * 60000);
}
function validOffset(value) { return Number.isInteger(value) && value >= -720 && value <= 840 ? value : 0; }
function denied(reason) { return { allowed: false, reason }; }

module.exports = { NORMAL_TRIGGER_TYPES, SYSTEM_TRIGGER_TYPES, evaluateProactiveDispatch };
