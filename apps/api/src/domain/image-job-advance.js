'use strict';

const { recordOperationMetric, providerName, providerModelVersion, moderateImageWithMetric } = require('./operation-metrics');

// 图片生成任务状态推进（后台任务化，P0）：同一状态机服务两个入口——
// 1) HTTP POST /image-jobs/:id/refresh（用户手动刷新兜底）；
// 2) 独立 Worker 进程轮询（run-workers.js），前端不再承担推进职责。
// 函数不做鉴权与归属校验：调用方（路由或 Worker）必须已加载该账户作用域
// store 并传入属于该账户的 PENDING/RUNNING 任务。

async function advanceImageJob(store, account, job, { imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService }) {
  if (!['PENDING', 'RUNNING'].includes(job.state)) return job;
  try {
    const providerStartedAt = Date.now();
    let status;
    try {
      status = await imageGenerator.query({ providerJobId: job.provider_job_id });
      recordOperationMetric(store, { accountId: account.account_id, capability: 'IMAGE_GENERATION', provider: providerName(imageGenerator, job.provider), modelVersion: providerModelVersion(imageGenerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: status.state === 'FAILED' ? 'FAILED' : 'COMPLETED' });
    } catch (error) {
      recordOperationMetric(store, { accountId: account.account_id, capability: 'IMAGE_GENERATION', provider: providerName(imageGenerator, job.provider), modelVersion: providerModelVersion(imageGenerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'FAILED' });
      throw error;
    }
    job.provider_request_id = status.providerRequestId;
    job.state = status.state;
    if (status.state === 'FAILED') {
      job.failure_code = status.failureCode || 'TENCENT_HUNYUAN_JOB_FAILED';
      releaseImageEntitlement(job, account, imageEntitlementService);
    }
    if (status.state === 'COMPLETED') {
      await persistGeneratedImage(store, account, job, status, imageModerator, imageStore, imageResultFetcher, imageEntitlementService);
      if (job.state === 'BLOCKED') releaseImageEntitlement(job, account, imageEntitlementService);
    }
  } catch (error) {
    job.state = 'FAILED';
    job.failure_code = error.code || 'IMAGE_GENERATION_REFRESH_FAILED';
    job.provider_error_code = safeProviderErrorCode(error);
    releaseImageEntitlement(job, account, imageEntitlementService);
  }
  return job;
}

async function persistGeneratedImage(store, account, job, status, imageModerator, imageStore, imageResultFetcher, imageEntitlementService) {
  const downloaded = await imageResultFetcher(status.resultImageUrl);
  const asset = {
    asset_id: store.next('med'), account_id: account.account_id, character_id: job.character_id, job_id: job.job_id,
    type: 'SCENE_IMAGE', state: 'PENDING_MODERATION', confirmation_state: 'NOT_REQUIRED', media_type: 'IMAGE', mime_type: downloaded.mimeType,
    byte_length: null, checksum: null, object_key: null, provider: 'tencent-hunyuan', provider_request_id: status.providerRequestId,
    ai_generated: true, aigc_mark_version: 'tencent-hunyuan-logoadd-v1', created_at: new Date().toISOString(), deleted_at: null
  };
  store.mediaAssets.set(asset.asset_id, asset);
  try {
    const persisted = await imageStore.putImage({ assetId: asset.asset_id, bytes: downloaded.bytes, mimeType: downloaded.mimeType });
    Object.assign(asset, { object_key: persisted.objectKey, checksum: persisted.checksum, byte_length: persisted.byteLength });
    const moderation = await moderateImageWithMetric(store, account, imageModerator, { fileUrl: await imageStore.createModerationUrl(asset.object_key), dataId: `generated-${asset.asset_id}` });
    asset.provider_request_id = moderation.providerRequestId;
    asset.moderation_policy_version = moderation.policyVersion;
    if (moderation.decision !== 'PASS') {
      asset.state = moderation.decision === 'BLOCK' ? 'BLOCKED' : 'REVIEW_REQUIRED';
      await imageStore.deleteAsset(asset.object_key);
      job.state = 'BLOCKED';
      job.failure_code = moderation.decision === 'BLOCK' ? 'IMAGE_OUTPUT_BLOCKED' : 'IMAGE_OUTPUT_REVIEW_REQUIRED';
      return;
    }
    if (imageEntitlementService) imageEntitlementService.commitImage({ accountId: account.account_id, jobId: job.job_id });
    asset.state = 'AVAILABLE';
    job.result_asset_id = asset.asset_id;
    job.state = 'COMPLETED';
  } catch (error) {
    asset.state = 'FAILED';
    asset.failure_code = error.code || 'IMAGE_RESULT_PROCESSING_FAILED';
    if (asset.object_key) await safeDeleteImage(imageStore, asset.object_key);
    throw error;
  }
}

function releaseImageEntitlement(job, account, imageEntitlementService) {
  if (!imageEntitlementService || !job.entitlement_id) return;
  try { imageEntitlementService.releaseImage({ accountId: account.account_id, jobId: job.job_id }); }
  catch { job.failure_code = 'ENTITLEMENT_RELEASE_FAILED'; }
}

function safeProviderErrorCode(error) {
  const value = error?.details?.upstream_error_code;
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}

async function safeDeleteImage(imageStore, objectKey) { try { await imageStore.deleteAsset(objectKey); } catch { /* 已删除或不可达：保留账本状态即可 */ } }

module.exports = { advanceImageJob, releaseImageEntitlement };
