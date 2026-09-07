'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TencentTc3Client, TencentProviderError } = require('../src/providers/tencent-tc3-client');

test('TC3 客户端仅请求允许的腾讯云主机，并按 TC3 头签名', async () => {
  let captured;
  const client = new TencentTc3Client({
    secretId: 'AKIDexample', secretKey: 'secret-key-must-not-be-logged', region: 'ap-guangzhou',
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ Response: { RequestId: 'req_tencent_1', Suggestion: 'Pass' } }) };
    }
  });
  const response = await client.request({ service: 'tms', action: 'TextModeration', version: '2020-12-29', body: { Content: 'Zm9v' } });
  assert.equal(response.RequestId, 'req_tencent_1');
  assert.equal(captured.url, 'https://tms.tencentcloudapi.com');
  assert.equal(captured.options.headers['x-tc-action'], 'TextModeration');
  assert.equal(captured.options.headers['x-tc-region'], 'ap-guangzhou');
  assert.equal(captured.options.headers['x-tc-timestamp'], '1788393600');
  assert.match(captured.options.headers.authorization, /^TC3-HMAC-SHA256 Credential=AKIDexample\/2026-09-03\/tms\/tc3_request,/);
  assert.doesNotMatch(JSON.stringify({ url: captured.url, body: captured.options.body, headers: { host: captured.options.headers.host, action: captured.options.headers['x-tc-action'] } }), /secret-key-must-not-be-logged/);
  await assert.rejects(() => client.request({ service: 'cvm', action: 'DescribeInstances', version: '2017-03-12', body: {} }), (error) => error instanceof TencentProviderError && error.code === 'TENCENT_SERVICE_NOT_ALLOWED');
});

test('腾讯云非成功状态与网络失败都不暴露上游正文', async () => {
  const rejected = new TencentTc3Client({ secretId: 'id', secretKey: 'key', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(() => rejected.request({ service: 'tms', action: 'TextModeration', version: '2020-12-29', body: {} }), (error) => error.code === 'TENCENT_UPSTREAM_REJECTED' && error.retryable === true && error.details.upstream_status === 429);
  const network = new TencentTc3Client({ secretId: 'id', secretKey: 'key', fetchImpl: async () => { throw new Error('contains upstream response body'); } });
  await assert.rejects(
    () => network.request({ service: 'tms', action: 'TextModeration', version: '2020-12-29', body: {} }),
    (error) => error.code === 'TENCENT_NETWORK_ERROR' && error.message === '腾讯云服务网络请求失败，请稍后重试' && !error.message.includes('upstream response body')
  );
});

test('腾讯云 API 错误仅保留安全格式的错误码，不保留上游正文', async () => {
  const rejected = new TencentTc3Client({
    secretId: 'id', secretKey: 'key',
    fetchImpl: async () => ({ ok: true, json: async () => ({ Response: { Error: { Code: 'FailedOperation.ServiceNotOpened', Message: 'upstream details must not be retained' } } }) })
  });
  await assert.rejects(
    () => rejected.request({ service: 'tts', action: 'TextToVoice', version: '2019-08-23', body: {} }),
    (error) => error.code === 'TENCENT_UPSTREAM_REJECTED' && error.details.upstream_error_code === 'FailedOperation.ServiceNotOpened' && !error.message.includes('upstream details')
  );
});
