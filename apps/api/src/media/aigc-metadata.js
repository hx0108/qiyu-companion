'use strict';

// AIGC 隐式标识（SAFE-04/SAFE-10，P1-7 扩展到图片与导出）：
//   音频（MP3）：ID3v2.3 TXXX 私有帧 + COMM 注释帧；
//   图片 PNG：IHDR 后插入 tEXt 块 qiyu_aigc=AI_GENERATED；
//   图片 JPEG：SOI 后插入 COM 段；
//   图片 WebP：RIFF 容器无轻量可写注释位，开发链路不写入（如实标注）。
// 标识在交付（下载）时注入，不可由下载链路移除；供应商/CDN/转码链路的
// 标识保持与显式水印（像素级）属生产化范围。
const { crc32 } = require('node:zlib');

const AIGC_LABEL = 'AI-generated-content (qiyu)';
const AIGC_MARK_VERSION_AUDIO = 'qiyu-aigc-id3v2.3-v1';
const AIGC_MARK_VERSION_IMAGE = 'qiyu-aigc-image-metadata-v1';

function tagWithAigcMetadata(mp3Bytes) {
  if (!Buffer.isBuffer(mp3Bytes) || mp3Bytes.length === 0) throw new TypeError('mp3Bytes must be a non-empty Buffer');
  if (mp3Bytes.subarray(0, 3).toString('latin1') === 'ID3') return mp3Bytes; // 已带标签则不重复写入
  const tag = id3v23Tag([txxxFrame('qiyu_aigc', 'AI_GENERATED'), commFrame(AIGC_LABEL)]);
  return Buffer.concat([tag, mp3Bytes]);
}

// PNG：8 字节签名 + IHDR 块之后插入 tEXt。已在任意位置带 qiyu_aigc tEXt 的不重复写。
function tagPngWithAigcMetadata(pngBytes) {
  if (!Buffer.isBuffer(pngBytes) || pngBytes.length < 33) throw new TypeError('pngBytes must be a non-empty PNG Buffer');
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!pngBytes.subarray(0, 8).equals(signature)) throw new TypeError('not a PNG buffer');
  if (pngBytes.includes(Buffer.from('qiyu_aigc'))) return pngBytes;
  const textChunk = pngChunk('tEXt', Buffer.from(`qiyu_aigc\u0000AI_GENERATED (${AIGC_LABEL})`, 'latin1'));
  // IHDR 固定为第一个块：签名(8) + 长度(4) + 'IHDR'(4) + 数据(13) + CRC(4) = 33。
  return Buffer.concat([pngBytes.subarray(0, 33), textChunk, pngBytes.subarray(33)]);
}

// JPEG：SOI（FFD8）后插入 COM 段（FFFE）。已带 qiyu_aigc 注释的不重复写。
function tagJpegWithAigcMetadata(jpegBytes) {
  if (!Buffer.isBuffer(jpegBytes) || jpegBytes.length < 4) throw new TypeError('jpegBytes must be a non-empty JPEG Buffer');
  if (jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) throw new TypeError('not a JPEG buffer');
  if (jpegBytes.includes(Buffer.from('qiyu_aigc'))) return jpegBytes;
  const comment = Buffer.from(`qiyu_aigc=AI_GENERATED (${AIGC_LABEL})`, 'latin1');
  const segment = Buffer.alloc(4 + comment.length);
  segment[0] = 0xff; segment[1] = 0xfe; // COM
  segment.writeUInt16BE(comment.length + 2, 2);
  comment.copy(segment, 4);
  return Buffer.concat([jpegBytes.subarray(0, 2), segment, jpegBytes.subarray(2)]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function id3v23Tag(frames) {
  const body = Buffer.concat(frames);
  const size = body.length;
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3; header[4] = 0; header[5] = 0; // v2.3, 无标志
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return Buffer.concat([header, body]);
}

function frameHeader(id, size) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header[4] = (size >> 24) & 0xff; header[5] = (size >> 16) & 0xff;
  header[6] = (size >> 8) & 0xff; header[7] = size & 0xff;
  header[8] = 0; header[9] = 0; // 无标志
  return header;
}

// ID3v2.3 文本编码 0x01 = UTF-16 with BOM。
function utf16WithBom(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function txxxFrame(description, value) {
  const payload = Buffer.concat([Buffer.from([0x01]), utf16WithBom(description), Buffer.from([0x00, 0x00]), utf16WithBom(value)]);
  return Buffer.concat([frameHeader('TXXX', payload.length), payload]);
}

function commFrame(text) {
  const payload = Buffer.concat([Buffer.from([0x01]), Buffer.from('eng', 'latin1'), Buffer.from([0x00, 0x00]), utf16WithBom(text)]);
  return Buffer.concat([frameHeader('COMM', payload.length), payload]);
}

module.exports = { AIGC_LABEL, AIGC_MARK_VERSION_AUDIO, AIGC_MARK_VERSION_IMAGE, tagWithAigcMetadata, tagPngWithAigcMetadata, tagJpegWithAigcMetadata };
