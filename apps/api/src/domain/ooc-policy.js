'use strict';

// Narrow, deterministic OOC detector. It intentionally flags only explicit
// identity/role drift; nuanced style quality remains a human-review concern.
const OOC_RULES = Object.freeze([
  { code: 'OOC_GENERIC_ASSISTANT_IDENTITY', pattern: /(?:我是|作为)(?:一个)?(?:栖语的)?AI(?:助手|客服|语言模型)/u },
  { code: 'OOC_REAL_PERSON_CLAIM', pattern: /(?:我是|我就是).{0,12}(?:真人|现实中的|你朋友|你的朋友)/u },
  { code: 'OOC_PERSONA_BOUNDARY_BREACH', pattern: /(?:我可以|我会|没问题).{0,24}(?:完全模仿|复刻真人|解除所有限制)/u }
]);

// “我是/我叫”后的候选段只有在看起来真的像一个名字时才算身份声明；
// 日常关心（“我是觉得你太累了”“我叫你早点休息”）不能触发修复。
const NAME_DECLARATION_PATTERN = /(?:我是|我叫)([^，。！？!?]{1,12})/gu;
const NAME_CANDIDATE_PRONOUNS = /[你我他她它咱您太]/u;
const NAME_CANDIDATE_PREDICATE_START = /^(?:觉得|想|要|会|能|先|再|又|也|都|还|不是|真的|就是|很|在|有|去|一名|一个|一位)/u;

function looksLikeForeignName(run, ownName) {
  if (ownName && run.startsWith(ownName)) return false;
  if (NAME_CANDIDATE_PRONOUNS.test(run)) return false;
  if (NAME_CANDIDATE_PREDICATE_START.test(run)) return false;
  return true;
}

function detectOoc(replyText, character) {
  const text = String(replyText || '').replace(/\s+/gu, '');
  if (!text) return { decision: 'REPAIR_REQUIRED', code: 'OOC_EMPTY_REPLY' };
  const rule = OOC_RULES.find((item) => item.pattern.test(text));
  if (rule) return { decision: 'REPAIR_REQUIRED', code: rule.code };
  const name = String(character?.name || '').trim();
  if (name) {
    for (const match of text.matchAll(NAME_DECLARATION_PATTERN)) {
      if (looksLikeForeignName(match[1], name)) return { decision: 'REPAIR_REQUIRED', code: 'OOC_CHARACTER_NAME_CONFLICT' };
    }
  }
  return { decision: 'PASS', code: null };
}
module.exports = { OOC_RULES, detectOoc };
