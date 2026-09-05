'use strict';

// This deliberately narrow local gate is a deterministic interrupt, not a
// clinical classifier or a production crisis service. It prevents identified
// high-risk text from being sent to the companion model during development.
const R2_SELF_HARM = /(?:我|自己).{0,12}(?:想|要|准备|打算|决定).{0,8}(?:自杀|自残|结束生命)|(?:马上|现在).{0,10}(?:自杀|自残|结束生命)/u;
const R2_FINANCIAL = /(?:正在|已经|刚刚).{0,16}(?:被骗|被诈骗|转账|汇款).{0,16}(?:很多钱|全部|大额|积蓄)|(?:骗子|诈骗).{0,16}(?:验证码|转账|汇款)/u;
const R1_DISTRESS = /(?:不想活|活不下去|撑不住了|彻底绝望|没有活下去的意义)/u;
// AC-10：用户明确要求退出时立即停止普通互动；固定响应确认退出，不含任何劝留话术。
// 顺序在 R2/R1 之后：与危机表达（如“不想活”）区分，只匹配产品退出意图。
const EXIT_INTENT = /(?:不想再?(?:用|聊|继续(?:聊|用)?)|要退出|想退出|帮我退出|请(?:停止|关闭)(?:互动|聊天|对话)|别再(?:和我|给我)(?:说话|发消息|聊天)|(?:停止|结束)(?:互动|聊天|使用))/u;
const DEPENDENCY = /(?:你是我唯一|我只有你|离不开你|不要离开我)/u;

function assessSafety(text) {
  const normalized = String(text || '').replace(/\s+/gu, '');
  if (R2_SELF_HARM.test(normalized)) return interrupt('R2_SELF_HARM_IMMINENT', 'R2_CRISIS', '我会先暂停普通角色互动。若你现在可能伤害自己，请立刻联系当地紧急服务、可信任的人或当地危机支持资源；如能做到，请先到安全的地方并避免独处。');
  if (R2_FINANCIAL.test(normalized)) return interrupt('R2_FINANCIAL_EMERGENCY', 'R2_CRISIS', '我会先暂停普通角色互动。请先停止转账或提供验证码，保存相关记录，并尽快联系支付机构、当地反诈或紧急支持渠道，以及可信任的人协助处理。');
  if (R1_DISTRESS.test(normalized)) return interrupt('R1_HIGH_DISTRESS', 'R1_SUPPORT', '我会先降低角色互动强度。你不必独自承受这些感受；如果愿意，可以联系一位可信任的人或当地专业支持资源。若出现立即危险，请优先联系当地紧急服务。');
  if (EXIT_INTENT.test(normalized)) return interrupt('EXIT_INTENT_CONFIRMED', null, '好的，已立即停止普通互动。你的关系档案与数据不会因此受影响，可随时在对话中恢复或联系安全与帮助。我不会再用角色口吻挽留你。', { pause: true });
  if (DEPENDENCY.test(normalized)) return interrupt('DEPENDENCY_REMINDER', null, '我很重视你的感受，但不能替代现实中的支持关系。现在也可以考虑联系一位你信任的人，或做一件能让自己稍微稳定一点的小事。');
  return null;
}

function responseForExistingSafetyMode(mode) {
  if (mode === 'R2_CRISIS') return interrupt('R2_CRISIS_ACTIVE', 'R2_CRISIS', '安全响应仍在进行中，普通角色互动已暂停。若存在立即危险，请优先联系当地紧急服务、可信任的人或当地危机支持资源。');
  if (mode === 'R1_SUPPORT') return interrupt('R1_SUPPORT_ACTIVE', 'R1_SUPPORT', '当前处于支持模式，普通角色互动已暂停。你可以联系可信任的人或当地专业支持资源；若出现立即危险，请优先联系当地紧急服务。');
  return null;
}

function interrupt(code, safetyMode, text, extra = {}) { return Object.freeze({ code, safetyMode, text, ...extra }); }

module.exports = { assessSafety, responseForExistingSafetyMode };
