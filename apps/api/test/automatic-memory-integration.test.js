'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../src/app');
const { buildMessages } = require('../src/providers/qwen-adapter');

async function fixture(t, options = {}) {
  const contexts = [];
  const replyGenerator = async (text, context) => {
    contexts.push(context);
    const reply = text === '问问我的爱好' ? '你平时喜欢做什么？' : '我明白了。';
    return { provider: 'test', model_version: 'test', reply_text: reply, ai_generated: true, memory_candidate: null };
  };
  const streamingReplyGenerator = { async generateStream(text, context, push) { contexts.push(context); await push('我明白了。'); return { provider: 'test', model_version: 'test', reply_text: '我明白了。', ai_generated: true, memory_candidate: null }; } };
  const server = createApp({ replyGenerator, streamingReplyGenerator, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; let key = 0;
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json', 'idempotency-key': `auto-${++key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
  }
  const notice = (await request('/required-notices')).notices[0];
  await request(`/required-notices/${notice.notice_id}/displayed`, 'POST', { notice_version: notice.notice_version });
  await request('/age/declarations', 'POST', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
  const character = (await request('/characters', 'POST', { name: '测试角色' })).character;
  const conversation = (await request('/conversations', 'POST', { character_id: character.character_id })).conversation;
  async function send(text, stream = false) {
    const result = await request(`/conversations/${conversation.conversation_id}/messages`, 'POST', { content: { text }, stream });
    if (stream && result.stream?.mode === 'live') {
      const response = await fetch(base + result.stream.stream_url, { headers: { authorization: 'Bearer dev-alice-token' } });
      const events = await response.text(); assert.match(events, /event: message.completed/);
    }
    return result;
  }
  return { request, send, contexts, conversation };
}

test('text and streaming memory are opt-in, source-labelled, conflict-confirmed and deletable', async (t) => {
  const f = await fixture(t);
  await f.send('我希望你回答直接一点');
  assert.equal((await f.request('/relationship-assets')).assets.length, 0);
  await f.request('/privacy/automatic-memory', 'POST', { enabled: true });
  await f.send('我希望你回答直接一点');
  let assets = (await f.request('/relationship-assets')).assets;
  assert.equal(assets.length, 1); assert.equal(assets[0].origin, 'AUTOMATIC');
  assert.equal(assets[0].display_text, '沟通偏好：回答更直接');
  assert.equal(assets[0].value.text, undefined, 'automatic memory does not retain the source message verbatim');
  assert.equal((await f.request('/timeline')).entries[0].entry_type, 'AUTOMATIC_ASSET');
  await f.send('你好');
  const context = f.contexts.at(-1);
  assert.equal(context.automatic_assets.length, 1); assert.equal(context.confirmed_assets.length, 0);
  const prompt = buildMessages('你好', context)[0].content;
  assert.match(prompt, /未经用户逐条确认/);
  await f.send('我希望你回答直接一点', true);
  assert.equal((await f.request('/relationship-assets')).assets.length, 1);
  await f.send('我希望你回答简洁一点', true);
  const candidates = (await f.request('/memory-candidates')).candidates;
  const candidate = candidates.find((item) => item.display_text === '我希望你回答简洁一点');
  assert.ok(candidate); assert.equal(candidate.conflicts_with.length, 1);
  await f.request(`/memory-candidates/${candidate.candidate_id}/confirm`, 'POST', { expected_version: candidate.version });
  assets = (await f.request('/relationship-assets')).assets;
  assert.equal(assets.length, 1); assert.equal(assets[0].value.fact_value, 'concise');
  await f.request(`/relationship-assets/${assets[0].asset_id}`, 'DELETE');
  await f.send('我希望你回答直接一点');
  assert.equal((await f.request('/relationship-assets')).assets.length, 0);
  assert.ok((await f.request('/memory-candidates')).candidates.some((item) => item.display_text === '我希望你回答直接一点'));
  await f.request('/privacy/automatic-memory', 'POST', { enabled: false });
  await f.send('我希望你回答详细一点');
  assert.equal((await f.request('/relationship-assets')).assets.length, 0);
});

test('recent interview memory expires from recall without expiring durable preferences', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const f = await fixture(t, { store });
  await f.request('/privacy/automatic-memory', 'POST', { enabled: true });
  await f.send('我喜欢喝热美式');
  await f.send('我喜欢喝茶');
  await f.send('我最近在准备面试');
  let assets = (await f.request('/relationship-assets')).assets;
  assert.equal(assets.length, 3);
  const recent = assets.find((asset) => asset.value.fact_key === 'recent.activity.interview');
  assert.ok(Date.parse(recent.valid_until) > Date.now() + 29 * 86400000);
  store.assets.get(recent.asset_id).valid_until = '2000-01-01T00:00:00Z';
  assets = (await f.request('/relationship-assets')).assets;
  assert.equal(assets.length, 2); assert.ok(assets.some((asset) => asset.value.fact_key === 'user.preference.drink:hot_americano'));
  await f.send('你好');
  assert.equal(f.contexts.at(-1).automatic_assets.length, 2);
});

test('rejecting a conflicting candidate prevents later silent recreation', async (t) => {
  const f = await fixture(t);
  await f.request('/privacy/automatic-memory', 'POST', { enabled: true });
  await f.send('我希望你回答直接一点');
  await f.send('我希望你回答简洁一点');
  const candidate = (await f.request('/memory-candidates')).candidates.find((item) => item.display_text === '我希望你回答简洁一点');
  assert.ok(candidate);
  await f.request(`/memory-candidates/${candidate.candidate_id}/reject`, 'POST', { expected_version: candidate.version });
  const original = (await f.request('/relationship-assets')).assets[0];
  await f.request(`/relationship-assets/${original.asset_id}`, 'DELETE');
  await f.send('我希望你回答简洁一点');
  assert.equal((await f.request('/relationship-assets')).assets.length, 0);
  assert.equal((await f.request('/memory-candidates')).candidates.length, 0);
});

test('PostgreSQL persists automatic memories and settings across scoped requests', { skip: !process.env.QIYU_PG_TEST_DATABASE_URL }, async (t) => {
  const pg = require('pg');
  const { PostgresStore } = require('../src/persistence/postgres-store');
  const pool = new pg.Pool({ connectionString: process.env.QIYU_PG_TEST_DATABASE_URL });
  t.after(() => pool.end());
  const store = new PostgresStore({ pool });
  const f = await fixture(t, { store });
  await f.request('/privacy/automatic-memory', 'POST', { enabled: true });
  await f.send('我希望你回答直接一点');
  await f.send('我最近在准备面试');
  const assets = (await f.request('/relationship-assets')).assets;
  assert.equal(assets.length, 2); assert.equal(assets[0].origin, 'AUTOMATIC');
  const client = await pool.connect();
  try {
    for (const [actor, value] of [['MODEL', { fact_key: 'communication.response_style', fact_value: 'direct' }], ['SYSTEM', { fact_key: 'health.diagnosis', fact_value: 'invented' }]]) {
      await client.query('BEGIN');
      await assert.rejects(client.query('INSERT INTO relationship_assets (account_id, character_id, type, value_json, state, activation_actor) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [assets[0].account_id, assets[0].character_id, 'PREFERENCE', JSON.stringify(value), 'ACTIVE', actor]), (error) => error.code === '23514');
      await client.query('ROLLBACK');
    }
  } finally { client.release(); }
  const recent = assets.find((asset) => asset.value.fact_key === 'recent.activity.interview');
  assert.ok(recent?.valid_until);
  const revised = await f.request(`/relationship-assets/${recent.asset_id}`, 'PATCH', { expected_version: recent.version, display_text: '我正在准备面试' });
  assert.equal(revised.revision.origin, 'USER_CONFIRMED');
  assert.equal((await f.request('/privacy/automatic-memory')).enabled, true);
  await f.send('我希望你回答详细一点', true);
  const candidate = (await f.request('/memory-candidates')).candidates.find((item) => item.display_text === '我希望你回答详细一点');
  assert.ok(candidate);
  assert.equal(candidate.conflicts_with.length, 1, 'conflicts are recomputed after PostgreSQL reload');
  await f.request(`/memory-candidates/${candidate.candidate_id}/confirm`, 'POST', { expected_version: candidate.version });
  const updated = (await f.request('/relationship-assets')).assets;
  assert.equal(updated.length, 2);
  const confirmed = updated.find((asset) => asset.value?.fact_key === 'communication.response_style');
  assert.ok(confirmed);
  const oldAutomatic = assets.find((asset) => asset.value.fact_key === 'communication.response_style');
  const previousRow = (await pool.query('SELECT state, superseded_by FROM relationship_assets WHERE asset_id = $1', [oldAutomatic.asset_id])).rows[0];
  assert.equal(previousRow.state, 'SUPERSEDED'); assert.equal(previousRow.superseded_by, confirmed.asset_id);
  await f.request(`/relationship-assets/${confirmed.asset_id}`, 'DELETE');
  assert.equal((await f.request('/relationship-assets')).assets.length, 1);
  await Promise.all([f.send('我喜欢喝茶'), f.send('我喜欢喝茶'), f.send('我喜欢喝茶')]);
  assert.equal((await f.request('/relationship-assets')).assets.filter((asset) => asset.value?.fact_key === 'user.preference.drink:tea').length, 1);
  const { runAutomaticMemoryJob, runAutomaticMemoryBatch } = require('../src/domain/automatic-memory-v2');
  const accountId = assets[0].account_id;
  const rejectedMessageId = randomUUID();
  await assert.rejects(store.withAccountTransaction(accountId, async (scoped) => {
    const account = scoped.account(accountId);
    scoped.messages.set(rejectedMessageId, {
      message_id: rejectedMessageId, conversation_id: f.conversation.conversation_id, actor: 'USER', text: '合成事务回滚样例'
    });
    scoped.automaticMemoryJobs.push({
      messageId: rejectedMessageId, preferenceVersion: account.automatic_memory_preference_version,
      revocationEpoch: account.revocation_epoch, mode: 'invalid-fixture'
    });
  }, { lockMemory: true }), (error) => error.code === '23514' && error.constraint === 'automatic_memory_jobs_mode_check');
  const { rows: [rollback] } = await pool.query(`SELECT
    EXISTS (SELECT 1 FROM messages WHERE message_id = $1) AS message_exists,
    EXISTS (SELECT 1 FROM automatic_memory_jobs WHERE message_id = $1) AS job_exists`, [rejectedMessageId]);
  assert.deepEqual(rollback, { message_exists: false, job_exists: false });
  const oldMode = process.env.QIYU_AUTOMATIC_MEMORY_V2;
  process.env.QIYU_AUTOMATIC_MEMORY_V2 = 'active';
  t.after(() => {
    if (oldMode === undefined) delete process.env.QIYU_AUTOMATIC_MEMORY_V2;
    else process.env.QIYU_AUTOMATIC_MEMORY_V2 = oldMode;
  });
  const extract = async (quote) => ({
    modelVersion: 'test-model',
    candidates: [{ category: 'preference', subject: 'self', assertion: 'explicit', quote, topic: '咖啡' }]
  });
  async function coffeeAssets(text) {
    await f.send(text);
    assert.equal(await runAutomaticMemoryJob({ store, accountId, extract, mode: 'active' }), 'COMPLETED');
    return (await f.request('/relationship-assets')).assets.filter((asset) => asset.value?.fact_key === 'user.preference.drink:coffee');
  }
  const [firstCoffee] = await coffeeAssets('我爱喝咖啡');
  assert.equal(firstCoffee.value.fact_value, 'like');
  const [duplicate] = await coffeeAssets('我偏爱咖啡');
  assert.equal(duplicate.asset_id, firstCoffee.asset_id);
  const revisedCoffee = await coffeeAssets('现在我不喜欢喝咖啡');
  assert.equal(revisedCoffee.length, 1);
  assert.equal(revisedCoffee[0].value.fact_value, 'dislike');
  const oldCoffee = (await pool.query('SELECT state, superseded_by FROM relationship_assets WHERE asset_id = $1', [firstCoffee.asset_id])).rows[0];
  assert.equal(oldCoffee.state, 'SUPERSEDED');
  assert.equal(oldCoffee.superseded_by, revisedCoffee[0].asset_id);
  let previousExam;
  for (const [date, expiresAt] of [
    ['2098-04-01', '2098-04-02T00:00:00.000Z'],
    ['2098-05-01', '2098-05-02T00:00:00.000Z'],
    ['2098-06-01', '2098-06-02T00:00:00.000Z'],
    ['二〇九九年二月二十八日', '2099-03-01T00:00:00.000Z']
  ]) {
    if (previousExam) {
      await pool.query("UPDATE relationship_assets SET valid_from = NOW() - interval '2 days', valid_until = NOW() - interval '1 day' WHERE asset_id = $1", [previousExam.asset_id]);
    }
    await f.send(`我计划${date}参加陶艺考试`);
    assert.equal(await runAutomaticMemoryJob({ store, accountId, mode: 'active', async extract(quote) {
      return { modelVersion: 'test-model', candidates: [{ category: 'recent', subject: 'self', assertion: 'explicit', quote, topic: '陶艺考试' }] };
    } }), 'COMPLETED');
    const exams = (await f.request('/relationship-assets')).assets.filter((asset) => asset.value?.fact_key === 'v2:recent:陶艺考试');
    assert.equal(exams.length, 1);
    assert.ok(exams[0].display_text.includes(date));
    assert.equal(exams[0].valid_until, expiresAt);
    if (previousExam) {
      const { rows: [oldExam] } = await pool.query('SELECT state, superseded_by FROM relationship_assets WHERE asset_id = $1', [previousExam.asset_id]);
      assert.equal(oldExam.state, 'SUPERSEDED');
      assert.equal(oldExam.superseded_by, exams[0].asset_id);
    }
    previousExam = exams[0];
  }
  const ambiguous = '我打算二月二十九日参加木雕考试';
  await f.send(ambiguous);
  assert.equal(await runAutomaticMemoryJob({ store, accountId, mode: 'active', async extract(quote) {
    return { modelVersion: 'test-model', candidates: [{ category: 'recent', subject: 'self', assertion: 'explicit', quote, topic: '木雕考试' }] };
  } }), 'COMPLETED');
  assert.ok((await f.request('/memory-candidates')).candidates.some((candidate) => candidate.display_text === ambiguous));
  assert.ok(!(await f.request('/relationship-assets')).assets.some((asset) => asset.display_text === ambiguous));
  async function jazzAssets(text) {
    await f.send(text);
    assert.equal(await runAutomaticMemoryJob({ store, accountId, mode: 'active', async extract(quote) {
      return { modelVersion: 'test-model', candidates: [{ category: 'interest', subject: 'self', assertion: 'explicit', quote, topic: '爵士乐' }] };
    } }), 'COMPLETED');
    return (await f.request('/relationship-assets')).assets.filter((asset) => asset.value?.fact_key === 'v2:preference:爵士乐');
  }
  const [firstJazz] = await jazzAssets('我很爱听爵士乐');
  assert.equal(firstJazz.value.fact_value, 'like');
  const [sameJazz] = await jazzAssets('我偏爱爵士乐');
  assert.equal(sameJazz.asset_id, firstJazz.asset_id);
  const changedJazz = await jazzAssets('现在我不喜欢听爵士乐');
  assert.equal(changedJazz.length, 1);
  assert.equal(changedJazz[0].value.fact_value, 'dislike');
  const { rows: [oldJazz] } = await pool.query('SELECT state, superseded_by FROM relationship_assets WHERE asset_id = $1', [firstJazz.asset_id]);
  assert.equal(oldJazz.state, 'SUPERSEDED');
  assert.equal(oldJazz.superseded_by, changedJazz[0].asset_id);
  async function yogurtAssets(text) {
    await f.send(text);
    assert.equal(await runAutomaticMemoryJob({ store, accountId, mode: 'active', async extract(quote) {
      return { modelVersion: 'test-model', candidates: [{ category: 'preference', subject: 'self', assertion: 'explicit', quote, topic: '无糖酸奶' }] };
    } }), 'COMPLETED');
    return (await f.request('/relationship-assets')).assets.filter((asset) =>
      ['v2:preference:无糖酸奶', 'v2:preference:吃无糖酸奶'].includes(asset.value?.fact_key));
  }
  const [firstYogurt] = await yogurtAssets('我喜欢吃无糖酸奶');
  assert.equal(firstYogurt.value.fact_key, 'v2:preference:无糖酸奶');
  // Earlier V2 builds used the literal object, including its action verb.
  await pool.query("UPDATE relationship_assets SET value_json = jsonb_set(value_json, '{fact_key}', to_jsonb($2::text)) WHERE asset_id = $1",
    [firstYogurt.asset_id, 'v2:preference:吃无糖酸奶']);
  const sameYogurt = await yogurtAssets('我偏爱无糖酸奶');
  assert.deepEqual(sameYogurt.map(({ asset_id }) => asset_id), [firstYogurt.asset_id]);
  const changedYogurt = await yogurtAssets('现在我不喜欢吃无糖酸奶');
  assert.equal(changedYogurt.length, 1);
  assert.equal(changedYogurt[0].value.fact_key, 'v2:preference:无糖酸奶');
  assert.equal(changedYogurt[0].value.fact_value, 'dislike');
  const { rows: [oldYogurt] } = await pool.query('SELECT state, superseded_by FROM relationship_assets WHERE asset_id = $1', [firstYogurt.asset_id]);
  assert.deepEqual(oldYogurt, { state: 'SUPERSEDED', superseded_by: changedYogurt[0].asset_id });
  const question = await f.send('问问我的爱好');
  assert.equal(await runAutomaticMemoryJob({ store, accountId, mode: 'active', async extract() {
    return { modelVersion: 'test-model', candidates: [] };
  } }), 'COMPLETED');
  const answer = await f.send('陶艺');
  assert.equal(await runAutomaticMemoryJob({ store, accountId, mode: 'active', async extract(quote, context) {
    assert.equal(context.at(-1).text, '你平时喜欢做什么？');
    return { modelVersion: 'test-model', candidates: [{ category: 'interest', subject: 'self', assertion: 'explicit', quote, topic: '陶艺' }] };
  } }), 'COMPLETED');
  const hobby = (await f.request('/relationship-assets')).assets.find((asset) => asset.value?.fact_key === 'v2:preference:陶艺');
  assert.equal(hobby.value.context_message_id, question.assistant_message.message_id);
  assert.equal(hobby.automatic_source_message_id, answer.user_message.message_id);
  const earlier = '我爱做折纸';
  const later = '现在我不喜欢折纸';
  await f.send(earlier);
  await f.send(later);
  const finished = [];
  let releaseEarlier;
  const release = new Promise((resolve) => { releaseEarlier = resolve; });
  const releaseTimeout = setTimeout(releaseEarlier, 3000);
  const [firstWorker, secondWorker] = await Promise.all([1, 2].map(() => runAutomaticMemoryBatch({
    store, accountId, mode: 'active',
    async extract(quote) {
      if (quote === earlier) await release;
      finished.push(quote);
      if (quote === later) releaseEarlier();
      return { modelVersion: 'test-model', candidates: [{ category: 'interest', subject: 'self', assertion: 'explicit', quote, topic: '折纸' }] };
    }
  })));
  clearTimeout(releaseTimeout);
  assert.deepEqual(finished, [later, earlier], 'model completion may be out of order without duplicate calls');
  assert.deepEqual([...firstWorker, ...secondWorker], ['COMPLETED', 'COMPLETED']);
  const paper = (await f.request('/relationship-assets')).assets.filter((asset) => asset.value?.fact_key === 'v2:preference:折纸');
  assert.equal(paper.length, 1);
  assert.equal(paper[0].value.fact_value, 'dislike', 'the later message must win despite finishing extraction first');
  await f.send('我喜欢烘焙');
  await f.send('现在我不喜欢做烘焙');
  let olderAttempts = 0;
  assert.deepEqual(await runAutomaticMemoryBatch({ store, accountId, mode: 'active', async extract(quote) {
    if (quote === '我喜欢烘焙' && ++olderAttempts === 1) throw new Error('synthetic timeout');
    return { modelVersion: 'test-model', candidates: [{ category: 'interest', subject: 'self', assertion: 'explicit', quote, topic: '烘焙' }] };
  } }), ['COMPLETED', 'COMPLETED']);
  assert.equal(olderAttempts, 2);
  const baking = (await f.request('/relationship-assets')).assets.filter((asset) => asset.value?.fact_key === 'v2:preference:烘焙');
  assert.equal(baking.length, 1);
  assert.equal(baking[0].value.fact_value, 'dislike', 'the older retry must not overtake the later revision');

  await f.request(`/conversations/${f.conversation.conversation_id}`, 'DELETE');
  assert.equal((await f.request('/relationship-assets')).assets.length, 0, 'deleting the source conversation removes its automatic and revised memories');
});
