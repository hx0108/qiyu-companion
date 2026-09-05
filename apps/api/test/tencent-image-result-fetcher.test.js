'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchTencentGeneratedImage } = require('../src/media/tencent-image-result-fetcher');

const url = 'https://result-1250000000.cos.ap-guangzhou.myqcloud.com/qiyu/result.png?signature=opaque';

test('只下载腾讯广州 COS 的受控生图结果，并验证 MIME 和大小', async () => {
  const result = await fetchTencentGeneratedImage(url, { fetchImpl: async (requestedUrl, options) => {
    assert.equal(requestedUrl, url);
    assert.deepEqual(options, { method: 'GET', redirect: 'error' });
    return response({ bytes: Buffer.from('png'), mimeType: 'image/png', contentLength: '3' });
  } });
  assert.deepEqual(result, { bytes: Buffer.from('png'), mimeType: 'image/png' });
});

test('拒绝任意地址、跳转后的响应、不支持类型和超限结果', async () => {
  await assert.rejects(() => fetchTencentGeneratedImage('https://example.com/image.png'), (error) => error.code === 'TENCENT_IMAGE_RESULT_INVALID');
  await assert.rejects(() => fetchTencentGeneratedImage(url, { fetchImpl: async () => response({ bytes: Buffer.from('gif'), mimeType: 'image/gif' }) }), /格式/);
  await assert.rejects(() => fetchTencentGeneratedImage(url, { fetchImpl: async () => response({ bytes: Buffer.alloc(10 * 1024 * 1024 + 1), mimeType: 'image/png' }) }), /大小/);
  await assert.rejects(() => fetchTencentGeneratedImage(url, { fetchImpl: async () => ({ ok: false, headers: { get() { return null; } } }) }), /下载失败/);
});

function response({ bytes, mimeType, contentLength }) {
  return { ok: true, headers: { get(name) { return name === 'content-type' ? mimeType : name === 'content-length' ? (contentLength || null) : null; } }, async arrayBuffer() { return bytes; } };
}
