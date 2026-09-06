'use strict';

const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { credentialHash, hashInitialSecret, normalizeInviteCode } = require('../src/domain/trial-invite-auth');

function argument(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseOptions(argv = process.argv.slice(2)) {
  const commandArgs = ['node', 'script', ...argv];
  const label = String(argument('--label', commandArgs) || '').trim();
  const days = Number(argument('--days', commandArgs) || 14);
  if (!label || label.length > 80) throw new Error('--label is required and must be 1-80 characters.');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be an integer from 1 to 90.');
  return { label, days };
}

function generatedInviteCode() {
  const value = randomBytes(12).toString('hex').toUpperCase();
  return `QY${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12, 18)}-${value.slice(18, 24)}`;
}

function oneTimeCredentialOutput({ inviteCode, initialSecret, days }) {
  // ASCII keys are intentionally easy to copy from Windows PowerShell and
  // avoid terminal-encoding ambiguity. Nothing is written to disk.
  return `INVITE_CODE=${inviteCode}\nINITIAL_SECRET=${initialSecret}\nEXPIRES_IN_DAYS=${days}\n`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; run inside the API container or provide it through the deployment environment.');
  const { label, days } = parseOptions();
  const inviteCode = normalizeInviteCode(generatedInviteCode());
  const initialSecret = randomBytes(32).toString('base64url');
  process.stderr.write('[qiyu] Connecting to the closed-trial database...\n');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query(`INSERT INTO trial_invites (invite_code_hash, initial_secret_hash, label, expires_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP + ($4 * interval '1 day'))`,
    [credentialHash(inviteCode), await hashInitialSecret(initialSecret), label, days]);
  } finally { await client.end().catch(() => {}); }
  process.stderr.write('[qiyu] Invite persisted. One-time credentials follow; do not save them to disk or Git.\n');
  process.stdout.write(oneTimeCredentialOutput({ inviteCode, initialSecret, days }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`创建试用邀请码失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { oneTimeCredentialOutput, parseOptions };
