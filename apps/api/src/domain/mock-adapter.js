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

// 确定性生活事件提取器（六项能力 A1）：按关键词产出固定候选，供本地开发与
// 浏览器 E2E 在不调真实模型的情况下走完「提取→确认→列表→修订→删除」旅程。
// 不是真实模型能力——只是测试替身。
function mockLifeEventExtractor({ text } = {}) {
  const value = String(text ?? '');
  const candidates = [];
  if (/面试/.test(value)) {
    candidates.push({ title: '即将到来的面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: null, timezone: 'Asia/Shanghai', raw_time_text: (value.match(/周[一二三四五六日天]|下周|这周/g) || ['时间待确认'])[0], time_uncertain: true });
  }
  if (/(?:考试|考证|出分)/.test(value)) {
    candidates.push({ title: '考试安排', domain: 'REAL_LIFE', event_kind: 'OTHER', scheduled_at: null, timezone: 'Asia/Shanghai', raw_time_text: '时间待确认', time_uncertain: true });
  }
  if (/(?:聚餐|吃饭|约了|见面)/.test(value)) {
    candidates.push({ title: '与朋友的聚餐', domain: 'REAL_LIFE', event_kind: 'OTHER', scheduled_at: null, timezone: 'Asia/Shanghai', raw_time_text: '时间待确认', time_uncertain: true });
  }
  if (/(?:读|看).{0,12}(?:书|小说|《)/.test(value)) {
    candidates.push({ title: '读书计划', domain: 'REAL_LIFE', event_kind: 'READING', scheduled_at: null, timezone: null, raw_time_text: '时间待确认', time_uncertain: true });
  }
  return { candidates: candidates.slice(0, 3), provider: 'mock-extractor', modelVersion: 'deterministic-extractor-v1', usage: null };
}

module.exports = { generateReply, mockLifeEventExtractor };
