'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { MediaEntitlementService } = require('../src/domain/media-entitlement-service');

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = 'dev-alice-token', key, body, headers } = {}) {
  const allHeaders = { authorization: `Bearer ${token}`, ...(headers || {}) };
  if (key) allHeaders['idempotency-key'] = key;
  if (body !== undefined) allHeaders['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers: allHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function passAge(base, prefix, token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

function developmentPaymentFlow(base, checkoutBody, key) {
  return (async () => {
    const checkout = await request(base, '/api/v1/checkout-sessions', { method: 'POST', key, body: checkoutBody });
    if (checkout.status !== 201) return checkout;
    const callback = await request(base, '/api/v1/callbacks/payments/development-simulated', {
      method: 'POST', key: `${key}-cb`, body: checkout.body.development_payment.callback_body,
      headers: { authorization: '', 'x-qiyu-payment-signature': checkout.body.development_payment.signature }
    });
    return { status: callback.status, body: { checkout: checkout.body, callback: callback.body } };
  })();
}

test('购买闭环：目录下单→验签回调→订阅生效→权益按秒/张发放', async (t) => {
  const base = await start(t);
  await passAge(base, 'sub');

  const badSku = await request(base, '/api/v1/checkout-sessions', { method: 'POST', key: 'sub-bad', body: { sku: 'unknown' } });
  assert.equal(badSku.status, 400);

  const flow = await developmentPaymentFlow(base, { sku: 'qiyu_public_monthly_v1' }, 'sub-ok');
  assert.equal(flow.status, 200, JSON.stringify(flow.body));
  assert.equal(flow.body.checkout.checkout.amount_fen, 3900);
  assert.equal(flow.body.checkout.checkout.auto_renew, false);
  assert.equal(flow.body.callback.outcome, 'APPLIED');

  const current = await request(base, '/api/v1/subscriptions/current');
  assert.equal(current.body.subscription.state, 'ACTIVE');
  assert.equal(current.body.subscription.sku, 'qiyu_public_monthly_v1');

  const entitlements = await request(base, '/api/v1/entitlements');
  assert.equal(entitlements.status, 200);
  const byCapability = Object.fromEntries(entitlements.body.entitlements.map((item) => [item.capability, item]));
  assert.equal(byCapability.IMAGE_GENERATION.granted_quantity, 15);
  assert.equal(byCapability.IMAGE_GENERATION.unit, 'IMAGES');
  assert.equal(byCapability.SYNTHESIZE_TTS.granted_quantity, 30 * 60);
  assert.equal(byCapability.SYNTHESIZE_TTS.unit, 'SECONDS');
  assert.equal(byCapability.TRANSCRIBE_ASR.granted_quantity, 15 * 60);
  assert.ok(byCapability.SYNTHESIZE_TTS.resets_at);
});

test('回调验签失败与事件重放被拒绝/隔离', async (t) => {
  const base = await start(t);
  await passAge(base, 'sec');
  const checkout = await request(base, '/api/v1/checkout-sessions', { method: 'POST', key: 'sec-ok', body: { sku: 'qiyu_public_monthly_v1' } });

  const badSignature = await request(base, '/api/v1/callbacks/payments/development-simulated', {
    method: 'POST', key: 'sec-bad', body: checkout.body.development_payment.callback_body,
    headers: { authorization: '', 'x-qiyu-payment-signature': 'deadbeef' }
  });
  assert.equal(badSignature.status, 401);

  const tampered = { ...checkout.body.development_payment.callback_body, amount: 1 };
  const tamperedCall = await request(base, '/api/v1/callbacks/payments/development-simulated', {
    method: 'POST', key: 'sec-tamper', body: tampered,
    headers: { authorization: '', 'x-qiyu-payment-signature': checkout.body.development_payment.signature }
  });
  assert.equal(tamperedCall.status, 401);
});

test('取消续费：当期权益保留、状态转为 CANCEL_AT_PERIOD_END', async (t) => {
  const base = await start(t);
  await passAge(base, 'cancel');
  const flow = await developmentPaymentFlow(base, { sku: 'qiyu_public_monthly_v1' }, 'cancel-ok');
  const subscriptionId = flow.body.checkout.checkout.subscription_id;

  const cancelled = await request(base, `/api/v1/subscriptions/${subscriptionId}/cancel-renewal`, { method: 'POST', key: 'cancel-run' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.subscription.state, 'CANCEL_AT_PERIOD_END');
  assert.equal(cancelled.body.subscription.auto_renew, false);

  const again = await request(base, `/api/v1/subscriptions/${subscriptionId}/cancel-renewal`, { method: 'POST', key: 'cancel-again' });
  assert.equal(again.status, 409);
});

test('TTS 任务按秒计量：成功提交扣减、失败返还、无额度时不阻塞文字', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const base = await start(t, {
    store,
    ttsGenerator: async () => ({
      asset: { bytes: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' }, providerRequestId: 'tts-test'
    }),
    imageEntitlementService: new MediaEntitlementService({ store })
  });
  await passAge(base, 'meter');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'meter-c', body: { name: '计量角色' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'meter-v', body: { character_id: character.body.character.character_id } });
  const sent = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'meter-m', body: { content: { text: '一段十六字以上的回复文本来估算语音秒数' } } });
  const messageId = sent.body.assistant_message.message_id;

  // 无订阅无额度：TTS 失败但带明确原因，文字消息仍在。
  const noQuota = await request(base, `/api/v1/messages/${messageId}/tts-jobs`, { method: 'POST', key: 'meter-tts-1' });
  assert.equal(noQuota.status, 202);
  assert.equal(noQuota.body.tts_job.state, 'FAILED');
  assert.equal(noQuota.body.tts_job.failure_code, 'ENTITLEMENT_QUOTA_EXCEEDED');

  // 购买订阅获得 1800 秒。
  const flow = await developmentPaymentFlow(base, { sku: 'qiyu_public_monthly_v1' }, 'meter-buy');
  assert.equal(flow.body.callback.outcome, 'APPLIED');

  const ok = await request(base, `/api/v1/messages/${messageId}/tts-jobs`, { method: 'POST', key: 'meter-tts-2' });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.tts_job.state, 'COMPLETED');

  const entitlements = await request(base, '/api/v1/entitlements');
  const tts = entitlements.body.entitlements.find((item) => item.capability === 'SYNTHESIZE_TTS');
  const expectedSeconds = Math.ceil(sent.body.assistant_message.text.length / 4);
  assert.equal(tts.committed_quantity, expectedSeconds);
  assert.equal(tts.available_quantity, tts.granted_quantity - tts.committed_quantity);
});

test('权益服务汇总跨能力余额并暴露重置时间', async () => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const service = new MediaEntitlementService({ store });
  const now = new Date('2026-09-04T00:00:00Z');
  store.subscriptions.set('sub_1', {
    subscription_id: 'sub_1', account_id: 'acct_dev_alice', sku: 'qiyu_public_monthly_v1', channel: 'development-simulated',
    state: 'ACTIVE', auto_renew: false, disclosure_version: 'v1',
    period_start: '2026-09-01T00:00:00Z', period_end: '2026-10-01T00:00:00Z', grace_period_end: null,
    refund_status: 'NONE', transaction_ref_hash: null, created_at: now.toISOString(), updated_at: now.toISOString()
  });
  service.grantSubscriptionCycle({
    subscription: store.subscriptions.get('sub_1'),
    product: { image_quota: 15, tts_minutes: 30, asr_minutes: 15 },
    sourceEventId: 'evt_balances'
  });
  const balances = service.entitlementBalances('acct_dev_alice', now);
  assert.equal(balances.length, 3);
  const image = balances.find((item) => item.capability === 'IMAGE_GENERATION');
  assert.equal(image.available_quantity, 15);
  assert.equal(image.resets_at, '2026-10-01T00:00:00Z');
  const empty = service.entitlementBalances('acct_dev_bob', now);
  assert.ok(empty.every((item) => item.available_quantity === 0 && item.resets_at === null));
});
