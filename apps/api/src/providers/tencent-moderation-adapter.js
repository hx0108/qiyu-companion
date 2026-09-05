'use strict';

const { assertAdapterResult } = require('../production/adapter-contracts');
const { TencentTc3Client, TencentProviderError } = require('./tencent-tc3-client');

const SUGGESTION_DECISION = Object.freeze({ Pass: 'PASS', Review: 'REVIEW', Block: 'BLOCK' });
const TMS_VERSION = '2020-12-29';
const IMS_VERSION = '2020-12-29';

class TencentModerationAdapter {
  constructor({ client, textBizType, imageBizType } = {}) {
    if (!client || typeof client.request !== 'function') throw new TypeError('TencentModerationAdapter requires a Tencent TC3 client');
    this.client = client;
    this.textBizType = textBizType;
    this.imageBizType = imageBizType;
  }

  async moderateText({ text, dataId, sessionId }) {
    if (!nonBlank(this.textBizType)) throw new TencentProviderError('TENCENT_TEXT_MODERATION_BIZ_TYPE_REQUIRED', '腾讯云文本审核策略未配置', 500);
    if (!nonBlank(text)) throw new TencentProviderError('TENCENT_TEXT_INPUT_INVALID', '待审核文本不能为空', 400);
    const response = await this.client.request({
      service: 'tms', action: 'TextModeration', version: TMS_VERSION,
      body: { Content: Buffer.from(text.trim(), 'utf8').toString('base64'), BizType: this.textBizType, DataId: safeIdentifier(dataId), SessionId: safeIdentifier(sessionId), Type: 'TEXT', SourceLanguage: 'zh' }
    });
    return normalize('TEXT_MODERATION', response, `tencent-tms-${TMS_VERSION}:${this.textBizType}`);
  }

  async moderateImage({ fileUrl, dataId }) {
    if (!nonBlank(this.imageBizType)) throw new TencentProviderError('TENCENT_IMAGE_MODERATION_BIZ_TYPE_REQUIRED', '腾讯云图片审核策略未配置', 500);
    // Public callers must not be allowed to submit arbitrary remote URLs. A later
    // media pipeline will pass only an object-storage URL after ownership checks.
    if (!isApprovedMediaUrl(fileUrl)) throw new TencentProviderError('TENCENT_IMAGE_SOURCE_INVALID', '图片审核仅接受受控媒体地址', 400);
    const response = await this.client.request({
      service: 'ims', action: 'ImageModeration', version: IMS_VERSION,
      body: { FileUrl: fileUrl, BizType: this.imageBizType, DataId: safeIdentifier(dataId) }
    });
    return normalize('IMAGE_MODERATION', response, `tencent-ims-${IMS_VERSION}:${this.imageBizType}`);
  }
}

function normalize(capability, response, policyVersion) {
  const decision = SUGGESTION_DECISION[response && response.Suggestion];
  if (!decision || !nonBlank(response.RequestId)) throw new TencentProviderError('TENCENT_MODERATION_RESPONSE_INVALID', '腾讯云内容审核未返回可用决策');
  return assertAdapterResult(capability, { decision, providerRequestId: response.RequestId, policyVersion });
}

function createTencentTextModeratorFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_TEXT_MODERATION_PROVIDER !== 'tencent') return null;
  const adapter = new TencentModerationAdapter({
    client: new TencentTc3Client({ secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY, region: environment.TENCENT_REGION, fetchImpl: dependencies.fetchImpl || globalThis.fetch, timeoutMs: environment.TENCENT_MODERATION_TIMEOUT_MS, now: dependencies.now }),
    textBizType: environment.TENCENT_TEXT_MODERATION_BIZ_TYPE
  });
  const moderateText = ({ text, accountId, conversationId }) => adapter.moderateText({ text, dataId: `msg-${accountId}`, sessionId: conversationId });
  moderateText.provider = 'tencent-tms';
  moderateText.modelVersion = `TextModeration/${TMS_VERSION}`;
  return moderateText;
}

function createTencentImageModeratorFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_IMAGE_MODERATION_PROVIDER !== 'tencent') return null;
  const adapter = new TencentModerationAdapter({
    client: new TencentTc3Client({ secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY, region: environment.TENCENT_REGION, fetchImpl: dependencies.fetchImpl || globalThis.fetch, timeoutMs: environment.TENCENT_IMAGE_MODERATION_TIMEOUT_MS, now: dependencies.now }),
    imageBizType: environment.TENCENT_IMAGE_MODERATION_BIZ_TYPE
  });
  const moderateImage = ({ fileUrl, dataId }) => adapter.moderateImage({ fileUrl, dataId });
  moderateImage.provider = 'tencent-ims';
  moderateImage.modelVersion = `ImageModeration/${IMS_VERSION}`;
  return moderateImage;
}

function isApprovedMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)cos\.ap-[a-z0-9-]+\.myqcloud\.com$/i.test(url.hostname);
  } catch { return false; }
}
function safeIdentifier(value) { return nonBlank(value) ? value.slice(0, 128) : undefined; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }

module.exports = { IMS_VERSION, SUGGESTION_DECISION, TMS_VERSION, TencentModerationAdapter, createTencentImageModeratorFromEnvironment, createTencentTextModeratorFromEnvironment, isApprovedMediaUrl };
