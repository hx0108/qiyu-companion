'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { advanceImageJob } = require('../src/domain/image-job-advance');

// P0 后台任务化：图片任务推进状态机必须可以脱离 HTTP 路由独立运行——
// 这是独立 Worker 进程（scripts/run-workers.js）承担该职责的前提。
// 若本测试失败，说明状态机又依赖了请求作用域（鉴权、path 解析等），
// Worker 将无法消费图片队列，前端将重新退回"手动刷新"兜底。

function pendingJob(store, accountId, characterId) {
  const job = {
    job_id: store.next('img'), account_id: accountId, character_id: characterId, reference_asset_id: 'med_ref_1',
    type: 'IMAGE_GENERATION', state: 'PENDING', attempts: 1, provider: 'tencent-hunyuan',
    provider_request_id: 'hunyuan-submit-1', provider_job_id: 'hunyuan-job-1', entitlement_id: 'ent_1',
    moderation_policy_version: null, result_asset_id: null, failure_code: null, provider_error_code: null,
    world_state_id: null, world_state_version: 1, scene_contract: null, created_at: new Date().toISOString()
  };
  store.mediaJobs.set(job.job_id, job);
  return job;
}

function imageDeps(overrides = {}) {
  return {
    imageGenerator: overrides.imageGenerator || { async query() { return { state: 'COMPLETED', providerRequestId: 'hunyuan-query-1', resultImageUrl: 'https://result.example.com/r.png' }; } },
    imageModerator: overrides.imageModerator || (async () => ({ decision: 'PASS', providerRequestId: 'ims-pass', policyVersion: 'ims-test-v1' })),
    imageStore: overrides.imageStore || {
      async putImage({ assetId, bytes }) { return { objectKey: `qiyu/images/${assetId}.png`, checksum: 'sha', byteLength: bytes.length }; },
      async createModerationUrl() { return 'https://signed.example.com/moderation'; },
      async deleteAsset() {}
    },
    imageResultFetcher: overrides.imageResultFetcher || (async () => ({ bytes: Buffer.from('png'), mimeType: 'image/png' })),
    imageEntitlementService: overrides.imageEntitlementService
  };
}

test('Worker 可独立把 PENDING 图片任务推进到 COMPLETED：落私有桶、过审核、扣权益', async () => {
  const store = new DevelopmentStore();
  const account = store.account('acct_dev_alice');
  const job = pendingJob(store, account.account_id, 'chr_1');
  const entitlementCalls = [];
  const deps = imageDeps({
    imageEntitlementService: { commitImage({ jobId }) { entitlementCalls.push(`commit:${jobId}`); }, releaseImage({ jobId }) { entitlementCalls.push(`release:${jobId}`); } }
  });
  const result = await advanceImageJob(store, account, job, deps);
  assert.equal(result.state, 'COMPLETED');
  assert.ok(result.result_asset_id);
  assert.equal(store.mediaAssets.get(result.result_asset_id).state, 'AVAILABLE');
  assert.equal(store.mediaAssets.get(result.result_asset_id).ai_generated, true);
  assert.deepEqual(entitlementCalls, [`commit:${job.job_id}`]);
  // 指标埋点必须与 HTTP 路径同形：可观测性依赖同一份供应商调用记录。
  const metrics = [...store.operationMetrics.values()].filter((metric) => metric.capability === 'IMAGE_GENERATION');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].outcome, 'COMPLETED');
});

test('供应商侧失败时任务置 FAILED 并返还预留权益，不产生结果资产', async () => {
  const store = new DevelopmentStore();
  const account = store.account('acct_dev_alice');
  const job = pendingJob(store, account.account_id, 'chr_1');
  const entitlementCalls = [];
  const deps = imageDeps({
    imageGenerator: { async query() { return { state: 'FAILED', providerRequestId: 'q', failureCode: 'FailedOperation.ServiceNotOpened' }; } },
    imageEntitlementService: { commitImage() {}, releaseImage({ jobId }) { entitlementCalls.push(`release:${jobId}`); } }
  });
  const result = await advanceImageJob(store, account, job, deps);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.failure_code, 'FailedOperation.ServiceNotOpened');
  assert.equal(result.result_asset_id, null);
  assert.deepEqual(entitlementCalls, [`release:${job.job_id}`]);
});

test('结果审核不通过时任务置 BLOCKED：私有对象立即删除且权益返还', async () => {
  const store = new DevelopmentStore();
  const account = store.account('acct_dev_alice');
  const job = pendingJob(store, account.account_id, 'chr_1');
  const deletedKeys = [];
  const entitlementCalls = [];
  const deps = imageDeps({
    imageModerator: async () => ({ decision: 'BLOCK', providerRequestId: 'ims-block', policyVersion: 'ims-test-v1' }),
    imageStore: {
      async putImage({ assetId, bytes }) { return { objectKey: `qiyu/images/${assetId}.png`, checksum: 'sha', byteLength: bytes.length }; },
      async createModerationUrl() { return 'https://signed.example.com/moderation'; },
      async deleteAsset(key) { deletedKeys.push(key); }
    },
    imageEntitlementService: { commitImage() {}, releaseImage({ jobId }) { entitlementCalls.push(`release:${jobId}`); } }
  });
  const result = await advanceImageJob(store, account, job, deps);
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.failure_code, 'IMAGE_OUTPUT_BLOCKED');
  assert.equal(deletedKeys.length, 1);
  assert.deepEqual(entitlementCalls, [`release:${job.job_id}`]);
  assert.equal([...store.operationMetrics.values()].some((metric) => metric.capability === 'IMAGE_MODERATION' && metric.outcome === 'BLOCKED'), true);
});

test('终态任务不会被重复推进（幂等：Worker 轮询与用户手动刷新并发安全）', async () => {
  const store = new DevelopmentStore();
  const account = store.account('acct_dev_alice');
  const job = pendingJob(store, account.account_id, 'chr_1');
  job.state = 'COMPLETED';
  let queried = 0;
  const deps = imageDeps({ imageGenerator: { async query() { queried += 1; return { state: 'COMPLETED', providerRequestId: 'q', resultImageUrl: 'u' }; } } });
  await advanceImageJob(store, account, job, deps);
  assert.equal(queried, 0);
});
