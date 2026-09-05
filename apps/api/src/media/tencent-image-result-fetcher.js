'use strict';

const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
const RESULT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Hunyuan result URLs are provider-issued and short lived. This helper never
// accepts a caller-controlled URL and refuses redirects, unexpected MIME types
// and oversized payloads before a result can enter the private COS bucket.
async function fetchTencentGeneratedImage(resultImageUrl, { fetchImpl = globalThis.fetch } = {}) {
  if (!isTencentImageResultUrl(resultImageUrl)) throw invalidResult('图片结果地址无效');
  if (typeof fetchImpl !== 'function') throw invalidResult('图片结果下载器不可用');
  const response = await fetchImpl(resultImageUrl, { method: 'GET', redirect: 'error' });
  if (!response || !response.ok) throw invalidResult('图片结果下载失败');
  const mimeType = normalizeMimeType(response.headers && response.headers.get('content-type'));
  if (!RESULT_MIME_TYPES.has(mimeType)) throw invalidResult('图片结果格式不受支持');
  const declaredLength = Number(response.headers && response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && (declaredLength <= 0 || declaredLength > MAX_GENERATED_IMAGE_BYTES)) throw invalidResult('图片结果超过大小限制');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) throw invalidResult('图片结果超过大小限制');
  return Object.freeze({ bytes, mimeType });
}

function isTencentImageResultUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)cos\.ap-guangzhou\.myqcloud\.com$/i.test(url.hostname);
  } catch { return false; }
}
function normalizeMimeType(value) { return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''; }
function invalidResult(message) { const error = new Error(message); error.code = 'TENCENT_IMAGE_RESULT_INVALID'; return error; }

module.exports = { MAX_GENERATED_IMAGE_BYTES, RESULT_MIME_TYPES, fetchTencentGeneratedImage, isTencentImageResultUrl };
