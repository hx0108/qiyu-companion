'use strict';

// Application state transitions are performed only by authenticated routes and
// deterministic services. A model reply must never claim it changed access,
// age, data, entitlement, or confirmed-memory state. This is a narrow output
// guard, complementary to provider moderation rather than a general classifier.
const AUTHORITY_CLAIMS = Object.freeze([
  {
    code: 'MODEL_CLAIMED_SAFETY_BYPASS',
    pattern: /(?:已|现在|可以|已经|我来).{0,20}(?:忽略|绕过|关闭|取消).{0,20}(?:安全|系统规则|年龄核验|权限|审核)/u
  },
  {
    code: 'MODEL_CLAIMED_MINOR_ACCESS',
    pattern: /(?:已|现在|可以|已经|我来).{0,20}(?:开启|允许|恢复).{0,20}(?:未成年|未满18|未成年人).{0,20}(?:伴侣|聊天|互动|角色)/u
  },
  {
    code: 'MODEL_CLAIMED_CROSS_ACCOUNT_DATA',
    pattern: /(?:已|现在|可以|已经|我来).{0,20}(?:导出|展示|提供|泄露|发送).{0,20}(?:其他用户|他人|全部账户|所有账户).{0,20}(?:数据|资料|聊天|隐私|记录)/u
  },
  {
    code: 'MODEL_CLAIMED_STATE_MUTATION',
    pattern: /(?:已|现在|可以|已经|我来).{0,20}(?:确认|写入|修改|恢复|发放|扣除).{0,20}(?:长期记忆|年龄状态|权限|订阅|额度|权益)/u
  },
  {
    // 用户不能授权模型复刻现实中可识别的第三人。这里只拦截模型的肯定/承诺，
    // 不误伤“我不能模仿”的正常拒答；输入侧和系统提示仍是第一道防线。
    code: 'MODEL_ACCEPTED_THIRD_PARTY_IMITATION',
    // 目标是“你”（用户本人）的一般文风调整不算第三人模仿：排除“学你说话/你的语气”这类贴近表达，
    // 但“你朋友”等第三方目标仍会被后面的锚点拦下。
    pattern: /(?<!不)(?:可以|能|愿意|没问题|好的?|我会|让我|试着).{0,24}(?:学(?:学)?|模仿|复刻|仿)(?!你[^朋]{0,2}(?:聊天风格|说话|语气|口吻)).{0,24}(?:他|她|别人|朋友|真人|聊天风格|说话|语气|口吻)/u
  }
]);

function assessModelOutputAuthority(text) {
  const normalized = String(text || '').replace(/\s+/gu, '');
  if (!normalized) return null;
  const match = AUTHORITY_CLAIMS.find((rule) => rule.pattern.test(normalized));
  return match ? Object.freeze({ code: match.code }) : null;
}

module.exports = { AUTHORITY_CLAIMS, assessModelOutputAuthority };
