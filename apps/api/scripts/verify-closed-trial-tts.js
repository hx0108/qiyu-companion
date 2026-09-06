'use strict';

// Docker-only TTS acceptance probe. It prints only provider/job metadata and
// never prints credentials, tokens, conversation text, model text or object keys.
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { credentialHash, hashInitialSecret, normalizeInviteCode } = require('../src/domain/trial-invite-auth');

const baseUrl = process.env.QIYU_ACCEPTANCE_BASE_URL || 'http://127.0.0.1:3000';
let currentStage = 'startup';

function inviteCode() {
  const value = randomBytes(12).toString('hex').toUpperCase();
  return normalizeInviteCode(`QY${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12, 18)}-${value.slice(18, 24)}`);
}

async function request(path, { method = 'GET', token = null, body = undefined, binary = false } = {}) {
  const headers = { accept: binary ? 'audio/mpeg' : 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['idempotency-key'] = `tts-acceptance-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`acceptance request failed: ${payload?.error?.code || `HTTP_${response.status}`}`);
  }
  if (binary) return { contentType: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) };
  return response.json();
}

async function main() {
  const required = ['DATABASE_URL', 'QWEN_API_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_TTS_VOICE_TYPE', 'TENCENT_COS_BUCKET'];
  for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);
  if (process.env.QIYU_TRIAL_AUTH !== 'invite') throw new Error('QIYU_TRIAL_AUTH=invite is required.');
  if (process.env.QIYU_TTS_PROVIDER !== 'tencent') throw new Error('QIYU_TTS_PROVIDER=tencent is required.');
  if (process.env.QIYU_PRIVATE_MEDIA_STORE !== 'tencent-cos') throw new Error('QIYU_PRIVATE_MEDIA_STORE=tencent-cos is required.');

  const code = inviteCode();
  const initialSecret = randomBytes(32).toString('base64url');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let inviteId = null;
  let accountId = null;
  let resultAssetId = null;
  let accessToken = null;
  try {
    await client.connect();
    currentStage = 'invite-create';
    const inserted = await client.query(`INSERT INTO trial_invites (invite_code_hash, initial_secret_hash, label, expires_at)
      VALUES ($1, $2, 'tts-acceptance-probe', CURRENT_TIMESTAMP + interval '1 hour') RETURNING invite_id`,
    [credentialHash(code), await hashInitialSecret(initialSecret)]);
    inviteId = inserted.rows[0].invite_id;
    currentStage = 'trial-login';
    const login = await request('/auth/trial-sessions', { method: 'POST', body: { invite_code: code, initial_secret: initialSecret } });
    accountId = login.account.account_id;
    accessToken = login.tokens.access_token;
    currentStage = 'notice-and-age';
    const notices = await request('/required-notices', { token: accessToken });
    await request(`/required-notices/${encodeURIComponent(notices.notices[0].notice_id)}/displayed`, { method: 'POST', token: accessToken, body: { notice_version: notices.notices[0].notice_version } });
    await request('/age/declarations', { method: 'POST', token: accessToken, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
    // TTS is a metered trial capability. Claim the explicit, non-renewing
    // seven-day trial before attempting the media job.
    currentStage = 'trial-entitlement';
    await request('/subscription-trials', { method: 'POST', token: accessToken, body: {} });
    currentStage = 'character-and-conversation';
    const character = await request('/characters', { method: 'POST', token: accessToken, body: { name: '语音验收角色' } });
    const conversation = await request('/conversations', { method: 'POST', token: accessToken, body: { character_id: character.character.character_id } });
    currentStage = 'assistant-message';
    const message = await request(`/conversations/${encodeURIComponent(conversation.conversation.conversation_id)}/messages`, {
      method: 'POST', token: accessToken, body: { content: { text: '请只用一句简短的话回应我。' }, stream: false }
    });
    currentStage = 'tts-job';
    const tts = await request(`/messages/${encodeURIComponent(message.assistant_message.message_id)}/tts-jobs`, { method: 'POST', token: accessToken, body: {} });
    if (tts.tts_job?.state !== 'COMPLETED' || !tts.tts_job.result_asset_id) {
      throw new Error(`TTS job did not complete: ${tts.tts_job?.failure_code || tts.tts_job?.state || 'unknown'}`);
    }
    resultAssetId = tts.tts_job.result_asset_id;
    currentStage = 'media-read';
    const audio = await request(`/media-assets/${encodeURIComponent(resultAssetId)}/content`, { token: accessToken, binary: true });
    if (!audio.contentType?.startsWith('audio/mpeg') || audio.bytes.length === 0) throw new Error('TTS media response was not a non-empty MP3.');
    const metric = await client.query(`SELECT count(*)::int AS count, max(provider) AS provider, max(model_version) AS model_version
      FROM operation_metrics WHERE account_id = $1 AND capability = 'TTS' AND outcome = 'COMPLETED'`, [accountId]);
    if (metric.rows[0].count < 1 || metric.rows[0].provider !== 'tencent-tts') throw new Error('Completed Tencent TTS metric was not recorded.');
    currentStage = 'complete';
    console.log(JSON.stringify({ acceptance: 'passed', provider: metric.rows[0].provider, model_version: metric.rows[0].model_version, job_state: tts.tts_job.state, media_type: audio.contentType, audio_bytes: audio.bytes.length }));
  } finally {
    if (resultAssetId && accessToken) await request(`/media-assets/${encodeURIComponent(resultAssetId)}`, { method: 'DELETE', token: accessToken }).catch(() => {});
    if (inviteId) await client.query('UPDATE trial_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE invite_id = $1 AND revoked_at IS NULL', [inviteId]).catch(() => {});
    if (inviteId) await client.query("UPDATE trial_invites SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP WHERE invite_id = $1", [inviteId]).catch(() => {});
    if (accountId) await client.query("UPDATE accounts SET account_status = 'CLOSED' WHERE account_id = $1", [accountId]).catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`封闭试用 TTS 验收失败（${currentStage}）：${error.message}`);
  process.exitCode = 1;
});
