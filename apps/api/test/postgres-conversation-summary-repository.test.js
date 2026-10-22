'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresConversationSummaryRepository } = require('../src/persistence/postgres-conversation-summary-repository');
test('PG摘要claim快照绑定源正文：生成期间修订或删除来源会取消提交', async () => {
  for (const operation of ['correct', 'delete', 'unchanged']) {
    let messages = [{ message_id: 'm1', conversation_id: 'c1', actor: 'USER', text: '我住在上海', created_at: '2026-09-01T00:00:00Z', retention_expires_at: '2026-12-01T00:00:00Z' }, { message_id: 'm2', conversation_id: 'c1', actor: 'ASSISTANT', text: '记下了', created_at: '2026-09-01T00:01:00Z', retention_expires_at: '2026-12-01T00:00:00Z' }];
    const statements = [];
    const client = { release() {}, async query(sql) {
      statements.push(sql);
      if (sql.startsWith('WITH next_job')) return { rows: [{ job_id: 'j1', account_id: 'a1', conversation_id: 'c1', source_to_id: 'm2', captured_revocation_epoch: 0 }] };
      if (sql.startsWith('SELECT m.message_id')) return { rows: messages.map((m) => ({ ...m })) };
      if (sql.startsWith('SELECT summary_id')) return { rows: [] };
      if (sql.startsWith('SELECT a.account_status')) return { rows: [{ account_status: 'OPEN', revocation_epoch: 0, status: 'OPEN' }] };
      return { rows: [] };
    } };
    const repository = new PostgresConversationSummaryRepository({ pool: { connect: async () => client } });
    const job = await repository.claimNext();
    if (operation === 'correct') messages[0].text = '我住在北京';
    if (operation === 'delete') messages = messages.slice(1);
    const result = await repository.complete(job, { text: '源摘要', modelVersion: 'spy', provider: 'spy', promptVersion: 'conversation-summary.v2' });
    assert.equal(result.state, operation === 'unchanged' ? 'COMPLETED' : 'CANCELLED');
    assert.equal(statements.some((sql) => sql.startsWith('INSERT INTO conversation_summaries')), operation === 'unchanged');
  }
});
