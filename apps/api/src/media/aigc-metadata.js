'use strict';

// AIGC 隐式标识（SAFE-04/SAFE-10）：在交付的 AI 生成音频文件前写入 ID3v2.3
// TXXX 私有帧与 COMM 注释帧。标识不可由下载链路移除；此处只覆盖本地开发
// 交付的字节流，供应商/CDN/转码链路的标识保持属生产化范围。
const AIGC_LABEL = 'AI-generated-content (qiyu)';

function tagWithAigcMetadata(mp3Bytes) {
  if (!Buffer.isBuffer(mp3Bytes) || mp3Bytes.length === 0) throw new TypeError('mp3Bytes must be a non-empty Buffer');
  if (mp3Bytes.subarray(0, 3).toString('latin1') === 'ID3') return mp3Bytes; // 已带标签则不重复写入
  const tag = id3v23Tag([txxxFrame('qiyu_aigc', 'AI_GENERATED'), commFrame(AIGC_LABEL)]);
  return Buffer.concat([tag, mp3Bytes]);
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

module.exports = { AIGC_LABEL, tagWithAigcMetadata };
