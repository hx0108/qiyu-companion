'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../src/domain/reviewer-identity');
const { DevelopmentStore } = require('../src/domain/store');

function seededStore() {
  const store = new DevelopmentStore();
  identity.createReviewerAccount(store, { reviewer_id: 'rev_a', username: 'alice', password: 'alice-password-123', roles: ['REVIEWER'] });
  identity.createReviewerAccount(store, { reviewer_id: 'rev_b', username: 'bob', password: 'bob-password-12345', roles: ['SECURITY_ADMIN', 'RELEASE'] });
  return store;
}

test('密码错误累计触发临时锁定，正确密码在锁定期内仍被拒绝，锁定全程留审计', () => {
  const store = seededStore();
  for (let attempt = 0; attempt < identity.MAX_FAILED_LOGINS; attempt += 1) {
    assert.throws(() => identity.loginReviewer(store, { username: 'alice', password: 'wrong-password-x' }), (error) => error.code === 'REVIEWER_LOGIN_FAILED');
  }
  // 第 MAX_FAILED_LOGINS 次失败后账号锁定：正确密码也被拒（423）。
  assert.throws(() => identity.loginReviewer(store, { username: 'alice', password: 'alice-password-123' }), (error) => error.code === 'REVIEWER_ACCOUNT_LOCKED');
  const lockedAudit = [...store.opsAuditEvents.values()].filter((event) => event.action === 'REVIEWER_LOGIN_REJECTED_LOCKED');
  assert.equal(lockedAudit.length, 1);
  // 锁定期过后成功登录并清零计数。
  const later = Date.now() + identity.LOCK_DURATION_MS + 1000;
  const result = identity.loginReviewer(store, { username: 'alice', password: 'alice-password-123' }, { now: later });
  assert.ok(result.session_token.startsWith('ops_'));
  assert.equal(store.reviewerAccounts.get('rev_a').failed_login_attempts, 0);
});

test('TOTP：启用 MFA 的账号无码/错码拒绝、正确动态码通过；±1 步漂移可容忍', () => {
  const store = new DevelopmentStore();
  const secret = identity.generateTotpSecret();
  identity.createReviewerAccount(store, { reviewer_id: 'rev_m', username: 'mfa-user', password: 'mfa-password-123', roles: ['REVIEWER'], mfa_required: true, mfa_secret: secret });
  const now = Date.now();
  assert.throws(() => identity.loginReviewer(store, { username: 'mfa-user', password: 'mfa-password-123' }, { now }), (error) => error.code === 'REVIEWER_LOGIN_FAILED');
  assert.throws(() => identity.loginReviewer(store, { username: 'mfa-user', password: 'mfa-password-123', totp_code: '000000' }, { now }), (error) => error.code === 'REVIEWER_LOGIN_FAILED');
  const good = identity.totpAt(secret, Math.floor(now / 1000));
  // 漂移容忍：31 秒后仍用"上一步"的动态码登录（verifyTotp 允许 ±1 步）。
  const previousStepCode = identity.totpAt(secret, Math.floor(now / 1000));
  const ok = identity.loginReviewer(store, { username: 'mfa-user', password: 'mfa-password-123', totp_code: good }, { now });
  const okDrift = identity.loginReviewer(store, { username: 'mfa-user', password: 'mfa-password-123', totp_code: previousStepCode }, { now: now + 31_000 });
  assert.ok(ok.session_token && okDrift.session_token);
});

test('会话过期与吊销后立即失效；吊销动作本身写入审计', () => {
  const store = seededStore();
  const now = Date.now();
  const { session_token } = identity.loginReviewer(store, { username: 'alice', password: 'alice-password-123' }, { now });
  assert.ok(identity.authenticateReviewerSession(store, session_token, { now }));
  assert.equal(identity.revokeReviewerSession(store, session_token), true);
  assert.equal(identity.authenticateReviewerSession(store, session_token, { now }), null);
  const revokedAudit = [...store.opsAuditEvents.values()].some((event) => event.action === 'REVIEWER_SESSION_REVOKED');
  assert.equal(revokedAudit, true);
  // 过期同样失效。
  const second = identity.loginReviewer(store, { username: 'alice', password: 'alice-password-123' }, { now });
  assert.equal(identity.authenticateReviewerSession(store, second.session_token, { now: now + identity.SESSION_TTL_MS + 1 }), null);
});

test('RBAC 权限矩阵：审核员不能人工发放订阅，安全管理员可以；未知权限显式报错', () => {
  const store = seededStore();
  const alice = store.reviewerAccounts.get('rev_a');
  const bob = store.reviewerAccounts.get('rev_b');
  assert.equal(identity.can(alice, 'DECIDE_AGE_REVIEW'), true);
  assert.equal(identity.can(alice, 'GRANT_SUBSCRIPTION'), false);
  assert.equal(identity.can(bob, 'GRANT_SUBSCRIPTION'), true);
  assert.throws(() => identity.can(alice, 'NOT_A_PERMISSION'));
});

test('双人审批状态机：申请→自我批准被拒→批准→执行消费；驳回与过期为终态', () => {
  const store = seededStore();
  const now = Date.now();
  const request = identity.createApprovalRequest(store, {
    action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_1', requested_by: 'rev_b', requester_roles: ['SECURITY_ADMIN'], reason: '退款'
  }, { now });
  // 申请人不能自我批准。
  assert.throws(() => identity.decideApprovalRequest(store, { approval_id: request.approval_id, reviewer_id: 'rev_b', reviewer_roles: ['SECURITY_ADMIN'], decision: 'APPROVE', reason: 'x' }), (error) => error.code === 'SELF_APPROVAL_FORBIDDEN');
  // 无对应权限的角色不能批准。
  assert.throws(() => identity.decideApprovalRequest(store, { approval_id: request.approval_id, reviewer_id: 'rev_a', reviewer_roles: ['REVIEWER'], decision: 'APPROVE', reason: 'x' }), (error) => error.code === 'PERMISSION_DENIED');
  identity.decideApprovalRequest(store, { approval_id: request.approval_id, reviewer_id: 'rev_a', reviewer_roles: ['REVIEWER', 'SECURITY_ADMIN'], decision: 'APPROVE', reason: '同意' }, { now });
  // 批准后执行一次即消费（EXECUTED），重复执行要求新审批。
  const approvedRequest = identity.requireApprovedRequestFor(store, { action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_1' }, { now });
  identity.markExecuted(store, approvedRequest, { executed_by: 'rev_b', now });
  assert.throws(() => identity.requireApprovedRequestFor(store, { action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_1' }, { now }), (error) => error.code === 'DUAL_APPROVAL_REQUIRED');
  // 驳回终态。
  const rejected = identity.createApprovalRequest(store, { action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_2', requested_by: 'rev_b', requester_roles: ['SECURITY_ADMIN'], reason: 'r' }, { now });
  identity.decideApprovalRequest(store, { approval_id: rejected.approval_id, reviewer_id: 'rev_a', reviewer_roles: ['REVIEWER', 'SECURITY_ADMIN'], decision: 'REJECT', reason: '凭证不足' }, { now });
  assert.equal(rejected.state, 'REJECTED');
  assert.throws(() => identity.decideApprovalRequest(store, { approval_id: rejected.approval_id, reviewer_id: 'rev_a', reviewer_roles: ['REVIEWER', 'SECURITY_ADMIN'], decision: 'APPROVE', reason: 'x' }), (error) => error.code === 'STATE_TRANSITION_INVALID');
  // 超时未决策自动过期。
  const stale = identity.createApprovalRequest(store, { action: 'SUBSCRIPTION_MANUAL_REVOKE', target_id: 'sub_3', requested_by: 'rev_b', requester_roles: ['SECURITY_ADMIN'], reason: 'r' }, { now });
  const expired = identity.decideApprovalRequest(store, { approval_id: stale.approval_id, reviewer_id: 'rev_a', reviewer_roles: ['REVIEWER', 'SECURITY_ADMIN'], decision: 'APPROVE', reason: 'x' }, { now: now + identity.APPROVAL_TTL_MS + 1000 });
  assert.equal(expired.state, 'EXPIRED');
});

test('敏感材料：AES-GCM 封装往返、错钥拒绝、按需查看必须先留痕', () => {
  const store = seededStore();
  const key = 'a'.repeat(64);
  process.env.QIYU_OPS_MATERIAL_KEY = key;
  try {
    const envelope = identity.encryptMaterial('{"date_of_birth":"1990-01-01"}', key);
    assert.equal(envelope.alg, 'AES-256-GCM');
    assert.equal(identity.decryptMaterial(envelope, key), '{"date_of_birth":"1990-01-01"}');
    assert.throws(() => identity.decryptMaterial(envelope, 'b'.repeat(64)));
    const plaintext = identity.viewSensitiveMaterial(store, {
      reviewer: { reviewer_id: 'rev_b' }, material_type: 'AGE_DECLARATION', resource_id: 'acct_x', envelope, ip: '127.0.0.1'
    });
    assert.equal(JSON.parse(plaintext).date_of_birth, '1990-01-01');
    const viewAudit = [...store.opsAuditEvents.values()].filter((event) => event.action === 'SENSITIVE_MATERIAL_VIEWED');
    assert.equal(viewAudit.length, 1);
    assert.equal(viewAudit[0].actor_id, 'rev_b');
    assert.equal(viewAudit[0].ip, '127.0.0.1');
    // 未配置密钥时明确拒绝而不是回退明文。
    delete process.env.QIYU_OPS_MATERIAL_KEY;
    assert.throws(() => identity.decryptMaterial(envelope), (error) => error.code === 'MATERIAL_KEY_UNCONFIGURED');
  } finally {
    delete process.env.QIYU_OPS_MATERIAL_KEY;
  }
});

test('密码哈希：scrypt 存储、验签常数时间比较、错误密码不匹配', () => {
  const stored = identity.hashPassword('correct-horse-battery');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(identity.verifyPassword('correct-horse-battery', stored), true);
  assert.equal(identity.verifyPassword('wrong', stored), false);
  assert.equal(identity.verifyPassword('x', null), false);
});
