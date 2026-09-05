'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationSummaryWorker } = require('../src/workers/conversation-summary-worker');

test('独立摘要 worker 只提交模型候选，失败时保留可重试任务', async () => {
  const events = [];
  const repository = {
    async claimNext() { return { job_id: 'job_1', conversation_id: 'cnv_1', previous_summary: null, pending_messages: [{ message_id: 'm1', actor: 'USER', text: '你好' }] }; },
    async complete(job, generated, latencyMs) { events.push(['complete', job.job_id, generated.text, latencyMs]); return { state: 'COMPLETED', summary_id: 'sum_1' }; },
    async fail(jobId, reason, latencyMs) { events.push(['fail', jobId, reason, latencyMs]); }
  };
  const worker = new ConversationSummaryWorker({ repository, summaryGenerator: async () => ({ text: '用户问候。', provider: 'qwen', modelVersion: 'qwen3.8-flash' }) });
  assert.deepEqual(await worker.runOnce(), { state: 'COMPLETED', job_id: 'job_1', summary_id: 'sum_1' });
  assert.deepEqual(events[0].slice(0, 3), ['complete', 'job_1', '用户问候。']);
  assert.equal(typeof events[0][3], 'number');
  const failed = new ConversationSummaryWorker({ repository, summaryGenerator: async () => { throw new Error('upstream\nbody'); } });
  assert.deepEqual(await failed.runOnce(), { state: 'RETRY_SCHEDULED', job_id: 'job_1' });
  assert.deepEqual(events.at(-1).slice(0, 3), ['fail', 'job_1', 'upstream body']);
  assert.equal(typeof events.at(-1)[3], 'number');
});

test('独立摘要 worker 在无任务时不会调用模型', async () => {
  const worker = new ConversationSummaryWorker({ repository: { async claimNext() { return null; }, async complete() {}, async fail() {} }, summaryGenerator: async () => { throw new Error('不应调用'); } });
  assert.deepEqual(await worker.runOnce(), { state: 'IDLE' });
});
