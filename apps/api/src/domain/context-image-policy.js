'use strict';

// 8MB 兜底上限：前端会把聊天图片降采样到 <1MB 再上传；这里放宽到 8MB 是
// 为了浏览器不支持降采样时手机照片（3-5MB）仍可直传（2026-09-13）。
const MAX_CONTEXT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_IMAGE_PIXELS = 16_000_000;

class ContextImageError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400; this.expose = true; }
}

function inspectContextImage(bytes, declaredMimeType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CONTEXT_IMAGE_BYTES) fail('CONTEXT_IMAGE_SIZE_INVALID', '图片为空或超过 8MB');
  let actualMimeType;
  let width;
  let height;
  let animated = false;
  let metadataPresent = false;
  if (isPng(bytes)) {
    actualMimeType = 'image/png';
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('CONTEXT_IMAGE_CORRUPT', 'PNG 图片损坏');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let hasEnd = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) fail('CONTEXT_IMAGE_CORRUPT', 'PNG 图片损坏');
      if (type === 'acTL') animated = true;
      if (['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(type)) metadataPresent = true;
      offset += 12 + length;
      if (type === 'IEND') { hasEnd = true; break; }
    }
    if (!hasEnd) fail('CONTEXT_IMAGE_CORRUPT', 'PNG 图片损坏');
  } else if (isJpeg(bytes)) {
    actualMimeType = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) fail('CONTEXT_IMAGE_CORRUPT', 'JPEG 图片损坏');
      if (marker === 0xe1 || marker === 0xed) metadataPresent = true;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) fail('CONTEXT_IMAGE_CORRUPT', 'JPEG 图片损坏');
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7);
      }
      offset += 2 + length;
    }
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) fail('CONTEXT_IMAGE_CORRUPT', 'JPEG 图片损坏');
  } else if (isWebp(bytes)) {
    actualMimeType = 'image/webp';
    if (bytes.readUInt32LE(4) !== bytes.length - 8) fail('CONTEXT_IMAGE_CORRUPT', 'WebP 图片损坏');
    animated = bytes.includes(Buffer.from('ANIM')) || bytes.includes(Buffer.from('ANMF'));
    metadataPresent = bytes.includes(Buffer.from('EXIF')) || bytes.includes(Buffer.from('XMP '));
    if (bytes.toString('ascii', 12, 16) === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    }
  } else fail('CONTEXT_IMAGE_SIGNATURE_MISMATCH', '文件内容不是受支持的图片');
  if (actualMimeType !== declaredMimeType) fail('CONTEXT_IMAGE_SIGNATURE_MISMATCH', '图片扩展名或 MIME 与文件内容不一致');
  if (animated) fail('CONTEXT_IMAGE_ANIMATION_NOT_ALLOWED', '暂不支持动画图片');
  if (!width || !height || width * height > MAX_CONTEXT_IMAGE_PIXELS) fail('CONTEXT_IMAGE_DIMENSIONS_INVALID', '图片尺寸无效或像素过大');
  // Storage receives the validated original. Metadata removal is a separate hard
  // gate: uploads carrying EXIF/XMP are rejected so GPS can never be persisted.
  if (metadataPresent) fail('CONTEXT_IMAGE_METADATA_NOT_ALLOWED', '图片包含 EXIF/XMP 等元数据，请移除后重试');
  return Object.freeze({ bytes, mimeType: actualMimeType, width, height, metadataStripped: true });
}

function isPng(b) { return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])); }
function isJpeg(b) { return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8; }
function isWebp(b) { return b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'; }
function fail(code, message) { throw new ContextImageError(code, message); }

module.exports = { inspectContextImage, MAX_CONTEXT_IMAGE_BYTES, MAX_CONTEXT_IMAGE_PIXELS, ContextImageError };
