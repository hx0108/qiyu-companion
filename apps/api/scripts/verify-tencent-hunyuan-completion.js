'use strict';

// 受控的腾讯图片闭环验收：固定无人物参考图 -> IMS -> 混元提交/轮询 ->
// 下载供应商短链结果 -> 私有 COS -> IMS 二审。所有探针对象在 finally 删除，
// 因而不创建用户、角色、关系资产或可在前端展示的长期内容。
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');
const { createTencentImageModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
const { createTencentHunyuanImageGeneratorFromEnvironment } = require('../src/providers/tencent-hunyuan-image-adapter');
const { fetchTencentGeneratedImage } = require('../src/media/tencent-image-result-fetcher');
const { createControlledPng } = require('./controlled-probe-png');

const CONTROLLED_PNG = createControlledPng();
const PROMPT = '一张温暖的浅米色室内窗边插画，无人物，无文字，无标识，柔和自然光。';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 180000;

async function main(environment = process.env) {
  const configured = { ...environment, TENCENT_HUNYUAN_REGION: environment.TENCENT_HUNYUAN_REGION || environment.TENCENT_REGION || 'ap-guangzhou' };
  requireConfigured(configured);
  const imageStore = createTencentCosPrivateImageStoreFromEnvironment(configured);
  const moderateImage = createTencentImageModeratorFromEnvironment(configured);
  const imageGenerator = createTencentHunyuanImageGeneratorFromEnvironment(configured);
  if (!imageStore || typeof moderateImage !== 'function' || !imageGenerator) throw new Error('Tencent COS, IMS and Hunyuan image providers must all be enabled.');

  const probeId = `hyfull${randomUUID().replace(/-/g, '')}`;
  let reference = null;
  let generated = null;
  try {
    reference = await imageStore.putImage({ assetId: `${probeId}ref`, bytes: CONTROLLED_PNG, mimeType: 'image/png' });
    const referenceReview = await moderateImage({ fileUrl: await imageStore.createModerationUrl(reference.objectKey), dataId: `${probeId}-reference` });
    if (referenceReview.decision !== 'PASS') throw new Error(`IMS did not pass the controlled reference image: ${referenceReview.decision}`);
    const submitted = await imageGenerator.generate({ prompt: PROMPT, referenceImageUrl: await imageStore.createModerationUrl(reference.objectKey), resolution: '768:768' });
    const completed = await waitForCompletion(imageGenerator, submitted.asset.provider_job_id);
    const downloaded = await fetchTencentGeneratedImage(completed.resultImageUrl);
    generated = await imageStore.putImage({ assetId: `${probeId}out`, bytes: downloaded.bytes, mimeType: downloaded.mimeType });
    const outputReview = await moderateImage({ fileUrl: await imageStore.createModerationUrl(generated.objectKey), dataId: `${probeId}-output` });
    if (outputReview.decision !== 'PASS') throw new Error(`IMS did not pass the generated image: ${outputReview.decision}`);
    const result = {
      acceptance: 'passed', provider: 'tencent-hunyuan', model_version: imageGenerator.modelVersion,
      provider_job_state: completed.state, reference_moderation: referenceReview.decision,
      output_moderation: outputReview.decision, private_cos_bytes: generated.byteLength,
      aigc_logo_requested: true, cleanup: 'scheduled'
    };
    writeAcceptance(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await Promise.all([generated, reference].filter(Boolean).map((asset) => imageStore.deleteAsset(asset.objectKey).catch(() => undefined)));
  }
}

function writeAcceptance(result) {
  const outputDir = path.resolve(__dirname, '../../../development/eval');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `tencent-hunyuan-completion-${new Date().toISOString().slice(0, 10)}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function waitForCompletion(imageGenerator, providerJobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await imageGenerator.query({ providerJobId });
    if (status.state === 'COMPLETED') return status;
    if (status.state === 'FAILED') throw new Error(`Hunyuan job failed: ${status.failureCode || 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Hunyuan job did not complete within ${POLL_TIMEOUT_MS / 1000}s`);
}

function requireConfigured(environment) {
  for (const name of ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION', 'TENCENT_COS_ENDPOINT', 'TENCENT_IMAGE_MODERATION_BIZ_TYPE']) {
    if (!environment[name]) throw new Error(`${name} is required.`);
  }
  if (environment.QIYU_IMAGE_PROVIDER !== 'tencent-hunyuan') throw new Error('QIYU_IMAGE_PROVIDER=tencent-hunyuan is required.');
  if (environment.QIYU_IMAGE_MODERATION_PROVIDER !== 'tencent') throw new Error('QIYU_IMAGE_MODERATION_PROVIDER=tencent is required.');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`腾讯混元图片闭环验收失败：${error.code || 'UNKNOWN'} ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, waitForCompletion };
