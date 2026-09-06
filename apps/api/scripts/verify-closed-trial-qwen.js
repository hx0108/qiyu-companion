'use strict';

// Docker-only acceptance probe. It never prints credentials, tokens, user
// text, model text or a connection string. The created account is closed and
// its invite/session revoked before exit, leaving no usable test credential.
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { credentialHash, hashInitialSecret, normalizeInviteCode } = require('../src/domain/trial-invite-auth');

const baseUrl = process.env.QIYU_ACCEPTANCE_BASE_URL || 'http://127.0.0.1:3000';

function code() {
  const value = randomBytes(12).toString('hex').toUpperCase();
  return normalizeInviteCode(`QY${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12, 18)}-${value.slice(18, 24)}`);
}

async function request(path, { method = 'GET', token = null, body = undefined } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = `qwen-acceptance-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload?.error?.code || `HTTP_${response.status}`;
    throw new Error(`acceptance request failed: ${code}`);
  }
  return payload;
}

async function main() {
  if (process.env.QIYU_TRIAL_AUTH !== 'invite') throw new Error('QIYU_TRIAL_AUTH=invite is required.');
  if (process.env.QIYU_LLM_PROVIDER !== 'qwen' || !process.env.QWEN_API_KEY) throw new Error('QIYU_LLM_PROVIDER=qwen and QWEN_API_KEY are required.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const inviteCode = code();
  const initialSecret = randomBytes(32).toString('base64url');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let inviteId = null;
  let accountId = null;
  try {
    await client.connect();
    const inserted = await client.query(`INSERT INTO trial_invites (invite_code_hash, initial_secret_hash, label, expires_at)
      VALUES ($1, $2, 'qwen-acceptance-probe', CURRENT_TIMESTAMP + interval '1 hour') RETURNING invite_id`,
    [credentialHash(inviteCode), await hashInitialSecret(initialSecret)]);
    inviteId = inserted.rows[0].invite_id;
    const login = await request('/auth/trial-sessions', { method: 'POST', body: { invite_code: inviteCode, initial_secret: initialSecret } });
    accountId = login.account.account_id;
    const token = login.tokens.access_token;
    const notices = await request('/required-notices', { token });
    await request(`/required-notices/${encodeURIComponent(notices.notices[0].notice_id)}/displayed`, { method: 'POST', token, body: { notice_version: notices.notices[0].notice_version } });
    await request('/age/declarations', { method: 'POST', token, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
    const character = await request('/characters', { method: 'POST', token, body: { name: '验收角色' } });
    const conversation = await request('/conversations', { method: 'POST', token, body: { character_id: character.character.character_id } });
    const message = await request(`/conversations/${encodeURIComponent(conversation.conversation.conversation_id)}/messages`, {
      method: 'POST', token, body: { content: { text: '请用一句简短的话回应：验收完成。' }, stream: false }
    });
    if (message.provider !== 'qwen') throw new Error(`Qwen returned an unacceptable provider state: ${message.provider || 'missing'}`);
    const metric = await client.query(`SELECT count(*)::int AS count, max(model_version) AS model_version FROM operation_metrics
      WHERE account_id = $1 AND capability = 'CHAT_GENERATION' AND provider = 'qwen' AND outcome = 'COMPLETED'`, [accountId]);
    if (metric.rows[0].count < 1) throw new Error('Qwen call was not recorded as a completed no-content metric.');
    if (typeof metric.rows[0].model_version !== 'string' || !metric.rows[0].model_version) throw new Error('Qwen call metric did not retain a model version.');
    console.log(JSON.stringify({ acceptance: 'passed', provider: message.provider, model_version: metric.rows[0].model_version, completed_chat_metrics: metric.rows[0].count }));
  } finally {
    if (inviteId) await client.query('UPDATE trial_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE invite_id = $1 AND revoked_at IS NULL', [inviteId]).catch(() => {});
    if (inviteId) await client.query("UPDATE trial_invites SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP WHERE invite_id = $1", [inviteId]).catch(() => {});
    if (accountId) await client.query("UPDATE accounts SET account_status = 'CLOSED' WHERE account_id = $1", [accountId]).catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`封闭试用 Qwen 验收失败：${error.message}`);
  process.exitCode = 1;
});
