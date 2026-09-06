'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { MemoryTrialInviteAuth } = require('../src/domain/trial-invite-auth');

async function start(t, options) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = '', body, key } = {}) {
  const headers = { authorization: token ? `Bearer ${token}` : '' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('封闭试用：邀请码首次登录、年龄准入、反馈持久化与会话轮换均隔离在同一账户', async (t) => {
  const store = new DevelopmentStore();
  const trialAuth = new MemoryTrialInviteAuth({ store });
  await trialAuth.provisionInvite({ inviteCode: 'QYTEST-ALPHA-BETA', initialSecret: 'a_secure_trial_secret_1234567890' });
  const base = await start(t, { store, trialAuthEnabled: true, trialAuth });

  const access = await request(base, '/api/v1/trial-access');
  assert.deepEqual(access.body, { enabled: true, authentication: 'closed-trial-invite', payment: 'disabled', external_age_verification: 'disabled' });
  const legacyToken = await request(base, '/api/v1/usage/daily', { token: 'dev-alice-token' });
  assert.equal(legacyToken.status, 401);
  const rejected = await request(base, '/api/v1/auth/trial-sessions', { method: 'POST', body: { invite_code: 'QYTEST-ALPHA-BETA', initial_secret: 'wrong' } });
  assert.equal(rejected.status, 401);

  const login = await request(base, '/api/v1/auth/trial-sessions', { method: 'POST', body: { invite_code: 'QYTEST-ALPHA-BETA', initial_secret: 'a_secure_trial_secret_1234567890' } });
  assert.equal(login.status, 201);
  assert.equal(login.body.authentication, 'closed-trial-invite');
  const token = login.body.tokens.access_token;
  const notices = await request(base, '/api/v1/required-notices', { token });
  assert.equal(notices.status, 200);
  await request(base, `/api/v1/required-notices/${notices.body.notices[0].notice_id}/displayed`, { method: 'POST', token, key: 'trial-notice', body: { notice_version: notices.body.notices[0].notice_version } });
  const age = await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: 'trial-age', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  assert.equal(age.body.status, 'AGE_PASS');

  const feedback = await request(base, '/api/v1/trial-feedback', { method: 'POST', token, key: 'trial-feedback', body: { category: 'USABILITY', rating: 4, note: '角色创建流程清晰。' } });
  assert.equal(feedback.status, 201);
  const list = await request(base, '/api/v1/trial-feedback', { token });
  assert.deepEqual(list.body.feedback.map(({ category, rating, note }) => ({ category, rating, note })), [{ category: 'USABILITY', rating: 4, note: '角色创建流程清晰。' }]);

  const refreshed = await request(base, '/api/v1/auth/trial-sessions/refresh', { method: 'POST', body: { refresh_token: login.body.tokens.refresh_token } });
  assert.equal(refreshed.status, 200);
  assert.equal((await request(base, '/api/v1/required-notices', { token })).status, 401, '旧 access token 必须在刷新后失效');
  assert.equal((await request(base, '/api/v1/required-notices', { token: refreshed.body.tokens.access_token })).status, 200);
  assert.equal((await request(base, '/api/v1/auth/trial-sessions/refresh', { method: 'POST', body: { refresh_token: login.body.tokens.refresh_token } })).status, 401, '旧 refresh token 不可重放');
});

test('封闭试用：由持久化 store 提供的认证仓库也会解析后续 Bearer token', async (t) => {
  const store = new DevelopmentStore();
  const trialAuth = new MemoryTrialInviteAuth({ store });
  store.createTrialSession = (input) => trialAuth.createSession(input);
  store.resolveTrialAccessToken = (token) => trialAuth.resolveAccessToken(token);
  store.refreshTrialSession = (input) => trialAuth.refreshSession(input);
  await trialAuth.provisionInvite({ inviteCode: 'QYPERSIST-ALPHA-BETA', initialSecret: 'another_secure_trial_secret_1234567890' });
  const base = await start(t, { store, trialAuthEnabled: true });

  const login = await request(base, '/api/v1/auth/trial-sessions', {
    method: 'POST', body: { invite_code: 'QYPERSIST-ALPHA-BETA', initial_secret: 'another_secure_trial_secret_1234567890' }
  });
  assert.equal(login.status, 201);
  const notices = await request(base, '/api/v1/required-notices', { token: login.body.tokens.access_token });
  assert.equal(notices.status, 200);
  assert.equal(notices.body.notices.length, 1);
});
