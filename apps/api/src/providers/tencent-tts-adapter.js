'use strict';

const { createHmac } = require('node:crypto');
const { assertAdapterResult } = require('../production/adapter-contracts');
const { TencentTc3Client, TencentProviderError } = require('./tencent-tc3-client');

const TTS_VERSION = '2019-08-23';
const MAX_TTS_TEXT_LENGTH = 300;
const MAX_STREAM_TTS_TEXT_LENGTH = 600;

class TencentTtsAdapter {
  constructor({ client, voiceType, modelType = 1, codec = 'mp3', sampleRate = 16000 } = {}) {
    if (!client || typeof client.request !== 'function') throw new TypeError('TencentTtsAdapter requires a Tencent TC3 client');
    if (!positiveInteger(voiceType)) throw new TencentProviderError('TENCENT_TTS_VOICE_TYPE_REQUIRED', '腾讯云 TTS 音色未配置', 500);
    if (!positiveInteger(modelType) || codec !== 'mp3' || ![8000, 16000, 24000].includes(Number(sampleRate))) {
      throw new TencentProviderError('TENCENT_TTS_CONFIGURATION_INVALID', '腾讯云 TTS 配置无效', 500);
    }
    this.client = client;
    this.voiceType = Number(voiceType);
    this.modelType = Number(modelType);
    this.codec = codec;
    this.sampleRate = Number(sampleRate);
  }

  async synthesize({ text, sessionId }) {
    if (!nonBlank(text) || text.trim().length > MAX_TTS_TEXT_LENGTH) {
      throw new TencentProviderError('TENCENT_TTS_TEXT_INVALID', `语音文本必须为 1-${MAX_TTS_TEXT_LENGTH} 个字符`, 400);
    }
    const response = await this.client.request({
      service: 'tts', action: 'TextToVoice', version: TTS_VERSION,
      body: { Text: text.trim(), SessionId: safeSessionId(sessionId), ModelType: this.modelType, VoiceType: this.voiceType, Codec: this.codec, SampleRate: this.sampleRate, Speed: 0, Volume: 0, EnableSubtitle: false }
    });
    if (!nonBlank(response.Audio) || !nonBlank(response.RequestId)) throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 未返回音频', 502);
    let bytes;
    try { bytes = Buffer.from(response.Audio, 'base64'); } catch { throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 音频格式无效', 502); }
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 音频大小无效', 502);
    return assertAdapterResult('TTS', { asset: { bytes, mimeType: 'audio/mpeg', byteLength: bytes.length }, providerRequestId: response.RequestId });
  }
}

// 腾讯云“实时语音合成”（TextToStreamAudioWS，WebSocket）：情感参数
// EmotionCategory/EmotionIntensity 只存在于该接口，基础版 TextToVoice 没有。
// 协议：全部请求参数在 URL 查询串上（含签名）；text 帧为 JSON 状态（code/final），
// binary 帧为音频分片；final=1 后由客户端主动断开。
const STREAM_WS_ORIGIN = 'GETtts.cloud.tencent.com/stream_ws?';
const STREAM_WS_URL = 'wss://tts.cloud.tencent.com/stream_ws?';
const STREAM_SIGNATURE_TTL_SECONDS = 300;

class TencentStreamTtsAdapter {
  constructor({ secretId, secretKey, appId, voiceType, codec = 'mp3', sampleRate = 16000, wsFactory, timeoutMs = 30000, now = () => new Date() } = {}) {
    if (!nonBlank(secretId) || !nonBlank(secretKey)) throw new TencentProviderError('TENCENT_CREDENTIAL_REQUIRED', '腾讯云凭据未配置', 500);
    if (!Number.isInteger(Number(appId)) || Number(appId) <= 0) throw new TencentProviderError('TENCENT_TTS_APP_ID_REQUIRED', '实时语音合成需要账号 AppId（整数）', 500);
    if (!positiveInteger(voiceType)) throw new TencentProviderError('TENCENT_TTS_VOICE_TYPE_REQUIRED', '腾讯云 TTS 音色未配置', 500);
    if (codec !== 'mp3' || ![8000, 16000, 24000].includes(Number(sampleRate))) {
      throw new TencentProviderError('TENCENT_TTS_CONFIGURATION_INVALID', '腾讯云 TTS 配置无效', 500);
    }
    if (typeof wsFactory !== 'function') {
      if (typeof globalThis.WebSocket !== 'function') throw new TencentProviderError('TENCENT_TTS_WS_UNAVAILABLE', '当前运行时没有可用的 WebSocket 实现', 500);
      wsFactory = (url) => new globalThis.WebSocket(url);
    }
    this.secretId = secretId;
    this.secretKey = secretKey;
    this.appId = Number(appId);
    this.voiceType = Number(voiceType);
    this.codec = codec;
    this.sampleRate = Number(sampleRate);
    this.wsFactory = wsFactory;
    this.timeoutMs = positiveTimeout(timeoutMs);
    this.now = now;
  }

  async synthesize({ text, sessionId, emotion, intensity, speed } = {}) {
    if (!nonBlank(text) || text.trim().length > MAX_STREAM_TTS_TEXT_LENGTH) {
      throw new TencentProviderError('TENCENT_TTS_TEXT_INVALID', `语音文本必须为 1-${MAX_STREAM_TTS_TEXT_LENGTH} 个字符`, 400);
    }
    const normalizedEmotion = normalizeStreamEmotion({ emotion, intensity, speed });
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const params = {
      Action: 'TextToStreamAudioWS',
      AppId: this.appId,
      SecretId: this.secretId,
      Timestamp: timestamp,
      Expired: timestamp + STREAM_SIGNATURE_TTL_SECONDS,
      SessionId: safeSessionId(sessionId),
      Text: text.trim(),
      VoiceType: this.voiceType,
      Codec: this.codec,
      SampleRate: this.sampleRate,
      Volume: 0,
      ...(normalizedEmotion ?? {}),
    };
    const socket = this.wsFactory(buildSignedStreamUrl(this.secretKey, params));
    // 二进制帧直接拿 ArrayBuffer，避免 undici 默认 Blob 再转一次；
    // 仍兼容注入实现返回 Blob/Buffer 的情况。
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer';
    return await receiveStreamAudio(socket, this.timeoutMs, params.SessionId);
  }
}

function buildSignedStreamUrl(secretKey, params) {
  // 签名原文用参数原始值（Text 不编码）；按 key 字典序拼接后 HMAC-SHA1，
  // 最终 URL 才对 Text 与 Signature 做 urlencode（文档明确要求）。
  const sorted = Object.keys(params).sort();
  const rawQuery = sorted.map((key) => `${key}=${params[key]}`).join('&');
  const signature = createHmac('sha1', secretKey).update(STREAM_WS_ORIGIN + rawQuery).digest('base64');
  const encodedQuery = sorted.map((key) => `${key}=${encodeURIComponent(String(params[key]))}`).join('&');
  return `${STREAM_WS_URL}${encodedQuery}&Signature=${encodeURIComponent(signature)}`;
}

function normalizeStreamEmotion({ emotion, intensity, speed } = {}) {
  if (emotion === undefined || emotion === null || emotion === '') return null;
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(String(emotion))) {
    throw new TencentProviderError('TENCENT_TTS_EMOTION_INVALID', '情感参数必须是实时合成接口的小写枚举值', 400);
  }
  const normalized = { EmotionCategory: String(emotion) };
  if (intensity !== undefined && intensity !== null) {
    if (!Number.isInteger(Number(intensity)) || Number(intensity) < 50 || Number(intensity) > 200) {
      throw new TencentProviderError('TENCENT_TTS_EMOTION_INVALID', '情感强度必须在 50-200 之间', 400);
    }
    normalized.EmotionIntensity = Number(intensity);
  }
  if (speed !== undefined && speed !== null) {
    if (!Number.isFinite(Number(speed)) || Number(speed) < -2 || Number(speed) > 6) {
      throw new TencentProviderError('TENCENT_TTS_SPEED_INVALID', '语速必须在 -2 到 6 之间', 400);
    }
    normalized.Speed = Number(speed);
  }
  return normalized;
}

async function receiveStreamAudio(socket, timeoutMs, fallbackRequestId) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let requestId = null;
    let processing = Promise.resolve();
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* 已断开时忽略。 */ }
      fn(arg);
    };
    const fail = (error) => finish(reject, error);
    const timer = setTimeout(() => {
      fail(new TencentProviderError('TENCENT_TTS_STREAM_TIMEOUT', '实时语音合成超时', 502, {}, true));
    }, timeoutMs);
    socket.onmessage = (event) => {
      // Blob→ArrayBuffer 是异步的；必须串行处理，否则 final 帧可能抢在
      // 还在转换的音频分片之前到达，返回不完整音频。
      processing = processing.then(() => handleStreamFrame(event.data)).catch(fail);
    };
    const handleStreamFrame = async (data) => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data);
        if (frame.code !== 0) throw streamFrameError(frame);
        if (typeof frame.request_id === 'string' && frame.request_id) requestId = frame.request_id;
        if (frame.final === 1) {
          if (chunks.length === 0) throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '腾讯云 TTS 未返回音频', 502);
          const bytes = Buffer.concat(chunks);
          finish(resolve, assertAdapterResult('TTS', { asset: { bytes, mimeType: 'audio/mpeg', byteLength: bytes.length }, providerRequestId: requestId || fallbackRequestId }));
        }
        return;
      }
      chunks.push(await toBuffer(data));
    };
    socket.onerror = () => fail(new TencentProviderError('TENCENT_TTS_STREAM_CONNECTION_FAILED', '实时语音合成连接中断', 502, {}, true));
    socket.onclose = () => {
      if (!settled) fail(new TencentProviderError('TENCENT_TTS_STREAM_CONNECTION_FAILED', '实时语音合成连接提前关闭', 502, {}, true));
    };
  });
}

function streamFrameError(frame) {
  const upstream = String(frame.code);
  const known = {
    10001: ['TENCENT_TTS_STREAM_PARAM_INVALID', 400, false],
    10002: ['TENCENT_TTS_STREAM_CONCURRENCY_LIMIT', 502, true],
    10003: ['TENCENT_TTS_STREAM_AUTH_FAILED', 500, false],
  }[upstream] ?? ['TENCENT_TTS_STREAM_FAILED', 502, true];
  return new TencentProviderError(known[0], `实时语音合成失败：${frame.message || upstream}`, known[1], { upstream_error_code: upstream }, known[2]);
}

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data?.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer()); // undici Blob
  throw new TencentProviderError('TENCENT_TTS_RESPONSE_INVALID', '实时语音合成返回了未知音频帧类型', 502);
}

function positiveTimeout(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30000;
}

function createTencentTtsGeneratorFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_TTS_PROVIDER !== 'tencent') return null;
  // stream = 实时合成（WebSocket，带情感参数）；缺 AppId 必须显式失败，
  // 静默回退 basic 会让“情感语音已上线”成为假象。
  const adapter = environment.TENCENT_TTS_API_MODE === 'stream'
    ? new TencentStreamTtsAdapter({
        secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY,
        appId: environment.TENCENT_TTS_APP_ID, voiceType: environment.TENCENT_TTS_VOICE_TYPE,
        codec: 'mp3', sampleRate: environment.TENCENT_TTS_SAMPLE_RATE || 16000,
        wsFactory: dependencies.wsFactory, timeoutMs: environment.TENCENT_TTS_TIMEOUT_MS, now: dependencies.now,
      })
    : new TencentTtsAdapter({
        client: new TencentTc3Client({ secretId: environment.TENCENT_SECRET_ID, secretKey: environment.TENCENT_SECRET_KEY, region: environment.TENCENT_REGION, fetchImpl: dependencies.fetchImpl || globalThis.fetch, timeoutMs: environment.TENCENT_TTS_TIMEOUT_MS, now: dependencies.now }),
        voiceType: environment.TENCENT_TTS_VOICE_TYPE,
        modelType: environment.TENCENT_TTS_MODEL_TYPE || 1,
        codec: 'mp3', sampleRate: environment.TENCENT_TTS_SAMPLE_RATE || 16000
      });
  const synthesize = (input) => adapter.synthesize(input);
  // Standard Tencent voices are never selected by the client.  The operator
  // records the provider entitlement and the completed internal rights review
  // once, then every task snapshots this immutable provenance.
  synthesize.voiceProfile = Object.freeze({
    voice_id: `tencent-standard-${adapter.voiceType}`,
    voice_version: requiredProfileValue(environment.TENCENT_TTS_VOICE_VERSION, 'TENCENT_TTS_VOICE_VERSION'),
    authorization_record_id: requiredProfileValue(environment.TENCENT_TTS_AUTHORIZATION_RECORD_ID, 'TENCENT_TTS_AUTHORIZATION_RECORD_ID'),
    rights_review_id: requiredProfileValue(environment.TENCENT_TTS_RIGHTS_REVIEW_ID, 'TENCENT_TTS_RIGHTS_REVIEW_ID'),
    rights_review_state: 'APPROVED',
    source: 'TENCENT_STANDARD_VOICE_OPERATOR_RECORD'
  });
  synthesize.provider = 'tencent-tts';
  synthesize.modelVersion = environment.TENCENT_TTS_API_MODE === 'stream'
    ? 'TextToStreamAudioWS:emotion-v1'
    : `TextToVoice/${TTS_VERSION}:${adapter.modelType}`;
  return synthesize;
}

function safeSessionId(value) { return nonBlank(value) ? value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) : 'qiyu_tts'; }
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function positiveInteger(value) { return Number.isInteger(Number(value)) && Number(value) > 0; }
function requiredProfileValue(value, name) {
  if (!nonBlank(value) || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.trim())) {
    throw new TencentProviderError('TENCENT_TTS_VOICE_PROVENANCE_REQUIRED', `${name} 必须是 1-128 位的服务端音色授权记录标识`, 500);
  }
  return value.trim();
}

module.exports = { MAX_TTS_TEXT_LENGTH, MAX_STREAM_TTS_TEXT_LENGTH, TTS_VERSION, TencentTtsAdapter, TencentStreamTtsAdapter, createTencentTtsGeneratorFromEnvironment };
