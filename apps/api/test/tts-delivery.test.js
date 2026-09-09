'use strict';

// 这些用例守护两条产品意图：
// 1) 动作描写是视觉通道，绝不能被语音念出（出戏）——但未闭合括号要保守放过。
// 2) 情绪映射是确定性查表，未知情绪一律落 neutral，避免供应商 10001 拒绝。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SUPPORTED_EMOTION_CATEGORIES, resolveEmotion, isSupportedEmotionCategory,
  sanitizeTtsText, truncateForTts, TTS_TEXT_MAX_LENGTH,
} = require('../src/domain/tts-delivery');

test('sanitizeTtsText 剥离成对括号动作描写并折叠空白，供语音合成使用', () => {
  assert.equal(sanitizeTtsText('（她转过身）你是谁？我在这里等了很久。'), '你是谁？我在这里等了很久。');
  assert.equal(sanitizeTtsText('(smiles) 你来啦。'), '你来啦。');
  assert.equal(sanitizeTtsText('（看了前面几个，摇摇头）今年不行…（转身）你是谁？'), '今年不行… 你是谁？');
  assert.equal(sanitizeTtsText('  空白   折叠\t成单个  '), '空白 折叠 成单个');
  assert.equal(sanitizeTtsText(''), '');
});

test('sanitizeTtsText 遇到未闭合括号时保留原文，不吞掉后半句台词', () => {
  // 用户/模型输出的台词可能带未闭合括号；宁可念出括号也不能丢内容。
  assert.equal(sanitizeTtsText('（还没说完的一句'), '（还没说完的一句');
  assert.equal(sanitizeTtsText('（前段）台词（未闭合'), '台词（未闭合');
});

test('resolveEmotion 按世界状态查表，未知情绪回落 neutral', () => {
  assert.deepEqual(resolveEmotion('HAPPY'), { category: 'happy', intensity: 110, speed: 0.2 });
  assert.deepEqual(resolveEmotion('CONCERNED'), { category: 'sad', intensity: 70, speed: -0.2 });
  assert.deepEqual(resolveEmotion('tired'), { category: 'peaceful', intensity: 80, speed: -0.3 });
  assert.deepEqual(resolveEmotion('UNKNOWN_MOOD'), { category: 'neutral', intensity: 100, speed: 0 });
  assert.deepEqual(resolveEmotion(null), { category: 'neutral', intensity: 100, speed: 0 });
});

test('isSupportedEmotionCategory 只接受实时合成接口的 17 个文档枚举', () => {
  assert.equal(SUPPORTED_EMOTION_CATEGORIES.size, 17);
  assert.ok(isSupportedEmotionCategory('sajiao'));
  assert.ok(!isSupportedEmotionCategory('joyful'));
  assert.ok(!isSupportedEmotionCategory(null));
});

test('truncateForTts 优先句边界截断，无标点时硬截到 600 字上限', () => {
  const withSentences = `${'前奏。'.repeat(200)}结尾不该被念出。`;
  const cut = truncateForTts(withSentences);
  assert.ok(cut.length <= TTS_TEXT_MAX_LENGTH);
  assert.ok(cut.endsWith('。'));
  assert.ok(!cut.includes('结尾'));

  const noPunctuation = '啊'.repeat(800);
  assert.equal(truncateForTts(noPunctuation).length, TTS_TEXT_MAX_LENGTH);

  assert.equal(truncateForTts('短文本。'), '短文本。');
  assert.equal(truncateForTts('  '), '');
});
