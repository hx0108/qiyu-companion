'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { AuthService, AuthServiceError } = require('../src/domain/auth-service');
const { createTencentSmsSenderFromEnvironment } = require('../src/providers/tencent-sms-adapter');

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

test('验证码防爆破：错码计数，5 次即作废，正确码也不能再用', async () => {
  const service = new AuthService({ store: new DevelopmentStore() });
  await service.createSmsChallenge({ phone: '13800001234' });
  for (let round = 1; round <= 4; round += 1) {
    assert.throws(() => service.register({ phone: '13800001234', code: '111111' }), (error) => error.code === 'SMS_CODE_INVALID');
  }
  // 第 5 次仍是错码：作废并锁定。
  assert.throws(() => service.register({ phone: '13800001234', code: '111111' }), (error) => error.code === 'SMS_CHALLENGE_LOCKED');
  // 作废后连正确码也被拒绝：须重新获取验证码。
  assert.throws(() => service.register({ phone: '13800001234', code: '000000' }), (error) => error.code === 'SMS_CHALLENGE_NOT_FOUND');
});

test('挑战频控：每手机号 24 小时最多 10 条', async () => {
  let clock = new Date('2026-09-08T10:00:00Z').getTime();
  const service = new AuthService({ store: new DevelopmentStore(), now: () => new Date(clock) });
  for (let round = 1; round <= 10; round += 1) {
    await service.createSmsChallenge({ phone: '13900001234' });
    clock += 65_000; // 错开每分钟频控，只考察 24 小时上限。
  }
  await assert.rejects(() => service.createSmsChallenge({ phone: '13900001234' }), (error) => error.code === 'REGISTRATION_DAILY_LIMITED');
  clock += 24 * 60 * 60 * 1000 + 65_000; // 次日窗口重置。
  await service.createSmsChallenge({ phone: '13900001234' });
});

test('真实短信通道：随机码经供应商发送、响应不回显；发送失败不落挑战', async () => {
  const sent = [];
  const service = new AuthService({ store: new DevelopmentStore(), smsSender: { provider: 'fake-sms', async send({ phone, code }) { sent.push({ phone, code }); } } });
  const challenge = await service.createSmsChallenge({ phone: '13700001234' });
  assert.equal(challenge.channel, 'fake-sms');
  assert.equal('dev_code' in challenge, false, '真实通道不得回显开发码');
  assert.ok(!JSON.stringify(challenge).includes(sent[0].code), '响应不得包含验证码');
  assert.match(sent[0].code, /^[0-9]{6}$/);
  const registered = service.register({ phone: '13700001234', code: sent[0].code });
  assert.ok(registered.tokens.access_token);
  // 供应商失败：挑战不落库，用户可立即重试。
  const failing = new AuthService({ store: new DevelopmentStore(), smsSender: { provider: 'fake-sms', async send() { throw new Error('upstream down'); } } });
  await assert.rejects(() => failing.createSmsChallenge({ phone: '13600001234' }), /upstream down/);
  assert.equal([...failing.store.smsChallenges?.values() ?? []].length, 0);
});

test('腾讯 SMS 适配器：SendSms 契约与供应商拒绝的安全映射', async () => {
  let captured;
  const sender = createTencentSmsSenderFromEnvironment({
    QIYU_SMS_PROVIDER: 'tencent', QIYU_SMS_SDK_APP_ID: 'app-1', QIYU_SMS_SIGN_NAME: '栖语', QIYU_SMS_TEMPLATE_ID: 'tpl-1',
    TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key'
  }, { clientFactory: () => ({ async request({ service, action, version, body }) { captured = { service, action, version, body }; return { RequestId: 'req-sms-1', SendStatusSet: [{ Code: 'Ok' }] }; } }) });
  const result = await sender.send({ phone: '13500001234', code: '482913' });
  assert.deepEqual(captured, { service: 'sms', action: 'SendSms', version: '2021-01-11', body: { PhoneNumberSet: ['+8613500001234'], SmsSdkAppId: 'app-1', SignName: '栖语', TemplateId: 'tpl-1', TemplateParamSet: ['482913'] } });
  assert.equal(result.providerRequestId, 'req-sms-1');
  const rejected = createTencentSmsSenderFromEnvironment({
    QIYU_SMS_PROVIDER: 'tencent', QIYU_SMS_SDK_APP_ID: 'app-1', QIYU_SMS_SIGN_NAME: '栖语', QIYU_SMS_TEMPLATE_ID: 'tpl-1',
    TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key'
  }, { clientFactory: () => ({ async request() { return { RequestId: 'req-sms-2', SendStatusSet: [{ Code: 'LimitExceeded.PhoneNumberDailyLimit' }] }; } }) });
  await assert.rejects(() => rejected.send({ phone: '13500001234', code: '482913' }), (error) => error.code === 'TENCENT_SMS_SEND_REJECTED' && error.retryable === true && !String(error.message).includes('PhoneNumberDailyLimit'));
  assert.equal(createTencentSmsSenderFromEnvironment({}), null, '未启用时返回 null（回退开发码）');
  assert.throws(() => createTencentSmsSenderFromEnvironment({ QIYU_SMS_PROVIDER: 'tencent' }), (error) => error.code === 'TENCENT_SMS_CONFIG_REQUIRED');
});

test('站内通知：注销启动与人工授予订阅各落一条，可读可标记', async (t) => {
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  const before = await request(base, '/api/v1/notifications');
  assert.equal(before.body.notifications.length, 0);
  const deletion = await request(base, '/api/v1/account-deletions', { method: 'POST', key: 'ntf-del', body: { confirm_text: '注销' } });
  assert.equal(deletion.status, 202);
  const listed = await request(base, '/api/v1/notifications');
  assert.equal(listed.body.notifications.length, 1);
  assert.equal(listed.body.notifications[0].type, 'ACCOUNT_DELETION_STARTED');
  assert.equal(listed.body.unread_count, 1);
  const read = await request(base, `/api/v1/notifications/${listed.body.notifications[0].notification_id}/read`, { method: 'POST', key: 'ntf-read' });
  assert.equal(read.body.notification.read, true);
  const after = await request(base, '/api/v1/notifications');
  assert.equal(after.body.unread_count, 0);
  // 他人通知不可见（单账户开发 store 下以 id 命中为准的越权检查）。
  const missing = await request(base, '/api/v1/notifications/ntf_unknown/read', { method: 'POST', key: 'ntf-miss' });
  assert.equal(missing.status, 404);
});
