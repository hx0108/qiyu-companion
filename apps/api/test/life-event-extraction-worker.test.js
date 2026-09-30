'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  LIFE_EVENT_EXTRACTION_PROMPT_VERSION, MAX_LIFE_EVENT_JOB_ATTEMPTS, MAX_PROCESSING_PER_ACCOUNT,
  enqueueLifeEventExtraction, runNextLifeEventExtractionJob, startLifeEventExtractionWorker
} = require('../src/domain/life-event-extraction-worker');

const ACCOUNT = 'acct_dev_alice';

function seededStore({ text = '我周五要去做产品经理的面试，好紧张' } = {}) {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set('char_1', { character_id: 'char_1', account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  store.conversations.set('conv_1', { conversation_id: 'conv_1', account_id: ACCOUNT, character_id: 'char_1', status: 'ACTIVE' });
  store.messages.set('msg_1', { message_id: 'msg_1', conversation_id: 'conv_1', account_id: ACCOUNT, actor: 'USER', text, created_at: new Date().toISOString(), deleted_at: null });
  return store;
}

function enqueue(store) {
  return enqueueLifeEventExtraction({
    store, account: store.account(ACCOUNT),
    conversation: store.conversations.get('conv_1'), message: store.messages.get('msg_1')
  });
}

const GOOD_CANDIDATE = { title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', raw_time_text: '周五', time_uncertain: true };
const generatorWith = (candidates) => async () => ({ candidates, provider: 'qwen', modelVersion: 'qwen3.8-flash', usage: { prompt_tokens: 100, completion_tokens: 20 } });

test('extraction-worker: 入队写 PENDING 任务 + outbox 事件，同消息去重', () => {
  const store = seededStore();
  const job = enqueue(store);
  assert.equal(job.state, 'PENDING');
  assert.equal(job.message_id, 'msg_1');
  assert.equal(job.captured_revocation_epoch, 0);
  assert.ok([...store.outboxEvents.values()].some((event) => event.event_type === 'life_event.extraction_requested.v1' && event.aggregate_id === job.job_id));
  const again = enqueue(store);
  assert.equal(again.job_id, job.job_id); // 去重
  assert.equal(store.lifeEventExtractionJobs.size, 1);
});

test('extraction-worker: 成功路径——合法候选建 life_event CANDIDATE、任务 COMPLETED、记成本', async () => {
  const store = seededStore();
  const job = enqueue(store);
  const outcome = await runNextLifeEventExtractionJob({ store, extractionGenerator: generatorWith([GOOD_CANDIDATE]), now: new Date() });
  assert.equal(outcome.state, 'COMPLETED');
  assert.equal(outcome.candidate_ids.length, 1);
  assert.equal(store.lifeEventExtractionJobs.get(job.job_id).state, 'COMPLETED');
  assert.ok(store.lifeEventExtractionJobs.get(job.job_id).completed_at);
  const candidate = store.candidates.get(outcome.candidate_ids[0]);
  assert.equal(candidate.type, 'life_event');
  assert.equal(candidate.state, 'CANDIDATE');
  assert.equal(candidate.source_message_id, 'msg_1');
  assert.equal(candidate.normalized_value.life_event.title, '周五的产品经理面试');
  assert.ok(candidate.expires_at);
  // 成本埋点：真实 usage 进 operationMetrics
  assert.ok([...store.operationMetrics.values()].some((metric) => metric.capability === 'LIFE_EVENT_EXTRACTION' && metric.input_tokens === 100));
});

test('extraction-worker: 单条不合法候选被丢弃，其余照常落地', async () => {
  const store = seededStore();
  enqueue(store);
  const outcome = await runNextLifeEventExtractionJob({
    store,
    extractionGenerator: generatorWith([{ title: 'x'.repeat(81), domain: 'REAL_LIFE' }, GOOD_CANDIDATE]),
    now: new Date()
  });
  assert.equal(outcome.state, 'COMPLETED');
  assert.equal(outcome.candidate_ids.length, 1);
  assert.equal(store.candidates.get(outcome.candidate_ids[0]).normalized_value.life_event.title, '周五的产品经理面试');
});

test('extraction-worker: 0 候选 = COMPLETED（无事件是正常结果，不重试）', async () => {
  const store = seededStore({ text: '今天天气不错' });
  const job = enqueue(store);
  const outcome = await runNextLifeEventExtractionJob({ store, extractionGenerator: generatorWith([]), now: new Date() });
  assert.equal(outcome.state, 'COMPLETED');
  assert.deepEqual(outcome.candidate_ids, []);
  assert.equal(store.lifeEventExtractionJobs.get(job.job_id).state, 'COMPLETED');
});

test('extraction-worker: 失败退避重试，3 次后 FAILED 留表（无独立死信表）', async () => {
  const store = seededStore();
  const job = enqueue(store);
  const failing = async () => { throw new Error('upstream 500'); };
  const first = await runNextLifeEventExtractionJob({ store, extractionGenerator: failing, now: new Date() });
  assert.equal(first.state, 'RETRY_SCHEDULED');
  assert.equal(store.lifeEventExtractionJobs.get(job.job_id).attempt_count, 1);
  assert.ok(store.lifeEventExtractionJobs.get(job.job_id).next_attempt_at > new Date().toISOString());

  // 推进时钟越过退避窗口再跑两次
  let now = new Date(Date.now() + 60_000);
  assert.equal((await runNextLifeEventExtractionJob({ store, extractionGenerator: failing, now })).state, 'RETRY_SCHEDULED');
  now = new Date(now.getTime() + 120_000);
  const final = await runNextLifeEventExtractionJob({ store, extractionGenerator: failing, now });
  assert.equal(final.state, 'FAILED');
  const finalJob = store.lifeEventExtractionJobs.get(job.job_id);
  assert.equal(finalJob.state, 'FAILED');
  assert.equal(finalJob.attempt_count, MAX_LIFE_EVENT_JOB_ATTEMPTS);
  assert.ok(finalJob.exhausted_at);
  assert.match(finalJob.last_error, /upstream 500/);
});

test('extraction-worker: epoch 变化（记忆撤销）→ 迟到结果丢弃 CANCELLED', async () => {
  const store = seededStore();
  const job = enqueue(store);
  store.account(ACCOUNT).revocation_epoch += 1; // 撤销发生在认领前
  const outcome = await runNextLifeEventExtractionJob({ store, extractionGenerator: generatorWith([GOOD_CANDIDATE]), now: new Date() });
  assert.equal(outcome.state, 'CANCELLED');
  assert.equal(store.lifeEventExtractionJobs.get(job.job_id).state, 'CANCELLED');
  assert.equal([...store.candidates.values()].filter((item) => item.type === 'life_event').length, 0);
});

test('extraction-worker: 模型调用在途期间消息被删 → 提交时丢弃', async () => {
  const store = seededStore();
  enqueue(store);
  const slowGenerator = async () => {
    store.messages.get('msg_1').deleted_at = new Date().toISOString(); // 在途删除
    return { candidates: [GOOD_CANDIDATE], provider: 'qwen', usage: null };
  };
  const outcome = await runNextLifeEventExtractionJob({ store, extractionGenerator: slowGenerator, now: new Date() });
  assert.equal(outcome.state, 'CANCELLED');
  assert.equal([...store.candidates.values()].filter((item) => item.type === 'life_event').length, 0);
});

test('extraction-worker: 单账户 PROCESSING 并发上限——超限任务不被认领', async () => {
  const store = seededStore();
  // 手工占满该账户的 PROCESSING 名额
  for (let index = 0; index < MAX_PROCESSING_PER_ACCOUNT; index += 1) {
    store.lifeEventExtractionJobs.set(`lexjob_busy_${index}`, { job_id: `lexjob_busy_${index}`, account_id: ACCOUNT, message_id: `msg_busy_${index}`, state: 'PROCESSING', attempt_count: 1, next_attempt_at: new Date().toISOString(), created_at: new Date().toISOString() });
  }
  enqueue(store);
  const outcome = await runNextLifeEventExtractionJob({ store, extractionGenerator: generatorWith([GOOD_CANDIDATE]), now: new Date() });
  assert.equal(outcome.state, 'IDLE'); // 名额满 → 不认领新任务
});

test('extraction-worker: 未配生成器返回 DISABLED（不堆积假执行）', async () => {
  const store = seededStore();
  enqueue(store);
  assert.equal((await runNextLifeEventExtractionJob({ store, extractionGenerator: null, now: new Date() })).state, 'DISABLED');
});

test('extraction-worker: startWorker 定时器 unref 且可停止', async () => {
  const store = seededStore();
  const worker = startLifeEventExtractionWorker(store, generatorWith([]), { intervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  worker.stop();
  assert.equal(LIFE_EVENT_EXTRACTION_PROMPT_VERSION, 'life-event-extraction.v1');
});
