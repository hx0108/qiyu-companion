'use strict';

const { assertAdapterResult } = require('../production/adapter-contracts');
const { TencentTc3Client, TencentProviderError } = require('./tencent-tc3-client');
const { buildImageSceneContract } = require('../domain/image-scene-contract');

// 混元生图 3.0（产品 1668，域名 aiart.tencentcloudapi.com）：旧 hunyuan:SubmitHunyuanImageJob
// 已于 2026-06-22 下线（官方迁移公告 cloud.tencent.com/document/product/1729/131925）。
// 3.0 状态码与旧接口一致（1 等待/2 运行/4 失败/5 完成），查询响应字段兼容。
const AIART_IMAGE_VERSION = '2022-12-29';
const MAX_IMAGE_PROMPT_LENGTH = 1024;
const SUPPORTED_RESOLUTIONS = new Set(['768:768', '768:1024', '1024:768', '1024:1024']);
const JOB_STATES = Object.freeze({ '1': 'PENDING', '2': 'RUNNING', '4': 'FAILED', '5': 'COMPLETED' });

// This adapter deliberately never downloads or exposes Tencent's one-hour result
// URL. The media pipeline must first copy a completed result into owned private
// storage, then apply post-generation moderation before it becomes an asset.
class TencentHunyuanImageAdapter {
  constructor({ client } = {}) {
    if (!client || typeof client.request !== 'function') throw new TypeError('TencentHunyuanImageAdapter requires a Tencent TC3 client');
    this.client = client;
    this.provider = 'tencent-hunyuan';
    this.modelVersion = `SubmitTextToImageJob/${AIART_IMAGE_VERSION}`;
  }

  async generate({ prompt, referenceImageUrl, style, resolution = '768:1024' } = {}) {
    const safePrompt = validatedPrompt(prompt);
    if (!isApprovedReferenceImageUrl(referenceImageUrl)) {
      throw new TencentProviderError('TENCENT_HUNYUAN_REFERENCE_INVALID', '情境图片必须使用受控 COS 参考立绘地址', 400);
    }
    if (!SUPPORTED_RESOLUTIONS.has(resolution)) {
      throw new TencentProviderError('TENCENT_HUNYUAN_RESOLUTION_INVALID', '参考立绘情境图分辨率不受支持', 400);
    }
    if (style !== undefined && !safeStyle(style)) {
      throw new TencentProviderError('TENCENT_HUNYUAN_STYLE_INVALID', '图片风格配置无效', 400);
    }
    const response = await this.client.request({
      service: 'aiart', action: 'SubmitTextToImageJob', version: AIART_IMAGE_VERSION,
      body: {
        Prompt: safePrompt, Images: [referenceImageUrl], Resolution: resolution,
        Revise: 1, LogoAdd: 1
      }
    });
    if (!nonBlank(response.JobId) || !nonBlank(response.RequestId)) {
      throw new TencentProviderError('TENCENT_HUNYUAN_RESPONSE_INVALID', '腾讯混元未返回图片任务标识', 502);
    }
    return assertAdapterResult('IMAGE_GENERATION', {
      asset: { state: 'PENDING', provider_job_id: response.JobId, provider: 'tencent-hunyuan', aigc_logo_requested: true },
      providerRequestId: response.RequestId
    });
  }

  async generateScene({ character, referenceAsset, scene, confirmedAssets, worldState, referenceImageUrl, style, resolution } = {}) {
    const sceneContract = buildImageSceneContract({ character, referenceAsset, scene, confirmedAssets, worldState });
    const result = await this.generate({ prompt: sceneContract.prompt, referenceImageUrl, style, resolution });
    return { ...result, sceneContract };
  }

  async query({ providerJobId } = {}) {
    if (!nonBlank(providerJobId)) throw new TencentProviderError('TENCENT_HUNYUAN_JOB_INVALID', '图片任务标识无效', 400);
    const response = await this.client.request({
      service: 'aiart', action: 'QueryTextToImageJob', version: AIART_IMAGE_VERSION,
      body: { JobId: providerJobId }
    });
    const state = JOB_STATES[response.JobStatusCode];
    if (!state || !nonBlank(response.RequestId)) {
      throw new TencentProviderError('TENCENT_HUNYUAN_RESPONSE_INVALID', '腾讯混元未返回可用图片任务状态', 502);
    }
    if (state === 'FAILED') return { state, providerRequestId: response.RequestId, failureCode: safeFailureCode(response.JobErrorCode) };
    if (state !== 'COMPLETED') return { state, providerRequestId: response.RequestId };
    const resultImageUrl = Array.isArray(response.ResultImage) ? response.ResultImage[0] : undefined;
    if (!isTencentResultUrl(resultImageUrl)) {
      throw new TencentProviderError('TENCENT_HUNYUAN_RESPONSE_INVALID', '腾讯混元未返回受控图片结果', 502);
    }
    return { state, providerRequestId: response.RequestId, resultImageUrl, revisedPrompt: Array.isArray(response.RevisedPrompt) ? response.RevisedPrompt[0] : undefined };
  }
}

function createTencentHunyuanImageGeneratorFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_IMAGE_PROVIDER !== 'tencent-hunyuan') return null;
  const region = environment.TENCENT_HUNYUAN_REGION || environment.TENCENT_REGION || 'ap-guangzhou';
  if (region !== 'ap-guangzhou') throw new TencentProviderError('TENCENT_HUNYUAN_REGION_INVALID', '腾讯混元生图仅允许广州地域', 500);
  return new TencentHunyuanImageAdapter({
    client: new TencentTc3Client({ secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY, region, fetchImpl: dependencies.fetchImpl || globalThis.fetch, timeoutMs: environment.TENCENT_HUNYUAN_TIMEOUT_MS, now: dependencies.now })
  });
}

function validatedPrompt(value) {
  if (!nonBlank(value) || [...value.trim()].length > MAX_IMAGE_PROMPT_LENGTH) {
    throw new TencentProviderError('TENCENT_HUNYUAN_PROMPT_INVALID', `图片描述必须为 1-${MAX_IMAGE_PROMPT_LENGTH} 个字符`, 400);
  }
  return value.trim();
}
function isApprovedReferenceImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)cos\.ap-guangzhou\.myqcloud\.com$/i.test(url.hostname);
  } catch { return false; }
}
function isTencentResultUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)cos\.ap-guangzhou\.myqcloud\.com$/i.test(url.hostname);
  } catch { return false; }
}
function safeStyle(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value); }
function safeFailureCode(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : 'TENCENT_HUNYUAN_JOB_FAILED'; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }

module.exports = { AIART_IMAGE_VERSION, JOB_STATES, MAX_IMAGE_PROMPT_LENGTH, SUPPORTED_RESOLUTIONS, TencentHunyuanImageAdapter, buildImageSceneContract, createTencentHunyuanImageGeneratorFromEnvironment, isApprovedReferenceImageUrl, isTencentResultUrl };
