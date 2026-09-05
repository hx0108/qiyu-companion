'use strict';

const { createHash } = require('node:crypto');
const { assertImagePipelineConfiguration } = require('../production/image-pipeline-config');

const IMAGE_MIME_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
});
const IMAGE_OBJECT_PREFIX = 'qiyu/images/';
const DEFAULT_REVIEW_URL_EXPIRES_SECONDS = 300;

// COS remains private. This store returns only object keys to the application;
// short-lived signed URLs are generated exclusively for server-side moderation.
class TencentCosPrivateImageStore {
  constructor({ client, bucket, region = 'ap-guangzhou', objectPrefix = IMAGE_OBJECT_PREFIX, reviewUrlExpiresSeconds = DEFAULT_REVIEW_URL_EXPIRES_SECONDS }) {
    if (!client || typeof client.putObject !== 'function' || typeof client.getObject !== 'function' || typeof client.deleteObject !== 'function' || typeof client.getObjectUrl !== 'function') throw new TypeError('A COS client with putObject, getObject, deleteObject and getObjectUrl is required');
    if (!isBucketName(bucket)) throw new TypeError('Invalid COS bucket name');
    if (region !== 'ap-guangzhou') throw new TypeError('Private image storage must use ap-guangzhou');
    if (objectPrefix !== IMAGE_OBJECT_PREFIX) throw new TypeError(`Private image object prefix must be ${IMAGE_OBJECT_PREFIX}`);
    if (!Number.isInteger(reviewUrlExpiresSeconds) || reviewUrlExpiresSeconds < 60 || reviewUrlExpiresSeconds > 600) throw new TypeError('Review URL expiry must be between 60 and 600 seconds');
    this.client = client;
    this.bucket = bucket;
    this.region = region;
    this.objectPrefix = objectPrefix;
    this.reviewUrlExpiresSeconds = reviewUrlExpiresSeconds;
  }

  async putImage({ assetId, bytes, mimeType }) {
    if (!isSafeId(assetId)) throw new TypeError('Invalid image asset id');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError('Private image bytes must be a non-empty Buffer');
    if (bytes.length > 10 * 1024 * 1024) throw new RangeError('Private image must not exceed 10 MiB');
    const extension = IMAGE_MIME_TYPES[mimeType];
    if (!extension) throw new TypeError('Unsupported private image MIME type');
    const objectKey = `${this.objectPrefix}${assetId}.${extension}`;
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

  async createModerationUrl(objectKey) {
    this.assertObjectKey(objectKey);
    const data = await callCos(this.client, 'getObjectUrl', {
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
      Sign: true,
      Method: 'GET',
      Expires: this.reviewUrlExpiresSeconds
    });
    if (!data || typeof data.Url !== 'string' || !isPrivateGuangzhouObjectUrl(data.Url, this.bucket, objectKey)) throw new Error('COS did not return a valid signed moderation URL');
    return data.Url;
  }

  async deleteAsset(objectKey) {
    this.assertObjectKey(objectKey);
    await callCos(this.client, 'deleteObject', { Bucket: this.bucket, Region: this.region, Key: objectKey });
  }

  async readImage(objectKey) {
    this.assertObjectKey(objectKey);
    const data = await callCos(this.client, 'getObject', { Bucket: this.bucket, Region: this.region, Key: objectKey });
    const bytes = Buffer.isBuffer(data && data.Body) ? data.Body : Buffer.from(data && data.Body || '');
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error('COS returned an invalid private image payload');
    return bytes;
  }

  assertObjectKey(objectKey) {
    if (typeof objectKey !== 'string' || !new RegExp(`^${escapeRegExp(this.objectPrefix)}[A-Za-z0-9_-]+\\.(?:jpg|png|webp)$`).test(objectKey)) throw new TypeError('Invalid private image object key');
  }
}

function createTencentCosPrivateImageStoreFromEnvironment(environment = process.env, { COS, client } = {}) {
  const configuration = assertImagePipelineConfiguration(environment);
  if (!configuration.enabled) return null;
  const resolvedClient = client || createCosClient(environment, COS);
  return new TencentCosPrivateImageStore({
    client: resolvedClient,
    bucket: configuration.bucket,
    region: environment.TENCENT_COS_REGION,
    reviewUrlExpiresSeconds: parseReviewUrlExpiry(environment.TENCENT_IMAGE_MODERATION_URL_EXPIRES_SECONDS)
  });
}

function createCosClient(environment, COS) {
  if (typeof environment.TENCENT_SECRET_ID !== 'string' || !environment.TENCENT_SECRET_ID.trim() || typeof environment.TENCENT_SECRET_KEY !== 'string' || !environment.TENCENT_SECRET_KEY.trim()) throw new Error('Tencent COS credentials are required when image pipeline is enabled');
  const CosConstructor = COS || require('cos-nodejs-sdk-v5');
  return new CosConstructor({ SecretId: environment.TENCENT_SECRET_ID, SecretKey: environment.TENCENT_SECRET_KEY });
}

function parseReviewUrlExpiry(value) {
  if (value === undefined || value === '') return DEFAULT_REVIEW_URL_EXPIRES_SECONDS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new TypeError('TENCENT_IMAGE_MODERATION_URL_EXPIRES_SECONDS must be an integer');
  return parsed;
}

function callCos(client, method, params) {
  return new Promise((resolve, reject) => {
    client[method](params, (error, data) => error ? reject(error) : resolve(data));
  });
}
function isSafeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value); }
function isBucketName(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*-\d+$/.test(value); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isPrivateGuangzhouObjectUrl(value, bucket, objectKey) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === `${bucket}.cos.ap-guangzhou.myqcloud.com` && url.pathname === `/${encodeURIComponent(objectKey).replace(/%2F/g, '/')}` && url.searchParams.has('q-signature');
  } catch { return false; }
}

module.exports = {
  DEFAULT_REVIEW_URL_EXPIRES_SECONDS,
  IMAGE_OBJECT_PREFIX,
  TencentCosPrivateImageStore,
  createTencentCosPrivateImageStoreFromEnvironment,
  isPrivateGuangzhouObjectUrl
};
