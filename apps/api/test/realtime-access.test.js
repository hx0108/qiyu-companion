'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore } = require('../src/persistence/postgres-store');

function fixture(change = {}) {
  const queries = [];
  const row = { account_id: 'a', account_status: 'OPEN', age_status: 'AGE_PASS', revocation_epoch: 2, user_pause_state: 'ACTIVE', safety_mode: 'R0_NORMAL', service_mode: 'FULL', character_version: 3, conversation_status: 'ACTIVE', retention_valid: true, notice_displayed_at: '2026-10-01T00:00:00Z', ...change };
  const client = { async query(sql, params) { queries.push({ sql, params }); return { rows: sql.includes('SELECT a.account_id') ? [row] : [] }; }, release() {} };
  return { queries, store: new PostgresStore({ pool: { async connect() { return client; } } }) };
}
const snapshot = { accountId: 'a', conversationId: 'c', characterId: 'ch', revocationEpoch: 2, characterVersion: 3 };

test('native PCM authorization uses a scoped narrow read without loading message/media tables or daily lock', async () => {
  const f = fixture(); assert.equal(await f.store.checkRealtimeAccess(snapshot), true);
  assert.equal(f.queries.length, 5);
  assert.equal(f.queries[0].sql, 'BEGIN'); assert.equal(f.queries[4].sql, 'COMMIT');
  assert.ok(f.queries[2].sql.includes('set_config')); assert.deepEqual(f.queries[3].params, ['a', 'c', 'ch']);
  assert.equal(f.queries.some((item) => /daily_chat_usage|media_jobs|FROM messages|FOR UPDATE/.test(item.sql)), false);
});

test('native PCM authorization revokes on epoch, persona, age, pause, notice and expiry changes', async () => {
  for (const [change, code] of [
    [{ revocation_epoch: 3 }, 'REALTIME_CONTEXT_CHANGED'], [{ character_version: 4 }, 'REALTIME_CONTEXT_CHANGED'],
    [{ age_status: 'AGE_REVIEW' }, 'AGE_NOT_PASSED'], [{ user_pause_state: 'USER_PAUSED' }, 'USER_PAUSED'],
    [{ notice_displayed_at: null }, 'REQUIRED_NOTICE_PENDING'], [{ retention_valid: false }, 'REALTIME_CONTEXT_CHANGED']
  ]) {
    const f = fixture(change); await assert.rejects(f.store.checkRealtimeAccess(snapshot), { code });
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK');
  }
});
