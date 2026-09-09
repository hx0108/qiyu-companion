'use strict';

// PostgreSQL 审核员身份仓库（迁移 055 的应用侧）：
// - login/lockout/session：行锁 + 域层 scrypt/TOTP 校验，计数与锁定原子更新；
// - withReviewerSession：审核员请求作用域数据库会话——事务内
//   SET LOCAL ROLE qiyu_reviewer + set_config('app.reviewer_id')，由 055 的
//   RLS 策略限定可见行（本人账号 / 本人参与的审批 / 安全管理员全量审计）；
// - 双人审批与审计：状态机与追加写审计落 PG；ops_audit_events 的
//   UPDATE/DELETE 被 055 触发器直接拒绝。
// 与 domain/reviewer-identity.js 语义一一对应；错误统一 {status, code, message}。

const nodeCrypto = require('node:crypto');
const domain = require('../domain/reviewer-identity');

const APPROVAL_ACTIONS = { PERSONA_STABLE_RELEASE: 'RELEASE_PERSONA', SUBSCRIPTION_MANUAL_REVOKE: 'REVOKE_SUBSCRIPTION' };
const SESSION_TTL_MS = domain.SESSION_TTL_MS;
const APPROVAL_TTL_MS = domain.APPROVAL_TTL_MS;

class PostgresReviewerIdentityRepository {
  constructor({ pool }) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgresReviewerIdentityRepository requires a pg-compatible pool');
    this.pool = pool;
  }

  // 审核员请求作用域数据库会话：以降权角色 + RLS 身份执行回调。
  async withReviewerSession(reviewerId, operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE qiyu_reviewer');
      await client.query("SELECT set_config('app.reviewer_id', $1, true)", [String(reviewerId)]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async login({ username, password, totp_code, ip }) {
    const name = String(username || '').trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM reviewer_accounts WHERE username = $1 FOR UPDATE', [name]);
      const account = rows[0];
      if (!account) { await client.query('COMMIT'); throw fail(401, 'REVIEWER_LOGIN_FAILED', '用户名、密码或动态码错误'); }
      const now = Date.now();
      if (account.state !== 'ACTIVE') throw fail(403, 'REVIEWER_ACCOUNT_SUSPENDED', '账号已停用');
      if (account.locked_until && new Date(account.locked_until).getTime() > now) {
        await this.auditOn(client, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_REJECTED_LOCKED', resource_type: 'REVIEWER_ACCOUNT', resource_id: account.reviewer_id, reason: `locked until ${account.locked_until}`, ip });
        await client.query('COMMIT');
        throw fail(423, 'REVIEWER_ACCOUNT_LOCKED', '失败次数过多，账号已临时锁定');
      }
      const passwordOk = domain.verifyPassword(password, account.password_hash);
      const mfaOk = !account.mfa_required || domain.verifyTotp(account.mfa_secret, totp_code, { now });
      if (!passwordOk || !mfaOk) {
        const attempts = account.failed_login_attempts + 1;
        const locked = attempts >= domain.MAX_FAILED_LOGINS;
        await client.query('UPDATE reviewer_accounts SET failed_login_attempts = $2, locked_until = $3 WHERE reviewer_id = $1',
          [account.reviewer_id, locked ? 0 : attempts, locked ? new Date(now + domain.LOCK_DURATION_MS).toISOString() : null]);
        await this.auditOn(client, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_FAILED', resource_type: 'REVIEWER_ACCOUNT', resource_id: account.reviewer_id, reason: passwordOk ? 'invalid totp' : 'invalid password', ip });
        await client.query('COMMIT');
        throw fail(401, 'REVIEWER_LOGIN_FAILED', locked ? '失败次数过多，账号已临时锁定' : '用户名、密码或动态码错误');
      }
      await client.query('UPDATE reviewer_accounts SET failed_login_attempts = 0, locked_until = NULL WHERE reviewer_id = $1', [account.reviewer_id]);
      const token = `ops_${nodeCrypto.randomBytes(24).toString('base64url')}`;
      const session = await client.query(`INSERT INTO reviewer_sessions (reviewer_id, token_hash, ip, expires_at) VALUES ($1, $2, $3, $4) RETURNING session_id, created_at, expires_at`,
        [account.reviewer_id, sha256(token), ip || null, new Date(now + SESSION_TTL_MS).toISOString()]);
      await this.auditOn(client, { actor_type: 'REVIEWER', actor_id: account.reviewer_id, action: 'REVIEWER_LOGIN_SUCCEEDED', resource_type: 'REVIEWER_SESSION', resource_id: session.rows[0].session_id, ip });
      await client.query('COMMIT');
      return {
        session_token: token,
        session: { session_id: session.rows[0].session_id, reviewer_id: account.reviewer_id, ip: ip || null, created_at: dateTime(session.rows[0].created_at), expires_at: dateTime(session.rows[0].expires_at), revoked_at: null },
        reviewer: domain.publicAccount(pgAccountToDomain(account))
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticateSession(token) {
    const { rows } = await this.pool.query(`SELECT s.session_id, s.expires_at, s.revoked_at, a.reviewer_id, a.username, a.display_name, a.roles, a.state
      FROM reviewer_sessions s JOIN reviewer_accounts a USING (reviewer_id) WHERE s.token_hash = $1`, [sha256(String(token || ''))]);
    const row = rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now() || row.state !== 'ACTIVE') return null;
    return { reviewer_id: row.reviewer_id, username: row.username, display_name: row.display_name, roles: row.roles, session_id: row.session_id };
  }

  async revokeSession(token) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('UPDATE reviewer_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL RETURNING session_id, reviewer_id', [sha256(String(token || ''))]);
      if (rows[0]) await this.auditOn(client, { actor_type: 'REVIEWER', actor_id: rows[0].reviewer_id, action: 'REVIEWER_SESSION_REVOKED', resource_type: 'REVIEWER_SESSION', resource_id: rows[0].session_id });
      await client.query('COMMIT');
      return Boolean(rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async listDualApprovals(state) {
    const { rows } = await this.pool.query(state
      ? 'SELECT * FROM dual_approval_requests WHERE state = $1 ORDER BY created_at DESC LIMIT 200'
      : 'SELECT * FROM dual_approval_requests ORDER BY created_at DESC LIMIT 200', state ? [state] : []);
    return rows.map(pgApprovalToDomain);
  }

  async createApproval({ action, target_id, payload, requested_by, requester_roles, reason }) {
    if (!APPROVAL_ACTIONS[action]) throw fail(400, 'VALIDATION_ERROR', `不受双人审批管理的动作：${action}`);
    if (!domain.can({ roles: requester_roles || [] }, APPROVAL_ACTIONS[action])) throw fail(403, 'PERMISSION_DENIED', `申请 ${action} 需要对应权限`);
    const text = requireText(reason);
    const { rows } = await this.pool.query(`INSERT INTO dual_approval_requests (action, target_id, payload_json, requested_by, request_reason, expires_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING *`,
      [action, String(target_id || '').trim(), payload == null ? null : JSON.stringify(payload), requested_by, text, new Date(Date.now() + APPROVAL_TTL_MS).toISOString()]);
    await this.appendAudit({ actor_type: 'REVIEWER', actor_id: requested_by, action: 'DUAL_APPROVAL_REQUESTED', resource_type: 'DUAL_APPROVAL', resource_id: rows[0].approval_id, after: { action, target_id: rows[0].target_id }, reason: text });
    return pgApprovalToDomain(rows[0]);
  }

  async decideApproval({ approval_id, reviewer_id, reviewer_roles, decision, reason }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM dual_approval_requests WHERE approval_id = $1 FOR UPDATE', [approval_id]);
      const request = rows[0];
      if (!request) throw fail(404, 'RESOURCE_NOT_FOUND', '审批请求不存在');
      if (request.state !== 'REQUESTED') throw fail(409, 'STATE_TRANSITION_INVALID', `仅 REQUESTED 可决策（当前 ${request.state}）`);
      if (request.requested_by === reviewer_id) throw fail(409, 'SELF_APPROVAL_FORBIDDEN', '申请人不能批准/驳回自己的请求（逻辑双人控制）');
      if (new Date(request.expires_at).getTime() <= Date.now()) {
        const expired = await client.query(`UPDATE dual_approval_requests SET state = 'EXPIRED', decided_at = CURRENT_TIMESTAMP WHERE approval_id = $1 RETURNING *`, [approval_id]);
        await client.query('COMMIT');
        return pgApprovalToDomain(expired.rows[0]);
      }
      if (!domain.can({ roles: reviewer_roles || [] }, APPROVAL_ACTIONS[request.action])) throw fail(403, 'PERMISSION_DENIED', `批准 ${request.action} 需要对应权限`);
      if (decision !== 'APPROVE' && decision !== 'REJECT') throw fail(400, 'VALIDATION_ERROR', 'decision 只能是 APPROVE / REJECT');
      const text = requireText(reason);
      const updated = await client.query(`UPDATE dual_approval_requests
        SET state = $2, approved_by = $3, rejected_by = $4, decided_at = CURRENT_TIMESTAMP WHERE approval_id = $1 RETURNING *`,
        [approval_id, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decision === 'APPROVE' ? reviewer_id : null, decision === 'REJECT' ? reviewer_id : null]);
      await this.auditOn(client, { actor_type: 'REVIEWER', actor_id: reviewer_id, action: decision === 'APPROVE' ? 'DUAL_APPROVAL_APPROVED' : 'DUAL_APPROVAL_REJECTED', resource_type: 'DUAL_APPROVAL', resource_id: approval_id, before: { state: 'REQUESTED' }, after: { state: updated.rows[0].state }, reason: text });
      await client.query('COMMIT');
      return pgApprovalToDomain(updated.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async requireApprovedFor({ action, target_id, reviewer_id }) {
    const { rows } = await this.pool.query(`SELECT * FROM dual_approval_requests
      WHERE action = $1 AND target_id = $2 AND state = 'APPROVED' AND expires_at > CURRENT_TIMESTAMP
      ORDER BY decided_at DESC LIMIT 1`, [action, String(target_id || '').trim()]);
    const request = rows[0];
    if (!request) throw fail(409, 'DUAL_APPROVAL_REQUIRED', `执行 ${action} 需要另一名具备权限的审核员先批准双人审批请求（/internal/dual-approvals）`);
    if (reviewer_id && request.approved_by === reviewer_id && request.requested_by === reviewer_id) throw fail(409, 'SELF_APPROVAL_FORBIDDEN', '申请与批准不能是同一账号');
    return pgApprovalToDomain(request);
  }

  async markExecuted(approval, executedBy) {
    const approvalId = typeof approval === 'object' && approval ? approval.approval_id : approval;
    const { rows } = await this.pool.query(`UPDATE dual_approval_requests SET state = 'EXECUTED', executed_at = CURRENT_TIMESTAMP WHERE approval_id = $1 AND state = 'APPROVED' RETURNING *`, [approvalId]);
    if (rows[0]) await this.appendAudit({ actor_type: 'REVIEWER', actor_id: executedBy, action: 'DUAL_APPROVAL_EXECUTED', resource_type: 'DUAL_APPROVAL', resource_id: approvalId, before: { state: 'APPROVED' }, after: { state: 'EXECUTED' } });
    return pgApprovalToDomain(rows[0]);
  }

  async appendAudit(entry) {
    const client = await this.pool.connect();
    try {
      await this.auditOn(client, entry);
    } finally {
      client.release();
    }
  }

  async auditOn(client, entry) {
    await client.query(`INSERT INTO ops_audit_events (actor_type, actor_id, action, resource_type, resource_id, before_json, after_json, reason, ip)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [entry.actor_type || 'REVIEWER', entry.actor_id || null, entry.action, entry.resource_type, entry.resource_id ?? null,
        entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
        entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
        entry.reason || null, entry.ip || null]);
  }

  async listAudit({ action, limit = 500 } = {}) {
    const { rows } = await this.pool.query(action
      ? 'SELECT * FROM ops_audit_events WHERE action = $1 ORDER BY created_at DESC LIMIT $2'
      : 'SELECT * FROM ops_audit_events ORDER BY created_at DESC LIMIT $2', action ? [action, limit] : [limit]);
    return rows.map((row) => ({
      audit_id: row.audit_id, actor_type: row.actor_type, actor_id: row.actor_id, action: row.action,
      resource_type: row.resource_type, resource_id: row.resource_id, before: row.before_json, after: row.after_json,
      reason: row.reason, ip: row.ip, created_at: dateTime(row.created_at)
    }));
  }
}

function pgAccountToDomain(row) {
  return { reviewer_id: row.reviewer_id, username: row.username, password_hash: row.password_hash, display_name: row.display_name, roles: row.roles, state: row.state, mfa_required: row.mfa_required, mfa_secret: row.mfa_secret, failed_login_attempts: row.failed_login_attempts, locked_until: row.locked_until ? dateTime(row.locked_until) : null, created_at: dateTime(row.created_at) };
}

function pgApprovalToDomain(row) {
  return {
    approval_id: row.approval_id, action: row.action, target_id: row.target_id, payload_json: row.payload_json ? JSON.stringify(row.payload_json) : null,
    requested_by: row.requested_by, approved_by: row.approved_by, rejected_by: row.rejected_by, state: row.state, request_reason: row.request_reason,
    created_at: dateTime(row.created_at), expires_at: dateTime(row.expires_at), decided_at: row.decided_at ? dateTime(row.decided_at) : null, executed_at: row.executed_at ? dateTime(row.executed_at) : null
  };
}

function sha256(value) { return nodeCrypto.createHash('sha256').update(value).digest('hex'); }
function dateTime(value) { return value instanceof Date ? value.toISOString() : String(value); }
function fail(status, code, message) { const error = new Error(message); error.status = status; error.code = code; return error; }
function requireText(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 1000) throw fail(400, 'VALIDATION_ERROR', 'reason 必须为 1-1000 字');
  return text;
}

module.exports = { PostgresReviewerIdentityRepository };
