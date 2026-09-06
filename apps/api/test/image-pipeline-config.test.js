'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertImagePipelineConfiguration } = require('../src/production/image-pipeline-config');

const enabled = {
  QIYU_IMAGE_PROVIDER: 'tencent-hunyuan', QIYU_IMAGE_MODERATION_PROVIDER: 'tencent',
  TENCENT_REGION: 'ap-guangzhou', TENCENT_HUNYUAN_REGION: 'ap-guangzhou', TENCENT_IMAGE_MODERATION_BIZ_TYPE: 'qiyu_image_v1',
  TENCENT_COS_BUCKET: 'qiyu-1250000000', TENCENT_COS_REGION: 'ap-guangzhou',
  TENCENT_COS_ENDPOINT: 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com'
};

test('图片链路完全未配置时保持关闭，完整配置才可启用', () => {
  assert.deepEqual(assertImagePipelineConfiguration({}), { enabled: false });
  assert.deepEqual(assertImagePipelineConfiguration({ TENCENT_HUNYUAN_REGION: 'ap-guangzhou' }), { enabled: false });
  assert.deepEqual(assertImagePipelineConfiguration(enabled), { enabled: true, provider: 'tencent-hunyuan', moderationProvider: 'tencent', bucket: 'qiyu-1250000000', endpoint: 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com' });
});

test('图片链路拒绝仅启用生图、非广州地域或不匹配的 COS 端点', () => {
  assert.throws(() => assertImagePipelineConfiguration({ QIYU_IMAGE_PROVIDER: 'tencent-hunyuan' }), (error) => error.code === 'IMAGE_PIPELINE_CONFIGURATION_INCOMPLETE');
  assert.throws(() => assertImagePipelineConfiguration({ ...enabled, TENCENT_COS_REGION: 'ap-shanghai' }), (error) => error.code === 'IMAGE_PIPELINE_CONFIGURATION_INVALID');
  assert.throws(() => assertImagePipelineConfiguration({ ...enabled, TENCENT_REGION: 'ap-shanghai' }), (error) => error.code === 'IMAGE_PIPELINE_CONFIGURATION_INVALID');
  assert.throws(() => assertImagePipelineConfiguration({ ...enabled, TENCENT_COS_ENDPOINT: 'https://other-1250000000.cos.ap-guangzhou.myqcloud.com' }), (error) => error.code === 'IMAGE_PIPELINE_CONFIGURATION_INVALID');
});

test('仅配置私有 COS 媒体存储不会误启用图片链路', () => {
  const bucket = 'qiyu-1250000000';
  assert.deepEqual(assertImagePipelineConfiguration({
    TENCENT_REGION: 'ap-guangzhou', TENCENT_COS_BUCKET: bucket,
    TENCENT_COS_REGION: 'ap-guangzhou', TENCENT_COS_ENDPOINT: `https://${bucket}.cos.ap-guangzhou.myqcloud.com`
  }), { enabled: false });
});
