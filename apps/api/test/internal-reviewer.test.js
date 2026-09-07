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

async function passAge(base, prefix, token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

test('内部接口拒绝用户与匿名身份，审核员可访问队列', async (t) => {
  const base = await start(t);
  await passAge(base, 'ir-auth');

  const anonymous = await fetch(`${base}/internal/content-rights-reviews`);
  assert.equal(anonymous.status, 401);
  const userToken = await fetch(`${base}/internal/content-rights-reviews`, { headers: { authorization: 'Bearer dev-alice-token' } });
  assert.equal(userToken.status, 401);
  assert.equal((await userToken.json()).error.code, 'REVIEWER_AUTH_REQUIRED');

  const reviewer = await fetch(`${base}/internal/content-rights-reviews`, { headers: REVIEWER });
  assert.equal(reviewer.status, 200);
  assert.equal((await reviewer.json()).reviews.length, 0);

  const unknown = await fetch(`${base}/internal/nothing`, { headers: REVIEWER });
  assert.equal(unknown.status, 404);
});

test('OC 导入审核闭环：队列可见→APPROVED→用户可按导入创建角色', async (t) => {
  const base = await start(t);
  await passAge(base, 'ir-oc');

  const imported = await request(base, '/api/v1/characters/imports', {
    method: 'POST', key: 'ir-oc-imp',
    body: { original_or_authorized: true, source_text: '世界观：海岛灯塔守护者\n年龄：30\n性格：沉稳可靠\n关系：可以依靠的兄长' }
  });
  assert.equal(imported.status, 202);
  const reviewId = imported.body.content_rights_review.review_id;

  // 未审核时创建角色被拒。
  const blocked = await request(base, '/api/v1/characters', { method: 'POST', key: 'ir-oc-block', body: { name: '灯塔', import_id: imported.body.oc_import.import_id } });
  assert.equal(blocked.status, 422);

  // 队列中可见，含人格候选与原文摘要。
  const queue = await fetch(`${base}/internal/content-rights-reviews`, { headers: REVIEWER }).then((response) => response.json());
  const queued = queue.reviews.find((review) => review.review_id === reviewId);
  assert.ok(queued, '审核队列应包含该导入');
  assert.equal(queued.subject_type, 'OC_TEXT');
  assert.match(queued.subject_preview, /海岛灯塔/);
  assert.equal(queued.proposed_persona.worldview, '海岛灯塔守护者');

  // 决策校验：缺 reason / 非法 decision。
  const noReason = await request(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'ir-dec-bad', token: 'reviewer-dev-token', body: { decision: 'APPROVED' } });
  assert.equal(noReason.status, 400);
  const badDecision = await request(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'ir-dec-bad2', token: 'reviewer-dev-token', body: { decision: 'MAYBE', reason: '不确定' } });
  assert.equal(badDecision.status, 400);

  // 审核通过后用户可按导入创建角色，人格来自隔离提取结果。
  const approved = await request(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'ir-dec-ok', token: 'reviewer-dev-token', body: { decision: 'APPROVED', reason: '合成设定，无真人/IP 风险' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.content_rights_review.state, 'APPROVED');
  assert.equal(approved.body.decision.reviewer_id, 'rev_dev_0001');

  const created = await request(base, '/api/v1/characters', { method: 'POST', key: 'ir-oc-create', body: { name: '灯塔', import_id: imported.body.oc_import.import_id } });
  assert.equal(created.status, 201);
  assert.equal(created.body.character.persona.worldview, '海岛灯塔守护者');
  assert.equal(created.body.character.persona.personality, '沉稳可靠');

  // 重复决策被拒；已决策项退出待审队列。
  const twice = await request(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'ir-dec-twice', token: 'reviewer-dev-token', body: { decision: 'REJECTED', reason: '再想想' } });
  assert.equal(twice.status, 409);
  const pendingQueue = await fetch(`${base}/internal/content-rights-reviews`, { headers: REVIEWER }).then((response) => response.json());
  assert.equal(pendingQueue.reviews.length, 0);
});

test('OC 拒绝为终态：申诉留档、队列可见，但不解除创建阻断', async (t) => {
  const base = await start(t);
  await passAge(base, 'ir-rej');

  const imported = await request(base, '/api/v1/characters/imports', {
    method: 'POST', key: 'ir-rej-imp',
    body: { original_or_authorized: true, source_text: '世界观：以明星刘德华为原型的角色\n性格：外向' }
  });
  const reviewId = imported.body.content_rights_review.review_id;
  assert.ok(imported.body.content_rights_review.risk_codes.includes('PUBLIC_FIGURE_CANDIDATE'));

  const rejected = await request(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'ir-rej-dec', token: 'reviewer-dev-token', body: { decision: 'REJECTED', reason: '涉及真实公众人物，未获授权' } });
  assert.equal(rejected.status, 200);

  const appeal = await request(base, `/api/v1/content-rights-reviews/${reviewId}/appeals`, { method: 'POST', key: 'ir-rej-appeal', body: { statement: '我持有授权材料' } });
  assert.equal(appeal.status, 202);

  const blocked = await request(base, '/api/v1/characters', { method: 'POST', key: 'ir-rej-create', body: { name: '不应创建', import_id: imported.body.oc_import.import_id } });
  assert.equal(blocked.status, 422);

  const queue = await fetch(`${base}/internal/content-rights-reviews?state=REJECTED`, { headers: REVIEWER }).then((response) => response.json());
  const entry = queue.reviews.find((review) => review.review_id === reviewId);
  assert.ok(entry, '已拒绝项带申诉出现在 REJECTED 队列');
  assert.equal(entry.appeals.length, 1);
  assert.equal(entry.appeals[0].state, 'SUBMITTED');
});

test('参考图审核闭环：APPROVED 后资产可用并放行生图任务的权利校验', async (t) => {
  const imageStore = {
    async putImage({ assetId, bytes, mimeType }) { return { objectKey: `qiyu/images/${assetId}`, checksum: 'c'.repeat(64), byteLength: bytes.length }; },
    async createModerationUrl(objectKey) { return `https://cos.example/${objectKey}`; },
    async deleteAsset() {},
    async readImage() { throw new Error('not needed'); }
  };
  const base = await start(t, {
    imageModerator: async () => ({ decision: 'PASS', providerRequestId: 'ims_req', policyVersion: 'ims_v1' }),
    imageStore,
    imageGenerator: {
      generateScene: async ({ scene }) => { if (!scene?.location) throw new Error('scene required'); return { providerRequestId: 'hy_req', asset: { provider_job_id: 'hy_job_1' }, sceneContract: { location: scene.location } }; },
      query: async () => ({ state: 'RUNNING', providerRequestId: 'hy_q' })
    },
    imageResultFetcher: async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' })
  });
  await passAge(base, 'ir-ref');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'ir-ref-c', body: { name: '参考图角色' } });

  // 上传参考图：IMS PASS 后进入 REVIEW_REQUIRED 隔离。
  const uploaded = await request(base, `/api/v1/characters/${character.body.character.character_id}/reference-images`, {
    method: 'POST', key: 'ir-ref-up',
    body: { mime_type: 'image/png', image_base64: Buffer.from('png-bytes').toString('base64'), user_confirms_image_rights: true }
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.media_asset.state, 'REVIEW_REQUIRED');
  const reviewId = uploaded.body.media_asset.rights_review_id ?? [...(await (await fetch(`${base}/internal/content-rights-reviews`, { headers: REVIEWER })).json()).reviews][0].review_id;

  // 审核通过 → 资产 AVAILABLE。
  const approved = await request(base, `/internal/content-rights-reviews/${reviewId}/decisions`, { method: 'POST', key: 'ir-ref-dec', token: 'reviewer-dev-token', body: { decision: 'APPROVED', reason: '原创立绘' } });
  assert.equal(approved.status, 200);
  const asset = await request(base, `/api/v1/characters/${character.body.character.character_id}/reference-images`);
  const restored = (asset.body.media_assets ?? []).find((item) => item.asset_id === uploaded.body.media_asset.asset_id);
  assert.ok(restored, '参考图列表应恢复');
  assert.equal(restored.state, 'AVAILABLE');

  // 生图任务通过权利校验（到达提交阶段而非 409 权利拦截）。
  const job = await request(base, `/api/v1/characters/${character.body.character.character_id}/image-jobs`, {
    method: 'POST', key: 'ir-ref-job',
    body: { reference_asset_id: uploaded.body.media_asset.asset_id, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] }, resolution: '768:1024' }
  });
  assert.equal(job.status, 202);
  assert.notEqual(job.body.image_job.failure_code, 'REFERENCE_IMAGE_RIGHTS_REVIEW_REQUIRED');
});

test('内部只读接口：删除队列、供应商健康与功能开关', async (t) => {
  const base = await start(t, {
    replyGenerator: async (text) => ({
      provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: `回复：${text}`, usage: { input_tokens: 10, output_tokens: 5 }, ai_generated: true, disclaimer: 'AI 生成。',
      memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: `你提到：“${text}”` }
    })
  });
  await passAge(base, 'ir-ops');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'ir-ops-c', body: { name: '运维角色' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'ir-ops-v', body: { character_id: character.body.character.character_id } });
  await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'ir-ops-m', body: { content: { text: '你好' } } });
  await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}`, { method: 'DELETE', key: 'ir-ops-del' });

  const deletionQueue = await fetch(`${base}/internal/deletion-jobs`, { headers: REVIEWER }).then((response) => response.json());
  assert.ok(deletionQueue.deletion_jobs.some((job) => job.scope === 'CONVERSATION'));

  const health = await fetch(`${base}/internal/provider-health`, { headers: REVIEWER }).then((response) => response.json());
  const qwen = health.providers.find((entry) => entry.provider === 'qwen');
  assert.ok(qwen, '供应商健康应聚合 qwen 调用');
  assert.equal(qwen.calls, 1);
  assert.equal(qwen.outcomes.COMPLETED, 1);
  assert.ok(!JSON.stringify(health).includes('你好'), '健康聚合不得包含消息正文');

  const flags = await fetch(`${base}/internal/feature-flags`, { headers: REVIEWER }).then((response) => response.json());
  assert.equal(flags.feature_flags.LLM_CHAT, false);
  assert.equal(flags.source, 'local-synthetic-default');
});

test('内部指标端点：Prometheus 文本导出调用量与队列深度；注入的运行时 flags 如实上报', async (t) => {
  const base = await start(t, {
    featureFlags: Object.freeze({ LLM_CHAT: true, CONVERSATION_SUMMARY_WRITE: true, ENHANCED_AGE_VERIFICATION: false, PAYMENTS: false, ASR: false, TTS: false, IMAGE_GENERATION: false, TEXT_MODERATION: false, IMAGE_MODERATION: false }),
    replyGenerator: async (text) => ({
      provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: `回复：${text}`, usage: {}, ai_generated: true, disclaimer: 'AI 生成。',
      memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: `你提到：“${text}”` }
    })
  });
  await passAge(base, 'ir-metrics');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'ir-metrics-c', body: { name: '指标角色' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'ir-metrics-v', body: { character_id: character.body.character.character_id } });
  await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'ir-metrics-m', body: { content: { text: '记录一次调用' } } });

  const metricsResponse = await fetch(`${base}/internal/metrics`, { headers: REVIEWER });
  assert.equal(metricsResponse.status, 200);
  assert.match(metricsResponse.headers.get('content-type') || '', /text\/plain/);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /# TYPE qiyu_provider_calls_total counter/);
  assert.match(metrics, /qiyu_provider_calls_total\{capability="CHAT_GENERATION",provider="qwen",outcome="COMPLETED"\} 1/);
  assert.match(metrics, /qiyu_dead_letters_open\{queue="conversation_summary"\} 0/);
  assert.match(metrics, /qiyu_deletion_jobs_pending 0/);
  assert.ok(!metrics.includes('记录一次调用'), '指标不得包含消息正文');

  // 未带审核员身份的访问必须被拒（指标端点与其它 /internal 同一边界）。
  const anonymous = await fetch(`${base}/internal/metrics`);
  assert.equal(anonymous.status, 401);

  const flags = await fetch(`${base}/internal/feature-flags`, { headers: REVIEWER }).then((response) => response.json());
  assert.equal(flags.source, 'runtime');
  assert.equal(flags.feature_flags.LLM_CHAT, true);
});
