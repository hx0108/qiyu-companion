'use strict';

const { createHash, randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(scryptCallback);
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

class TrialAuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function normalizeInviteCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,32}(?:-[A-Z0-9]{4,32}){1,4}$/.test(code)) {
    throw new TrialAuthError('TRIAL_INVITE_INVALID', '邀请码或试用口令不正确');
  }
  return code;
}

function normalizeInitialSecret(value) {
  const secret = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(secret)) {
    throw new TrialAuthError('TRIAL_INVITE_INVALID', '邀请码或试用口令不正确');
  }
  return secret;
}

function credentialHash(value) { return createHash('sha256').update(String(value), 'utf8').digest(); }
function opaqueToken(prefix) { return `${prefix}_${randomBytes(32).toString('base64url')}`; }

async function hashInitialSecret(secret) {
  const normalized = normalizeInitialSecret(secret);
  const salt = randomBytes(16);
  const derived = await scrypt(normalized, salt, 64);
  return `scrypt-v1$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyInitialSecret(secret, serialized) {
  let normalized;
  try { normalized = normalizeInitialSecret(secret); } catch { return false; }
  const parts = String(serialized || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt-v1') return false;
  try {
    const actual = Buffer.from(parts[2], 'base64url');
    const derived = Buffer.from(await scrypt(normalized, Buffer.from(parts[1], 'base64url'), actual.length));
    return actual.length === derived.length && timingSafeEqual(actual, derived);
  } catch { return false; }
}

function issueTokens() {
  return {
    access_token: opaqueToken('trial_at'), refresh_token: opaqueToken('trial_rt'), token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS
  };
}

// In-memory implementation keeps local unit tests self-contained. Docker trial
// mode uses the PostgreSQL repository, which persists only the hashes.
class MemoryTrialInviteAuth {
  constructor({ store, now = () => new Date() } = {}) {
    if (!store || typeof store.next !== 'function') throw new TypeError('MemoryTrialInviteAuth requires a compatible store');
    this.store = store;
    this.now = now;
    this.store.trialInvites ||= new Map();
    this.store.trialSessions ||= new Map();
  }

  async provisionInvite({ inviteCode, initialSecret, label = 'test', expiresAt = null }) {
    const code = normalizeInviteCode(inviteCode);
    const key = credentialHash(code).toString('hex');
    if (this.store.trialInvites.has(key)) throw new TrialAuthError('TRIAL_INVITE_DUPLICATE', '邀请码已存在');
    const invite = {
      invite_id: this.store.next('inv'), invite_code_hash: key, initial_secret_hash: await hashInitialSecret(initialSecret),
      label, status: 'ACTIVE', account_id: null, expires_at: expiresAt ? new Date(expiresAt) : null, created_at: this.now()
    };
    this.store.trialInvites.set(key, invite);
    return invite;
  }

  async createSession({ inviteCode, initialSecret }) {
    const invite = this.store.trialInvites.get(credentialHash(normalizeInviteCode(inviteCode)).toString('hex'));
    if (!invite || invite.status !== 'ACTIVE' || (invite.expires_at && this.now() >= invite.expires_at) || !(await verifyInitialSecret(initialSecret, invite.initial_secret_hash))) {
      throw new TrialAuthError('TRIAL_INVITE_INVALID', '邀请码或试用口令不正确');
    }
    if (!invite.account_id) {
      const { DevelopmentStore } = require('./store');
      const template = new DevelopmentStore({ accountIds: [this.store.next('acct_trial')] }).accounts.values().next().value;
      this.store.accounts.set(template.account_id, template);
      invite.account_id = template.account_id;
    }
    for (const session of this.store.trialSessions.values()) if (session.invite_id === invite.invite_id) session.revoked_at = this.now();
    const tokens = issueTokens();
    this.store.trialSessions.set(credentialHash(tokens.access_token).toString('hex'), {
      session_id: randomUUID(), invite_id: invite.invite_id, account_id: invite.account_id,
      access_hash: credentialHash(tokens.access_token).toString('hex'), refresh_hash: credentialHash(tokens.refresh_token).toString('hex'),
      expires_at: new Date(this.now().getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
      refresh_expires_at: new Date(this.now().getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000), revoked_at: null
    });
    return { account_id: invite.account_id, tokens };
  }

  async resolveAccessToken(token) {
    const session = this.store.trialSessions.get(credentialHash(token).toString('hex'));
    if (!session || session.revoked_at || this.now() >= session.expires_at) return null;
    return session.account_id;
  }

  async refreshSession({ refreshToken }) {
    const refreshHash = credentialHash(String(refreshToken || '')).toString('hex');
    const session = [...this.store.trialSessions.values()].find((item) => item.refresh_hash === refreshHash);
    if (!session || session.revoked_at || this.now() >= session.refresh_expires_at) throw new TrialAuthError('TRIAL_SESSION_INVALID', '试用会话已失效，请重新输入邀请码和口令');
    session.revoked_at = this.now();
    const tokens = issueTokens();
    this.store.trialSessions.set(credentialHash(tokens.access_token).toString('hex'), {
      ...session, session_id: randomUUID(), access_hash: credentialHash(tokens.access_token).toString('hex'), refresh_hash: credentialHash(tokens.refresh_token).toString('hex'),
      expires_at: new Date(this.now().getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000), refresh_expires_at: new Date(this.now().getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000), revoked_at: null
    });
    return { account_id: session.account_id, tokens };
  }
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, TrialAuthError, MemoryTrialInviteAuth,
  credentialHash, hashInitialSecret, issueTokens, normalizeInitialSecret, normalizeInviteCode, opaqueToken, verifyInitialSecret
};
