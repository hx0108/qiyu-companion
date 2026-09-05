'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');

async function start(t, store = new DevelopmentStore()) {
  const server = createApp({ store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, store };
}

async function request(base, path, { method = 'GET', key, body } = {}) {
  const headers = { authorization: 'Bearer dev-alice-token' };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function passAge(base) {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: 'trial-notice', body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'trial-age', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

test('7 天完整体验：年龄准入后一次性发放，绝不创建支付订单或自动续费', async (t) => {
  const { base, store } = await start(t);
  const blocked = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: 'trial-before-age' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AGE_NOT_PASSED');

  await passAge(base);
  const started = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: 'trial-start' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.subscription.state, 'TRIAL');
  assert.equal(started.body.subscription.auto_renew, false);
  assert.equal(Date.parse(started.body.subscription.period_end) - Date.parse(started.body.subscription.period_start), 7 * 86400000);
  assert.equal(store.subscriptionOrders.size, 0);
  assert.equal(store.paymentEvents.size, 0);

  const balances = await request(base, '/api/v1/entitlements');
  const byCapability = Object.fromEntries(balances.body.entitlements.map((item) => [item.capability, item]));
  assert.equal(byCapability.IMAGE_GENERATION.granted_quantity, 3);
  assert.equal(byCapability.SYNTHESIZE_TTS.granted_quantity, 5 * 60);
  assert.equal(byCapability.TRANSCRIBE_ASR.granted_quantity, 0);

  store.subscriptions.set(started.body.subscription.subscription_id, { ...started.body.subscription, period_end: new Date(Date.now() + 12 * 3600000).toISOString() });
  const ending = await request(base, '/api/v1/subscriptions/current');
  assert.equal(ending.body.trial.phase, 'ENDING');

  const duplicate = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: 'trial-duplicate' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'TRIAL_ALREADY_CLAIMED');
});

test('试用到期由服务端状态投影降级，媒体额度失效但数据权利不受订阅状态影响', async (t) => {
  const { base, store } = await start(t);
  await passAge(base);
  const started = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: 'trial-expire-start' });
  const trial = started.body.subscription;
  store.subscriptions.set(trial.subscription_id, { ...trial, period_end: '2020-01-01T00:00:00.000Z' });

  const current = await request(base, '/api/v1/subscriptions/current');
  assert.equal(current.status, 200);
  assert.equal(current.body.subscription, null);
  assert.equal(current.body.trial.state, 'EXPIRED');

  const balances = await request(base, '/api/v1/entitlements');
  assert.ok(balances.body.entitlements.every((item) => item.available_quantity === 0 && item.resets_at === null));
  const retention = await request(base, '/api/v1/privacy/raw-interaction-retention');
  assert.equal(retention.status, 200);
});
