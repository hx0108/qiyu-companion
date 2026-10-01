'use strict';
// 六项能力 A4 三通道提取一致性（P4.2）：数据集 channel-replay 标记的 10 条
// 关键剧本，经文字非流式 / SSE 流式 / 通话回合（与 call-turn-engine 同款域
// 入队入口——通话接线本身由 call-turn-engine.test.js 覆盖）三路径入队后，
// 用确定性提取器逐任务提取，断言三通道候选 canonical JSON 两两一致。
// 首轮运行即抓到真缺口：非流式的输出侧守卫（越权声明/输出审核）触发时
// 静默跳过提取，而 SSE 在受理时已入队——同一条消息两通道行为分叉，已修
//（app.js 输出守卫分支补 enqueue）。输入侧安全/审核分支两通道语义本就
// 一致（SSE 在这些分支之前即返回，不到受理）。
// 提示注入用例在本层只验奇偶性；注入防护的模型层判定属真实运行包范围。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { parseDevFlags } = require('../src/development/dev-flags');
const { generateReply, mockLifeEventExtractor } = require('../src/domain/mock-adapter');
const { runNextLifeEventExtractionJob } = require('../src/domain/life-event-extraction-worker');
const { enqueueLifeEventExtraction } = require('../src/domain/life-event-extraction-worker');

const DATASET = path.resolve(__dirname, '../../../development/eval/datasets/qiyu-capabilities-v0.1/cases.jsonl');
const REPLAY_CASES = fs.readFileSync(DATASET, 'utf8').trim().split(/\r?\n/)
  .map((line) => JSON.parse(line))
  .filter((item) => (item.tags ?? []).includes('channel-replay'));

const LIFE_FLAGS = parseDevFlags({ QIYU_DEV_FLAGS: 'LIFE_EVENTS' });

function canonical(value) {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  return value;
}

async function seedConversation(base) {
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };
  const notices = await (await fetch(`${base}/api/v1/required-notices`, { headers })).json();
  const notice = notices.notices[0];
  await fetch(`${base}/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', headers: { ...headers, 'idempotency-key': `n-${Math.random()}` }, body: JSON.stringify({ notice_version: notice.notice_version }) });
  await fetch(`${base}/api/v1/age/declarations`, { method: 'POST', headers: { ...headers, 'idempotency-key': `a-${Math.random()}` }, body: JSON.stringify({ date_of_birth: '1990-01-01', confirmed_18_plus: true }) });
  const character = (await (await fetch(`${base}/api/v1/characters`, { method: 'POST', headers: { ...headers, 'idempotency-key': `c-${Math.random()}` }, body: JSON.stringify({ name: '栖夏' }) })).json()).character;
  const conversation = (await (await fetch(`${base}/api/v1/conversations`, { method: 'POST', headers: { ...headers, 'idempotency-key': `v-${Math.random()}` }, body: JSON.stringify({ character_id: character.character_id }) })).json()).conversation;
  return { conversation, character };
}

test('三通道提取一致性：channel-replay 10 条剧本逐条奇偶（canonical JSON 两两相等）', async (t) => {
  assert.equal(REPLAY_CASES.length, 10, '数据集应提供恰好 10 条 channel-replay 剧本');
  const store = new DevelopmentStore();
  const app = createApp({
    store, devFlags: LIFE_FLAGS, replyGenerator: generateReply,
    streamingReplyGenerator: { generateStream: async () => {} }
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const { conversation, character } = await seedConversation(base);
  const headers = { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json' };

  const channelOfJob = new Map(); // job_id → channel
  for (const [index, replayCase] of REPLAY_CASES.entries()) {
    const text = replayCase.turns[0];
    // ① 文字非流式。
    await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': `parity-plain-${index}` }, body: JSON.stringify({ content: { text } })
    });
    const plainJob = [...store.lifeEventExtractionJobs.values()].at(-1);
    channelOfJob.set(plainJob.job_id, 'plain');
    // ② SSE 流式。
    await fetch(`${base}/api/v1/conversations/${conversation.conversation_id}/messages`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': `parity-sse-${index}` }, body: JSON.stringify({ content: { text }, stream: true })
    });
    const sseJob = [...store.lifeEventExtractionJobs.values()].at(-1);
    channelOfJob.set(sseJob.job_id, 'sse');
    // ③ 通话回合：与 call-turn-engine 的 deps.enqueueLifeEventExtraction 同款
    // 域入口（消息形态带 call_session_id 的转写落库）。
    const callMessage = {
      message_id: store.next('msg'), conversation_id: conversation.conversation_id, account_id: 'acct_dev_alice',
      actor: 'USER', text, call_session_id: 'call_parity_' + index, created_at: new Date().toISOString()
    };
    store.messages.set(callMessage.message_id, callMessage);
    enqueueLifeEventExtraction({ store, account: store.account('acct_dev_alice'), conversation, message: callMessage });
    const callJob = [...store.lifeEventExtractionJobs.values()].at(-1);
    channelOfJob.set(callJob.job_id, 'call');
  }
  assert.equal(store.lifeEventExtractionJobs.size, 30, '10 剧本 × 3 通道 = 30 个提取任务');

  // 逐任务提取（确定性提取器），按通道与剧本归组候选。
  const candidatesByJob = new Map();
  for (let i = 0; i < 30; i += 1) {
    const outcome = await runNextLifeEventExtractionJob({ store, extractionGenerator: mockLifeEventExtractor });
    assert.notEqual(outcome.state, 'FAILED', `提取任务失败：${outcome.last_error ?? ''}`);
    if (outcome.state === 'COMPLETED') candidatesByJob.set(outcome.job_id, (outcome.candidates ?? []).map(canonical));
    else if (outcome.state === 'CANCELLED') candidatesByJob.set(outcome.job_id, []);
    else break;
  }
  // 30 个任务分属 10 个剧本（同一剧本三通道的消息在 store 顺序相邻）。
  const jobsByChannelOrder = [...store.lifeEventExtractionJobs.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.job_id < b.job_id ? -1 : 1));
  // 按入队顺序每 3 个为一组（plain/sse/call），组内两两比较。
  for (let caseIndex = 0; caseIndex < REPLAY_CASES.length; caseIndex += 1) {
    const group = jobsByChannelOrder.slice(caseIndex * 3, caseIndex * 3 + 3);
    const channels = group.map((job) => channelOfJob.get(job.job_id));
    assert.deepEqual([...channels].sort(), ['call', 'plain', 'sse'], `剧本 ${REPLAY_CASES[caseIndex].case_id} 的三通道任务应齐备`);
    const plain = candidatesByJob.get(group.find((job) => channelOfJob.get(job.job_id) === 'plain').job_id);
    const sse = candidatesByJob.get(group.find((job) => channelOfJob.get(job.job_id) === 'sse').job_id);
    const call = candidatesByJob.get(group.find((job) => channelOfJob.get(job.job_id) === 'call').job_id);
    const caseId = REPLAY_CASES[caseIndex].case_id;
    assert.equal(plain.length, sse.length, `${caseId} 非流式与 SSE 候选数一致`);
    assert.equal(plain.length, call.length, `${caseId} 非流式与通话候选数一致`);
    for (let i = 0; i < plain.length; i += 1) {
      assert.equal(plain[i], sse[i], `${caseId} 第 ${i + 1} 个候选非流式=SSE`);
      assert.equal(plain[i], call[i], `${caseId} 第 ${i + 1} 个候选非流式=通话`);
    }
  }
});
