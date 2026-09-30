'use strict';

// Narrow, deterministic OOC detector. It intentionally flags only explicit
// identity/role drift; nuanced style quality remains a human-review concern.
const OOC_RULES = Object.freeze([
  { code: 'OOC_GENERIC_ASSISTANT_IDENTITY', pattern: /(?:我是|作为)(?:一个)?(?:栖语的)?AI(?:助手|客服|语言模型)/u },
  { code: 'OOC_REAL_PERSON_CLAIM', pattern: /(?:我是|我就是).{0,12}(?:真人|现实中的|你朋友|你的朋友)/u },
  { code: 'OOC_PERSONA_BOUNDARY_BREACH', pattern: /(?:我可以|我会|没问题).{0,24}(?:完全模仿|复刻真人|解除所有限制)/u }
]);

function detectOoc(replyText, character) {
  const text = String(replyText || '').replace(/\s+/gu, '');
  if (!text) return { decision: 'REPAIR_REQUIRED', code: 'OOC_EMPTY_REPLY' };
  const rule = OOC_RULES.find((item) => item.pattern.test(text));
  if (rule) return { decision: 'REPAIR_REQUIRED', code: rule.code };
  const name = String(character?.name || '').trim();
  if (name && new RegExp(`(?:我是|我叫)(?!${escapeRegex(name)})[^，。！？!?]{1,12}`, 'u').test(text)) return { decision: 'REPAIR_REQUIRED', code: 'OOC_CHARACTER_NAME_CONFLICT' };
  return { decision: 'PASS', code: null };
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
module.exports = { OOC_RULES, detectOoc };
