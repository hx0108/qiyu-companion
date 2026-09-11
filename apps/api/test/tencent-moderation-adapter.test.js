'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TencentModerationAdapter, createTencentImageModeratorFromEnvironment, createTencentTextModeratorFromEnvironment, isApprovedMediaUrl } = require('../src/providers/tencent-moderation-adapter');

test('文本审核适配器以 base64 传递文本、透出 Label/Score，且不传 SessionId（腾讯误判坑）', async () => {
  let request;
  const adapter = new TencentModerationAdapter({ client: { request: async (input) => { request = input; return { Suggestion: 'Review', Label: 'Ad', Score: 75, RequestId: 'req_review' }; } }, textBizType: 'qiyu_text_v1' });
  const result = await adapter.moderateText({ text: '中文内容', dataId: 'msg-a' });
  assert.equal(result.decision, 'REVIEW');
  assert.equal(result.label, 'Ad');
  assert.equal(result.score, 75);
  assert.equal(result.providerRequestId, 'req_review');
  assert.equal(request.service, 'tms');
  assert.equal(Buffer.from(request.body.Content, 'base64').toString('utf8'), '中文内容');
  assert.equal(request.body.BizType, 'qiyu_text_v1');
  // 2026-09-12 线上事故：传 SessionId（会话 UUID）会让普通问句被腾讯误判为
  // Ad Review，用户完全无法对话。该字段从此不再发送。
  assert.equal('SessionId' in request.body, false);
});

test('图片审核只接受受控 COS 地址，环境开关默认不创建真实审核器', async () => {
  assert.equal(isApprovedMediaUrl('https://bucket-1.cos.ap-guangzhou.myqcloud.com/object.png'), true);
  assert.equal(isApprovedMediaUrl('https://untrusted.example/object.png'), false);
  assert.equal(createTencentTextModeratorFromEnvironment({}), null);
  assert.equal(createTencentImageModeratorFromEnvironment({}), null);
  assert.throws(() => createTencentTextModeratorFromEnvironment({ QIYU_TEXT_MODERATION_PROVIDER: 'tencent' }), (error) => error.code === 'TENCENT_CREDENTIAL_REQUIRED');
});

test('图片审核工厂仅在显式开关下创建，并保留 IMS 策略和受控 COS 地址约束', async () => {
  const calls = [];
  const imageModerator = createTencentImageModeratorFromEnvironment({
    QIYU_IMAGE_MODERATION_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key', TENCENT_REGION: 'ap-guangzhou', TENCENT_IMAGE_MODERATION_BIZ_TYPE: 'qiyu_image_v1'
  }, { fetchImpl: async (_url, request) => {
    calls.push(JSON.parse(request.body));
    return { ok: true, async json() { return { Response: { Suggestion: 'Pass', RequestId: 'ims_req_1' } }; } };
  }, now: () => new Date('2026-09-04T00:00:00.000Z') });
  const result = await imageModerator({ fileUrl: 'https://qiyu-1250000000.cos.ap-guangzhou.myqcloud.com/image.png?opaque=1', dataId: 'reference-med_1' });
  assert.equal(result.decision, 'PASS');
  assert.equal(calls[0].BizType, 'qiyu_image_v1');
});
