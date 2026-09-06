'use strict';

const { randomUUID } = require('node:crypto');
const { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, TrialAuthError, credentialHash, issueTokens, normalizeInviteCode, verifyInitialSecret } = require('../domain/trial-invite-auth');

class PostgresTrialInviteAuthRepository {
  constructor({ pool } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgresTrialInviteAuthRepository requires a pg-compatible pool');
    this.pool = pool;
  }

  async createSession({ inviteCode, initialSecret }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inviteResult = await client.query(`SELECT invite_id, initial_secret_hash, status, account_id, expires_at
        FROM trial_invites WHERE invite_code_hash = $1 FOR UPDATE`, [credentialHash(normalizeInviteCode(inviteCode))]);
      const invite = inviteResult.rows[0];
      if (!invite || invite.status !== 'ACTIVE' || (invite.expires_at && new Date() >= new Date(invite.expires_at)) || !(await verifyInitialSecret(initialSecret, invite.initial_secret_hash))) {
        throw new TrialAuthError('TRIAL_INVITE_INVALID', '邀请码或试用口令不正确');
      }
      let accountId = invite.account_id;
      if (!accountId) {
        const accountResult = await client.query('INSERT INTO accounts DEFAULT VALUES RETURNING account_id');
        accountId = accountResult.rows[0].account_id;
        await client.query('INSERT INTO account_interaction_controls (account_id) VALUES ($1)', [accountId]);
        await client.query(`INSERT INTO required_notices (account_id, type, notice_version, state)
          VALUES ($1, 'AI_IDENTITY', 'ai_identity_m1.0', 'PENDING')`, [accountId]);
        await client.query(`UPDATE trial_invites SET account_id = $2, first_claimed_at = CURRENT_TIMESTAMP, last_login_at = CURRENT_TIMESTAMP
          WHERE invite_id = $1`, [invite.invite_id, accountId]);
      } else {
        await client.query('UPDATE trial_invites SET last_login_at = CURRENT_TIMESTAMP WHERE invite_id = $1', [invite.invite_id]);
      }
      await client.query('UPDATE trial_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE invite_id = $1 AND revoked_at IS NULL', [invite.invite_id]);
      const tokens = issueTokens();
      await client.query(`INSERT INTO trial_sessions (session_id, invite_id, account_id, access_token_hash, refresh_token_hash, expires_at, refresh_expires_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + ($6 * interval '1 second'), CURRENT_TIMESTAMP + ($7 * interval '1 second'))`,
      [randomUUID(), invite.invite_id, accountId, credentialHash(tokens.access_token), credentialHash(tokens.refresh_token), ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS]);
      await client.query('COMMIT');
      return { account_id: accountId, tokens };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Keep original error. */ }
      throw error;
    } finally { client.release(); }
  }

  async resolveAccessToken(token) {
    const result = await this.pool.query(`SELECT s.account_id FROM trial_sessions s
      JOIN trial_invites i ON i.invite_id = s.invite_id
      JOIN accounts a ON a.account_id = s.account_id
      WHERE s.access_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
        AND i.status = 'ACTIVE' AND (i.expires_at IS NULL OR i.expires_at > CURRENT_TIMESTAMP) AND a.account_status = 'OPEN'`, [credentialHash(String(token || ''))]);
    return result.rows[0]?.account_id || null;
  }

  async refreshSession({ refreshToken }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT s.session_id, s.invite_id, s.account_id FROM trial_sessions s
        JOIN trial_invites i ON i.invite_id = s.invite_id JOIN accounts a ON a.account_id = s.account_id
        WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.refresh_expires_at > CURRENT_TIMESTAMP
          AND i.status = 'ACTIVE' AND (i.expires_at IS NULL OR i.expires_at > CURRENT_TIMESTAMP) AND a.account_status = 'OPEN'
        FOR UPDATE`, [credentialHash(String(refreshToken || ''))]);
      const session = result.rows[0];
      if (!session) throw new TrialAuthError('TRIAL_SESSION_INVALID', '试用会话已失效，请重新输入邀请码和口令');
      const tokens = issueTokens();
      await client.query(`UPDATE trial_sessions SET access_token_hash = $2, refresh_token_hash = $3,
        expires_at = CURRENT_TIMESTAMP + ($4 * interval '1 second'), refresh_expires_at = CURRENT_TIMESTAMP + ($5 * interval '1 second'), rotated_at = CURRENT_TIMESTAMP
        WHERE session_id = $1`, [session.session_id, credentialHash(tokens.access_token), credentialHash(tokens.refresh_token), ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS]);
      await client.query('COMMIT');
      return { account_id: session.account_id, tokens };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Keep original error. */ }
      throw error;
    } finally { client.release(); }
  }
}

module.exports = { PostgresTrialInviteAuthRepository };
