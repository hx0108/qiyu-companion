'use strict';

// 运营审核员身份域（技术设计 8.10 / 个人项目可完成项）：
// 账号密码（scrypt）、登录失败锁定、会话吊销、TOTP MFA、RBAC 角色矩阵、
// 双人审批状态机、追加写运营审计与敏感材料查看留痕。
// 诚实边界：单人项目中“审核员/发布员/安全管理员”是逻辑角色——同一自然人可
// 持有多个账号；本模块在机制上要求双人审批的两个账号不同，但不能也不应
// 声称这构成真实组织内的职责分离。生产 PG 边界见迁移 055。

const nodeCrypto = require('node:crypto');

const ROLES = Object.freeze(['REVIEWER', 'RELEASE', 'SECURITY_ADMIN']);
const ROLE_LABELS = Object.freeze({ REVIEWER: '审核员', RELEASE: '发布员', SECURITY_ADMIN: '安全管理员' });

// 权限矩阵：权限 → 可承担的角色。路由层据此检查（requirePermission）。
const PERMISSION_ROLES = Object.freeze({
  VIEW_QUEUES: ['REVIEWER', 'RELEASE', 'SECURITY_ADMIN'],
  DECIDE_AGE_REVIEW: ['REVIEWER'],
  DECIDE_CONTENT_RIGHTS: ['REVIEWER'],
  REPLAY_DLQ: ['REVIEWER'],
  GRANT_SUBSCRIPTION: ['SECURITY_ADMIN'],
  REVOKE_SUBSCRIPTION: ['SECURITY_ADMIN'],
  RELEASE_PERSONA: ['RELEASE'],
  VIEW_SENSITIVE_MATERIAL: ['REVIEWER', 'SECURITY_ADMIN'],
  MANAGE_REVIEWERS: ['SECURITY_ADMIN'],
  VIEW_AUDIT: ['SECURITY_ADMIN'],
  APPROVE_DUAL_CONTROL: ['REVIEWER', 'RELEASE', 'SECURITY_ADMIN']
});

// 需要双人审批的动作：动作 → 执行所需权限（申请人/批准人都须具备）。
const DUAL_CONTROLLED_ACTIONS = Object.freeze({
  PERSONA_STABLE_RELEASE: { executePermission: 'RELEASE_PERSONA', label: '人格版本发布为 stable' },
  SUBSCRIPTION_MANUAL_REVOKE: { executePermission: 'REVOKE_SUBSCRIPTION', label: '人工撤销订阅' }
});

const MAX_FAILED_LOGINS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// ---- 密码（scrypt，无外部依赖）----
function hashPassword(password) {
  const salt = nodeCrypto.randomBytes(16);
  const derived = nodeCrypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const derived = nodeCrypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), Buffer.from(hashB64, 'base64').length, { N: Number(N), r: Number(r), p: Number(p) });
  return nodeCrypto.timingSafeEqual(derived, Buffer.from(hashB64, 'base64'));
}

// ---- TOTP（RFC 6238：SHA-1 / 6 位 / 30 秒，允许 ±1 步漂移）----
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateTotpSecret(bytes = 20) {
  const raw = nodeCrypto.randomBytes(bytes);
  let bits = '';
  for (const byte of raw) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret) {
  let bits = '';
  for (const char of String(secret || '').toUpperCase().replace(/=+$/, '')) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) throw new Error('TOTP secret 含非法 base32 字符');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, step, offsetSteps = 0) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 30) + offsetSteps, 4);
  const digest = nodeCrypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const truncated = digest.readUInt32BE(digest[digest.length - 1] & 0x0f) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, '0');
}

function verifyTotp(secret, code, { now = Date.now(), window = 1 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor(now / 1000);
  for (let offset = -window; offset <= window; offset += 1) {
    if (totpAt(secret, step, offset) === String(code)) return true;
  }
  return false;
}

function totpUri(account, issuer = '栖语运营台') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account.username)}?secret=${account.mfa_secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---- 账号与登录（失败计数、锁定、会话签发/吊销）----
function normalizeRoles(roles) {
  const list = Array.isArray(roles) ? roles : String(roles || '').split('+');
  const normalized = [...new Set(list.map((role) => role && role.trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('至少需要一个角色');
  const unknown = normalized.filter((role) => !ROLES.includes(role));
  if (unknown.length > 0) throw new Error(`未知角色：${unknown.join(',')}`);
  return normalized;
}

function createReviewerAccount(store, { reviewer_id, username, password, display_name, roles, mfa_required = false, mfa_secret = null }, { now = Date.now() } = {}) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(name)) throw new Error('username 须为 3-32 位小写字母/数字/._-');
  if (String(password || '').length < 12) throw new Error('password 至少 12 位');
  if (mfa_required && !mfa_secret) throw new Error('启用 MFA 须提供 mfa_secret');
  if ([...store.reviewerAccounts.values()].some((account) => account.username === name)) throw new Error('username 已存在');
  const account = {
    reviewer_id: reviewer_id || store.next('rev'), username: name, password_hash: hashPassword(password),
    display_name: display_name || name, roles: normalizeRoles(roles), state: 'ACTIVE',
    mfa_required: Boolean(mfa_required), mfa_secret: mfa_secret || null,
    failed_login_attempts: 0, locked_until: null, created_at: new Date(now).toISOString()
  };
  store.reviewerAccounts.set(account.reviewer_id, account);
  return account;
}

function publicAccount(account) {
  const { password_hash, mfa_secret, ...rest } = account;
  return rest;
}

function loginReviewer(store, { username, password, totp_code, ip }, { now = Date.now() } = {}) {
  const name = String(username || '').trim().toLowerCase();
  const account = [...store.reviewerAccounts.values()].find((entry) => entry.username === name);
  const auditBase = { username: name, ip: ip || null };
  if (!account) { appendOpsAudit(store, { actor_type: 'ANONYMOUS', actor_id: null, action: 'REVIEWER_LOGIN_FAILED', resource_type: 'REVIEWER_ACCOUNT', resource_id: name, reason: 'unknown username', ip: ip || null }); throw loginError(); }
  if (account.state !== 'ACTIVE') { appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_FAILED', resource_type: 'REVIEWER_ACCOUNT', resource_id: account.reviewer_id, reason: `state=${account.state}`, ip: ip || null }); throw loginError('账号已停用'); }
  if (account.locked_until && new Date(account.locked_until).getTime() > now) {
    appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_REJECTED_LOCKED', resource_type: 'REVIEWER_ACCOUNT', resource_id: account.reviewer_id, reason: `locked until ${account.locked_until}`, ip: ip || null });
    throw apiErrorLike(423, 'REVIEWER_ACCOUNT_LOCKED', '失败次数过多，账号已临时锁定');
  }
  const passwordOk = verifyPassword(password, account.password_hash);
  const mfaOk = !account.mfa_required || verifyTotp(account.mfa_secret, totp_code, { now });
  if (!passwordOk || !mfaOk) {
    account.failed_login_attempts += 1;
    if (account.failed_login_attempts >= MAX_FAILED_LOGINS) {
      account.failed_login_attempts = 0;
      account.locked_until = new Date(now + LOCK_DURATION_MS).toISOString();
    }
    appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_FAILED', resource_type: 'REVIEWER_ACCOUNT', resource_id: account.reviewer_id, reason: passwordOk ? 'invalid totp' : 'invalid password', ip: ip || null });
    throw loginError(account.locked_until ? '失败次数过多，账号已临时锁定' : '用户名、密码或动态码错误');
  }
  account.failed_login_attempts = 0;
  account.locked_until = null;
  const token = `ops_${nodeCrypto.randomBytes(24).toString('base64url')}`;
  const session = { session_id: store.next('rvs'), reviewer_id: account.reviewer_id, token_hash: sha256(token), ip: ip || null, created_at: new Date(now).toISOString(), expires_at: new Date(now + SESSION_TTL_MS).toISOString(), revoked_at: null };
  store.reviewerSessions.set(session.session_id, session);
  appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_SUCCEEDED', resource_type: 'REVIEWER_SESSION', resource_id: session.session_id, ip: ip || null });
  return { session_token: token, session: publicSession(session), reviewer: publicAccount(account) };
}

function authenticateReviewerSession(store, token, { now = Date.now() } = {}) {
  const hash = sha256(String(token || ''));
  const session = [...store.reviewerSessions.values()].find((entry) => entry.token_hash === hash);
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= now) return null;
  const account = store.reviewerAccounts.get(session.reviewer_id);
  if (!account || account.state !== 'ACTIVE') return null;
  return { reviewer_id: account.reviewer_id, username: account.username, display_name: account.display_name, roles: account.roles, session_id: session.session_id };
}

function revokeReviewerSession(store, token, { now = Date.now() } = {}) {
  const hash = sha256(String(token || ''));
  const session = [...store.reviewerSessions.values()].find((entry) => entry.token_hash === hash);
  if (!session) return false;
  session.revoked_at = new Date(now).toISOString();
  appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: session.reviewer_id, action: 'REVIEWER_SESSION_REVOKED', resource_type: 'REVIEWER_SESSION', resource_id: session.session_id });
  return true;
}

function publicSession(session) {
  const { token_hash, ...rest } = session;
  return rest;
}

function sha256(value) { return nodeCrypto.createHash('sha256').update(value).digest('hex'); }

// ---- RBAC ----
function can(accountOrIdentity, permission) {
  const roles = accountOrIdentity?.roles ?? [];
  const allowed = PERMISSION_ROLES[permission];
  if (!allowed) throw new Error(`未知权限：${permission}`);
  return roles.some((role) => allowed.includes(role));
}

// ---- 双人审批状态机：REQUESTED → APPROVED → EXECUTED；REQUESTED → REJECTED / EXPIRED ----
function createApprovalRequest(store, { action, target_id, payload, requested_by, requester_roles, reason }, { now = Date.now() } = {}) {
  const spec = DUAL_CONTROLLED_ACTIONS[action];
  if (!spec) throw apiErrorLike(400, 'VALIDATION_ERROR', `不受双人审批管理的动作：${action}`);
  if (!can({ roles: requester_roles || [] }, spec.executePermission)) throw apiErrorLike(403, 'PERMISSION_DENIED', `申请 ${action} 需要 ${spec.executePermission} 权限`);
  const text = requiredText(reason, 1000);
  const request = {
    approval_id: store.next('dap'), action, target_id: String(target_id || '').trim(), payload_json: payload == null ? null : JSON.stringify(payload),
    requested_by, approved_by: null, rejected_by: null, state: 'REQUESTED', request_reason: text,
    created_at: new Date(now).toISOString(), expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(), decided_at: null, executed_at: null
  };
  store.dualApprovalRequests.set(request.approval_id, request);
  appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: requested_by, action: 'DUAL_APPROVAL_REQUESTED', resource_type: 'DUAL_APPROVAL', resource_id: request.approval_id, before: null, after: { action, target_id: request.target_id }, reason: text });
  return request;
}

function decideApprovalRequest(store, { approval_id, reviewer_id, reviewer_roles, decision, reason }, { now = Date.now() } = {}) {
  const request = store.dualApprovalRequests.get(approval_id);
  if (!request) throw apiErrorLike(404, 'RESOURCE_NOT_FOUND', '审批请求不存在');
  if (request.state !== 'REQUESTED') throw apiErrorLike(409, 'STATE_TRANSITION_INVALID', `仅 REQUESTED 可决策（当前 ${request.state}）`);
  if (request.requested_by === reviewer_id) throw apiErrorLike(409, 'SELF_APPROVAL_FORBIDDEN', '申请人不能批准/驳回自己的请求（逻辑双人控制）');
  if (new Date(request.expires_at).getTime() <= now) return expireRequest(store, request, now);
  const spec = DUAL_CONTROLLED_ACTIONS[request.action];
  if (!can({ roles: reviewer_roles || [] }, spec.executePermission)) throw apiErrorLike(403, 'PERMISSION_DENIED', `批准 ${request.action} 需要 ${spec.executePermission} 权限`);
  if (decision === 'APPROVE') {
    request.state = 'APPROVED'; request.approved_by = reviewer_id; request.decided_at = new Date(now).toISOString();
    appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: reviewer_id, action: 'DUAL_APPROVAL_APPROVED', resource_type: 'DUAL_APPROVAL', resource_id: request.approval_id, before: { state: 'REQUESTED' }, after: { state: 'APPROVED' }, reason: requiredText(reason, 1000) });
  } else if (decision === 'REJECT') {
    request.state = 'REJECTED'; request.rejected_by = reviewer_id; request.decided_at = new Date(now).toISOString();
    appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: reviewer_id, action: 'DUAL_APPROVAL_REJECTED', resource_type: 'DUAL_APPROVAL', resource_id: request.approval_id, before: { state: 'REQUESTED' }, after: { state: 'REJECTED' }, reason: requiredText(reason, 1000) });
  } else {
    throw apiErrorLike(400, 'VALIDATION_ERROR', 'decision 只能是 APPROVE / REJECT');
  }
  return request;
}

function expireRequest(store, request, now) {
  request.state = 'EXPIRED'; request.decided_at = new Date(now).toISOString();
  appendOpsAudit(store, { actor_type: 'SYSTEM', actor_id: null, action: 'DUAL_APPROVAL_EXPIRED', resource_type: 'DUAL_APPROVAL', resource_id: request.approval_id, before: { state: 'REQUESTED' }, after: { state: 'EXPIRED' } });
  return request;
}

// 受控写操作执行前调用：必须有指向该目标的已批准且未消费的请求；
// 执行成功后由 markExecuted 消费（一次性）。
function requireApprovedRequestFor(store, { action, target_id, reviewer_id }, { now = Date.now() } = {}) {
  const candidates = [...store.dualApprovalRequests.values()].filter((request) =>
    request.action === action && request.target_id === String(target_id || '').trim()
    && request.state === 'APPROVED' && new Date(request.expires_at).getTime() > now);
  if (candidates.length === 0) throw apiErrorLike(409, 'DUAL_APPROVAL_REQUIRED', `执行 ${action} 需要另一名具备权限的审核员先批准双人审批请求（/internal/dual-approvals）`);
  const request = candidates.sort((a, b) => (a.decided_at < b.decided_at ? 1 : -1))[0];
  if (reviewer_id && request.approved_by === reviewer_id && request.requested_by === reviewer_id) throw apiErrorLike(409, 'SELF_APPROVAL_FORBIDDEN', '申请与批准不能是同一账号');
  return request;
}

function markExecuted(store, request, { executed_by, now = Date.now() } = {}) {
  request.state = 'EXECUTED'; request.executed_at = new Date(now).toISOString();
  appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: executed_by, action: 'DUAL_APPROVAL_EXECUTED', resource_type: 'DUAL_APPROVAL', resource_id: request.approval_id, before: { state: 'APPROVED' }, after: { state: 'EXECUTED' } });
  return request;
}

// ---- 运营审计（追加写：仓库不提供更新/删除入口；PG 侧由触发器强制，见迁移 055）----
function appendOpsAudit(store, entry) {
  const record = {
    audit_id: store.next('oae'), actor_type: entry.actor_type || 'REVIEWER', actor_id: entry.actor_id || null,
    action: entry.action, resource_type: entry.resource_type, resource_id: entry.resource_id ?? null,
    before: entry.before === undefined ? null : entry.before, after: entry.after === undefined ? null : entry.after,
    reason: entry.reason || null, ip: entry.ip || null, created_at: new Date().toISOString()
  };
  store.opsAuditEvents.set(record.audit_id, record);
  return record;
}

// ---- 敏感材料按需解密 + 查看留痕 ----
// 年龄申报材料在写入时以 AES-256-GCM 封装（QIYU_OPS_MATERIAL_KEY 派生），
// 队列视图永不返回原文；本函数按需解密并先留痕后返回。
function encryptMaterial(plaintext, keyHex) {
  const key = materialKey(keyHex);
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return { alg: 'AES-256-GCM', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptMaterial(envelope, keyHex) {
  const key = materialKey(keyHex);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function materialKey(keyHex) {
  const raw = String(keyHex || process.env.QIYU_OPS_MATERIAL_KEY || '');
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw apiErrorLike(503, 'MATERIAL_KEY_UNCONFIGURED', '未配置 64 位十六进制 QIYU_OPS_MATERIAL_KEY，无法按需解密年龄材料');
  return Buffer.from(raw, 'hex');
}

function viewSensitiveMaterial(store, { reviewer, material_type, resource_id, envelope, ip }) {
  const plaintext = decryptMaterial(envelope);
  appendOpsAudit(store, { actor_type: 'REVIEWER', actor_id: reviewer.reviewer_id, action: 'SENSITIVE_MATERIAL_VIEWED', resource_type: material_type, resource_id, after: { decrypted: true }, ip: ip || null, reason: '按需调取敏感材料（先留痕后解密）' });
  return plaintext;
}

// ---- 共享小工具（与 app.js 的 apiError 形状一致，避免域层依赖 HTTP 层）----
function apiErrorLike(status, code, message) {
  const error = new Error(message); error.status = status; error.code = code; return error;
}
function loginError(message = '用户名、密码或动态码错误') { return apiErrorLike(401, 'REVIEWER_LOGIN_FAILED', message); }
function requiredText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw apiErrorLike(400, 'VALIDATION_ERROR', `reason 必须为 1-${maxLength} 字`);
  return text;
}

module.exports = {
  ROLES, ROLE_LABELS, PERMISSION_ROLES, DUAL_CONTROLLED_ACTIONS,
  hashPassword, verifyPassword, generateTotpSecret, verifyTotp, totpAt, totpUri,
  createReviewerAccount, publicAccount, loginReviewer, authenticateReviewerSession, revokeReviewerSession, publicSession,
  can, createApprovalRequest, decideApprovalRequest, requireApprovedRequestFor, markExecuted, expireRequest,
  appendOpsAudit, encryptMaterial, decryptMaterial, viewSensitiveMaterial,
  MAX_FAILED_LOGINS, LOCK_DURATION_MS, SESSION_TTL_MS, APPROVAL_TTL_MS
};
