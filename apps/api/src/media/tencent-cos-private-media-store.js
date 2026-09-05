'use strict';

const { createHash } = require('node:crypto');

const COS_MEDIA_PREFIX = 'qiyu/media/';
const TTS_PREFIX = `${COS_MEDIA_PREFIX}tts/`;
const ASR_PREFIX = `${COS_MEDIA_PREFIX}asr-input/`;
const JOB_PREFIX = `${COS_MEDIA_PREFIX}jobs/`;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const ASR_EXTENSIONS = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg'
});

// The media store deliberately has no signed-URL method. Browsers fetch media
// only through the authenticated API proxy, while COS remains private.
class TencentCosPrivateMediaStore {
  constructor({ client, bucket, region = 'ap-guangzhou' } = {}) {
    if (!client || typeof client.putObject !== 'function' || typeof client.getObject !== 'function' || typeof client.deleteObject !== 'function') {
      throw new TypeError('A COS client with putObject, getObject and deleteObject is required');
    }
    if (!isBucketName(bucket)) throw new TypeError('Invalid COS bucket name');
    if (region !== 'ap-guangzhou') throw new TypeError('Private media storage must use ap-guangzhou');
    this.client = client;
    this.bucket = bucket;
    this.region = region;
    this.storageKind = 'COS_PRIVATE';
  }

  async createPendingJob(job) {
    await this.writeJobManifest(job, {
      job_id: job.job_id,
      state: job.state,
      type: job.type,
      created_at: job.created_at,
      source_message_id: job.source_message_id || null
    });
  }

  async updateJob(job) {
    await this.writeJobManifest(job, {
      job_id: job.job_id,
      state: job.state,
      type: job.type,
      provider: job.provider || null,
      provider_request_id: job.provider_request_id || null,
      result_asset_id: job.result_asset_id || null,
      input_asset_id: job.input_asset_id || null,
      failure_code: job.failure_code || null
    });
  }

  async putAudio({ assetId, jobId, bytes, mimeType }) {
    if (mimeType !== 'audio/mpeg') throw new TypeError('Only MP3 audio is supported in the private media store');
    const objectKey = `${TTS_PREFIX}${safeId(assetId)}.mp3`;
    return this.putBytes({ objectKey, jobId, bytes, mimeType });
  }

  async putAsrInput({ assetId, jobId, bytes, mimeType }) {
    const extension = ASR_EXTENSIONS[mimeType];
    if (!extension) throw new TypeError('Unsupported ASR input MIME type');
    const objectKey = `${ASR_PREFIX}${safeId(assetId)}.${extension}`;
    return this.putBytes({ objectKey, jobId, bytes, mimeType });
  }

  async putBytes({ objectKey, jobId, bytes, mimeType }) {
    this.assertMediaObjectKey(objectKey);
    safeId(jobId);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) throw new TypeError('Private media bytes must be a non-empty buffer below 10 MiB');
    await callCos(this.client, 'putObject', {
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
      Body: bytes,
      ContentLength: bytes.length,
      Headers: { 'Content-Type': mimeType, 'Cache-Control': 'no-store' }
    });
    return Object.freeze({
      objectKey,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mimeType
    });
  }

  async readTtsAudio(objectKey) {
    if (typeof objectKey !== 'string' || !new RegExp(`^${escapeRegExp(TTS_PREFIX)}[A-Za-z0-9_-]+\\.mp3$`).test(objectKey)) throw new TypeError('Invalid private TTS media object key');
    const data = await callCos(this.client, 'getObject', { Bucket: this.bucket, Region: this.region, Key: objectKey });
    const bytes = Buffer.isBuffer(data && data.Body) ? data.Body : Buffer.from(data && data.Body || '');
    if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) throw new Error('COS returned an invalid private media payload');
    return bytes;
  }

  async deleteAsset(objectKey) {
    this.assertMediaObjectKey(objectKey);
    await callCos(this.client, 'deleteObject', { Bucket: this.bucket, Region: this.region, Key: objectKey });
  }

  async writeJobManifest(job, manifest) {
    const key = `${JOB_PREFIX}${safeId(job.job_id)}.json`;
    const body = Buffer.from(JSON.stringify(manifest), 'utf8');
    await callCos(this.client, 'putObject', {
      Bucket: this.bucket,
      Region: this.region,
      Key: key,
      Body: body,
      ContentLength: body.length,
      Headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  assertMediaObjectKey(objectKey) {
    if (typeof objectKey !== 'string' || !new RegExp(`^(?:${escapeRegExp(TTS_PREFIX)}[A-Za-z0-9_-]+\\.mp3|${escapeRegExp(ASR_PREFIX)}[A-Za-z0-9_-]+\\.(?:mp3|wav|m4a|aac|ogg))$`).test(objectKey)) {
      throw new TypeError('Invalid private media object key');
    }
  }
}

function createTencentCosPrivateMediaStoreFromEnvironment(environment = process.env, { COS, client } = {}) {
  if (!nonBlank(environment.QIYU_PRIVATE_MEDIA_STORE)) return null;
  if (environment.QIYU_PRIVATE_MEDIA_STORE !== 'tencent-cos') throw configurationError('PRIVATE_MEDIA_STORE_CONFIGURATION_INVALID', 'QIYU_PRIVATE_MEDIA_STORE 必须为 tencent-cos');
  const required = [
    ['TENCENT_SECRET_ID'], ['TENCENT_SECRET_KEY'], ['TENCENT_COS_BUCKET'],
    ['TENCENT_COS_REGION', 'ap-guangzhou'], ['TENCENT_COS_ENDPOINT']
  ];
  for (const [key, expected] of required) {
    if (!nonBlank(environment[key])) throw configurationError('PRIVATE_MEDIA_STORE_CONFIGURATION_INCOMPLETE', `私有媒体存储缺少 ${key}`);
    if (expected && environment[key] !== expected) throw configurationError('PRIVATE_MEDIA_STORE_CONFIGURATION_INVALID', `${key} 必须为 ${expected}`);
  }
  if (!isPrivateGuangzhouCosEndpoint(environment.TENCENT_COS_ENDPOINT, environment.TENCENT_COS_BUCKET)) {
    throw configurationError('PRIVATE_MEDIA_STORE_CONFIGURATION_INVALID', 'COS 端点必须匹配广州地域的私有桶域名');
  }
  const resolvedClient = client || createCosClient(environment, COS);
  return new TencentCosPrivateMediaStore({ client: resolvedClient, bucket: environment.TENCENT_COS_BUCKET, region: environment.TENCENT_COS_REGION });
}

function createCosClient(environment, COS) {
  const CosConstructor = COS || require('cos-nodejs-sdk-v5');
  return new CosConstructor({ SecretId: environment.TENCENT_SECRET_ID, SecretKey: environment.TENCENT_SECRET_KEY });
}
function callCos(client, method, params) { return new Promise((resolve, reject) => client[method](params, (error, data) => error ? reject(error) : resolve(data))); }
function safeId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid media id'); return value; }
function isBucketName(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*-\d+$/.test(value); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function configurationError(code, message) { const error = new Error(message); error.code = code; return error; }
function isPrivateGuangzhouCosEndpoint(value, bucket) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.pathname === '/' && url.hostname === `${bucket}.cos.ap-guangzhou.myqcloud.com`; } catch { return false; }
}

module.exports = {
  ASR_EXTENSIONS,
  COS_MEDIA_PREFIX,
  TencentCosPrivateMediaStore,
  createTencentCosPrivateMediaStoreFromEnvironment
};
