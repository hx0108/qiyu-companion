'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TencentCosPrivateImageStore,
  createTencentCosPrivateImageStoreFromEnvironment
} = require('../src/media/tencent-cos-private-image-store');

const bucket = 'qiyu-1250000000';
const objectKey = 'qiyu/images/asset_1.png';
const signedUrl = `https://${bucket}.cos.ap-guangzhou.myqcloud.com/${objectKey}?q-signature=example`;

test('私有 COS 图片存储仅写入固定前缀，并将审核 URL 限制为短时私有签名地址', async () => {
  const calls = [];
  const client = callbackClient(calls, signedUrl);
  const store = new TencentCosPrivateImageStore({ client, bucket });
  const image = await store.putImage({ assetId: 'asset_1', bytes: Buffer.from('png-bytes'), mimeType: 'image/png' });
  assert.deepEqual(image, { objectKey, checksum: 'ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56', byteLength: 9, mimeType: 'image/png' });
  assert.equal(calls[0].method, 'putObject');
  assert.deepEqual(calls[0].params, { Bucket: bucket, Region: 'ap-guangzhou', Key: objectKey, Body: Buffer.from('png-bytes'), ContentLength: 9, Headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  assert.equal(await store.createModerationUrl(objectKey), signedUrl);
  assert.deepEqual(calls[1].params, { Bucket: bucket, Region: 'ap-guangzhou', Key: objectKey, Sign: true, Method: 'GET', Expires: 300 });
  assert.deepEqual(await store.readImage(objectKey), Buffer.from('stored-image'));
  assert.deepEqual(calls[2].params, { Bucket: bucket, Region: 'ap-guangzhou', Key: objectKey });
  await store.deleteAsset(objectKey);
  assert.deepEqual(calls[3].params, { Bucket: bucket, Region: 'ap-guangzhou', Key: objectKey });
});

test('私有 COS 图片存储拒绝越界键、公开地址和不支持的文件', async () => {
  const client = callbackClient([], `https://${bucket}.cos.ap-guangzhou.myqcloud.com/${objectKey}`);
  const store = new TencentCosPrivateImageStore({ client, bucket });
  await assert.rejects(() => store.putImage({ assetId: '../bad', bytes: Buffer.from('x'), mimeType: 'image/png' }), /asset id/);
  await assert.rejects(() => store.putImage({ assetId: 'asset_1', bytes: Buffer.from('x'), mimeType: 'image/gif' }), /MIME/);
  await assert.rejects(() => store.createModerationUrl('../public.png'), /object key/);
  await assert.rejects(() => store.createModerationUrl(objectKey), /valid signed moderation URL/);
});

test('环境工厂仅在完整图片链路配置下创建 COS 客户端，且不暴露凭据', () => {
  const calls = [];
  const environment = {
    QIYU_IMAGE_PROVIDER: 'tencent-hunyuan', QIYU_IMAGE_MODERATION_PROVIDER: 'tencent',
    TENCENT_REGION: 'ap-guangzhou', TENCENT_HUNYUAN_REGION: 'ap-guangzhou', TENCENT_IMAGE_MODERATION_BIZ_TYPE: 'qiyu_image_v1',
    TENCENT_COS_BUCKET: bucket, TENCENT_COS_REGION: 'ap-guangzhou', TENCENT_COS_ENDPOINT: `https://${bucket}.cos.ap-guangzhou.myqcloud.com`,
    TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_IMAGE_MODERATION_URL_EXPIRES_SECONDS: '120'
  };
  class FakeCos { constructor(options) { calls.push(options); } putObject() {} getObject() {} deleteObject() {} getObjectUrl() {} }
  const store = createTencentCosPrivateImageStoreFromEnvironment(environment, { COS: FakeCos });
  assert.equal(store.reviewUrlExpiresSeconds, 120);
  assert.deepEqual(calls, [{ SecretId: 'id', SecretKey: 'key' }]);
  assert.equal(createTencentCosPrivateImageStoreFromEnvironment({}), null);
});

test('腾讯通用区域配置不会单独误启用图片链路', () => {
  assert.equal(createTencentCosPrivateImageStoreFromEnvironment({ TENCENT_REGION: 'ap-guangzhou' }), null);
});

function callbackClient(calls, responseUrl) {
  return {
    putObject(params, callback) { calls.push({ method: 'putObject', params }); callback(null, { ETag: 'etag' }); },
    getObjectUrl(params, callback) { calls.push({ method: 'getObjectUrl', params }); callback(null, { Url: responseUrl }); },
    getObject(params, callback) { calls.push({ method: 'getObject', params }); callback(null, { Body: Buffer.from('stored-image') }); },
    deleteObject(params, callback) { calls.push({ method: 'deleteObject', params }); callback(null, {}); }
  };
}
