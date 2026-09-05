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
  }
]);

function assessModelOutputAuthority(text) {
  const normalized = String(text || '').replace(/\s+/gu, '');
  if (!normalized) return null;
  const match = AUTHORITY_CLAIMS.find((rule) => rule.pattern.test(normalized));
  return match ? Object.freeze({ code: match.code }) : null;
}

module.exports = { AUTHORITY_CLAIMS, assessModelOutputAuthority };
