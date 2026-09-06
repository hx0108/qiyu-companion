'use strict';

const { Client } = require('pg');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseRevokeOptions(argv = process.argv.slice(2)) {
  const inviteId = String(argument(argv, '--invite-id') || '').trim();
  if (!UUID_PATTERN.test(inviteId)) throw new Error('--invite-id must be a UUID returned by list-trial-invites.js.');
  if (argument(argv, '--confirm') !== 'REVOKE') throw new Error('Refusing to revoke. Re-run with --confirm REVOKE.');
  return { inviteId };
}

async function revokeInvite(client, inviteId) {
  await client.query('BEGIN');
  try {
    const selected = await client.query(`SELECT invite_id, status, account_id
      FROM trial_invites WHERE invite_id = $1 FOR UPDATE`, [inviteId]);
    const invite = selected.rows[0];
    if (!invite) throw new Error('Trial invite not found.');

    if (invite.status === 'REVOKED') {
      await client.query('COMMIT');
      return { invite_id: invite.invite_id, prior_status: invite.status, active_sessions_revoked: 0, already_revoked: true, account_preserved: Boolean(invite.account_id) };
    }

    const sessions = await client.query(`UPDATE trial_sessions
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE invite_id = $1 AND revoked_at IS NULL`, [inviteId]);
    await client.query(`UPDATE trial_invites
      SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
      WHERE invite_id = $1`, [inviteId]);
    await client.query('COMMIT');
    return { invite_id: invite.invite_id, prior_status: invite.status, active_sessions_revoked: sessions.rowCount, already_revoked: false, account_preserved: Boolean(invite.account_id) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; run inside the API container or provide it through the deployment environment.');
  const { inviteId } = parseRevokeOptions();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const result = await revokeInvite(client, inviteId);
    // No invite code, initial secret, access token or user content is emitted.
    console.log(JSON.stringify({ operation: 'trial_invite_revoked', ...result }, null, 2));
  } finally { await client.end().catch(() => {}); }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`撤销试用邀请码失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseRevokeOptions, revokeInvite };
