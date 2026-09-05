'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

test('图片链路依次执行参考图审核、混元任务、私有入桶、结果审核，并且不暴露 COS URL', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const events = [];
  const objects = new Map();
  let observedWorldState;
  const imageStore = {
    async putImage({ assetId, bytes, mimeType }) { events.push(`put:${assetId}`); const objectKey = `qiyu/images/${assetId}.${mimeType === 'image/png' ? 'png' : 'jpg'}`; objects.set(objectKey, Buffer.from(bytes)); return { objectKey, checksum: `sha-${assetId}`, byteLength: bytes.length, mimeType }; },
    async createModerationUrl(objectKey) { events.push(`sign:${objectKey}`); return `https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com/${objectKey}?q-signature=opaque`; },
    async readImage(objectKey) { return objects.get(objectKey); },
    async deleteAsset(objectKey) { events.push(`delete:${objectKey}`); objects.delete(objectKey); }
  };
  const imageModerator = async ({ fileUrl, dataId }) => { events.push(`moderate:${dataId}`); assert.match(fileUrl, /q-signature=opaque/); return { decision: 'PASS', providerRequestId: `ims-${dataId}`, policyVersion: 'ims-test-v1' }; };
  const imageGenerator = {
    async generateScene({ character, referenceAsset, scene, worldState, referenceImageUrl }) { events.push('generate'); assert.equal(character.name, '阿栖'); assert.equal(referenceAsset.confirmation_state, 'USER_CONFIRMED'); assert.match(referenceImageUrl, /q-signature=opaque/); assert.equal(scene.location, '窗边'); observedWorldState = { ...worldState }; return { asset: { state: 'PENDING', provider_job_id: 'hunyuan-job-1', provider: 'tencent-hunyuan', aigc_logo_requested: true }, providerRequestId: 'hunyuan-submit-1', sceneContract: { version: 'qiyu-image-scene-v1', world_state: { ...worldState } } }; },
    async query({ providerJobId }) { events.push('query'); assert.equal(providerJobId, 'hunyuan-job-1'); return { state: 'COMPLETED', providerRequestId: 'hunyuan-query-1', resultImageUrl: 'https://result-1250000000.cos.ap-guangzhou.myqcloud.com/provider.png?opaque=1' }; }
  };
  const base = await start(t, { store, imageStore, imageModerator, imageGenerator, imageResultFetcher: async (url) => { events.push('fetch'); assert.match(url, /result-125/); return { bytes: Buffer.from('generated-png'), mimeType: 'image/png' }; } });
  const character = await readyCharacter(base);
  const reference = await request(base, `/api/v1/characters/${character.character_id}/reference-images`, { method: 'POST', key: 'reference-image', body: { mime_type: 'image/png', image_base64: Buffer.from('reference-png').toString('base64'), user_confirms_image_rights: true } });
  assert.equal(reference.status, 201);
  assert.equal(reference.body.media_asset.state, 'REVIEW_REQUIRED');
  assert.equal(reference.body.media_asset.confirmation_state, 'USER_CONFIRMED');
  assert.equal(reference.body.content_rights_review.state, 'REVIEW_REQUIRED');
  assert.doesNotMatch(JSON.stringify(reference.body), /myqcloud\.com/);
  const restoredReferences = await request(base, `/api/v1/characters/${character.character_id}/reference-images`);
  assert.equal(restoredReferences.status, 200);
  assert.equal(restoredReferences.body.media_assets.length, 1);
  assert.equal(restoredReferences.body.media_assets[0].asset_id, reference.body.media_asset.asset_id);
  assert.equal(restoredReferences.body.media_assets[0].content_rights_review.state, 'REVIEW_REQUIRED');
  assert.doesNotMatch(JSON.stringify(restoredReferences.body), /myqcloud\.com/);
  const denied = await request(base, `/api/v1/characters/${character.character_id}/image-jobs`, { method: 'POST', key: 'image-job-before-rights-review', body: { reference_asset_id: reference.body.media_asset.asset_id, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] } } });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'REFERENCE_IMAGE_RIGHTS_REVIEW_REQUIRED');
  assert.equal(events.includes('generate'), false);
  approveReferenceRightsForTest(store, reference.body);
  const created = await request(base, `/api/v1/characters/${character.character_id}/image-jobs`, { method: 'POST', key: 'image-job', body: { reference_asset_id: reference.body.media_asset.asset_id, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] }, resolution: '768:1024' } });
  assert.equal(created.status, 202);
  assert.equal(created.body.image_job.state, 'PENDING');
  assert.ok(created.body.image_job.world_state_id);
  assert.equal(created.body.image_job.world_state_version, 1);
  assert.deepEqual(observedWorldState, { world_state_id: created.body.image_job.world_state_id, state_version: 1, mood_code: 'NEUTRAL', location_code: 'UNSPECIFIED', wardrobe_asset_id: null, active_event_refs: [], expires_at: null, reset_at: observedWorldState.reset_at, updated_at: observedWorldState.updated_at });
  const stateChanged = await request(base, `/api/v1/characters/${character.character_id}/world-state`, { method: 'PATCH', key: 'change-world-after-image-submit', body: { expected_version: 1, mood_code: 'HAPPY', location_code: 'CAFE' } });
  assert.equal(stateChanged.status, 200);
  const frozen = await request(base, `/api/v1/image-jobs/${created.body.image_job.job_id}`);
  assert.equal(frozen.body.image_job.world_state_version, 1);
  const refreshed = await request(base, `/api/v1/image-jobs/${created.body.image_job.job_id}/refresh`, { method: 'POST', key: 'image-refresh', body: {} });
  assert.equal(refreshed.status, 202);
  assert.equal(refreshed.body.image_job.state, 'COMPLETED');
  const metrics = await request(base, '/api/v1/development/operation-metrics');
  assert.ok(metrics.body.metrics.some((metric) => metric.capability === 'IMAGE_GENERATION' && metric.provider === 'tencent-hunyuan' && metric.outcome === 'COMPLETED'));
  assert.equal(metrics.body.metrics.filter((metric) => metric.capability === 'IMAGE_MODERATION' && metric.provider === 'image-moderation' && metric.outcome === 'COMPLETED').length, 2);
  const resultAssetId = refreshed.body.image_job.result_asset_id;
  const metadata = await request(base, `/api/v1/media-assets/${resultAssetId}`);
  assert.equal(metadata.body.media_asset.ai_generated, true);
  assert.equal(metadata.body.media_asset.aigc_mark_version, 'tencent-hunyuan-logoadd-v1');
  assert.doesNotMatch(JSON.stringify(metadata.body), /myqcloud\.com/);
  const content = await fetch(`${base}/api/v1/media-assets/${resultAssetId}/content`, { headers: { authorization: 'Bearer dev-alice-token' } });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), Buffer.from('generated-png'));
  const deleted = await request(base, `/api/v1/media-assets/${resultAssetId}`, { method: 'DELETE', key: 'delete-generated' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deletion_job.physical_cleanup_state, 'COS_PRIVATE_OBJECT_DELETED');
  assert.equal(objects.has(`qiyu/images/${resultAssetId}.png`), false);
  const referenceAssetId = reference.body.media_asset.asset_id;
  assert.deepEqual(events, [`put:${referenceAssetId}`, `sign:qiyu/images/${referenceAssetId}.png`, `moderate:reference-${referenceAssetId}`, `sign:qiyu/images/${referenceAssetId}.png`, 'generate', 'query', 'fetch', `put:${resultAssetId}`, `sign:qiyu/images/${resultAssetId}.png`, `moderate:generated-${resultAssetId}`, `delete:qiyu/images/${resultAssetId}.png`]);
});

test('图片链路未显式启用时拒绝上传；审核不通过的参考图会立即删除私有对象', async (t) => {
  const disabled = await start(t);
  const character = await readyCharacter(disabled, 'disabled');
  const unavailable = await request(disabled, `/api/v1/characters/${character.character_id}/reference-images`, { method: 'POST', key: 'disabled-reference', body: { mime_type: 'image/png', image_base64: Buffer.from('x').toString('base64'), user_confirms_image_rights: true } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'IMAGE_GENERATION_NOT_ENABLED');

  const deleted = [];
  const enabled = await start(t, {
    imageModerator: async () => ({ decision: 'BLOCK', providerRequestId: 'ims-block', policyVersion: 'ims-test-v1' }),
    imageStore: { async putImage({ assetId, bytes, mimeType }) { return { objectKey: `qiyu/images/${assetId}.png`, checksum: 'sha', byteLength: bytes.length, mimeType }; }, async createModerationUrl() { return 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com/qiyu/images/a.png?q-signature=opaque'; }, async deleteAsset(key) { deleted.push(key); } }
  });
  const enabledCharacter = await readyCharacter(enabled, 'blocked');
  const blocked = await request(enabled, `/api/v1/characters/${enabledCharacter.character_id}/reference-images`, { method: 'POST', key: 'blocked-reference', body: { mime_type: 'image/png', image_base64: Buffer.from('x').toString('base64'), user_confirms_image_rights: true } });
  assert.equal(blocked.status, 201);
  assert.equal(blocked.body.media_asset.state, 'BLOCKED');
  const metrics = await request(enabled, '/api/v1/development/operation-metrics');
  assert.ok(metrics.body.metrics.some((metric) => metric.capability === 'IMAGE_MODERATION' && metric.outcome === 'BLOCKED'));
  assert.deepEqual(deleted, [`qiyu/images/${blocked.body.media_asset.asset_id}.png`]);
});

test('图片提交仅在内部保留安全的供应商错误码，不向用户 API 暴露该诊断字段', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const imageStore = { async putImage({ assetId, bytes, mimeType }) { return { objectKey: `qiyu/images/${assetId}.png`, checksum: 'sha', byteLength: bytes.length, mimeType }; }, async createModerationUrl() { return 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com/qiyu/images/reference.png?q-signature=opaque'; }, async deleteAsset() {} };
  const base = await start(t, { store, imageStore, imageModerator: async () => ({ decision: 'PASS', providerRequestId: 'ims-pass', policyVersion: 'ims-test-v1' }), imageGenerator: { async generateScene() { const error = new Error('upstream body must not escape'); error.code = 'TENCENT_UPSTREAM_REJECTED'; error.details = { upstream_error_code: 'FailedOperation.ServiceNotOpened' }; throw error; } } });
  const character = await readyCharacter(base, 'provider-diagnostic');
  const reference = await request(base, `/api/v1/characters/${character.character_id}/reference-images`, { method: 'POST', key: 'provider-diagnostic-reference', body: { mime_type: 'image/png', image_base64: Buffer.from('x').toString('base64'), user_confirms_image_rights: true } });
  approveReferenceRightsForTest(store, reference.body);
  const created = await request(base, `/api/v1/characters/${character.character_id}/image-jobs`, { method: 'POST', key: 'provider-diagnostic-job', body: { reference_asset_id: reference.body.media_asset.asset_id, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] } } });
  assert.equal(created.body.image_job.failure_code, 'TENCENT_UPSTREAM_REJECTED');
  assert.equal(JSON.stringify(created.body), JSON.stringify(created.body).replace('FailedOperation.ServiceNotOpened', ''));
  assert.equal(store.mediaJobs.get(created.body.image_job.job_id).provider_error_code, 'FailedOperation.ServiceNotOpened');
});

test('启用权益服务时，图片只在成功交付后扣额，提交失败会返还预留', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const calls = [];
  const store = new DevelopmentStore();
  const imageStore = { async putImage({ assetId, bytes, mimeType }) { return { objectKey: `qiyu/images/${assetId}.png`, checksum: 'sha', byteLength: bytes.length, mimeType }; }, async createModerationUrl() { return 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com/qiyu/images/reference.png?q-signature=opaque'; }, async deleteAsset() {} };
  const imageEntitlementService = { reserveImage({ jobId }) { calls.push(`reserve:${jobId}`); return { entitlement_id: 'sub_1:2026-10-04T00:00:00.000Z' }; }, commitImage({ jobId }) { calls.push(`commit:${jobId}`); }, releaseImage({ jobId }) { calls.push(`release:${jobId}`); } };
  const imageGenerator = { async generateScene() { calls.push('generate'); return { asset: { provider_job_id: 'hunyuan-job-1' }, providerRequestId: 'submit-1', sceneContract: { version: 'qiyu-image-scene-v1' } }; }, async query() { return { state: 'COMPLETED', providerRequestId: 'query-1', resultImageUrl: 'https://result-1250000000.cos.ap-guangzhou.myqcloud.com/result.png?opaque=1' }; } };
  const base = await start(t, { store, imageStore, imageEntitlementService, imageGenerator, imageModerator: async () => ({ decision: 'PASS', providerRequestId: 'ims-pass', policyVersion: 'ims-test-v1' }), imageResultFetcher: async () => ({ bytes: Buffer.from('x'), mimeType: 'image/png' }) });
  const character = await readyCharacter(base, 'quota');
  const reference = await request(base, `/api/v1/characters/${character.character_id}/reference-images`, { method: 'POST', key: 'quota-reference', body: { mime_type: 'image/png', image_base64: Buffer.from('x').toString('base64'), user_confirms_image_rights: true } });
  approveReferenceRightsForTest(store, reference.body);
  const created = await request(base, `/api/v1/characters/${character.character_id}/image-jobs`, { method: 'POST', key: 'quota-job', body: { reference_asset_id: reference.body.media_asset.asset_id, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] } } });
  assert.equal(created.body.image_job.state, 'PENDING');
  await request(base, `/api/v1/image-jobs/${created.body.image_job.job_id}/refresh`, { method: 'POST', key: 'quota-refresh', body: {} });
  assert.deepEqual(calls, [`reserve:${created.body.image_job.job_id}`, 'generate', `commit:${created.body.image_job.job_id}`]);

  const failingStore = new DevelopmentStore();
  const failing = await start(t, { store: failingStore, imageStore, imageEntitlementService, imageModerator: async () => ({ decision: 'PASS', providerRequestId: 'ims-pass', policyVersion: 'ims-test-v1' }), imageGenerator: { async generateScene() { const error = new Error('submit failed'); error.code = 'TENCENT_UPSTREAM_REJECTED'; throw error; } } });
  const failingCharacter = await readyCharacter(failing, 'quota-fail');
  const failingReference = await request(failing, `/api/v1/characters/${failingCharacter.character_id}/reference-images`, { method: 'POST', key: 'quota-fail-reference', body: { mime_type: 'image/png', image_base64: Buffer.from('x').toString('base64'), user_confirms_image_rights: true } });
  approveReferenceRightsForTest(failingStore, failingReference.body);
  const failed = await request(failing, `/api/v1/characters/${failingCharacter.character_id}/image-jobs`, { method: 'POST', key: 'quota-fail-job', body: { reference_asset_id: failingReference.body.media_asset.asset_id, scene: { location: '窗边', outfit: '针织衫', time_of_day: 'NIGHT', confirmed_event_asset_ids: [] } } });
  assert.equal(failed.body.image_job.failure_code, 'TENCENT_UPSTREAM_REJECTED');
  assert.ok(calls.includes(`release:${failed.body.image_job.job_id}`));
});

async function start(t, options) {
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
async function readyCharacter(base, prefix = 'image') {
  const notices = await request(base, '/api/v1/required-notices');
  await request(base, `/api/v1/required-notices/${notices.body.notices[0].notice_id}/displayed`, { method: 'POST', key: `${prefix}-notice`, body: { notice_version: notices.body.notices[0].notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-age`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const response = await request(base, '/api/v1/characters', { method: 'POST', key: `${prefix}-character`, body: { name: '阿栖' } });
  assert.equal(response.status, 201);
  return response.body.character;
}

function approveReferenceRightsForTest(store, payload) {
  // This simulates the separate authorized reviewer service. It is not an
  // application endpoint and cannot be performed by the user-facing role.
  const review = store.contentRightsReviews.get(payload.content_rights_review.review_id);
  review.state = 'APPROVED';
  review.reviewer_id = 'reviewer-test-only';
  review.updated_at = new Date().toISOString();
  store.mediaAssets.get(payload.media_asset.asset_id).state = 'AVAILABLE';
}
