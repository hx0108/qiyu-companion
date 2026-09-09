'use strict';

// 腾讯 ASR 供应商探针：用同一受控腾讯标准音色生成固定短句，再提交给 ASR。
// 不创建账户、会话、媒体资产或权益记录；控制台只输出脱敏验收元数据。
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { extname } = require('node:path');
const { createTencentAsrTranscriberFromEnvironment } = require('../src/providers/tencent-asr-adapter');
const { createTencentTtsGeneratorFromEnvironment } = require('../src/providers/tencent-tts-adapter');

const TEST_TEXT = '你好，这是栖语语音识别功能验收。';

async function main() {
  const required = ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION'];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is required.`);
  }
  if (process.env.QIYU_ASR_PROVIDER !== 'tencent') throw new Error('QIYU_ASR_PROVIDER=tencent is required.');
  const asr = createTencentAsrTranscriberFromEnvironment(process.env);
  if (typeof asr !== 'function') throw new Error('Tencent ASR adapter must be enabled.');

  const suppliedAudioPath = process.env.QIYU_ASR_PROBE_AUDIO_FILE;
  let audio;
  let tts = null;
  if (suppliedAudioPath) {
    if (extname(suppliedAudioPath).toLowerCase() !== '.wav') throw new Error('QIYU_ASR_PROBE_AUDIO_FILE must point to a WAV file.');
    const bytes = readFileSync(suppliedAudioPath);
    audio = { bytes, mimeType: 'audio/wav', byteLength: bytes.length, source: 'LOCAL_CONTROLLED_WAV' };
  } else {
    const ttsRequired = ['TENCENT_TTS_VOICE_TYPE', 'TENCENT_TTS_VOICE_VERSION', 'TENCENT_TTS_AUTHORIZATION_RECORD_ID', 'TENCENT_TTS_RIGHTS_REVIEW_ID'];
    for (const name of ttsRequired) if (!process.env[name]) throw new Error(`${name} is required for the TTS input mode.`);
    if (process.env.QIYU_TTS_PROVIDER !== 'tencent') throw new Error('QIYU_TTS_PROVIDER=tencent is required for the controlled test input.');
    tts = createTencentTtsGeneratorFromEnvironment(process.env);
    if (typeof tts !== 'function') throw new Error('Tencent TTS adapter must be enabled.');
    const speech = await tts({ text: TEST_TEXT, sessionId: `asr_probe_${randomUUID().replace(/-/g, '')}` });
    audio = { ...speech.asset, source: 'TENCENT_TTS_CONTROLLED_TEXT' };
  }
  const transcript = await asr({ bytes: audio.bytes, mimeType: audio.mimeType, sessionId: `asr_probe_${randomUUID().replace(/-/g, '')}` });
  if (typeof transcript.text !== 'string' || transcript.text.trim().length === 0) {
    throw new Error('Tencent ASR returned an empty transcript.');
  }

  console.log(JSON.stringify({
    acceptance: 'passed',
    input_source: audio.source,
    tts_provider: tts?.provider ?? null,
    tts_model_version: tts?.modelVersion ?? null,
    asr_provider: asr.provider,
    asr_model_version: asr.modelVersion,
    audio_bytes: audio.byteLength,
    transcript_characters: Array.from(transcript.text.trim()).length
  }));
}

main().catch((error) => {
  console.error(`腾讯 ASR 供应商验收失败：${error.message}`);
  process.exitCode = 1;
});
