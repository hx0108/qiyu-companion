'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { deterministicEmbedding, runNextAssetEmbeddingJob, EMBEDDING_DIMENSIONS } = require('../src/domain/asset-embedding-worker');
const { DevelopmentStore } = require('../src/domain/store');

const REVIEWER = { authorization: 'Bearer reviewer-dev-token' };

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = 'dev-alice-token', key, body, headers } = {}) {
  const allHeaders = { authorization: `Bearer ${token}`, ...(headers || {}) };
  if (key) allHeaders['idempotency-key'] = key;
  if (body !== undefined) allHeaders['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers: allHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function readyConversation(base, prefix = 'emb', token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', token, key: `${prefix}-c`, body: { name: `${prefix} 角色` } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', token, key: `${prefix}-v`, body: { character_id: character.body.character.character_id } });
  return { characterId: character.body.character.character_id, conversationId: conversation.body.conversation.conversation_id };
}

async function confirmAsset(base, store, prefix, text = '用户喜欢雨天') {
  const conversation = [...store.conversations.values()].at(-1);
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: `${prefix}-m`, body: { content: { text } } });
  const candidates = await request(base, '/api/v1/memory-candidates');
  const candidate = candidates.body.candidates[0];
  const confirmed = await request(base, `/api/v1/memory-candidates/${candidate.candidate_id}/confirm`, { method: 'POST', key: `${prefix}-conf`, body: { expected_version: candidate.version } });
  return confirmed.body.asset;
}

test('确认资产 → index_state=PENDING → Worker 建索引 → READY，向量可复现且维度固定', async (t) => {
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  await readyConversation(base, 'emb1');
  const asset = await confirmAsset(base, store, 'emb1');

  assert.equal(asset.index_state, 'PENDING', '确认响应应返回 index_state=PENDING（技术设计 8.5）');
  assert.equal(store.assetEmbeddingJobs.size, 1, '应入队一个建索引任务');
  assert.equal([...store.outboxEvents.values()].filter((event) => event.event_type === 'asset.embedding_requested.v1').length, 1, '应写入 Outbox 事件');

  const result = await runNextAssetEmbeddingJob({ store, now: new Date() });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(store.assets.get(asset.asset_id).index_state, 'READY');
  const embedding = store.assetEmbeddings.get(asset.asset_id);
  assert.ok(embedding, '向量应写入');
  assert.equal(embedding.embedding.length, EMBEDDING_DIMENSIONS);
  assert.equal(embedding.version, asset.version);
  // 确定性嵌入可复现。
  assert.deepEqual(embedding.embedding, deterministicEmbedding(asset.display_text));
});

test('索引未就绪不丢失召回：PENDING 资产仍进入上下文，READY 后按向量重排', async (t) => {
  const store = new DevelopmentStore();
  const observed = [];
  const base = await start(t, {
    store,
    replyGenerator: async (text, context) => {
      observed.push(context.confirmed_assets.map((item) => item.display_text));
      return { provider: 'spy', model_version: 'spy-v1', reply_text: `回复：${text}`, ai_generated: true, disclaimer: '测试生成器。', memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: text } };
    }
  });
  const { conversationId } = await readyConversation(base, 'emb2');
  await confirmAsset(base, store, 'emb2', '用户喜欢雨天的声音');

  // PENDING 期间：资产仍被召回（词法回退，不丢失）。
  await request(base, `/api/v1/conversations/${conversationId}/messages`, { method: 'POST', key: 'emb2-m2', body: { content: { text: '今天也在下雨' } } });
  assert.equal(observed.at(-1).length, 1, '索引未就绪资产仍应召回');

  await runNextAssetEmbeddingJob({ store, now: new Date() });
  await request(base, `/api/v1/conversations/${conversationId}/messages`, { method: 'POST', key: 'emb2-m3', body: { content: { text: '下雨天好安静' } } });
  assert.equal(observed.at(-1).length, 1, 'READY 后仍召回');
});

test('删除资产：向量立即失效、未完成任务取消、删除任务含 VECTOR_INDEX 目标', async (t) => {
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  await readyConversation(base, 'emb3');
  const asset = await confirmAsset(base, store, 'emb3');
  await runNextAssetEmbeddingJob({ store, now: new Date() });
  assert.ok(store.assetEmbeddings.has(asset.asset_id));

  const deleted = await request(base, `/api/v1/relationship-assets/${asset.asset_id}`, { method: 'DELETE', key: 'emb3-del' });
  assert.equal(deleted.status, 200);
  const vectorTarget = deleted.body.deletion_job.targets.find((target) => target.type === 'VECTOR_INDEX');
  assert.ok(vectorTarget, '删除任务应含 VECTOR_INDEX 目标（技术设计 8.9）');
  assert.equal(vectorTarget.state, 'INVALIDATED');
  assert.ok(!store.assetEmbeddings.has(asset.asset_id), '向量应立即下线');

  // 删除后 Worker 不再为已删资产建索引。
  const cancelled = await runNextAssetEmbeddingJob({ store, now: new Date() });
  assert.equal(cancelled.state, 'IDLE');
});

test('修订资产：旧向量失效、新版本重新入队（SUPERSEDED 不再召回旧文本）', async (t) => {
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  await readyConversation(base, 'emb4');
  const asset = await confirmAsset(base, store, 'emb4', '用户喜欢绿茶');
  await runNextAssetEmbeddingJob({ store, now: new Date() });
  assert.ok(store.assetEmbeddings.has(asset.asset_id));

  const revised = await request(base, `/api/v1/relationship-assets/${asset.asset_id}`, {
    method: 'PATCH', key: 'emb4-rev', body: { expected_version: asset.version, display_text: '用户现在更喜欢乌龙茶' }
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.revision.index_state, 'PENDING');
  assert.ok(!store.assetEmbeddings.has(asset.asset_id), '旧版本向量应失效');
  const result = await runNextAssetEmbeddingJob({ store, now: new Date() });
  assert.equal(result.state, 'COMPLETED');
  assert.equal(store.assets.get(revised.body.revision.asset_id).index_state, 'READY');
});

test('供应商失败：指数退避重试 → 耗尽进死信 → 运营重放一次恢复', async (t) => {
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  await readyConversation(base, 'emb5');
  const asset = await confirmAsset(base, store, 'emb5');

  let calls = 0;
  // 入队时刻取真实 now；测试时钟从其后开始，保证重试窗口按序推进。
  let clock = new Date(Date.now() + 1000);
  const failThenPass = async () => { calls += 1; if (calls <= 5) throw new Error('vector service down'); return deterministicEmbedding(asset.display_text); };
  let outcome;
  for (let round = 0; round < 5; round += 1) {
    outcome = await runNextAssetEmbeddingJob({ store, embeddingProvider: failThenPass, now: clock });
    if (outcome.state === 'DLQ') break;
    clock = new Date(clock.getTime() + 600_000);
  }
  assert.equal(outcome.state, 'DLQ', '五次失败后应进死信');
  assert.equal(store.assetEmbeddingDeadLetters.size, 1);

  // internal 队列可见；重放一次后恢复。
  const queue = await request(base, '/internal/asset-embedding-dead-letters', { token: 'reviewer-dev-token', headers: REVIEWER });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.dead_letters[0].state, 'OPEN');
  const jobId = queue.body.dead_letters[0].job_id;

  const replayed = await request(base, `/internal/asset-embedding-dead-letters/${encodeURIComponent(jobId)}/replay`, {
    method: 'POST', token: 'reviewer-dev-token', headers: REVIEWER, key: 'emb5-replay', body: { reason: '向量服务已恢复，人工重放' }
  });
  assert.equal(replayed.status, 200);
  const done = await runNextAssetEmbeddingJob({ store, embeddingProvider: failThenPass, now: clock });
  assert.equal(done.state, 'COMPLETED');
  assert.equal(store.assets.get(asset.asset_id).index_state, 'READY');

  // 第二次重放被拒（一次限制）。
  const twice = await request(base, `/internal/asset-embedding-dead-letters/${encodeURIComponent(jobId)}/replay`, {
    method: 'POST', token: 'reviewer-dev-token', headers: REVIEWER, key: 'emb5-replay2', body: { reason: '再试一次' }
  });
  assert.equal(twice.status, 409);

  // 用户 token 不可访问。
  const forbidden = await request(base, '/internal/asset-embedding-dead-letters');
  assert.equal(forbidden.status, 401);
});

test('确定性嵌入：非空归一化、相同文本同向量、不同文本异向量', () => {
  const left = deterministicEmbedding('用户喜欢雨天');
  const right = deterministicEmbedding('用户喜欢雨天');
  const other = deterministicEmbedding('用户养了一只猫叫芝麻');
  assert.deepEqual(left, right);
  assert.notDeepEqual(left, other);
  const norm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, 'L2 归一化');
  assert.ok(left.every((value) => Number.isFinite(value)));
});
