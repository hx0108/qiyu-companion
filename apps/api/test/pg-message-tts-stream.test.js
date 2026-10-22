'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { PostgresStore, DEVELOPMENT_DATABASE_ACCOUNT_IDS } = require('../src/persistence/postgres-store');
const { createApp } = require('../src/app');

const databaseUrl = process.env.QIYU_PG_TEST_DATABASE_URL;
const options = { skip: !databaseUrl && '需要显式隔离 QIYU_PG_TEST_DATABASE_URL', timeout: 30000 };

test('真实 PG 点播 SSE：首段提前、延迟事务持久化、并发复用只合成和扣费一次', options, async (t) => {
  const target = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname.endsWith('_test'), '仅允许本机显式隔离测试库');
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  t.after(() => pool.end());
  const store = new PostgresStore({ pool });
  const accountId = DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice;
  let calls = 0, providerFinished = false, completeProvider, cancellationMode = false;
  const wait = new Promise((resolve) => { completeProvider = resolve; });
  t.after(() => completeProvider());
  const mediaStore = {
    async createPendingJob() {}, async updateJob() {},
    async putAudio({ assetId, bytes }) { return { objectKey: `pg-test/${assetId}.mp3`, checksum: 'a'.repeat(64), byteLength: bytes.length, mimeType: 'audio/mpeg' }; }
  };
  const server = createApp({ store, mediaStore, summaryEnabled: false,
    replyGenerator: async () => ({ reply_text: '我在呢，慢慢说就好。', provider: 'mock', model_version: 'mock-v1', ai_generated: true }),
    ttsGenerator: async ({ onAudioSegment, signal }) => {
      calls += 1;
      onAudioSegment(Buffer.from('test-first-audio'));
      if (cancellationMode) {
        await new Promise((resolve, reject) => {
          const cancel = () => reject(Object.assign(new Error('cancelled synthetic TTS'), { code: 'TENCENT_TTS_STREAM_ABORTED' }));
          if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
        });
      }
      await wait;
      providerFinished = true;
      return { asset: { bytes: Buffer.from('test-first-audio-test-last-audio'), mimeType: 'audio/mpeg' }, providerRequestId: 'test-pg-tts' };
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prefix = `pg-tts-${randomUUID()}`;
  async function json(path, method = 'GET', body) {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json', 'idempotency-key': `${prefix}:${randomUUID()}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  }
  const notices = await json('/api/v1/required-notices');
  for (const notice of notices.notices) await json(`/api/v1/required-notices/${notice.notice_id}/displayed`, 'POST', { notice_version: notice.notice_version });
  await json('/api/v1/age/declarations', 'POST', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
  // Synthetic paid entitlement avoids the trial's deliberately unmetered policy.
  await store.withAccountTransaction(accountId, (scoped) => {
    const now = new Date().toISOString();
    const subscription = { subscription_id: scoped.next('sub'), account_id: accountId, sku: 'qiyu_monthly_v1', channel: 'DEVELOPMENT_SIMULATED', state: 'ACTIVE', auto_renew: false, disclosure_version: 'test-only', period_start: now, period_end: new Date(Date.now() + 86400000).toISOString(), grace_period_end: null, refund_status: 'NONE', transaction_ref_hash: null, created_at: now, updated_at: now };
    scoped.subscriptions.set(subscription.subscription_id, subscription);
    scoped.mediaEntitlementService.grantSubscriptionCycle({ subscription, product: { image_quota: 1, tts_minutes: 10, asr_minutes: 1 }, sourceEventId: prefix });
  });
  const characters = await json('/api/v1/characters');
  const character = characters.characters.find((item) => item.status === 'ACTIVE') || (await json('/api/v1/characters', 'POST', { name: '栖语测试角色' })).character;
  const conversation = (await json('/api/v1/conversations', 'POST', { character_id: character.character_id })).conversation;
  const message = (await json(`/api/v1/conversations/${conversation.conversation_id}/messages`, 'POST', { content: { text: '陪我聊聊。' } })).assistant_message;
  function stream(key) {
    return fetch(`${base}/api/v1/messages/${message.message_id}/tts-stream`, { method: 'POST', headers: { authorization: 'Bearer dev-alice-token', 'idempotency-key': key, 'content-type': 'application/json' }, body: '{}' });
  }
  const first = await stream(`${prefix}:first`);
  assert.equal(first.status, 200);
  const reader = first.body.getReader();
  const firstChunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstChunk, /event: tts.audio/);
  assert.equal(providerFinished, false, '首段必须早于整轮TTS完成');
  const simultaneous = stream(`${prefix}:second`);
  completeProvider();
  let rest = '';
  for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /"state":"COMPLETED"/);
  const second = await simultaneous;
  assert.match(await second.text(), /"state":"COMPLETED"/);
  assert.equal(calls, 1);
  const rows = await pool.query('SELECT job_id, result_asset_id, state FROM media_jobs WHERE source_message_id = $1 AND type = $2', [message.message_id, 'TTS']);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].state, 'COMPLETED');
  assert.ok(rows.rows[0].result_asset_id);
  const ledger = await pool.query('SELECT action, quantity FROM entitlement_ledgers WHERE job_id = $1 ORDER BY action', [rows.rows[0].job_id]);
  assert.deepEqual(ledger.rows.map((row) => row.action), ['COMMIT', 'RESERVE']);
  const replay = await stream(`${prefix}:third`);
  assert.match(await replay.text(), /"state":"COMPLETED"/);
  assert.equal(calls, 1);
  const sameKeyReplay = await stream(`${prefix}:first`);
  assert.match(await sameKeyReplay.text(), /"state":"COMPLETED"/);
  assert.equal(calls, 1, '同幂等键重放不重新合成');

  cancellationMode = true;
  const cancelMessage = (await json(`/api/v1/conversations/${conversation.conversation_id}/messages`, 'POST', { content: { text: '接下来听一段语音。' } })).assistant_message;
  const controller = new AbortController();
  const cancelled = await fetch(`${base}/api/v1/messages/${cancelMessage.message_id}/tts-stream`, {
    method: 'POST', headers: { authorization: 'Bearer dev-alice-token', 'idempotency-key': `${prefix}:cancel`, 'content-type': 'application/json' }, body: '{}', signal: controller.signal
  });
  const cancelledReader = cancelled.body.getReader();
  assert.match(new TextDecoder().decode((await cancelledReader.read()).value), /event: tts.audio/);
  controller.abort();
  let cancelledJob;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    cancelledJob = (await pool.query('SELECT job_id, state, failure_code FROM media_jobs WHERE source_message_id = $1 AND type = $2', [cancelMessage.message_id, 'TTS'])).rows[0];
    if (cancelledJob?.state === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(cancelledJob?.state, 'FAILED');
  assert.equal(cancelledJob.failure_code, 'TENCENT_TTS_STREAM_ABORTED');
  const cancellationLedger = (await pool.query('SELECT action, quantity FROM entitlement_ledgers WHERE job_id = $1 ORDER BY action', [cancelledJob.job_id])).rows;
  assert.deepEqual(cancellationLedger.map((row) => row.action), ['COMMIT', 'RESERVE']);
  assert.ok(cancellationLedger[0].quantity > 0 && cancellationLedger[0].quantity < cancellationLedger[1].quantity, '已下发部分音频按部分量计费，不全免或全额');
});
