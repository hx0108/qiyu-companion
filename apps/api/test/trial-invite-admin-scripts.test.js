'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseListOptions } = require('../scripts/list-trial-invites');
const { parseRevokeOptions } = require('../scripts/revoke-trial-invite');

test('邀请码运维脚本只输出无凭据元数据，并限制列表范围', () => {
  assert.deepEqual(parseListOptions([]), { limit: 20 });
  assert.deepEqual(parseListOptions(['--limit', '100']), { limit: 100 });
  assert.throws(() => parseListOptions(['--limit', '101']), /1 to 100/);
  const source = readFileSync(path.resolve(__dirname, '../scripts/list-trial-invites.js'), 'utf8');
  assert.doesNotMatch(source, /invite_code_hash|initial_secret_hash/);
});

test('撤销邀请码要求 UUID 与显式确认，并且只撤销会话、不删除账户', () => {
  const inviteId = '018f0e48-1234-7abc-8def-0123456789ab';
  assert.deepEqual(parseRevokeOptions(['--invite-id', inviteId, '--confirm', 'REVOKE']), { inviteId });
  assert.throws(() => parseRevokeOptions(['--invite-id', inviteId]), /--confirm REVOKE/);
  assert.throws(() => parseRevokeOptions(['--invite-id', 'not-an-id', '--confirm', 'REVOKE']), /must be a UUID/);
  const source = readFileSync(path.resolve(__dirname, '../scripts/revoke-trial-invite.js'), 'utf8');
  assert.match(source, /UPDATE trial_sessions[\s\S]*SET revoked_at/);
  assert.match(source, /status = 'REVOKED'/);
  assert.doesNotMatch(source, /DELETE FROM accounts/i);
});
