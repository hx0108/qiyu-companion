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

module.exports = {
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
