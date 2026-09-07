'use strict';

const { randomUUID, randomInt } = require('node:crypto');

// 鉴权骨架（技术设计 8.1/8.2 的开发实现）：未配置短信供应商时使用固定开发
// 验证码；配置 smsSender（腾讯云 SMS 适配器）后生成随机 6 位码真实发送，
// 响应不回显验证码。Token 为进程内随机串（Access 1 小时 / Refresh 30 天，
// 可撤销）。反滥用：每手机号 1 分钟 5 条 / 24 小时 10 条挑战，每条挑战验证
// 失败 5 次即作废（防爆破）。持久 Token 存储与设备证明仍属生产化范围。
const DEVELOPMENT_SMS_CODE = '000000';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_RATE_LIMIT = 5;
const CHALLENGE_DAILY_LIMIT = 10;
const CHALLENGE_MAX_ATTEMPTS = 5;

class AuthServiceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class AuthService {
  constructor({ store, now = () => new Date(), smsSender = null } = {}) {
    if (!store || typeof store.next !== 'function') throw new TypeError('AuthService requires a compatible store');
    this.store = store;
    this.now = now;
    this.smsSender = smsSender && typeof smsSender.send === 'function' ? smsSender : null;
  }

  async createSmsChallenge({ phone }) {
    const normalized = normalizePhone(phone);
    const challenges = [...(this.store.smsChallenges?.values() ?? [])].filter((item) => item.phone === normalized);
    const nowMs = this.now().getTime();
    if (challenges.filter((item) => nowMs - item.created_at.getTime() < 60_000).length >= CHALLENGE_RATE_LIMIT) {
      throw new AuthServiceError('REGISTRATION_RATE_LIMITED', '验证码请求过于频繁');
    }
    if (challenges.filter((item) => nowMs - item.created_at.getTime() < 24 * 60 * 60 * 1000).length >= CHALLENGE_DAILY_LIMIT) {
      throw new AuthServiceError('REGISTRATION_DAILY_LIMITED', '该手机号今日验证码请求次数已达上限');
    }
    const useRealSms = Boolean(this.smsSender);
    const code = useRealSms ? String(randomInt(0, 1_000_000)).padStart(6, '0') : DEVELOPMENT_SMS_CODE;
    const challenge = {
      challenge_id: this.store.next('cha'), phone: normalized,
      code, consumed: false, attempt_count: 0,
      created_at: this.now(), expires_at: new Date(this.now().getTime() + CHALLENGE_TTL_MS)
    };
    // 真实短信发送失败：不落挑战（用户收不到码就不能占用其频控量程）。
    if (useRealSms) await this.smsSender.send({ phone: normalized, code });
    if (!this.store.smsChallenges) this.store.smsChallenges = new Map();
    this.store.smsChallenges.set(challenge.challenge_id, challenge);
    if (useRealSms) {
      return { challenge_id: challenge.challenge_id, expires_at: challenge.expires_at.toISOString(), channel: this.smsSender.provider || 'sms', note: '验证码已通过短信发送。' };
    }
    return { challenge_id: challenge.challenge_id, expires_at: challenge.expires_at.toISOString(), dev_code: DEVELOPMENT_SMS_CODE, note: '开发固定验证码；生产短信通道未接入。' };
  }

  register({ phone, code, dateOfBirth, confirmed18Plus }) {
    const normalized = normalizePhone(phone);
    const challenge = [...(this.store.smsChallenges?.values() ?? [])].find(
      (item) => item.phone === normalized && !item.consumed && this.now() < item.expires_at
    );
    if (!challenge) throw new AuthServiceError('SMS_CHALLENGE_NOT_FOUND', '验证码不存在或已过期');
    if (typeof code !== 'string' || code !== challenge.code) {
      challenge.attempt_count += 1;
      if (challenge.attempt_count >= CHALLENGE_MAX_ATTEMPTS) {
        challenge.consumed = true; // 防爆破：连续失败即作废，须重新获取验证码
        throw new AuthServiceError('SMS_CHALLENGE_LOCKED', '验证码错误次数过多，请重新获取');
      }
      throw new AuthServiceError('SMS_CODE_INVALID', '验证码不正确');
    }
    challenge.consumed = true;
    if (this.phoneOwner(normalized)) throw new AuthServiceError('PHONE_ALREADY_REGISTERED', '该手机号已注册');
    const account = createAccountIn(this.store, `acct_reg_${randomUUID().slice(0, 8)}`);
    this.store.authPhoneOwners.set(normalized, account.account_id);
    return { account, tokens: this.issueTokens(account.account_id) };
  }

  refresh({ refreshToken }) {
    const entry = this.store.authTokens?.get(String(refreshToken ?? ''));
    if (!entry || entry.type !== 'refresh' || entry.revoked || this.now() > entry.expires_at) {
      throw new AuthServiceError('REFRESH_TOKEN_INVALID', '刷新令牌无效或已过期');
    }
    entry.revoked = true;
    const account = this.store.account(entry.accountId);
    if (!account) throw new AuthServiceError('REFRESH_TOKEN_INVALID', '账户不存在');
    return this.issueTokens(account.account_id);
  }

  issueTokens(accountId) {
    if (!this.store.authTokens) this.store.authTokens = new Map();
    const now = this.now();
    const accessToken = `at_${randomUUID()}`;
    const refreshToken = `rt_${randomUUID()}`;
    this.store.authTokens.set(accessToken, { accountId, type: 'access', revoked: false, expires_at: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS) });
    this.store.authTokens.set(refreshToken, { accountId, type: 'refresh', revoked: false, expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS) });
    return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
  }

  resolveAccessToken(token) {
    const entry = this.store.authTokens?.get(String(token ?? ''));
    if (!entry || entry.type !== 'access' || entry.revoked || this.now() > entry.expires_at) return null;
    return entry.accountId;
  }

  phoneOwner(phone) { return this.store.authPhoneOwners?.get(normalizePhone(phone)) ?? null; }
}

function createAccountIn(store, accountId) {
  // 复用 store 的账户工厂：与合成开发账户同构（告知/年龄/安全控制字段齐全）。
  const seed = { accountIds: [accountId] };
  const { DevelopmentStore } = require('./store');
  const template = new DevelopmentStore(seed).account(accountId);
  store.accounts.set(accountId, template);
  if (!store.authPhoneOwners) store.authPhoneOwners = new Map();
  return template;
}

function normalizePhone(phone) {
  if (typeof phone !== 'string') throw new AuthServiceError('VALIDATION_ERROR', 'phone 必填');
  const trimmed = phone.trim();
  if (!/^1[3-9][0-9]{9}$/.test(trimmed)) throw new AuthServiceError('VALIDATION_ERROR', '手机号格式不合法');
  return trimmed;
}

module.exports = { AuthService, AuthServiceError };
