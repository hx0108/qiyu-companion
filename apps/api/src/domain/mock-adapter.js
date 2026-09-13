'use strict';

function generateReply(text, context = {}) {
  const trimmed = text.trim();
  const imageCount = Array.isArray(context.context_images) ? context.context_images.length : 0;
  return {
    provider: 'mock',
    model_version: 'deterministic-m1-v1',
    reply_text: imageCount ? `开发 Mock 已收到 ${imageCount} 张已审核图片和文字：“${trimmed}”。` : `开发 Mock 已收到：“${trimmed}”。`,
    ai_generated: true,
    disclaimer: '这是确定性开发 Mock，不是真实模型回复。',
    memory_candidate: imageCount ? null : {
      type: 'development_note',
      normalized_value: { text: trimmed },
      display_text: `你提到：“${trimmed}”`,
      confidence: 1
    }
  };
}

module.exports = { generateReply };
