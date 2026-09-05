'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const REVIEWER = { authorization: 'Bearer reviewer-dev-token' };

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

async function internal(base, path, { method = 'GET', key, body } = {}) {
  return request(base, path, { method, token: 'reviewer-dev-token', key, body, headers: REVIEWER });
}

async function passAge(base, prefix, token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

test('年龄人工复核：队列可见→复核放行→用户恢复互动；驳回则阻断但数据权利保留', async (t) => {
  const base = await start(t);
  await passAge(base, 'ar');

  // 制造 AGE_REVIEW：变更出生日期触发冲突复核。
  const redeclared = await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'ar-re', body: { date_of_birth: '1991-02-02', confirmed_18_plus: true } });
  assert.equal(redeclared.body.status, 'AGE_REVIEW');

  const queue = await internal(base, '/internal/age-reviews');
  assert.equal(queue.status, 200);
  const entry = queue.body.age_reviews.find((review) => review.reason_codes.includes('DATE_OF_BIRTH_CHANGED'));
  assert.ok(entry, '复核队列应包含 DOB 冲突账户');

  // 用户 token 不可访问内部接口。
  const forbidden = await request(base, '/internal/age-reviews');
  assert.equal(forbidden.status, 401);

  // 缺 reason / 非法 decision 拒绝。
  const noReason = await internal(base, `/internal/age-reviews/${encodeURIComponent(entry.account_id)}/decisions`, { method: 'POST', key: 'ar-bad', body: { decision: 'PASS' } });
  assert.equal(noReason.status, 400);
  const badDecision = await internal(base, `/internal/age-reviews/${encodeURIComponent(entry.account_id)}/decisions`, { method: 'POST', key: 'ar-bad2', body: { decision: 'MAYBE', reason: '不确定' } });
  assert.equal(badDecision.status, 400);

  // 复核放行：用户恢复普通互动。
  const passed = await internal(base, `/internal/age-reviews/${encodeURIComponent(entry.account_id)}/decisions`, { method: 'POST', key: 'ar-pass', body: { decision: 'PASS', reason: '申诉材料显示成年（封测人工复核）' } });
  assert.equal(passed.status, 200);
  assert.equal(passed.body.age_status, 'AGE_PASS');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'ar-c', body: { name: '复核后角色' } });
  assert.equal(character.status, 201);

  // 驳回路径（bob 制造 REVIEW 后驳回）：互动阻断、数据权利保留。
  await passAge(base, 'ar2', 'dev-bob-token');
  await request(base, '/api/v1/age/declarations', { method: 'POST', token: 'dev-bob-token', key: 'ar2-re', body: { date_of_birth: '1992-03-03', confirmed_18_plus: true } });
  const bobQueue = await internal(base, '/internal/age-reviews');
  const bobEntry = bobQueue.body.age_reviews.find((review) => review.account_id.includes('bob') || bobQueue.body.age_reviews.at(-1));
  const denied = await internal(base, `/internal/age-reviews/${encodeURIComponent(bobEntry.account_id)}/decisions`, { method: 'POST', key: 'ar-deny', body: { decision: 'DENIED_MINOR', reason: '申诉材料确认未成年' } });
  assert.equal(denied.body.age_status, 'AGE_DENIED_MINOR');
  const bobCharacter = await request(base, '/api/v1/characters', { method: 'POST', token: 'dev-bob-token', key: 'ar2-c', body: { name: '不应创建' } });
  assert.equal(bobCharacter.status, 403);
  const bobExport = await request(base, '/api/v1/data-exports/relationship-profile', { token: 'dev-bob-token' });
  assert.equal(bobExport.status, 200);

  // 放行与驳回都会结束复核态：两个账户均退出待复核队列。
  const finalQueue = await internal(base, '/internal/age-reviews');
  assert.ok(!finalQueue.body.age_reviews.some((review) => review.account_id === entry.account_id));
  assert.ok(!finalQueue.body.age_reviews.some((review) => review.account_id === bobEntry.account_id));
});

test('线下收款人工发放：按订阅周期入账→用户可用→撤销后新预留失败', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const { MediaEntitlementService } = require('../src/domain/media-entitlement-service');
  const store = new DevelopmentStore();
  const base = await start(t, {
    store,
    imageEntitlementService: new MediaEntitlementService({ store }),
    imageGenerator: {
      generateScene: async ({ scene }) => ({ providerRequestId: 'hy_req', asset: { provider_job_id: 'hy_job' }, sceneContract: { location: scene.location } }),
      query: (callCount => async () => { callCount += 1; return callCount >= 2
        ? { state: 'COMPLETED', providerRequestId: 'hy_q', resultImageUrl: 'https://hyimg-1250000000.cos.ap-guangzhou.myqcloud.com/result.png?temporary=1' }
        : { state: 'RUNNING', providerRequestId: 'hy_q' }; })(0)
    },
    imageResultFetcher: async () => ({ bytes: Buffer.from('png-bytes'), mimeType: 'image/png' }),
    imageModerator: async () => ({ decision: 'PASS', providerRequestId: 'ims_req', policyVersion: 'ims_v1' }),
    imageStore: {
      putImage: async ({ assetId, bytes }) => ({ objectKey: `qiyu/images/${assetId}`, checksum: 'c'.repeat(64), byteLength: bytes.length }),
      createModerationUrl: async (objectKey) => `https://cos.example/${objectKey}`,
      deleteAsset: async () => {}
    }
  });
  await passAge(base, 'mg');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'mg-c', body: { name: '发放角色' } });
  const characterId = character.body.character.character_id;

  // 先上传参考图并审核放行，使任务校验能走到权益环节。
  const uploaded = await request(base, `/api/v1/characters/${characterId}/reference-images`, {
    method: 'POST', key: 'mg-ref',
    body: { mime_type: 'image/png', image_base64: Buffer.from('png').toString('base64'), user_confirms_image_rights: true }
  });
  assert.equal(uploaded.status, 201);
  const reviewId = (await internal(base, '/internal/content-rights-reviews?state=REVIEW_REQUIRED')).body.reviews[0].review_id;
  await internal(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'mg-dec', body: { decision: 'APPROVED', reason: '原创' } });
  const sceneBody = { reference_asset_id: uploaded.body.media_asset.asset_id, scene: { location: '窗边', outfit: '白裙', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] }, resolution: '768:1024' };

  // 无额度时图片任务被拒。
  const before = await request(base, `/api/v1/characters/${characterId}/image-jobs`, { method: 'POST', key: 'mg-job-0', body: sceneBody });
  assert.equal(before.status, 202);
  assert.equal(before.body.image_job.failure_code, 'ENTITLEMENT_QUOTA_EXCEEDED');

  // 人工发放（缺 reason / 未知账户 / 未知 sku 拒绝）。
  const noReason = await internal(base, '/internal/subscriptions/manual-grant', { method: 'POST', key: 'mg-bad', body: { account_id: 'acct_dev_alice', sku: 'qiyu_public_monthly_v1' } });
  assert.equal(noReason.status, 400);
  const unknownAccount = await internal(base, '/internal/subscriptions/manual-grant', { method: 'POST', key: 'mg-bad2', body: { account_id: 'acct_missing', sku: 'qiyu_public_monthly_v1', reason: 'x' } });
  assert.equal(unknownAccount.status, 404);
  const unknownSku = await internal(base, '/internal/subscriptions/manual-grant', { method: 'POST', key: 'mg-bad3', body: { account_id: 'acct_dev_alice', sku: 'nope', reason: 'x' } });
  assert.equal(unknownSku.status, 400);

  const granted = await internal(base, '/internal/subscriptions/manual-grant', {
    method: 'POST', key: 'mg-ok',
    body: { account_id: 'acct_dev_alice', sku: 'qiyu_public_monthly_v1', reason: '封测用户线下转账 39 元（微信，已截图留痕）' }
  });
  assert.equal(granted.status, 201);
  assert.equal(granted.body.subscription.state, 'ACTIVE');
  assert.equal(granted.body.subscription.channel, 'MANUAL_OFFLINE_PAYMENT');
  assert.equal(granted.body.order.state, 'PAID_OFFLINE');

  const entitlements = await request(base, '/api/v1/entitlements');
  const image = entitlements.body.entitlements.find((item) => item.capability === 'IMAGE_GENERATION');
  assert.equal(image.available_quantity, 15);

  // 发放后同一任务通过权益校验（不再 QUOTA_EXCEEDED）。
  const job = await request(base, `/api/v1/characters/${characterId}/image-jobs`, { method: 'POST', key: 'mg-job-1', body: sceneBody });
  assert.equal(job.status, 202);
  assert.notEqual(job.body.image_job.failure_code, 'ENTITLEMENT_QUOTA_EXCEEDED');

  // 轮询一次至 COMPLETED：成功交付后额度从预留转为已用。
  for (let poll = 0; poll < 3; poll += 1) {
    const refreshed = await request(base, `/api/v1/image-jobs/${job.body.image_job.job_id}/refresh`, { method: 'POST', key: `mg-poll-${poll}` });
    if (refreshed.body.image_job.state === 'COMPLETED') break;
  }

  // 撤销前：成功交付已入账（committed=1）。
  const beforeRevokeEntitlements = await request(base, '/api/v1/entitlements');
  assert.equal(beforeRevokeEntitlements.body.entitlements.find((item) => item.capability === 'IMAGE_GENERATION').committed_quantity, 1);

  // 撤销：模拟全额退款。周期退出有效聚合（append-only 账本仍可审计），新预留失败。
  const revoked = await internal(base, `/internal/subscriptions/${granted.body.subscription.subscription_id}/revoke`, {
    method: 'POST', key: 'mg-revoke', body: { reason: '用户申请退款，已原路退回 39 元' }
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.subscription.state, 'REVOKED');
  assert.equal(revoked.body.subscription.refund_status, 'FULL');

  const afterRevoke = await request(base, `/api/v1/characters/${characterId}/image-jobs`, { method: 'POST', key: 'mg-job-2', body: sceneBody });
  assert.equal(afterRevoke.body.image_job.failure_code, 'ENTITLEMENT_QUOTA_EXCEEDED');

  // 撤销后周期不再出现在用户权益视图（全额退款语义）；审计走内部账本而非该视图。
  const finalEntitlements = await request(base, '/api/v1/entitlements');
  const finalImage = finalEntitlements.body.entitlements.find((item) => item.capability === 'IMAGE_GENERATION');
  assert.equal(finalImage.granted_quantity, 0);
  assert.equal(finalImage.available_quantity, 0);
});

test('摘要死信仅向审核员暴露无正文元数据，带理由且最多可重放一次', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const { COMPLETED_TURN_MESSAGE_THRESHOLD, MAX_SUMMARY_JOB_ATTEMPTS, enqueueConversationSummary, runNextConversationSummaryJob } = require('../src/domain/conversation-summary-worker');
  const store = new DevelopmentStore();
  const account = store.account('acct_dev_alice');
  const conversation = { conversation_id: 'cnv_internal_dlq', account_id: account.account_id, character_id: 'chr_internal_dlq', status: 'OPEN' };
  store.conversations.set(conversation.conversation_id, conversation);
  for (let index = 0; index < COMPLETED_TURN_MESSAGE_THRESHOLD; index += 1) {
    const messageId = 'msg_internal_' + String(index).padStart(2, '0');
    store.messages.set(messageId, { message_id: messageId, conversation_id: conversation.conversation_id, actor: index % 2 ? 'ASSISTANT' : 'USER', text: '不应进入 DLQ 响应正文的合成消息', created_at: '2026-09-01T02:' + String(index).padStart(2, '0') + ':00.000Z' });
  }
  const job = enqueueConversationSummary({ store, account, conversation, now: new Date('2026-09-02T00:00:00Z') });
  let now = new Date('2026-09-02T00:00:00Z');
  for (let attempt = 1; attempt <= MAX_SUMMARY_JOB_ATTEMPTS; attempt += 1) {
    await runNextConversationSummaryJob({ store, summaryGenerator: async () => { throw new Error('provider diagnostic must not be exposed'); }, now });
    now = new Date(store.conversationSummaryJobs.get(job.job_id).next_attempt_at);
  }
  const base = await start(t, { store });
  const denied = await request(base, '/internal/conversation-summary-dead-letters');
  assert.equal(denied.status, 401);

  const listed = await internal(base, '/internal/conversation-summary-dead-letters');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.dead_letters.length, 1);
  assert.equal(listed.body.dead_letters[0].job_id, job.job_id);
  assert.ok(!Object.prototype.hasOwnProperty.call(listed.body.dead_letters[0], 'last_error'));
  assert.ok(!JSON.stringify(listed.body).includes('provider diagnostic must not be exposed'));

  const endpoint = '/internal/conversation-summary-dead-letters/' + encodeURIComponent(job.job_id) + '/replay';
  const noReason = await internal(base, endpoint, { method: 'POST', key: 'dlq-no-reason', body: {} });
  assert.equal(noReason.status, 400);
  const replayed = await internal(base, endpoint, { method: 'POST', key: 'dlq-replay', body: { reason: '已检查供应商健康状态，允许一次受控重放' } });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.summary_job.state, 'PENDING');
  assert.equal(replayed.body.summary_job.attempt_count, MAX_SUMMARY_JOB_ATTEMPTS);
  assert.equal(replayed.body.dead_letter.replay_count, 1);
  assert.ok(!JSON.stringify(replayed.body).includes('已检查供应商健康状态'));

  const sameReplay = await internal(base, endpoint, { method: 'POST', key: 'dlq-replay', body: { reason: '不同载荷不能覆盖同一幂等结果' } });
  assert.equal(sameReplay.status, 409);
  assert.equal(sameReplay.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const secondReplay = await internal(base, endpoint, { method: 'POST', key: 'dlq-replay-next', body: { reason: '不应第二次重放' } });
  assert.equal(secondReplay.status, 409);
  assert.equal(secondReplay.body.error.code, 'SUMMARY_DLQ_REPLAY_LIMIT_REACHED');
});
