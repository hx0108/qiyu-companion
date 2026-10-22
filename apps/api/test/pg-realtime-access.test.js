'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');
const { PostgresStore } = require('../src/persistence/postgres-store');
const databaseUrl = process.env.QIYU_PG_TEST_DATABASE_URL;

test('真实PG原生PCM窄授权：RLS、撤销、年龄、告知、暂停、角色、过期与100次时延', { skip: !databaseUrl && '需要本机隔离QIYU_PG_TEST_DATABASE_URL', timeout: 30000 }, async (t) => {
  const target = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: databaseUrl, max: 4 }); t.after(() => pool.end());
  const store = new PostgresStore({ pool });
  const accountId = randomUUID(), bobId = randomUUID(), characterId = randomUUID(), conversationId = randomUUID(), noticeId = randomUUID();
  await pool.query("INSERT INTO accounts(account_id,age_status) VALUES ($1,'AGE_PASS'),($2,'AGE_PASS')", [accountId, bobId]);
  await pool.query('INSERT INTO account_interaction_controls(account_id) VALUES ($1),($2)', [accountId, bobId]);
  await pool.query("INSERT INTO required_notices(notice_id,account_id,type,notice_version,state,displayed_at) VALUES ($1,$2,'AI_IDENTITY','test-native','DISPLAYED',CURRENT_TIMESTAMP)", [noticeId, accountId]);
  await pool.query("INSERT INTO characters(character_id,account_id,display_name) VALUES ($1,$2,'原生合成测试')", [characterId, accountId]);
  await pool.query("INSERT INTO conversations(conversation_id,account_id,character_id,retention_expires_at) VALUES ($1,$2,$3,CURRENT_TIMESTAMP+interval '1 day')", [conversationId, accountId, characterId]);
  const snapshot = { accountId, conversationId, characterId, revocationEpoch: 0, characterVersion: 1 };
  assert.equal(await store.checkRealtimeAccess(snapshot), true);
  await assert.rejects(store.checkRealtimeAccess({ ...snapshot, accountId: bobId }), { code: 'RESOURCE_NOT_FOUND' });
  const cases = [
    ["UPDATE accounts SET revocation_epoch=1 WHERE account_id=$1", "UPDATE accounts SET revocation_epoch=0 WHERE account_id=$1", accountId, 'REALTIME_CONTEXT_CHANGED'],
    ["UPDATE accounts SET age_status='AGE_REVIEW' WHERE account_id=$1", "UPDATE accounts SET age_status='AGE_PASS' WHERE account_id=$1", accountId, 'AGE_NOT_PASSED'],
    ["UPDATE account_interaction_controls SET user_pause_state='USER_PAUSED' WHERE account_id=$1", "UPDATE account_interaction_controls SET user_pause_state='ACTIVE' WHERE account_id=$1", accountId, 'USER_PAUSED'],
    ["UPDATE required_notices SET displayed_at=NULL WHERE notice_id=$1", "UPDATE required_notices SET displayed_at=CURRENT_TIMESTAMP WHERE notice_id=$1", noticeId, 'REQUIRED_NOTICE_PENDING'],
    ["UPDATE characters SET version=2 WHERE character_id=$1", "UPDATE characters SET version=1 WHERE character_id=$1", characterId, 'REALTIME_CONTEXT_CHANGED'],
    ["UPDATE conversations SET retention_expires_at=CURRENT_TIMESTAMP-interval '1 second' WHERE conversation_id=$1", "UPDATE conversations SET retention_expires_at=CURRENT_TIMESTAMP+interval '1 day' WHERE conversation_id=$1", conversationId, 'REALTIME_CONTEXT_CHANGED'],
    ["UPDATE conversations SET deleted_at=CURRENT_TIMESTAMP WHERE conversation_id=$1", "UPDATE conversations SET deleted_at=NULL WHERE conversation_id=$1", conversationId, 'RESOURCE_NOT_FOUND']
  ];
  for (const [change, restore, id, code] of cases) {
    assert.equal(await store.checkRealtimeAccess(snapshot), true);
    await pool.query(change, [id]); await assert.rejects(store.checkRealtimeAccess(snapshot), { code }); await pool.query(restore, [id]);
    // The real schema monotonically increments version on every UPDATE, even a
    // fixture's attempted restore. Capture the restored current version rather
    // than weakening the production comparison or disabling its trigger.
    snapshot.characterVersion = Number((await pool.query('SELECT version FROM characters WHERE character_id=$1', [characterId])).rows[0].version);
  }
  const samples = [];
  for (let index = 0; index < 100; index += 1) {
    const before = performance.now(); await store.checkRealtimeAccess(snapshot); samples.push(performance.now() - before);
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ source: 'local-isolated-postgres-not-network-SLA', samples: samples.length, p50_ms: +samples[49].toFixed(2), p95_ms: +samples[94].toFixed(2), max_ms: +samples[99].toFixed(2) }));
  assert.ok(samples.every(Number.isFinite));
});
