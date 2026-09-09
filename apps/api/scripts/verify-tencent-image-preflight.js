'use strict';

// 图片链路预检：固定 256x256 纯色 PNG -> 私有 COS -> 短签名 IMS 审核 URL。
// 不创建账户、角色、生图任务或长期媒体资产；finally 始终删除测试对象。
const { randomUUID } = require('node:crypto');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');
const { createTencentImageModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
const { createControlledPng } = require('./controlled-probe-png');

const CONTROLLED_PNG = createControlledPng();
let currentStage = 'startup';

async function main() {
  const required = [
    'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION',
    'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION', 'TENCENT_COS_ENDPOINT',
    'TENCENT_IMAGE_MODERATION_BIZ_TYPE'
  ];
  for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);
  if (process.env.QIYU_IMAGE_MODERATION_PROVIDER !== 'tencent') throw new Error('QIYU_IMAGE_MODERATION_PROVIDER=tencent is required.');
  if (process.env.QIYU_IMAGE_PROVIDER !== 'tencent-hunyuan') throw new Error('QIYU_IMAGE_PROVIDER=tencent-hunyuan is required.');

  const imageStore = createTencentCosPrivateImageStoreFromEnvironment(process.env);
  const moderateImage = createTencentImageModeratorFromEnvironment(process.env);
  if (!imageStore || typeof moderateImage !== 'function') throw new Error('Tencent COS image store and IMS moderator must both be enabled.');

  const assetId = `imgprobe${randomUUID().replace(/-/g, '')}`;
  let persisted = null;
  try {
    currentStage = 'cos-upload';
    persisted = await imageStore.putImage({ assetId, bytes: CONTROLLED_PNG, mimeType: 'image/png' });
    currentStage = 'cos-signed-url';
    currentStage = 'ims-moderation';
    const moderation = await moderateImage({ fileUrl: await imageStore.createModerationUrl(persisted.objectKey), dataId: assetId });
    console.log(JSON.stringify({
      acceptance: moderation.decision === 'PASS' ? 'passed' : 'failed',
      provider: moderateImage.provider,
      model_version: moderateImage.modelVersion,
      moderation_decision: moderation.decision,
      uploaded_bytes: persisted.byteLength,
      cleanup: 'scheduled'
    }));
    if (moderation.decision !== 'PASS') throw new Error(`IMS did not pass the controlled image: ${moderation.decision}`);
  } finally {
    if (persisted) await imageStore.deleteAsset(persisted.objectKey);
  }
}

main().catch((error) => {
  const upstream = error && error.details && typeof error.details === 'object'
    ? error.details.upstream_status || error.details.upstream_error_code
    : null;
  const upstreamHint = upstream ? `（上游状态/错误码：${upstream}）` : '';
  console.error(`腾讯 COS/IMS 图片预检失败（${currentStage}）：${error.code || 'UNKNOWN'} ${error.message}${upstreamHint}`);
  process.exitCode = 1;
});
