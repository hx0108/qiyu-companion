'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { DEVELOPMENT_DATABASE_ACCOUNT_IDS, PostgresStore } = require('../src/persistence/postgres-store');
const { createPersistenceFromEnvironment } = require('../src/persistence/composition');
const { createApp } = require('../src/app');

function fakePool({ rejectConcurrentQueries = false, loadActiveTrial = false, loadTtsJob = false } = {}) {
  const calls = [];
  let queryActive = false;
  const client = {
    async query(sql, values = []) {
      if (rejectConcurrentQueries && queryActive) throw new Error('concurrent query on one pg Client');
      queryActive = true;
      calls.push({ sql: String(sql), values });
      try {
        if (rejectConcurrentQueries) await new Promise((resolve) => setImmediate(resolve));
        if (String(sql).includes('FROM accounts a JOIN account_interaction_controls')) {
          return { rows: [{ account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice, account_status: 'OPEN', age_status: 'AGE_UNVERIFIED', retention_policy_id: 'RETENTION_30D', revocation_epoch: '0', user_pause_state: 'ACTIVE', safety_mode: 'R0_NORMAL', service_mode: 'FULL' }] };
        }
        if (String(sql).includes('FROM required_notices')) {
          return { rows: [{ notice_id: '00000000-0000-7000-8000-0000000000a3', account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice, type: 'AI_IDENTITY', notice_version: 'ai_identity_m1.0', state: 'PENDING', displayed_at: null }] };
        }
        if (String(sql).includes('FROM messages m JOIN conversations')) {
          return { rows: [{ message_id: '00000000-0000-7000-8000-0000000000d1', conversation_id: '00000000-0000-7000-8000-0000000000d2', actor: 'USER', text: '已持久化消息', provider: 'qwen', model_version: 'qwen3.8-flash', ai_generated: false, created_at: '2026-08-01T00:00:00.000Z' }] };
        }
        if (String(sql).includes('FROM daily_chat_usage')) {
          return { rows: [{ account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice, usage_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), chat_rounds: 2, billed_input_tokens: 6400, reserved_input_tokens: 0, updated_at: '2026-09-04T00:00:00.000Z' }] };
        }
        if (loadActiveTrial && String(sql).includes('FROM entitlement_ledgers')) {
          return { rows: [{
            entitlement_ledger_id: '00000000-0000-7000-8000-0000000000e1', account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice,
            entitlement_id: '00000000-0000-7000-8000-0000000000e2:2099-09-14T00:00:00.000Z', capability: 'SYNTHESIZE_TTS',
            action: 'GRANT', job_id: null, quantity: 300, reserved_quantity: null, idempotency_key: 'trial:GRANT:SYNTHESIZE_TTS',
            source: 'TRIAL_GRANTED', source_event_id: 'trial-test', created_at: new Date('2026-09-07T00:00:00.000Z')
          }] };
        }
        if (loadActiveTrial && String(sql).includes('FROM subscriptions WHERE')) {
          return { rows: [{
            subscription_id: '00000000-0000-7000-8000-0000000000e2', account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice,
            sku: 'qiyu_full_experience_trial_7d_v1', channel: 'DEVELOPMENT_TRIAL', state: 'TRIAL', auto_renew: false,
            disclosure_version: 'trial_full_experience_7d_v1', period_start: new Date('2099-09-07T00:00:00.000Z'),
            period_end: new Date('2099-09-14T00:00:00.000Z'), grace_period_end: null, refund_status: 'NONE',
            transaction_ref_hash: null, created_at: new Date('2099-09-07T00:00:00.000Z'), updated_at: new Date('2099-09-07T00:00:00.000Z')
          }] };
        }
        if (loadTtsJob && String(sql).includes('FROM media_jobs WHERE')) {
          return { rows: [{
            job_id: '00000000-0000-7000-8000-0000000000f1', account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice,
            character_id: '00000000-0000-7000-8000-0000000000f2', conversation_id: '00000000-0000-7000-8000-0000000000f3',
            source_message_id: '00000000-0000-7000-8000-0000000000f4', input_asset_id: null, reference_asset_id: null,
            entitlement_id: null, type: 'TTS', state: 'PENDING', attempts: 0, provider: 'tencent-tts', provider_request_id: null,
            provider_job_id: null, moderation_policy_version: null, result_asset_id: null, transcript_text: null, transcript_state: null,
            failure_code: null, provider_error_code: null, world_state_id: null, world_state_version: null, scene_contract: null,
            voice_id: 'tencent-standard-101001', voice_version: 'provider-catalog-2026-09', authorization_record_id: 'tts-auth',
            rights_review_id: 'tts-rights', rights_review_state: 'APPROVED', tts_text: '一句清洗后的台词。', emotion_category: 'happy',
            emotion_intensity: 110, emotion_source: 'world_state_mood', tts_speed: '0.20', created_at: new Date('2026-09-07T00:00:00.000Z')
          }] };
        }
        return { rows: [] };
      } finally {
        queryActive = false;
      }
    },
    release() { calls.push({ sql: 'RELEASE', values: [] }); }
  };
  return { calls, async connect() { return client; } };
}

test('PostgresStore scopes every request with a local RLS transaction and persists an M1 account transition', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  const response = await store.withAccountTransaction(accountId, async (scoped) => {
    assert.equal(scoped.account(accountId).age_status, 'AGE_UNVERIFIED');
    assert.equal(scoped.messages.get('00000000-0000-7000-8000-0000000000d1').created_at, '2026-08-01T00:00:00.000Z');
    scoped.account(accountId).age_status = 'AGE_PASS';
    scoped.account(accountId).raw_interaction_retention_days = 90;
    return { status: 200 };
  });
  assert.deepEqual(response, { status: 200 });
  assert.equal(pool.calls[0].sql, 'BEGIN');
  assert.ok(pool.calls.some((call) => call.sql === 'SET LOCAL ROLE qiyu_app'));
  const scope = pool.calls.find((call) => call.sql.includes("set_config('app.account_id'"));
  assert.deepEqual(scope.values, [accountId]);
  assert.ok(pool.calls.some((call) => call.sql.startsWith('INSERT INTO accounts')));
  const update = pool.calls.find((call) => call.sql.startsWith('UPDATE accounts SET age_status'));
  assert.deepEqual(update.values, [accountId, 'AGE_PASS', 'RETENTION_90D', 0, 'OPEN', '{"enabled":true,"quiet_start_hour":23,"quiet_end_hour":8,"timezone_offset_minutes":0}']);
  const controlsUpdate = pool.calls.find((call) => call.sql.startsWith('UPDATE account_interaction_controls SET safety_mode'));
  assert.deepEqual(controlsUpdate.values, [accountId, 'R0_NORMAL']);
  assert.equal(pool.calls.at(-2).sql, 'COMMIT');
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});

test('PostgresStore runs deferred SSE work in a fresh account transaction before releasing it', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  let runDeferred;
  await store.withAccountTransaction(accountId, async (scoped) => {
    runDeferred = scoped.runDeferredAccountTransaction;
  });
  assert.equal(typeof runDeferred, 'function');
  await runDeferred(async (scoped) => {
    scoped.account(accountId).age_status = 'AGE_PASS';
  }, { lockDailyUsage: true });
  assert.equal(pool.calls.filter((call) => call.sql === 'BEGIN').length, 2);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 2);
  assert.equal(pool.calls.filter((call) => call.sql === 'RELEASE').length, 2);
});

test('PostgresStore rolls back and releases the client when a scoped operation fails', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  await assert.rejects(() => store.withAccountTransaction(store.resolveAccountId('acct_dev_alice'), async () => { throw new Error('boom'); }), /boom/);
  assert.ok(pool.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!pool.calls.some((call) => call.sql === 'COMMIT'));
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});

test('PostgresStore loads one RLS-scoped pg Client sequentially', async () => {
  const pool = fakePool({ rejectConcurrentQueries: true });
  const store = new PostgresStore({ pool });
  await store.withAccountTransaction(store.resolveAccountId('acct_dev_alice'), async (scoped) => scoped.account(store.resolveAccountId('acct_dev_alice')));
  assert.equal(pool.calls.at(-2).sql, 'COMMIT');
});

test('PostgresStore normalizes subscription timestamps so persisted trial TTS quota remains active', async () => {
  const pool = fakePool({ loadActiveTrial: true });
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    const subscription = [...scoped.subscriptions.values()][0];
    assert.equal(subscription.period_end, '2099-09-14T00:00:00.000Z');
    assert.equal(subscription.created_at, '2099-09-07T00:00:00.000Z');
    const tts = scoped.mediaEntitlementService.entitlementBalances(accountId).find((item) => item.capability === 'SYNTHESIZE_TTS');
    assert.equal(tts.available_quantity, 300);
  });
});

test('PostgresStore vector recall stays inside the authenticated account, character, active state, indexed version, and matching embedding model version', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    // 缺 embeddingModelVersion（跨版本向量不可比）时不得发起任何向量查询。
    const guarded = await scoped.rankActiveAssetsByVector({ accountId, characterId: 'character-1', queryVector: new Array(256).fill(0), limit: 3 });
    assert.deepEqual(guarded, []);
    await scoped.rankActiveAssetsByVector({ accountId, characterId: 'character-1', queryVector: new Array(256).fill(0), embeddingModelVersion: 'deterministic-char-ngram-256-v1', limit: 3 });
  });
  const ranking = pool.calls.find((call) => call.sql.includes('FROM relationship_asset_embeddings AS embedding') && call.sql.includes('<=>'));
  assert.ok(ranking);
  assert.match(ranking.sql, /embedding\.account_id = \$1/);
  assert.match(ranking.sql, /embedding\.character_id = \$2/);
  assert.match(ranking.sql, /embedding\.embedding_model_version = \$4/);
  assert.match(ranking.sql, /asset\.state = 'ACTIVE'/);
  assert.match(ranking.sql, /asset\.index_state = 'READY'/);
  assert.match(ranking.sql, /asset\.version = embedding\.version/);
  assert.ok(!/\(256\)/.test(ranking.sql), '不得再钉死 256 维');
  assert.deepEqual(ranking.values.slice(0, 2), [accountId, 'character-1']);
  assert.equal(ranking.values[3], 'deterministic-char-ngram-256-v1');
  assert.equal(ranking.values.at(-1), 3);
});

test('PostgresStore locks and persists only the current account daily chat usage during message mutation', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    const usage = [...scoped.dailyChatUsage.values()][0];
    assert.equal(usage.chat_rounds, 2);
    usage.chat_rounds = 3;
    usage.billed_input_tokens = 9600;
    usage.updated_at = '2026-09-04T00:01:00.000Z';
  }, { lockDailyUsage: true });
  assert.ok(pool.calls.some((call) => call.sql.startsWith('INSERT INTO daily_chat_usage')));
  assert.ok(pool.calls.some((call) => call.sql.includes('FROM daily_chat_usage') && call.sql.includes('FOR UPDATE')));
  const update = pool.calls.find((call) => call.sql.startsWith('UPDATE daily_chat_usage'));
  assert.ok(update);
  assert.deepEqual(update.values.slice(0, 5), [accountId, new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), 3, 9600, 0]);
});

test('daily chat usage migration keeps the counter scoped, bounded, and writable only through the application role', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/015_development_daily_chat_usage.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS daily_chat_usage/);
  assert.match(migration, /PRIMARY KEY \(account_id, usage_date\)/);
  assert.match(migration, /billed_input_tokens \+ reserved_input_tokens <= 320000/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON daily_chat_usage TO qiyu_app/);
  assert.doesNotMatch(migration, /DELETE ON daily_chat_usage TO qiyu_app/);
});

test('PostgresStore loads and appends privacy-preserving operation metrics without allowing mutation', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.operationMetrics.set('metric-chat-20260905-001', {
      metric_id: 'metric-chat-20260905-001', account_id: accountId,
      capability: 'CHAT_GENERATION', provider: 'qwen', model_version: 'qwen3.8-flash',
      input_tokens: 12, output_tokens: 8, latency_ms: 42, outcome: 'COMPLETED',
      created_at: '2026-09-05T00:00:00.000Z'
    });
  });
  assert.ok(pool.calls.some((call) => call.sql.includes('FROM operation_metrics')));
  const insert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO operation_metrics'));
  assert.ok(insert);
  assert.deepEqual(insert.values, [
    'metric-chat-20260905-001', accountId, 'CHAT_GENERATION', 'qwen', 'qwen3.8-flash',
    12, 8, 42, 'COMPLETED', '2026-09-05T00:00:00.000Z'
  ]);
});

test('PostgresStore persists a persona draft without making it the active stable persona', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  const characterId = '00000000-0000-7000-8000-0000000000cf';
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.characters.set(characterId, {
      character_id: characterId, account_id: accountId, name: '人格草稿角色', status: 'ACTIVE', version: 1, active_persona_version: 1,
      persona: { personality: '稳定表达' },
      persona_history: [{ version: 1, state: 'STABLE', parent_version: null, persona: { personality: '稳定表达' }, changed_fields: ['personality'], note: '创建', created_at: '2026-09-05T00:00:00.000Z', updated_at: '2026-09-05T00:00:00.000Z' }, { version: 2, state: 'DRAFT', parent_version: 1, persona: { personality: '待评测表达' }, changed_fields: ['personality'], note: '草稿', created_at: '2026-09-05T00:01:00.000Z', updated_at: '2026-09-05T00:01:00.000Z' }]
    });
  });
  const characterInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO characters'));
  const drafts = pool.calls.filter((call) => call.sql.startsWith('INSERT INTO persona_versions'));
  assert.equal(characterInsert.values.at(-1), 1);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[1].values.slice(2, 8), [2, JSON.stringify({ personality: '待评测表达' }), ['personality'], '草稿', 'DRAFT', 1]);
});

test('persona release draft migration persists state metadata without granting app-role release authority', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/031_development_persona_release_drafts.sql'), 'utf8');
  assert.match(migration, /active_persona_version bigint/);
  assert.match(migration, /state IN \('DRAFT', 'EVALUATING', 'SHADOW', 'CANARY', 'STABLE', 'REJECTED', 'ROLLED_BACK', 'RETIRED'\)/);
  assert.match(migration, /evaluation_json jsonb/);
  assert.doesNotMatch(migration, /GRANT .*qiyu_app/i);
  assert.doesNotMatch(migration, /qiyu_reviewer/i);
});

test('PostgresStore writes short-lived world state only after its character and appends the state event', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    const characterId = '00000000-0000-7000-8000-0000000000c6';
    scoped.characters.set(characterId, { character_id: characterId, account_id: accountId, name: '持久化角色', status: 'ACTIVE', version: 1, persona: {}, persona_history: [] });
    scoped.worldStates.set(characterId, {
      world_state_id: '00000000-0000-7000-8000-0000000000c7', account_id: accountId, character_id: characterId,
      mood_code: 'CALM', location_code: 'CAFE', wardrobe_asset_id: null, active_event_refs: [], source: 'USER_PATCH', state_version: 2,
      expires_at: null, reset_at: '2026-09-04T00:00:00.000Z', updated_at: '2026-09-04T00:01:00.000Z'
    });
    scoped.worldStateEvents.set('00000000-0000-7000-8000-0000000000c8', {
      event_id: '00000000-0000-7000-8000-0000000000c8', world_state_id: '00000000-0000-7000-8000-0000000000c7', account_id: accountId, character_id: characterId,
      patch: { mood_code: 'CALM', location_code: 'CAFE' }, source_type: 'USER_PATCH', previous_version: 1, new_version: 2, occurred_at: '2026-09-04T00:01:00.000Z'
    });
  });
  const characterInsertIndex = pool.calls.findIndex((call) => call.sql.startsWith('INSERT INTO characters'));
  const stateInsertIndex = pool.calls.findIndex((call) => call.sql.startsWith('INSERT INTO character_world_states'));
  const eventInsertIndex = pool.calls.findIndex((call) => call.sql.startsWith('INSERT INTO world_state_events'));
  assert.ok(characterInsertIndex >= 0 && stateInsertIndex > characterInsertIndex && eventInsertIndex > stateInsertIndex);
  assert.equal(pool.calls[eventInsertIndex].values[5], 'USER_PATCH');
});

test('world state migration limits fields, applies account RLS, and preserves an append-only event trail', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/017_development_world_state.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS character_world_states/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS world_state_events/);
  assert.match(migration, /CHECK \(mood_code IN/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON character_world_states TO qiyu_app/);
  assert.match(migration, /GRANT SELECT, INSERT ON world_state_events TO qiyu_app/);
  assert.doesNotMatch(migration, /GRANT .*UPDATE ON world_state_events TO qiyu_app/);
});

test('PostgresStore persists a user message with ai_generated=false rather than a null value', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.messages.set('00000000-0000-7000-8000-0000000000e1', {
      message_id: '00000000-0000-7000-8000-0000000000e1',
      conversation_id: '00000000-0000-7000-8000-0000000000e2',
      actor: 'USER', text: '合成用户消息', provider: null, created_at: '2026-09-03T00:00:00.000Z'
    });
  });
  const insert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO messages'));
  assert.equal(insert.values[8], false);
  assert.equal(insert.values[4], '2026-09-03T00:00:00.000Z');
  assert.equal(insert.values[5], 30);
});

test('PostgresStore permanently removes raw messages that retention or conversation deletion removed from the scoped store', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.messages.delete('00000000-0000-7000-8000-0000000000d1');
  });
  const deletion = pool.calls.find((call) => call.sql.startsWith('DELETE FROM messages'));
  assert.deepEqual(deletion.values, ['00000000-0000-7000-8000-0000000000d1', '00000000-0000-7000-8000-0000000000d2']);
});

test('PostgresStore persists scoped TTS job and private-media metadata without exposing a public URL field', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.mediaJobs.set('00000000-0000-7000-8000-0000000000f1', {
      job_id: '00000000-0000-7000-8000-0000000000f1', account_id: accountId, character_id: '00000000-0000-7000-8000-0000000000f2', conversation_id: '00000000-0000-7000-8000-0000000000f3', source_message_id: '00000000-0000-7000-8000-0000000000f4', type: 'TTS', state: 'COMPLETED', attempts: 1, provider: 'tencent-tts', provider_request_id: 'tts_req_1', voice_id: 'tencent-standard-101001', voice_version: 'provider-catalog-2026-09', authorization_record_id: 'tencent-service-entitlement-2026', rights_review_id: 'rights-review-voice-001', rights_review_state: 'APPROVED', tts_text: '一句清洗后的台词。', emotion_category: 'happy', emotion_intensity: 110, emotion_source: 'world_state_mood', tts_speed: 0.2, created_at: '2026-09-03T00:00:00.000Z'
    });
    scoped.mediaAssets.set('00000000-0000-7000-8000-0000000000f5', {
      asset_id: '00000000-0000-7000-8000-0000000000f5', account_id: accountId, character_id: '00000000-0000-7000-8000-0000000000f2', job_id: '00000000-0000-7000-8000-0000000000f1', type: 'TTS_AUDIO', state: 'AVAILABLE', media_type: 'AUDIO', mime_type: 'audio/mpeg', byte_length: 42, checksum: 'a'.repeat(64), object_key: 'tts/00000000-0000-7000-8000-0000000000f5.mp3', provider: 'tencent-tts', provider_request_id: 'tts_req_1', ai_generated: true, aigc_mark_version: 'not-implemented-development', created_at: '2026-09-03T00:00:00.000Z'
    });
  });
  const jobInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO media_jobs'));
  const assetInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO media_assets'));
  assert.ok(jobInsert);
  assert.ok(assetInsert);
  assert.deepEqual(jobInsert.values.slice(23, 28), ['tencent-standard-101001', 'provider-catalog-2026-09', 'tencent-service-entitlement-2026', 'rights-review-voice-001', 'APPROVED']);
  assert.deepEqual(jobInsert.values.slice(28, 33), ['一句清洗后的台词。', 'happy', 110, 'world_state_mood', 0.2]);
  const assetParameters = [...new Set([...assetInsert.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  assert.deepEqual(assetParameters, Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(assetInsert.values.length, 20);
  assert.equal(assetInsert.values.includes('https://'), false);
  assert.equal(assetInsert.values.includes('tts/00000000-0000-7000-8000-0000000000f5.mp3'), true);
});

test('PostgresStore updates an existing TTS job with contiguous PostgreSQL parameters', async () => {
  const pool = fakePool({ loadTtsJob: true });
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    const job = scoped.mediaJobs.get('00000000-0000-7000-8000-0000000000f1');
    job.state = 'RUNNING';
    job.attempts = 1;
    job.entitlement_id = 'trial-entitlement';
  });
  const update = pool.calls.find((call) => call.sql.startsWith('UPDATE media_jobs SET'));
  assert.ok(update);
  const parameters = [...new Set([...update.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  assert.deepEqual(parameters, Array.from({ length: 31 }, (_, index) => index + 1));
  assert.equal(update.values.length, 31);
  assert.equal(update.values[6], 'trial-entitlement');
});

test('PostgresStore persists image-job continuation state and confirmed private reference metadata', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    const referenceAssetId = '00000000-0000-7000-8000-0000000000f6';
    const rightsReviewId = '00000000-0000-7000-8000-0000000000f0';
    scoped.contentRightsReviews.set(rightsReviewId, {
      review_id: rightsReviewId, account_id: accountId, subject_type: 'REFERENCE_IMAGE', subject_ref: referenceAssetId,
      declaration_version: 'reference-image-rights-v1', risk_codes: ['MANUAL_RIGHTS_REVIEW_REQUIRED'], state: 'REVIEW_REQUIRED', reviewer_id: null,
      decision_reason: '待独立审核', created_at: '2026-09-04T00:00:00.000Z', updated_at: '2026-09-04T00:00:00.000Z'
    });
    scoped.mediaAssets.set(referenceAssetId, {
      asset_id: referenceAssetId, account_id: accountId, character_id: '00000000-0000-7000-8000-0000000000f2', job_id: null,
      type: 'REFERENCE_IMAGE', state: 'AVAILABLE', confirmation_state: 'USER_CONFIRMED', media_type: 'IMAGE', mime_type: 'image/png', byte_length: 512,
      checksum: 'b'.repeat(64), object_key: 'qiyu/images/00000000-0000-7000-8000-0000000000f6.png', provider: 'user-upload-private-cos', provider_request_id: 'ims-reference-1',
      moderation_policy_version: 'ims-test-v1', rights_review_id: rightsReviewId, ai_generated: false, aigc_mark_version: 'not-applicable-user-input', created_at: '2026-09-04T00:00:00.000Z'
    });
    scoped.mediaJobs.set('00000000-0000-7000-8000-0000000000f7', {
      job_id: '00000000-0000-7000-8000-0000000000f7', account_id: accountId, character_id: '00000000-0000-7000-8000-0000000000f2', conversation_id: null,
      source_message_id: null, input_asset_id: null, reference_asset_id: '00000000-0000-7000-8000-0000000000f6', type: 'IMAGE_GENERATION', state: 'RUNNING', attempts: 1,
      provider: 'tencent-hunyuan', provider_request_id: 'hunyuan-submit-1', provider_job_id: 'hunyuan-job-1', result_asset_id: null, failure_code: null,
      world_state_id: '00000000-0000-7000-8000-0000000000c7', world_state_version: 2,
      scene_contract: { version: 'qiyu-image-scene-v1', location: '窗边' }, created_at: '2026-09-04T00:00:01.000Z'
    });
  });
  const jobInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO media_jobs') && call.values[8] === 'IMAGE_GENERATION');
  const referenceInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO media_assets') && call.values[4] === 'REFERENCE_IMAGE');
  const rightsReviewInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO content_rights_reviews') && call.values[2] === 'REFERENCE_IMAGE');
  assert.ok(jobInsert);
  assert.ok(referenceInsert);
  assert.ok(rightsReviewInsert);
  assert.equal(jobInsert.values[6], '00000000-0000-7000-8000-0000000000f6');
  assert.equal(jobInsert.values[13], 'hunyuan-job-1');
  assert.equal(jobInsert.values[20], '00000000-0000-7000-8000-0000000000c7');
  assert.equal(jobInsert.values[21], 2);
  assert.equal(jobInsert.values[22], JSON.stringify({ version: 'qiyu-image-scene-v1', location: '窗边' }));
  assert.equal(referenceInsert.values[3], null);
  assert.equal(referenceInsert.values[15], 'USER_CONFIRMED');
  assert.equal(referenceInsert.values[19], '00000000-0000-7000-8000-0000000000f0');
  assert.ok(pool.calls.indexOf(rightsReviewInsert) < pool.calls.indexOf(referenceInsert));
  assert.equal(referenceInsert.values.includes('https://'), false);
});

test('image persistence migration permits durable image state without database URLs or object payloads', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/007_development_image_media.sql'), 'utf8');
  assert.match(migration, /reference_asset_id uuid/);
  assert.match(migration, /provider_job_id text/);
  assert.match(migration, /scene_contract jsonb/);
  assert.match(migration, /ALTER COLUMN conversation_id DROP NOT NULL/);
  assert.match(migration, /ALTER COLUMN job_id DROP NOT NULL/);
  assert.doesNotMatch(migration, /signed_url|public_url|image_base64/i);
});

test('media snapshot migration binds optional world-state identity and version as one pair', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/018_development_media_world_state_snapshot.sql'), 'utf8');
  assert.match(migration, /world_state_id uuid/);
  assert.match(migration, /world_state_version bigint/);
  assert.match(migration, /world_state_id IS NULL AND world_state_version IS NULL/);
  assert.match(migration, /world_state_id IS NOT NULL AND world_state_version > 0/);
  assert.doesNotMatch(migration, /signed_url|public_url|image_base64/i);
});

test('message snapshot migration preserves the model response state used by later TTS work', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/019_development_message_world_state_snapshot.sql'), 'utf8');
  assert.match(migration, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS world_state_id uuid/);
  assert.match(migration, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS world_state_version bigint/);
  assert.match(migration, /messages_world_state_snapshot_check/);
  assert.match(migration, /world_state_id IS NOT NULL AND world_state_version > 0/);
});

test('conversation pause and message feedback migration scopes correction records to the current account', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/020_development_conversation_pause_feedback.sql'), 'utf8');
  assert.match(migration, /USER_PAUSED/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS message_feedback/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /GRANT SELECT, INSERT ON message_feedback TO qiyu_app/);
  assert.doesNotMatch(migration, /GRANT .*UPDATE ON message_feedback TO qiyu_app/);
});

test('PostgresStore appends quarantined OC input, its review request, and an appeal without granting the app approval rights', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    const importId = '00000000-0000-7000-8000-000000000101';
    const reviewId = '00000000-0000-7000-8000-000000000102';
    scoped.ocImports.set(importId, {
      import_id: importId, account_id: accountId, source_text: '世界观：雨夜书店', declaration_version: 'oc-rights-v1', state: 'REVIEW_REQUIRED',
      proposed_persona: { worldview: '雨夜书店' }, created_at: '2026-09-04T00:00:00.000Z', retention_expires_at: '2026-10-04T00:00:00.000Z'
    });
    scoped.contentRightsReviews.set(reviewId, {
      review_id: reviewId, account_id: accountId, subject_type: 'OC_TEXT', subject_ref: importId, declaration_version: 'oc-rights-v1', risk_codes: ['MANUAL_RIGHTS_REVIEW_REQUIRED'],
      state: 'REVIEW_REQUIRED', reviewer_id: null, decision_reason: 'OC 导入默认进入权利审核队列', created_at: '2026-09-04T00:00:00.000Z', updated_at: '2026-09-04T00:00:00.000Z'
    });
    scoped.contentRightsAppeals.set('00000000-0000-7000-8000-000000000103', {
      appeal_id: '00000000-0000-7000-8000-000000000103', account_id: accountId, review_id: reviewId, statement: '我拥有授权', state: 'SUBMITTED', created_at: '2026-09-04T00:01:00.000Z'
    });
  });
  const importInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO oc_imports'));
  const reviewInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO content_rights_reviews'));
  const appealInsert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO content_rights_appeals'));
  assert.ok(importInsert && reviewInsert && appealInsert);
  assert.equal(importInsert.values[2], '世界观：雨夜书店');
  assert.equal(reviewInsert.values[6], 'REVIEW_REQUIRED');
  assert.equal(reviewInsert.values.includes('APPROVED'), false);
  assert.equal(appealInsert.values[4], 'SUBMITTED');
  assert.ok(pool.calls.indexOf(importInsert) < pool.calls.indexOf(reviewInsert));
});

test('OC rights-review migration keeps source private and blocks application-role review decisions', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/021_development_oc_rights_review.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS oc_imports/);
  assert.match(migration, /source_bytes bytea NOT NULL/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS content_rights_reviews/);
  assert.match(migration, /state = 'REVIEW_REQUIRED' AND reviewer_id IS NULL/);
  assert.match(migration, /GRANT SELECT, INSERT ON content_rights_reviews TO qiyu_app/);
  assert.doesNotMatch(migration, /GRANT .*UPDATE ON content_rights_reviews TO qiyu_app/);
  assert.doesNotMatch(migration, /source_text text/i);
  assert.doesNotMatch(migration, /source_ciphertext/i);
});

test('reference-media rights link migration keeps the review decision outside the application role', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/022_development_reference_asset_rights_link.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS rights_review_id uuid REFERENCES content_rights_reviews/);
  assert.match(migration, /media_assets_rights_review_idx/);
  assert.doesNotMatch(migration, /GRANT .*UPDATE ON content_rights_reviews TO qiyu_app/);
});

test('image media migration expands the persisted media type constraint without excluding audio assets', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/046_development_image_media_type_constraint.sql'), 'utf8');
  assert.match(migration, /DROP CONSTRAINT IF EXISTS media_assets_media_type_check/);
  assert.match(migration, /media_type IN \('AUDIO', 'IMAGE'\)/);
  assert.match(migration, /046_development_image_media_type_constraint\.sql/);
});

test('TTS voice provenance migration requires a complete approved record for new TTS rows without inventing legacy approval', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/023_development_tts_voice_provenance.sql'), 'utf8');
  assert.match(migration, /voice_id text/);
  assert.match(migration, /authorization_record_id text/);
  assert.match(migration, /rights_review_id text/);
  assert.match(migration, /rights_review_state = 'APPROVED'/);
  assert.match(migration, /voice_id IS NULL AND voice_version IS NULL/);
  assert.match(migration, /media_jobs_tts_voice_provenance_idx/);
});

test('TTS emotion columns migration keeps category format open to provider growth and intensity bounded', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/056_tts_emotion_columns.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS tts_text text/);
  assert.match(migration, /emotion_category ~ '\^\[a-z\]\[a-z0-9_\]/);
  assert.match(migration, /emotion_intensity >= 50 AND emotion_intensity <= 200/);
  assert.match(migration, /emotion_source IN \('model_judgement', 'world_state_mood', 'fallback_neutral'\)/);
  assert.match(migration, /056_tts_emotion_columns\.sql/);
  // 供应商扩充情感枚举时不应被数据库约束挡住（应用层 SUPPORTED 集合才是闸门）。
  assert.doesNotMatch(migration, /emotion_category IN \(/);
});

test('content-rights reviewer migration excludes the application role and emits a decision event', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/024_development_content_rights_reviewer_boundary.sql'), 'utf8');
  assert.match(migration, /CREATE ROLE qiyu_reviewer NOLOGIN NOINHERIT/);
  assert.match(migration, /CREATE ROLE qiyu_rights_service NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS content_rights_review_decisions/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /OWNER TO qiyu_rights_service/);
  assert.match(migration, /pg_has_role\(session_user, 'qiyu_reviewer', 'member'\)/);
  assert.match(migration, /content_rights\.review_changed\.v1/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.decide_content_rights_review\(uuid, text, text\) FROM PUBLIC, qiyu_app/);
});

test('rights-service reviewer decision has only the reference-media read columns required by its guarded update', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/047_development_rights_service_reference_asset_read.sql'), 'utf8');
  assert.match(migration, /GRANT SELECT \(asset_id, account_id, type\) ON media_assets TO qiyu_rights_service/);
  assert.doesNotMatch(migration, /TO qiyu_app/);
});

test('content-rights revocation migration disables reference media online before physical cleanup', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/025_development_content_rights_revocation.sql'), 'utf8');
  assert.match(migration, /revoke_content_rights_review/);
  assert.match(migration, /review_row\.state <> 'APPROVED'/);
  assert.match(migration, /type = 'REFERENCE_IMAGE'/);
  assert.match(migration, /derived\.type = 'SCENE_IMAGE'/);
  assert.match(migration, /physical_cleanup_required', true/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.revoke_content_rights_review\(uuid, text\) FROM PUBLIC, qiyu_app/);
});

test('content-rights cleanup migration creates a leased, retryable worker boundary without application access', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/026_development_content_rights_cleanup_worker.sql'), 'utf8');
  assert.match(migration, /CREATE ROLE qiyu_content_cleanup NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS content_rights_cleanup_jobs/);
  assert.match(migration, /lease_expires_at timestamptz/);
  assert.match(migration, /content_rights_cleanup_enqueue/);
  assert.match(migration, /physical_cleanup_required/);
  assert.match(migration, /GRANT SELECT ON outbox_events, media_assets, media_jobs TO qiyu_content_cleanup/);
  assert.match(migration, /REVOKE ALL ON content_rights_cleanup_jobs FROM PUBLIC, qiyu_app, qiyu_reviewer/);
});

test('operation metrics migration is append-only, account-scoped, and contains no content fields', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/027_development_operation_metrics.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS operation_metrics/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /operation_metrics_scope/);
  assert.match(migration, /REVOKE UPDATE, DELETE ON operation_metrics FROM qiyu_app/);
  assert.doesNotMatch(migration, /\b(?:prompt|reply|content|text)_(?:text|json|body|ciphertext)\b/i);
});

test('PostgresStore only appends entitlement ledger entries and never stores payment channel payloads', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.entitlementLedgers.set('00000000-0000-7000-8000-0000000000f8', {
      entitlement_ledger_id: '00000000-0000-7000-8000-0000000000f8', account_id: accountId, entitlement_id: 'subscription-period-1', capability: 'IMAGE_GENERATION',
      action: 'GRANT', job_id: null, quantity: 15, reserved_quantity: null, idempotency_key: 'payment-event-1:GRANT', source: 'PAYMENT_VERIFIED', source_event_id: 'payment-event-1', created_at: '2026-09-04T00:00:00.000Z'
    });
  });
  const insert = pool.calls.find((call) => call.sql.startsWith('INSERT INTO entitlement_ledgers'));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(0, 11), ['00000000-0000-7000-8000-0000000000f8', accountId, 'subscription-period-1', 'IMAGE_GENERATION', 'GRANT', null, 15, null, 'payment-event-1:GRANT', 'PAYMENT_VERIFIED', 'payment-event-1']);
  assert.equal(pool.calls.some((call) => call.sql.startsWith('UPDATE entitlement_ledgers')), false);
});

test('PostgresStore rejects mutation or deletion of an already-loaded entitlement ledger entry', async () => {
  const pool = fakePool();
  const originalQuery = pool.connect;
  pool.connect = async () => {
    const client = await originalQuery();
    const query = client.query.bind(client);
    client.query = async (sql, values) => {
      if (String(sql).includes('FROM entitlement_ledgers')) {
        return { rows: [{ entitlement_ledger_id: '00000000-0000-7000-8000-0000000000f9', account_id: DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice, entitlement_id: 'subscription-period-1', capability: 'IMAGE_GENERATION', action: 'GRANT', job_id: null, quantity: 15, reserved_quantity: null, idempotency_key: 'payment-event-1:GRANT', source: 'PAYMENT_VERIFIED', source_event_id: 'payment-event-1', created_at: '2026-09-04T00:00:00.000Z' }] };
      }
      return query(sql, values);
    };
    return client;
  };
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await assert.rejects(() => store.withAccountTransaction(accountId, async (scoped) => {
    scoped.entitlementLedgers.get('00000000-0000-7000-8000-0000000000f9').quantity = 14;
  }), /append-only/);
  assert.ok(pool.calls.some((call) => call.sql === 'ROLLBACK'));
});

test('entitlement ledger migration enforces append-only idempotency and excludes payment payload fields', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/008_development_entitlement_ledger.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS entitlement_ledgers/);
  assert.match(migration, /UNIQUE INDEX entitlement_ledgers_account_idempotency_idx/);
  assert.match(migration, /append-only/);
  assert.match(migration, /GRANT SELECT, INSERT ON entitlement_ledgers TO qiyu_app/);
  assert.doesNotMatch(migration, /card_number|bank_account|callback_body|payment_payload/i);
});

test('media provider diagnostics migration only permits a safe error code', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/009_development_media_provider_diagnostics.sql'), 'utf8');
  assert.match(migration, /provider_error_code text/);
  assert.match(migration, /\^\[A-Za-z0-9._-\]\{1,128\}\$/);
  assert.doesNotMatch(migration, /provider_error_message|callback_payload|signed_url/i);
});

test('PostgresStore persists subscription state, server-priced order, and hashed append-only payment event', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.subscriptions.set('00000000-0000-7000-8000-0000000000c1', {
      subscription_id: '00000000-0000-7000-8000-0000000000c1', account_id: accountId, sku: 'qiyu_public_monthly_v1', channel: 'ALIPAY_H5', state: 'ACTIVE', auto_renew: false,
      disclosure_version: 'subscription_v1', period_start: '2026-09-04T00:00:00.000Z', period_end: '2026-10-04T00:00:00.000Z', grace_period_end: null, refund_status: 'NONE', transaction_ref_hash: 'a'.repeat(64), created_at: '2026-09-04T00:00:00.000Z', updated_at: '2026-09-04T00:01:00.000Z'
    });
    scoped.subscriptionOrders.set('00000000-0000-7000-8000-0000000000c2', {
      order_id: '00000000-0000-7000-8000-0000000000c2', account_id: accountId, subscription_id: '00000000-0000-7000-8000-0000000000c1', sku: 'qiyu_public_monthly_v1', amount_fen: 3900, currency: 'CNY', state: 'PAID', channel: 'ALIPAY_H5', auto_renew: false, disclosure_version: 'subscription_v1', created_at: '2026-09-04T00:00:00.000Z'
    });
    scoped.paymentEvents.set('provider-event-1', {
      provider_event_id: 'provider-event-1', account_id: accountId, subscription_id: '00000000-0000-7000-8000-0000000000c1', event_type: 'PURCHASE_SUCCEEDED', transaction_ref_hash: 'a'.repeat(64), event_hash: 'b'.repeat(64), outcome: 'APPLIED', quarantine_reason: null, effective_at: '2026-09-04T00:01:00.000Z'
    });
  });
  const subscription = pool.calls.find((call) => call.sql.startsWith('INSERT INTO subscriptions'));
  const order = pool.calls.find((call) => call.sql.startsWith('INSERT INTO subscription_orders'));
  const paymentEvent = pool.calls.find((call) => call.sql.startsWith('INSERT INTO payment_events'));
  assert.ok(subscription && order && paymentEvent);
  assert.equal(order.values[4], 3900);
  assert.equal(paymentEvent.values[4], 'a'.repeat(64));
  assert.equal(JSON.stringify(paymentEvent.values).includes('transaction-'), false);
});

test('subscription persistence migration isolates account rows and stores no raw payment notification', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/010_development_subscription_lifecycle.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS subscriptions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS subscription_orders/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS payment_events/);
  assert.match(migration, /transaction_ref_hash text NOT NULL/);
  assert.match(migration, /payment_events_scope/);
  assert.doesNotMatch(migration, /callback_body|raw_payload|card_number|bank_account|checkout_url/i);
});

test('development payment channel migration keeps local simulation explicit without widening real channels', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/016_development_simulated_payment_channel.sql'), 'utf8');
  assert.match(migration, /DEVELOPMENT_SIMULATED/);
  assert.match(migration, /ALIPAY_H5/);
  assert.match(migration, /WECHAT_H5/);
  assert.doesNotMatch(migration, /payment_payload|callback_body|checkout_url/i);
});

test('trial subscription migration keeps the free experience distinct from payment channels and orders', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/032_development_trial_subscription.sql'), 'utf8');
  assert.match(migration, /DEVELOPMENT_TRIAL/);
  assert.match(migration, /'TRIAL'/);
  assert.doesNotMatch(migration, /subscription_orders|payment_events|checkout_url|callback_body/i);
});

test('trial ledger migration permits only the named trial source while retaining the append-only action shape', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/033_development_trial_entitlement_source.sql'), 'utf8');
  assert.match(migration, /TRIAL_GRANTED/);
  assert.match(migration, /PAYMENT_VERIFIED/);
  assert.match(migration, /action = 'RESERVE'/);
  assert.doesNotMatch(migration, /callback_body|payment_payload|checkout_url/i);
});

test('closed trial migration stores only credential hashes and scopes trial feedback to the authenticated account', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/045_closed_trial_invites_feedback.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE trial_invites/);
  assert.match(migration, /invite_code_hash bytea NOT NULL UNIQUE/);
  assert.match(migration, /initial_secret_hash text NOT NULL/);
  assert.match(migration, /CREATE TABLE trial_sessions/);
  assert.match(migration, /access_token_hash bytea NOT NULL UNIQUE/);
  assert.match(migration, /ALTER TABLE trial_feedback FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /WITH CHECK \(account_id = app\.current_account_id\(\)\)/);
  assert.match(migration, /REVOKE ALL ON trial_invites, trial_sessions FROM qiyu_app/);
});

test('conversation summary migration is account-scoped and stores a revocable derived payload', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/034_development_conversation_summaries.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS conversation_summaries/);
  assert.match(migration, /summary_ciphertext bytea NOT NULL/);
  assert.match(migration, /model_route_id text NOT NULL/);
  assert.match(migration, /prompt_version text NOT NULL/);
  assert.match(migration, /revocation_epoch bigint NOT NULL/);
  assert.match(migration, /retention_expires_at timestamptz NOT NULL/);
  assert.match(migration, /conversation_summaries_scope/);
  assert.doesNotMatch(migration, /checkout_url|payment_payload/i);
});

test('conversation summary job migration persists an account-scoped retryable task without granting unrestricted writes', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/035_development_conversation_summary_jobs.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS conversation_summary_jobs/);
  assert.match(migration, /'PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'/);
  assert.match(migration, /captured_revocation_epoch bigint NOT NULL/);
  assert.match(migration, /conversation_summary_jobs_scope/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE \(state, completed_at, last_error\)/);
});

test('conversation summary worker migration requires a separate leased database role', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/036_development_conversation_summary_worker.sql'), 'utf8');
  assert.match(migration, /qiyu_conversation_summary_worker NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(migration, /lease_expires_at timestamptz/);
  assert.match(migration, /GRANT SELECT, UPDATE ON conversation_summary_jobs TO qiyu_conversation_summary_worker/);
  assert.match(migration, /GRANT INSERT, UPDATE ON conversation_summaries TO qiyu_conversation_summary_worker/);
});

test('conversation summary outbox migration deduplicates only the named no-content request event', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/037_development_conversation_summary_outbox.sql'), 'utf8');
  assert.match(migration, /outbox_conversation_summary_requested_once/);
  assert.match(migration, /conversation\.summary_requested\.v1/);
  assert.doesNotMatch(migration, /content_ciphertext|summary_ciphertext|payload_text/i);
});

test('conversation summary DLQ stops exhausted jobs without storing message or summary text', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/038_development_conversation_summary_dlq.sql'), 'utf8');
  const repository = readFileSync(path.resolve(__dirname, '../src/persistence/postgres-conversation-summary-repository.js'), 'utf8');
  assert.match(migration, /conversation_summary_dead_letters/);
  assert.match(migration, /attempt_count integer NOT NULL CHECK \(attempt_count >= 8\)/);
  assert.match(repository, /SUMMARY_GENERATION_FAILED/);
  assert.match(migration, /REVOKE ALL ON conversation_summary_dead_letters FROM PUBLIC, qiyu_app/);
  assert.doesNotMatch(migration, /content_ciphertext|summary_ciphertext|text_payload/i);
});

test('conversation summary metrics use the append-only no-content operation table', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/039_development_conversation_summary_metrics.sql'), 'utf8');
  const repository = readFileSync(path.resolve(__dirname, '../src/persistence/postgres-conversation-summary-repository.js'), 'utf8');
  assert.match(migration, /CONVERSATION_SUMMARY_GENERATION/);
  assert.match(migration, /GRANT INSERT ON operation_metrics TO qiyu_conversation_summary_worker/);
  assert.match(repository, /INSERT INTO operation_metrics \(metric_id, account_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome\)/);
  assert.match(repository, /CONVERSATION_SUMMARY_GENERATION/);
  assert.match(repository, /usageNumber\(usage\.input_tokens \?\? usage\.prompt_tokens\)/);
});

test('conversation summary DLQ replay requires a separate operator, source recheck, reason hash, and one replay only', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/040_development_conversation_summary_dlq_replay.sql'), 'utf8');
  assert.match(migration, /CREATE ROLE qiyu_summary_operator NOLOGIN NOINHERIT/);
  assert.match(migration, /CREATE ROLE qiyu_summary_replay_service NOLOGIN NOINHERIT BYPASSRLS/);
  assert.match(migration, /conversation_summary_operator_identities/);
  assert.match(migration, /replay_count integer NOT NULL DEFAULT 0 CHECK \(replay_count BETWEEN 0 AND 1\)/);
  assert.match(migration, /replay_conversation_summary_dead_letter/);
  assert.match(migration, /pg_has_role\(session_user, 'qiyu_summary_operator', 'member'\)/);
  assert.match(migration, /a\.revocation_epoch = job_row\.captured_revocation_epoch/);
  assert.match(migration, /message_id = job_row\.source_to_id AND deleted_at IS NULL/);
  assert.match(migration, /last_replay_reason_sha256 = encode\(digest\(trim\(p_reason\), 'sha256'\), 'hex'\)/);
  assert.match(migration, /conversation\.summary_dlq_replayed\.v1/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.replay_conversation_summary_dead_letter\(uuid, text\) FROM PUBLIC, qiyu_app/);
  assert.doesNotMatch(migration, /summary_ciphertext|content_ciphertext|INSERT INTO .*p_reason/i);
});

test('PostgresStore persists an account-scoped conversation summary and only permits state updates', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.conversationSummaries.set('00000000-0000-7000-8000-0000000000e1', {
      summary_id: '00000000-0000-7000-8000-0000000000e1', account_id: accountId, conversation_id: '00000000-0000-7000-8000-0000000000d2',
      source_from_id: '00000000-0000-7000-8000-0000000000d1', source_to_id: '00000000-0000-7000-8000-0000000000d1', text: '已持久化摘要',
      model_route_id: 'qwen3.8-flash', prompt_version: 'conversation-summary.v1', source_checksum: 'a'.repeat(64), revocation_epoch: 0,
      state: 'ACTIVE', created_at: '2026-09-05T00:00:00.000Z', invalidated_at: null, retention_expires_at: '2026-12-01T00:00:00.000Z'
    });
  });
  const inserted = pool.calls.find((call) => call.sql.startsWith('INSERT INTO conversation_summaries'));
  assert.ok(inserted);
  assert.equal(inserted.values[1], accountId);
  assert.equal(inserted.values[5], '已持久化摘要');
});

test('PostgresStore persists a summary task in the same scoped transaction as the conversation state', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.conversationSummaryJobs.set('00000000-0000-7000-8000-0000000000e2', {
      job_id: '00000000-0000-7000-8000-0000000000e2', account_id: accountId, conversation_id: '00000000-0000-7000-8000-0000000000d2', source_to_id: '00000000-0000-7000-8000-0000000000d1',
      captured_revocation_epoch: 0, state: 'PENDING', attempt_count: 0, next_attempt_at: '2026-09-05T00:00:00.000Z', last_error: null, created_at: '2026-09-05T00:00:00.000Z', completed_at: null
    });
  });
  const inserted = pool.calls.find((call) => call.sql.startsWith('INSERT INTO conversation_summary_jobs'));
  assert.ok(inserted);
  assert.deepEqual(inserted.values.slice(0, 6), ['00000000-0000-7000-8000-0000000000e2', accountId, '00000000-0000-7000-8000-0000000000d2', '00000000-0000-7000-8000-0000000000d1', 0, 'PENDING']);
});

test('PostgresStore appends a summary-requested outbox event without content text', async () => {
  const pool = fakePool();
  const store = new PostgresStore({ pool });
  const accountId = store.resolveAccountId('acct_dev_alice');
  await store.withAccountTransaction(accountId, async (scoped) => {
    scoped.outboxEvents.set('00000000-0000-7000-8000-0000000000e3', {
      event_id: '00000000-0000-7000-8000-0000000000e3', account_id: accountId, character_id: null,
      aggregate_type: 'CONVERSATION_SUMMARY_JOB', aggregate_id: '00000000-0000-7000-8000-0000000000e2', event_type: 'conversation.summary_requested.v1',
      payload: { conversation_id: '00000000-0000-7000-8000-0000000000d2', source_to_id: '00000000-0000-7000-8000-0000000000d1', captured_revocation_epoch: 0 }, occurred_at: '2026-09-05T00:00:00.000Z'
    });
  });
  const inserted = pool.calls.find((call) => call.sql.startsWith('INSERT INTO outbox_events'));
  assert.ok(inserted);
  assert.equal(JSON.stringify(inserted.values).includes('消息正文'), false);
  assert.match(inserted.values[6], /conversation_id/);
});

test('media entitlement link migration persists only the selected subscription-period identifier', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../../infra/postgres/migrations/011_development_media_entitlement_link.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS entitlement_id text/);
  assert.match(migration, /media_jobs_entitlement_idx/);
  assert.doesNotMatch(migration, /balance|payment_payload|checkout_url/i);
});

test('postgres composition is explicit, requires DATABASE_URL, accepts a fake pool, and remains unavailable in production', () => {
  assert.throws(() => createPersistenceFromEnvironment({ QIYU_PERSISTENCE: 'postgres' }), (error) => error.code === 'DATABASE_URL_REQUIRED');
  const pool = fakePool();
  const store = createPersistenceFromEnvironment({ QIYU_PERSISTENCE: 'postgres', DATABASE_URL: 'postgres://ignored-for-fake' }, { pool });
  assert.ok(store instanceof PostgresStore);
  assert.throws(() => createPersistenceFromEnvironment({ NODE_ENV: 'production', QIYU_PERSISTENCE: 'postgres', DATABASE_URL: 'postgres://ignored' }), (error) => error.code === 'PRODUCTION_RUNTIME_NOT_WIRED');
});

test('createApp selects the scoped PostgreSQL request path when given a PostgresStore', async (t) => {
  const pool = fakePool();
  const app = createApp({ store: new PostgresStore({ pool }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/dev/session`, {
    headers: { authorization: 'Bearer dev-alice-token' }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).account_id, DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice);
  assert.ok(pool.calls.some((call) => call.sql.includes("set_config('app.account_id'")));
  assert.ok(pool.calls.some((call) => call.sql === 'COMMIT'));
});

test('a valid local development payment callback enters the signed account PostgreSQL scope', async (t) => {
  const secret = 'postgres-callback-test-secret';
  const previous = process.env.QIYU_DEV_PAYMENT_SECRET;
  process.env.QIYU_DEV_PAYMENT_SECRET = secret;
  t.after(() => { if (previous === undefined) delete process.env.QIYU_DEV_PAYMENT_SECRET; else process.env.QIYU_DEV_PAYMENT_SECRET = previous; });
  const pool = fakePool();
  const app = createApp({ store: new PostgresStore({ pool }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const accountId = DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice;
  const body = {
    provider_event_id: 'evt_signed_scope', type: 'PURCHASE_SUCCEEDED', account_id: accountId,
    subscription_id: '00000000-0000-7000-8000-0000000000c1', transaction_ref: 'txn_signed_scope',
    sku: 'qiyu_public_monthly_v1', effective_at: '2026-09-04T00:00:00.000Z',
    period_start: '2026-09-04T00:00:00.000Z', period_end: '2026-10-04T00:00:00.000Z', verified: true
  };
  const signature = createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/callbacks/payments/development-simulated`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-qiyu-payment-signature': signature }, body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  const scope = pool.calls.find((call) => call.sql.includes("set_config('app.account_id'"));
  assert.deepEqual(scope.values, [accountId]);
});
