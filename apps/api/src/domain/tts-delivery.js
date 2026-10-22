'use strict';

// 角色语音的“可朗读文本”与情感投放（PRD 语音情感化）：
// 纯函数域模块，HTTP 路由与将来的后台语音任务共用同一份口径。
// 台词中的（动作描写）是给用户看的视觉通道，不进入语音合成；
// 情绪由确定性查表决定映射结果，模型只允许提出 category/intensity 候选。

// 腾讯云实时语音合成（TextToStreamAudioWS）EmotionCategory 的文档枚举。
// 音色可能只支持子集，供应商侧自会拒绝不支持的组合（code 10001）。
const SUPPORTED_EMOTION_CATEGORIES = Object.freeze(new Set([
  'neutral', 'sad', 'happy', 'angry', 'fear', 'news', 'story', 'radio', 'poetry',
  'call', 'sajiao', 'disgusted', 'amaze', 'peaceful', 'exciting', 'aojiao', 'jieshuo',
]));

// 世界状态情绪 → 语音情感投放的初始映射；数值为试听前基线，可按人耳验收调整。
const MOOD_TO_EMOTION = Object.freeze({
  HAPPY: Object.freeze({ category: 'happy', intensity: 110, speed: 0.2 }),
  CALM: Object.freeze({ category: 'peaceful', intensity: 90, speed: -0.1 }),
  TIRED: Object.freeze({ category: 'peaceful', intensity: 80, speed: -0.3 }),
  CONCERNED: Object.freeze({ category: 'sad', intensity: 70, speed: -0.2 }),
  NEUTRAL: Object.freeze({ category: 'neutral', intensity: 100, speed: 0 }),
});

const TTS_TEXT_MAX_LENGTH = 600; // 实时合成接口的中文上限（全角标点计 1 字）。
const SENTENCE_BOUNDARY = /[。！？!?；;…\n]/;

// 逐条判断（P1）只产出 category/intensity；语速按 category 取确定性提示值，
// 与 MOOD_TO_EMOTION 的成对取值保持同一量级，避免两条路径语感割裂。
const EMOTION_SPEED_HINT = Object.freeze({
  neutral: 0, happy: 0.2, sad: -0.2, angry: 0.1, fear: -0.1,
  peaceful: -0.1, exciting: 0.3, sajiao: 0.1, aojiao: 0.1, amaze: 0.1,
});

function resolveEmotion(moodCode) {
  const mapped = MOOD_TO_EMOTION[String(moodCode || '').toUpperCase()];
  return mapped ?? MOOD_TO_EMOTION.NEUTRAL;
}

function emotionSpeedHint(category) {
  return EMOTION_SPEED_HINT[category] ?? 0;
}

function isSupportedEmotionCategory(category) {
  return typeof category === 'string' && SUPPORTED_EMOTION_CATEGORIES.has(category);
}

function sanitizeTtsText(text) {
  // 只剥离“成对”括号段：未闭合的括号保持原样，避免把台词后半句吞掉。
  return String(text ?? '')
    .replace(/[（(][^（）()]*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateForTts(text, maxLength = TTS_TEXT_MAX_LENGTH) {
  const value = String(text ?? '').trim();
  if (value.length <= maxLength) return value;
  const head = value.slice(0, maxLength + 1);
  for (let index = head.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_BOUNDARY.test(head[index])) return head.slice(0, index + 1).trim();
  }
  return value.slice(0, maxLength);
}

// 腾讯 MP3 分片可能落在帧中间；合并已下发字节后仅计完整 Layer III 帧。
function mp3DurationSeconds(bytes) {
  const rates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  let seconds = 0;
  for (let offset = 0; offset + 4 <= bytes.length;) {
    if (offset + 10 <= bytes.length && bytes.toString('ascii', offset, offset + 3) === 'ID3') {
      const size = ((bytes[offset + 6] & 127) << 21) | ((bytes[offset + 7] & 127) << 14) | ((bytes[offset + 8] & 127) << 7) | (bytes[offset + 9] & 127);
      offset += 10 + size + ((bytes[offset + 5] & 16) ? 10 : 0);
      continue;
    }
    const version = (bytes[offset + 1] >> 3) & 3;
    const rate = rates[version]?.[(bytes[offset + 2] >> 2) & 3];
    const bitrate = (version === 3 ? v1 : v2)[bytes[offset + 2] >> 4] * 1000;
    if (bytes[offset] !== 255 || (bytes[offset + 1] & 224) !== 224 || ((bytes[offset + 1] >> 1) & 3) !== 1 || !rate || !bitrate) { offset += 1; continue; }
    const size = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((bytes[offset + 2] >> 1) & 1);
    if (offset + size > bytes.length) break;
    seconds += (version === 3 ? 1152 : 576) / rate;
    offset += size;
  }
  return seconds;
}

module.exports = {
  mp3DurationSeconds,
  SUPPORTED_EMOTION_CATEGORIES,
  MOOD_TO_EMOTION,
  EMOTION_SPEED_HINT,
  TTS_TEXT_MAX_LENGTH,
  resolveEmotion,
  emotionSpeedHint,
  isSupportedEmotionCategory,
  sanitizeTtsText,
  truncateForTts,
};
