'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = 'dev-alice-token', key, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function passAge(base, prefix) {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

async function createEvent(base, key, body = { type: 'SUBSCRIBED_MORNING', title: '早安提醒' }) {
  return request(base, '/api/v1/proactive-events', { method: 'POST', key, body });
}

// 默认静默 23-8 会覆盖深夜运行的测试：把静默窗动态放到当前小时之外。
async function setNonQuietHours(base, key) {
  const hour = new Date().getUTCHours();
  const start = (hour + 1) % 23;
  let end = (start + 1) % 23;
  if (end === start) end = (end + 1) % 23;
  await request(base, '/api/v1/proactive-preferences', { method: 'PUT', key, body: { enabled: true, quiet_start_hour: start, quiet_end_hour: end } });
}

test('偏好默认开启且每日限1条；关闭立即生效', async (t) => {
  const base = await start(t);
  await passAge(base, 'pp');

  const preferences = await request(base, '/api/v1/proactive-preferences');
  assert.equal(preferences.body.preferences.enabled, true);
  assert.equal(preferences.body.policy.max_normal_per_day, 1);

  const invalid = await request(base, '/api/v1/proactive-preferences', { method: 'PUT', key: 'pp-bad', body: { quiet_start_hour: 5, quiet_end_hour: 5 } });
  assert.equal(invalid.status, 400);

  const updated = await request(base, '/api/v1/proactive-preferences', { method: 'PUT', key: 'pp-off', body: { enabled: false } });
  assert.equal(updated.body.preferences.enabled, false);

  // 关闭后普通触发被规则引擎拒绝。
  const event = await createEvent(base, 'pp-ev');
  const denied = await request(base, `/api/v1/proactive-events/${event.body.event.event_id}/trigger`, { method: 'POST', key: 'pp-trig-1' });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.dispatched, false);
  assert.equal(denied.body.reason, 'USER_OPTED_OUT');

  await request(base, '/api/v1/proactive-preferences', { method: 'PUT', key: 'pp-on', body: { enabled: true } });
});

test('事件创建/删除与每日1条上限：第一条发出，第二条被拒', async (t) => {
  const base = await start(t);
  await passAge(base, 'pe');
  await setNonQuietHours(base, 'pe-quiet');

  const badType = await createEvent(base, 'pe-bad', { type: 'MODEL_CHURN_GUESS', title: 'x' });
  assert.equal(badType.status, 400);

  const morning = await createEvent(base, 'pe-m', { type: 'SUBSCRIBED_MORNING', title: '早安提醒' });
  assert.equal(morning.status, 201);
  const evening = await createEvent(base, 'pe-e', { type: 'SUBSCRIBED_EVENING', title: '晚安提醒' });
  assert.equal(evening.status, 201);

  const first = await request(base, `/api/v1/proactive-events/${morning.body.event.event_id}/trigger`, { method: 'POST', key: 'pe-t1' });
  assert.equal(first.status, 201);
  assert.equal(first.body.dispatched, true);
  assert.equal(first.body.message.template_slot, 'SUBSCRIBED_MORNING');
  assert.match(first.body.message.text, /早安/);
  assert.equal(first.body.message.kind, 'NORMAL');

  const second = await request(base, `/api/v1/proactive-events/${evening.body.event.event_id}/trigger`, { method: 'POST', key: 'pe-t2' });
  assert.equal(second.body.dispatched, false);
  assert.equal(second.body.reason, 'DAILY_LIMIT_REACHED');

  // 删除事件后触发被拒。
  await request(base, `/api/v1/proactive-events/${evening.body.event.event_id}`, { method: 'DELETE', key: 'pe-del' });
  const afterDelete = await request(base, `/api/v1/proactive-events/${evening.body.event.event_id}/trigger`, { method: 'POST', key: 'pe-t3' });
  assert.equal(afterDelete.status, 409);

  const messages = await request(base, '/api/v1/proactive-messages');
  assert.equal(messages.body.messages.length, 1);
  const events = await request(base, '/api/v1/proactive-events');
  assert.equal(events.body.events.length, 1);
});

test('纪念日模板填入标题，含内疚/惩罚话术的模板不存在', async (t) => {
  const base = await start(t);
  await passAge(base, 'an');
  await setNonQuietHours(base, 'an-quiet');
  const event = await createEvent(base, 'an-ev', { type: 'CONFIRMED_ANNIVERSARY', title: '在一起一百天', due_at: '2026-10-01T00:00:00Z' });
  const sent = await request(base, `/api/v1/proactive-events/${event.body.event.event_id}/trigger`, { method: 'POST', key: 'an-t' });
  assert.equal(sent.body.dispatched, true);
  assert.match(sent.body.message.text, /在一起一百天/);
  const source = require('../src/app');
  assert.ok(source, 'app module loads');
  // 模板话术红线：不出现内疚诱导词。
  const { PROACTIVE_TEMPLATES } = require('../src/domain/proactive-templates');
  for (const template of Object.values(PROACTIVE_TEMPLATES)) {
    assert.ok(!/你不来|我会难过|惩罚|不理你/.test(template), `模板含禁止话术: ${template}`);
  }
});
