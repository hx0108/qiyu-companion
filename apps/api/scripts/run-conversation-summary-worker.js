'use strict';

const { Pool } = require('pg');
const { createQwenConversationSummaryGenerator } = require('../src/providers/qwen-adapter');
const { PostgresConversationSummaryRepository } = require('../src/persistence/postgres-conversation-summary-repository');
const { ConversationSummaryWorker } = require('../src/workers/conversation-summary-worker');

async function main(environment = process.env) {
  const databaseUrl = required(environment.QIYU_CONVERSATION_SUMMARY_DATABASE_URL, 'QIYU_CONVERSATION_SUMMARY_DATABASE_URL');
  const summaryGenerator = createQwenConversationSummaryGenerator(environment);
  if (!summaryGenerator) throw new Error('QIYU_LLM_PROVIDER=qwen and a Qwen API key are required for the summary worker');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const worker = new ConversationSummaryWorker({ repository: new PostgresConversationSummaryRepository({ pool }), summaryGenerator });
    process.stdout.write(`${JSON.stringify(await worker.runOnce())}\n`);
  } finally { await pool.end(); }
}
function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value; }
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
