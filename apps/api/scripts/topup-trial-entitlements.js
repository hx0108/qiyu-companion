'use strict';

// 一次性运营补授：给已领取试用（额度在领取时按当时的试用商品一次性发放，
// 商品定义后续调大不会自动补发）的账户补差额。2026-09-13 首用：语音输入
// 上线后试用档 asr 0→10 分钟、tts 5→30 分钟，存量账户需要补授才能使用。
// 幂等：idempotency_key = source_event:GRANT:capability，重复执行安全。

const { Client } = require('pg');

// 宽松 UUID 结构校验：账户/订阅 ID 由 app.uuid_v7() 生成，variant 位
// 不保证 RFC 4122 的 8-b 取值，只按 8-4-4-4-12 十六进制结构校验。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOptions(argv = process.argv.slice(2)) {
  const argument = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const accountId = String(argument('--account-id') || '').trim();
  const capability = String(argument('--capability') || '').trim();
  const seconds = Number(argument('--seconds'));
  const sourceEvent = String(argument('--source-event') || '').trim();
  if (!UUID_PATTERN.test(accountId)) throw new Error('--account-id must be a UUID.');
  if (!['TRANSCRIBE_ASR', 'SYNTHESIZE_TTS', 'IMAGE_GENERATION'].includes(capability)) throw new Error('--capability must be TRANSCRIBE_ASR / SYNTHESIZE_TTS / IMAGE_GENERATION.');
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('--seconds must be a positive integer.');
  if (!/^[\w:-]{1,120}$/.test(sourceEvent)) throw new Error('--source-event is required (used as idempotency scope).');
  if (argument('--confirm') !== 'TOPUP') throw new Error('Refusing to top up. Re-run with --confirm TOPUP.');
  return { accountId, capability, seconds, sourceEvent };
}

async function topup(client, { accountId, capability, seconds, sourceEvent }) {
  const idempotencyKey = `${sourceEvent}:GRANT:${capability}`;
  await client.query('BEGIN');
  try {
    const subscription = await client.query(
      `SELECT subscription_id, state, period_end FROM subscriptions
       WHERE account_id = $1 AND state = 'TRIAL' AND period_end > now() FOR UPDATE`,
      [accountId]
    );
    const trial = subscription.rows[0];
    if (!trial) throw new Error('No active TRIAL subscription for this account.');
    const entitlementId = `${trial.subscription_id}:${trial.period_end.toISOString()}`;
    const existing = await client.query('SELECT 1 FROM entitlement_ledgers WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      return { account_id: accountId, capability, entitlement_id: entitlementId, topped_up_seconds: 0, already_applied: true };
    }
    await client.query(
      `INSERT INTO entitlement_ledgers (entitlement_ledger_id, account_id, entitlement_id, capability, action, quantity, idempotency_key, source, source_event_id)
       VALUES (gen_random_uuid(), $1, $2, $3, 'GRANT', $4, $5, 'TRIAL_TOPUP', $6)`,
      [accountId, entitlementId, capability, seconds, idempotencyKey, sourceEvent]
    );
    const balances = await client.query(
      `SELECT capability,
              SUM(CASE WHEN action = 'GRANT' THEN quantity ELSE 0 END) AS granted,
              SUM(CASE WHEN action = 'COMMIT' THEN quantity ELSE 0 END) AS committed
       FROM entitlement_ledgers WHERE account_id = $1 AND entitlement_id = $2 GROUP BY capability`,
      [accountId, entitlementId]
    );
    await client.query('COMMIT');
    return { account_id: accountId, capability, entitlement_id: entitlementId, topped_up_seconds: seconds, already_applied: false, balances: balances.rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; run inside the API container or provide it through the deployment environment.');
  const options = parseOptions();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const result = await topup(client, options);
    // No invite code, access token or user content is emitted.
    console.log(JSON.stringify({ operation: 'trial_entitlement_topup', ...result }, null, 2));
  } finally { await client.end().catch(() => {}); }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`补授试用额度失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseOptions, topup };
