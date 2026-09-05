'use strict';

// 独立后台 Worker 进程（技术设计 12.4 的隔离 Worker 部署形态，本地开发版）：
// API 进程以 QIYU_PERSISTENCE=postgres 运行时不内嵌任何 Worker（请求作用域存储
// 不适合后台轮询）；本进程补齐该空白——消费会话摘要与资产 Embedding 任务队列。
//
// 队列发现与 RLS 语义：先用直连（无 app.current_account 作用域）查询两张任务表
// 的 DISTINCT account_id（只取账户标识、不读任务内容，可审计），再逐账户经
// withAccountTransaction 在账户作用域内执行任务——任务读写仍走全部 RLS 约束。
//
// 模型依赖：摘要任务需要 Qwen（QIYU_LLM_PROVIDER=qwen + QWEN_API_KEY），
// 未配置时摘要队列跳过；Embedding 用确定性开发嵌入，无外呼、无密钥。
//
// 用法：DATABASE_URL=... node scripts/run-workers.js [--once] [--interval-ms 5000]

const { createPersistenceFromEnvironment } = require('../src/persistence/composition');
const { createQwenConversationSummaryGenerator } = require('../src/providers/qwen-adapter');
const { runNextConversationSummaryJob } = require('../src/domain/conversation-summary-worker');
const { runNextAssetEmbeddingJob } = require('../src/domain/asset-embedding-worker');
const pg = require('pg');

function parseArgs(argv) {
  return {
    once: argv.includes('--once'),
    intervalMs: Number(argv.find((arg) => arg.startsWith('--interval-ms='))?.split('=')[1]) || 5000
  };
}

async function main() {
  const { once, intervalMs } = parseArgs(process.argv.slice(2));
  const store = createPersistenceFromEnvironment(process.env);
  if (typeof store.withAccountTransaction !== 'function') {
    throw new Error('run-workers 需要 QIYU_PERSISTENCE=postgres；内存模式的 Worker 由 API 进程内嵌运行');
  }
  const summaryGenerator = createQwenConversationSummaryGenerator(process.env) || null;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

  async function discoverAccounts() {
    // 只取账户标识做队列发现；任务内容的读写全部发生在账户作用域事务内。
    const result = await pool.query(`
      SELECT DISTINCT account_id FROM (
        SELECT account_id FROM conversation_summary_jobs WHERE state = 'PENDING' AND exhausted_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP
        UNION ALL
        SELECT account_id FROM asset_embedding_jobs WHERE state = 'PENDING' AND exhausted_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP
      ) pending`);
    return result.rows.map((row) => row.account_id);
  }

  async function drainAccount(accountId) {
    let summaries = 0;
    let embeddings = 0;
    for (let round = 0; round < 20; round += 1) {
      const outcome = await store.withAccountTransaction(accountId, async (scoped) => {
        const summaryResult = summaryGenerator ? await runNextConversationSummaryJob({ store: scoped, summaryGenerator, now: new Date() }) : { state: 'SKIPPED_NO_MODEL' };
        if (summaryResult.state === 'COMPLETED') summaries += 1;
        const embeddingResult = await runNextAssetEmbeddingJob({ store: scoped, now: new Date() });
        if (embeddingResult.state === 'COMPLETED') embeddings += 1;
        return summaryResult.state === 'IDLE' && embeddingResult.state === 'IDLE';
      });
      if (outcome) break;
    }
    return { summaries, embeddings };
  }

  async function tick() {
    const accounts = await discoverAccounts();
    for (const accountId of accounts) {
      const done = await drainAccount(accountId).catch((error) => {
        console.error(`[worker] 账户 ${accountId} 任务失败：`, error.message);
        return { summaries: 0, embeddings: 0 };
      });
      if (done.summaries > 0 || done.embeddings > 0) {
        console.log(`[worker] 账户 ${accountId}：摘要 +${done.summaries}，向量 +${done.embeddings}`);
      }
    }
    return accounts.length;
  }

  console.log(`[worker] 独立 Worker 已启动（间隔 ${intervalMs}ms；摘要模型：${summaryGenerator ? 'qwen' : '未配置——跳过摘要队列'}）。`);
  let running = true;
  process.on('SIGINT', () => { running = false; });

  while (running) {
    const pending = await tick().catch((error) => { console.error('[worker] 队列发现失败：', error.message); return 0; });
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (pending === 0) continue;
  }

  await pool.end();
  console.log('[worker] 已退出。');
}

main().catch((error) => { console.error('[worker] 启动失败：', error.message); process.exit(1); });
