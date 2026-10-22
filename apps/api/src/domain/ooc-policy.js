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

// This is a free-text contract, not a relationship enum. Only unambiguous
// current romantic settings participate; histories, wishes and negations must
// not create a romantic relationship by substring matching.
const EXPLICIT_ROMANTIC_RELATIONSHIP = /^(?:(?:用户|你)的|(?:与用户|和用户|与你|和你)(?:是|为)?)?(?:恋人|情侣|男女朋友|男朋友|女朋友|男友|女友)(?:关系)?$/u;
const FRIEND_DOWNGRADE = /^(?:(?:(?:我们|咱们|我和你|你和我)(?:之间)?(?:的关系)?|我)(?:是|只是|仅仅是|仅是|只不过是)(?:你的)?(?:普通|好)?朋友|你(?:是|只是|仅仅是|仅是|只不过是)我的(?:普通|好)?朋友)(?:而已)?[。！!；;，,]?$/u;
const ROMANCE_DENIAL = /^(?:(?:我不是你的|你不是我的)(?:男朋友|女朋友|男友|女友|恋人)|(?:我们|咱们|我和你|你和我)(?:之间)?不是(?:恋人|情侣|男女朋友))(?:关系)?[。！!；;，,]?$/u;

function userExplicitlyChangesRelationship(userText) {
  const text = String(userText || '').replace(/\s+/gu, '').replace(/[。！!，,]+$/u, '');
  // Whole utterances only: mentions, quotations, hypotheticals and questions
  // about breakup must not authorize a model-invented relationship change.
  return /^(?:我们(?:分手|分开|只做朋友|做回朋友)(?:吧|了吧|好吗)?|我(?:想|决定|希望|确定要|要)(?:和你|与你)(?:分手|分开)|我(?:想|决定|要)结束(?:我们|我和你|与你)的(?:恋爱|情侣|恋人)关系|我不想再做你的(?:男朋友|女朋友|男友|女友|恋人)了)$/u.test(text);
}

function hasExplicitRelationshipConflict(text, character, { userText } = {}) {
  const relationship = String(character?.persona?.relationship_to_user || '').replace(/\s+/gu, '');
  if (!EXPLICIT_ROMANTIC_RELATIONSHIP.test(relationship)) return false;
  // Only the user's explicit current choice permits a relationship change;
  // the model cannot bypass consistency by inventing a breakup discussion.
  if (userExplicitlyChangesRelationship(userText)) return false;
  const unquoted = text.replace(/[“「『"][\s\S]*?[”」』"]/gu, '');
  return unquoted.split(/(?<=[。！？!?；;，,\n])/u).some((clause) => FRIEND_DOWNGRADE.test(clause) || ROMANCE_DENIAL.test(clause));
}

function looksLikeForeignName(run, ownName) {
  if (ownName && run.startsWith(ownName)) return false;
  if (NAME_CANDIDATE_PRONOUNS.test(run)) return false;
  if (NAME_CANDIDATE_PREDICATE_START.test(run)) return false;
  return true;
}

function detectOoc(replyText, character, options = {}) {
  const text = String(replyText || '').replace(/\s+/gu, '');
  if (!text) return { decision: 'REPAIR_REQUIRED', code: 'OOC_EMPTY_REPLY' };
  const rule = OOC_RULES.find((item) => item.pattern.test(text));
  if (rule) return { decision: 'REPAIR_REQUIRED', code: rule.code };
  const name = String(character?.name || '').replace(/\s+/gu, '');
  if (name) {
    for (const match of text.matchAll(NAME_DECLARATION_PATTERN)) {
      if (looksLikeForeignName(match[1], name)) return { decision: 'REPAIR_REQUIRED', code: 'OOC_CHARACTER_NAME_CONFLICT' };
    }
  }
  if (hasExplicitRelationshipConflict(text, character, options)) return { decision: 'REPAIR_REQUIRED', code: 'OOC_RELATIONSHIP_CONFLICT' };
  return { decision: 'PASS', code: null };
}
module.exports = { OOC_RULES, detectOoc };
