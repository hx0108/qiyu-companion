'use strict';

// 真实混元生图提交预检：仅使用固定纯色参考图和固定无人物提示词。
// 不创建账户、角色、关系记忆或持久化媒体资产；finally 始终删除 COS 测试参考图。
const { randomUUID } = require('node:crypto');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');
const { createTencentImageModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
const { createTencentHunyuanImageGeneratorFromEnvironment } = require('../src/providers/tencent-hunyuan-image-adapter');
const { createControlledPng } = require('./controlled-probe-png');

const CONTROLLED_PNG = createControlledPng();
const PROMPT = '一张温暖的浅米色室内窗边插画，无人物，无文字，无标识，柔和自然光。';
let currentStage = 'startup';

async function main() {
  const required = [
    'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION',
    'TENCENT_COS_ENDPOINT', 'TENCENT_IMAGE_MODERATION_BIZ_TYPE', 'TENCENT_HUNYUAN_REGION'
  ];
  for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);
  if (process.env.QIYU_IMAGE_PROVIDER !== 'tencent-hunyuan') throw new Error('QIYU_IMAGE_PROVIDER=tencent-hunyuan is required.');
  if (process.env.QIYU_IMAGE_MODERATION_PROVIDER !== 'tencent') throw new Error('QIYU_IMAGE_MODERATION_PROVIDER=tencent is required.');

  const imageStore = createTencentCosPrivateImageStoreFromEnvironment(process.env);
  const moderateImage = createTencentImageModeratorFromEnvironment(process.env);
  const imageGenerator = createTencentHunyuanImageGeneratorFromEnvironment(process.env);
  if (!imageStore || typeof moderateImage !== 'function' || !imageGenerator) throw new Error('Tencent COS, IMS and Hunyuan image providers must all be enabled.');

  const assetId = `hyprobe${randomUUID().replace(/-/g, '')}`;
  let persisted = null;
  try {
    currentStage = 'cos-upload';
    persisted = await imageStore.putImage({ assetId, bytes: CONTROLLED_PNG, mimeType: 'image/png' });
    currentStage = 'ims-reference-moderation';
    const referenceImageUrl = await imageStore.createModerationUrl(persisted.objectKey);
    const moderation = await moderateImage({ fileUrl: referenceImageUrl, dataId: assetId });
    if (moderation.decision !== 'PASS') throw new Error('The controlled reference image was not approved by IMS.');
    currentStage = 'hunyuan-submit';
    const result = await imageGenerator.generate({ prompt: PROMPT, referenceImageUrl, resolution: '768:768' });
    console.log(JSON.stringify({
      acceptance: 'passed', provider: result.asset.provider, model_version: imageGenerator.modelVersion,
      job_state: result.asset.state, aigc_logo_requested: result.asset.aigc_logo_requested,
      reference_moderation: moderation.decision, reference_bytes: CONTROLLED_PNG.length, cleanup: 'scheduled'
    }));
  } finally {
    if (persisted) {
      currentStage = 'cos-cleanup';
      await imageStore.deleteAsset(persisted.objectKey).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  const upstream = error && error.details && typeof error.details === 'object'
    ? error.details.upstream_status || error.details.upstream_error_code
    : null;
  const upstreamHint = upstream ? `（上游状态/错误码：${upstream}）` : '';
  console.error(`腾讯混元生图提交预检失败（${currentStage}）：${error.code || 'UNKNOWN'} ${error.message}${upstreamHint}`);
  process.exitCode = 1;
});
