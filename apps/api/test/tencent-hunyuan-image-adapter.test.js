'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AIART_IMAGE_VERSION, TencentHunyuanImageAdapter, createTencentHunyuanImageGeneratorFromEnvironment } = require('../src/providers/tencent-hunyuan-image-adapter');

const REFERENCE_URL = 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com/reference/role.png?sign=opaque';

test('腾讯混元图片适配器提交固定参考图任务（混元生图 3.0 / aiart），强制提示词扩写与 AIGC 显式标识', async () => {
  const calls = [];
  const adapter = new TencentHunyuanImageAdapter({ client: { async request(request) { calls.push(request); return { JobId: 'job-1', RequestId: 'request-1' }; } } });
  const result = await adapter.generate({ prompt: '夜晚的窗边，温柔微笑', referenceImageUrl: REFERENCE_URL, style: 'riman' });
  assert.deepEqual(result, { asset: { state: 'PENDING', provider_job_id: 'job-1', provider: 'tencent-hunyuan', aigc_logo_requested: true }, providerRequestId: 'request-1' });
  assert.deepEqual(calls[0], {
    service: 'aiart', action: 'SubmitTextToImageJob', version: AIART_IMAGE_VERSION,
    body: { Prompt: '夜晚的窗边，温柔微笑', Images: [REFERENCE_URL], Resolution: '768:1024', Revise: 1, LogoAdd: 1 }
  });
});

test('腾讯混元图片适配器可从用户确认的情境契约生成供应商提示词', async () => {
  const adapter = new TencentHunyuanImageAdapter({ client: { async request() { return { JobId: 'job-2', RequestId: 'request-2' }; } } });
  const result = await adapter.generateScene({
    character: { character_id: 'chr_1', name: '栖语' },
    referenceAsset: { asset_id: 'med_ref_1', type: 'REFERENCE_IMAGE', state: 'AVAILABLE', confirmation_state: 'USER_CONFIRMED' },
    confirmedAssets: [{ asset_id: 'ras_1', state: 'ACTIVE', display_text: '我们约好在雨天一起看电影' }],
    scene: { location: '电影院门口', outfit: '浅色风衣', time_of_day: 'EVENING', confirmed_event_asset_ids: ['ras_1'] },
    referenceImageUrl: REFERENCE_URL
  });
  assert.equal(result.sceneContract.reference_asset_id, 'med_ref_1');
  assert.match(result.sceneContract.prompt, /不添加未确认人物/);
});

test('腾讯混元图片适配器拒绝任意第三方参考图、空描述和超出参考图规格的分辨率', async () => {
  const adapter = new TencentHunyuanImageAdapter({ client: { async request() { throw new Error('must not call'); } } });
  await assert.rejects(() => adapter.generate({ prompt: '场景', referenceImageUrl: 'https://example.com/reference.png' }), (error) => error.code === 'TENCENT_HUNYUAN_REFERENCE_INVALID');
  await assert.rejects(() => adapter.generate({ prompt: ' ', referenceImageUrl: REFERENCE_URL }), (error) => error.code === 'TENCENT_HUNYUAN_PROMPT_INVALID');
  await assert.rejects(() => adapter.generate({ prompt: '场景', referenceImageUrl: REFERENCE_URL, resolution: '720:1280' }), (error) => error.code === 'TENCENT_HUNYUAN_RESOLUTION_INVALID');
});

test('腾讯混元图片适配器只将受控的短时供应商结果交给内部媒体流水线', async () => {
  const adapter = new TencentHunyuanImageAdapter({ client: { async request() { return { JobStatusCode: '5', RequestId: 'request-2', ResultImage: ['https://hyimg-1250000000.cos.ap-guangzhou.myqcloud.com/result.png?temporary=1'], RevisedPrompt: ['扩写后的描述'] }; } } });
  const result = await adapter.query({ providerJobId: 'job-1' });
  assert.deepEqual(result, { state: 'COMPLETED', providerRequestId: 'request-2', resultImageUrl: 'https://hyimg-1250000000.cos.ap-guangzhou.myqcloud.com/result.png?temporary=1', revisedPrompt: '扩写后的描述' });
});

test('腾讯混元图片适配器默认不开启，且工厂拒绝非广州地域', () => {
  assert.equal(createTencentHunyuanImageGeneratorFromEnvironment({}), null);
  assert.throws(() => createTencentHunyuanImageGeneratorFromEnvironment({ QIYU_IMAGE_PROVIDER: 'tencent-hunyuan', TENCENT_HUNYUAN_REGION: 'ap-shanghai' }), (error) => error.code === 'TENCENT_HUNYUAN_REGION_INVALID');
});
