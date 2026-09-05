'use strict';

function generateReply(text) {
  const trimmed = text.trim();
  return {
    provider: 'mock',
    model_version: 'deterministic-m1-v1',
    reply_text: `开发 Mock 已收到：“${trimmed}”。`,
    ai_generated: true,
    disclaimer: '这是确定性开发 Mock，不是真实模型回复。',
    memory_candidate: {
      type: 'development_note',
      normalized_value: { text: trimmed },
      display_text: `你提到：“${trimmed}”`,
      confidence: 1
    }
  };
}

module.exports = { generateReply };
