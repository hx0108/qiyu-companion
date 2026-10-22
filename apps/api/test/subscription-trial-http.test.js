'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { MediaEntitlementService } = require('../src/domain/media-entitlement-service');

async function start(t, store = new DevelopmentStore(), options = {}) {
  const server = createApp({ store, ...options });
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
  // 基线发放量仅保留历史审计；当前有效试用期由 quota_policy 明确免计量。
  assert.equal(byCapability.SYNTHESIZE_TTS.granted_quantity, 30 * 60);
  assert.equal(byCapability.TRANSCRIBE_ASR.granted_quantity, 10 * 60);
  assert.equal(byCapability.SYNTHESIZE_TTS.quota_policy, 'UNLIMITED_DURING_TRIAL');
  assert.equal(byCapability.TRANSCRIBE_ASR.quota_policy, 'UNLIMITED_DURING_TRIAL');

  const currentPolicy = await request(base, '/api/v1/subscriptions/current');
  assert.equal(currentPolicy.body.trial_product.voice_quota_policy, 'UNLIMITED_DURING_TRIAL');

  store.subscriptions.set(started.body.subscription.subscription_id, { ...started.body.subscription, period_end: new Date(Date.now() + 12 * 3600000).toISOString() });
  const ending = await request(base, '/api/v1/subscriptions/current');
  assert.equal(ending.body.trial.phase, 'ENDING');

  const duplicate = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: 'trial-duplicate' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'TRIAL_ALREADY_CLAIMED');
});

test('有效试用期内 ASR/TTS 不再因账本余额耗尽失败，且不会继续扣减语音账本', async (t) => {
  const store = new DevelopmentStore();
  const ledger = new MediaEntitlementService({ store });
  const { base } = await start(t, store, {
    imageEntitlementService: ledger,
    voiceCallEnabled: true,
    asrTranscriber: async () => ({ text: '今天想聊聊天', providerRequestId: 'asr-unlimited-trial' }),
    ttsGenerator: async () => ({ asset: { bytes: Buffer.from('mp3'), mimeType: 'audio/mpeg' }, providerRequestId: 'tts-unlimited-trial' })
  });
  await passAge(base);
  const started = await request(base, '/api/v1/subscription-trials', { method: 'POST', key: 'trial-unlimited-start' });
  assert.equal(started.status, 201);

  const initial = ledger.entitlementBalances('acct_dev_alice');
  const tts = initial.find((item) => item.capability === 'SYNTHESIZE_TTS');
  const asr = initial.find((item) => item.capability === 'TRANSCRIBE_ASR');
  ledger.reserve({ accountId: 'acct_dev_alice', jobId: 'exhaust-tts', capability: 'SYNTHESIZE_TTS', quantity: tts.available_quantity });
  ledger.commit({ accountId: 'acct_dev_alice', jobId: 'exhaust-tts', capability: 'SYNTHESIZE_TTS', quantity: tts.available_quantity });
  ledger.reserve({ accountId: 'acct_dev_alice', jobId: 'exhaust-asr', capability: 'TRANSCRIBE_ASR', quantity: asr.available_quantity });
  ledger.commit({ accountId: 'acct_dev_alice', jobId: 'exhaust-asr', capability: 'TRANSCRIBE_ASR', quantity: asr.available_quantity });

  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'trial-unlimited-character', body: { name: '语音试用角色' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'trial-unlimited-conversation', body: { character_id: character.body.character.character_id } });
  const conversationId = conversation.body.conversation.conversation_id;
  const call = await request(base, `/api/v1/conversations/${conversationId}/calls`, { method: 'POST', key: 'trial-unlimited-call' });
  assert.equal(call.status, 201, JSON.stringify(call.body));
  const sent = await request(base, `/api/v1/conversations/${conversationId}/messages`, { method: 'POST', key: 'trial-unlimited-message', body: { content: { text: '请用语音回应我' } } });

  const ttsJob = await request(base, `/api/v1/messages/${sent.body.assistant_message.message_id}/tts-jobs`, { method: 'POST', key: 'trial-unlimited-tts' });
  assert.equal(ttsJob.body.tts_job.state, 'COMPLETED', JSON.stringify(ttsJob.body));
  const asrJob = await request(base, `/api/v1/conversations/${conversationId}/asr-jobs`, {
    method: 'POST', key: 'trial-unlimited-asr', body: { mime_type: 'audio/wav', audio_base64: Buffer.alloc(32000).toString('base64') }
  });
  assert.equal(asrJob.body.asr_job.state, 'COMPLETED', JSON.stringify(asrJob.body));

  const exhausted = ledger.entitlementBalances('acct_dev_alice');
  assert.equal(exhausted.find((item) => item.capability === 'SYNTHESIZE_TTS').available_quantity, 0);
  assert.equal(exhausted.find((item) => item.capability === 'TRANSCRIBE_ASR').available_quantity, 0);
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
