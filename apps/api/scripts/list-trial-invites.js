'use strict';

const { Client } = require('pg');

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseListOptions(argv = process.argv.slice(2)) {
  const limit = Number(argument(argv, '--limit') || 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100.');
  return { limit };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; run inside the API container or provide it through the deployment environment.');
  const { limit } = parseListOptions();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    // Never select credential hashes or any plaintext credentials. This output is
    // solely for an operator to identify an invite before revoking it.
    const result = await client.query(`SELECT invite_id, label, status, expires_at, created_at, first_claimed_at, last_login_at, revoked_at,
      CASE WHEN account_id IS NULL THEN 'UNCLAIMED' ELSE 'CLAIMED' END AS claim_state
      FROM trial_invites
      ORDER BY created_at DESC
      LIMIT $1`, [limit]);
    console.log(JSON.stringify({ invites: result.rows }, null, 2));
  } finally { await client.end().catch(() => {}); }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`读取试用邀请码失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseListOptions };
