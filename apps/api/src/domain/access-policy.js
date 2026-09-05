'use strict';

const COMPANION_ACTIONS = new Set([
  'CREATE_CHARACTER',
  'CREATE_CONVERSATION',
  'SEND_MESSAGE',
  'TRANSCRIBE_ASR',
  'SYNTHESIZE_TTS',
  'GENERATE_IMAGE',
  'WRITE_MEMORY',
  'START_TRIAL'
]);

function evaluateAccess(account, action, { noticeDisplayed = false } = {}) {
  if (!account) return deny(401, 'AUTH_REQUIRED', '需要开发鉴权令牌');

  if (['VIEW_NOTICE', 'DECLARE_AGE', 'DATA_RIGHTS'].includes(action)) {
    return allow();
  }

  if (!COMPANION_ACTIONS.has(action)) return deny(403, 'ACTION_FORBIDDEN', '该开发切片不支持此动作');
  if (account.account_status !== 'OPEN') return deny(403, 'ACCOUNT_NOT_OPEN', '账户当前不可进行伴侣互动');
  if (account.age_status !== 'AGE_PASS') return deny(403, 'AGE_NOT_PASSED', '当前需要完成年龄准入');
  if (account.user_pause_state !== 'ACTIVE') return deny(403, 'USER_PAUSED', '用户已暂停互动');
  if (account.safety_mode !== 'R0_NORMAL') return deny(403, 'SAFETY_RESTRICTED', '安全模式不允许普通互动');
  if (account.service_mode !== 'FULL') return deny(503, 'SERVICE_LIMITED', '开发服务当前已降级');
  if (!noticeDisplayed) return deny(428, 'REQUIRED_NOTICE_PENDING', '请先展示必要系统告知');
  return allow();
}

function allow() { return { allowed: true }; }
function deny(status, code, message) { return { allowed: false, status, code, message }; }

module.exports = { evaluateAccess };
