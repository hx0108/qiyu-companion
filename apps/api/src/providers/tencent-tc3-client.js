'use strict';

const { createHash, createHmac } = require('node:crypto');

const SERVICES = Object.freeze({
  tms: 'tms.tencentcloudapi.com',
  ims: 'ims.tencentcloudapi.com',
  asr: 'asr.tencentcloudapi.com',
  tts: 'tts.tencentcloudapi.com',
  hunyuan: 'hunyuan.tencentcloudapi.com',
  // 混元生图 3.0（产品 1668）：旧 hunyuan:SubmitHunyuanImageJob 已于 2026-06-22 下线。
  aiart: 'aiart.tencentcloudapi.com'
});

class TencentProviderError extends Error {
  constructor(code, message, status = 502, details = {}, retryable = false) {
    super(message);
    this.name = 'TencentProviderError';
    this.code = code;
    this.status = status;
    this.expose = true;
    this.details = details;
    this.retryable = retryable;
  }
}

class TencentTc3Client {
  constructor({ secretId, secretKey, region = 'ap-guangzhou', fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => new Date() } = {}) {
    if (!nonBlank(secretId) || !nonBlank(secretKey)) throw new TencentProviderError('TENCENT_CREDENTIAL_REQUIRED', '腾讯云凭据未配置', 500);
    if (!nonBlank(region)) throw new TencentProviderError('TENCENT_REGION_REQUIRED', '腾讯云处理地域未配置', 500);
    if (typeof fetchImpl !== 'function') throw new TypeError('TencentTc3Client requires fetch');
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.region = region;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveTimeout(timeoutMs);
    this.now = now;
  }

  async request({ service, action, version, body }) {
    const host = SERVICES[service];
    if (!host) throw new TencentProviderError('TENCENT_SERVICE_NOT_ALLOWED', '腾讯云服务未在本适配器中允许', 500);
    if (!nonBlank(action) || !nonBlank(version) || !body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TencentProviderError('TENCENT_REQUEST_INVALID', '腾讯云请求参数无效', 500);
    }
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify(body);
    const signed = signature({ secretId: this.secretId, secretKey: this.secretKey, host, service, action, version, region: this.region, timestamp, date, payload });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://${host}`, {
        method: 'POST',
        headers: signed.headers,
        body: payload,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new TencentProviderError('TENCENT_UPSTREAM_REJECTED', '腾讯云内容审核暂时不可用', 502, { upstream_status: response.status }, response.status === 429 || response.status >= 500);
      }
      let payloadResponse;
      try { payloadResponse = await response.json(); } catch { throw new TencentProviderError('TENCENT_RESPONSE_INVALID', '腾讯云内容审核返回格式无效'); }
      const result = payloadResponse && payloadResponse.Response;
      if (!result || typeof result !== 'object') throw new TencentProviderError('TENCENT_RESPONSE_INVALID', '腾讯云内容审核未返回可用结果');
      if (result.Error) {
        throw new TencentProviderError('TENCENT_UPSTREAM_REJECTED', '腾讯云服务暂时不可用', 502, {
          upstream_error_code: safeUpstreamErrorCode(result.Error.Code)
        }, false);
      }
      return result;
    } catch (error) {
      if (error instanceof TencentProviderError) throw error;
      if (error && error.name === 'AbortError') throw new TencentProviderError('TENCENT_TIMEOUT', '腾讯云内容审核响应超时', 502, {}, true);
      throw new TencentProviderError('TENCENT_NETWORK_ERROR', '腾讯云内容审核网络请求失败', 502, {}, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function signature({ secretId, secretKey, host, service, action, version, region, timestamp, date, payload }) {
  const signedHeaders = 'content-type;host;x-tc-action;x-tc-region;x-tc-timestamp;x-tc-version';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\nx-tc-region:${region}\nx-tc-timestamp:${timestamp}\nx-tc-version:${version}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(payload)}`;
  const scope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signatureValue = hmac(secretSigning, stringToSign).toString('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signatureValue}`;
  return { headers: {
    authorization,
    'content-type': 'application/json; charset=utf-8',
    host,
    'x-tc-action': action,
    'x-tc-region': region,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': version
  } };
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function hmac(key, value) { return createHmac('sha256', key).update(value).digest(); }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function safeUpstreamErrorCode(value) { return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined; }
function positiveTimeout(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 1000 && parsed <= 60000 ? parsed : 10000; }

module.exports = { SERVICES, TencentProviderError, TencentTc3Client, signature };
