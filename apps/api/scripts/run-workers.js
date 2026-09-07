'use strict';

// 独立后台 Worker 进程（技术设计 12.4 的隔离 Worker 部署形态，本地开发版）：
// API 进程以 QIYU_PERSISTENCE=postgres 运行时不内嵌任何 Worker（请求作用域存储
// 不适合后台轮询）；本进程补齐该空白，消费四类队列：
//   1) 会话摘要（账户 RLS 作用域消费；需要 Qwen，未配置时跳过）；
//   2) 资产 Embedding（确定性开发嵌入；由 BYPASSRLS 专用角色领取）；
//   3) 图片生成任务状态推进（P0 后台任务化：不再依赖前端手动刷新；
//      需要 QIYU_IMAGE_PROVIDER=tencent-hunyuan 全套图片管线环境）；
//   4) 保留期清理（30/90 天原始消息 + ASR 原始音频 24h 下线，PG 版）；
//   5) 内容权利清理（可选：配置 QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL
//      专用角色连接后，COS 物理删除随本进程持续消费，无需人工定时脚本）。
//
// 模型依赖：摘要任务需要 Qwen（QIYU_LLM_PROVIDER=qwen + QWEN_API_KEY），
// 未配置时摘要队列跳过；Embedding 用确定性开发嵌入，无外呼、无密钥。
//
// 用法：DATABASE_URL=... node scripts/run-workers.js [--once] [--interval-ms 5000]

const { createPersistenceFromEnvironment } = require('../src/persistence/composition');
const { createQwenConversationSummaryGenerator, createQwenEmbeddingProvider } = require('../src/providers/qwen-adapter');
const { runNextConversationSummaryJob } = require('../src/domain/conversation-summary-worker');
const { deterministicEmbedding, DEVELOPMENT_EMBEDDING_MODEL_VERSION } = require('../src/domain/asset-embedding-worker');
const { advanceImageJob } = require('../src/domain/image-job-advance');
const { runRetentionSweep } = require('../src/domain/retention-worker');
const { runAccountDeletionCleanup } = require('../src/domain/deletion-orchestration');
const { ContentRightsCleanupWorker } = require('../src/workers/content-rights-cleanup-worker');
const { PostgresContentRightsCleanupRepository } = require('../src/persistence/postgres-content-rights-cleanup-repository');
const { PostgresAssetEmbeddingRepository } = require('../src/persistence/postgres-asset-embedding-repository');
const { createTencentHunyuanImageGeneratorFromEnvironment } = require('../src/providers/tencent-hunyuan-image-adapter');
const { createTencentImageModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');
const { createTencentCosPrivateMediaStoreFromEnvironment } = require('../src/media/tencent-cos-private-media-store');
const { LocalPrivateMediaStore } = require('../src/media/local-private-media-store');
const { fetchTencentGeneratedImage } = require('../src/media/tencent-image-result-fetcher');
const pg = require('pg');

function parseArgs(argv) {
  return {
    once: argv.includes('--once'),
    intervalMs: Number(argv.find((arg) => arg.startsWith('--interval-ms='))?.split('=')[1]) || 5000
  };
}

// 图片管线依赖：任一环节未配置就整体跳过（与 API 进程 server.js 的装配同一批
// 工厂），保证 Worker 推进与 HTTP 手动刷新走同一适配器实现。
function buildImageDepsFromEnvironment(environment) {
  try {
    const imageGenerator = createTencentHunyuanImageGeneratorFromEnvironment(environment);
    const imageModerator = createTencentImageModeratorFromEnvironment(environment);
    const imageStore = createTencentCosPrivateImageStoreFromEnvironment(environment);
    if (!imageGenerator || typeof imageGenerator.query !== 'function' || !imageModerator || !imageStore) return null;
    return { imageGenerator, imageModerator, imageStore };
  } catch {
    return null;
  }
}

async function main() {
  const { once, intervalMs } = parseArgs(process.argv.slice(2));
  const store = createPersistenceFromEnvironment(process.env);
  if (typeof store.withAccountTransaction !== 'function') {
    throw new Error('run-workers 需要 QIYU_PERSISTENCE=postgres；内存模式的 Worker 由 API 进程内嵌运行');
  }
  const summaryGenerator = createQwenConversationSummaryGenerator(process.env) || null;
  // 语义向量（P1-4）：Qwen 配置时用供应商语义向量建索引；否则确定性开发嵌入。
  const embeddingProvider = createQwenEmbeddingProvider(process.env) || null;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const embeddingRepository = new PostgresAssetEmbeddingRepository({ pool });
  const imageDeps = buildImageDepsFromEnvironment(process.env);
  // 注销清理用的私有媒体存储：优先 COS，未配置时退回本地开发库（与 API
  // 进程 createApp 的默认 LocalPrivateMediaStore 同一根目录）。
  let mediaStore = null;
  try { mediaStore = createTencentCosPrivateMediaStoreFromEnvironment(process.env) || new LocalPrivateMediaStore(); }
  catch { mediaStore = new LocalPrivateMediaStore(); }
  const cleanupPool = process.env.QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL, max: 1 })
    : null;
  const cleanupWorker = cleanupPool && imageDeps
    ? new ContentRightsCleanupWorker({ repository: new PostgresContentRightsCleanupRepository({ pool: cleanupPool }), imageStore: imageDeps.imageStore })
    : null;

  async function discoverAccounts(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows.map((row) => row.account_id);
  }

  async function drainAccount(accountId) {
    let summaries = 0;
    for (let round = 0; round < 20; round += 1) {
      const outcome = await store.withAccountTransaction(accountId, async (scoped) => {
        const summaryResult = summaryGenerator ? await runNextConversationSummaryJob({ store: scoped, summaryGenerator, now: new Date() }) : { state: 'SKIPPED_NO_MODEL' };
        if (summaryResult.state === 'COMPLETED') summaries += 1;
        return summaryResult.state === 'IDLE' || summaryResult.state === 'SKIPPED_NO_MODEL';
      });
      if (outcome) break;
    }
    return { summaries };
  }

  // 图片任务推进：与 HTTP refresh 共用 ./domain/image-job-advance 状态机。
  // 权益服务由请求作用域 store 挂载（同 API 进程），提交/回滚语义一致。
  async function advanceImageJobs(accountId) {
    let advanced = 0;
    await store.withAccountTransaction(accountId, async (scoped) => {
      const account = [...scoped.accounts.values()][0];
      if (!account) return;
      const pending = [...scoped.mediaJobs.values()]
        .filter((job) => job.type === 'IMAGE_GENERATION' && ['PENDING', 'RUNNING'].includes(job.state))
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      for (const job of pending) {
        await advanceImageJob(scoped, account, job, { ...imageDeps, imageResultFetcher: fetchTencentGeneratedImage, imageEntitlementService: scoped.mediaEntitlementService || null });
        advanced += 1;
        if (['COMPLETED', 'FAILED', 'BLOCKED'].includes(job.state)) console.log(`[worker] 图片任务 ${job.job_id} → ${job.state}`);
      }
    });
    return advanced;
  }

  // 保留期清理（PG 版，与内存模式 runRetentionSweep 同一领域函数）。
  async function sweepRetention(accountId) {
    let swept = 0;
    await store.withAccountTransaction(accountId, async (scoped) => {
      const result = runRetentionSweep(scoped, new Date());
      swept += result.accounts.reduce((total, item) => total + item.expired_message_count, 0) + result.expired_asr_input_assets.length;
    });
    return swept;
  }

  async function tick() {
    let worked = 0;
    const summaryAccounts = await discoverAccounts(`
      SELECT DISTINCT account_id FROM (
        SELECT account_id FROM conversation_summary_jobs WHERE state = 'PENDING' AND exhausted_at IS NULL AND next_attempt_at <= CURRENT_TIMESTAMP
      ) pending`);
    for (const accountId of summaryAccounts) {
      const done = await drainAccount(accountId).catch((error) => {
        console.error(`[worker] 账户 ${accountId} 摘要任务失败：`, error.message);
        return { summaries: 0 };
      });
      if (done.summaries > 0) {
        console.log(`[worker] 账户 ${accountId}：摘要 +${done.summaries}`);
        worked += done.summaries;
      }
    }

    let embeddings = 0;
    for (let round = 0; round < 20; round += 1) {
      const outcome = await embeddingRepository.runOnce({
        embeddingProvider: embeddingProvider ? embeddingProvider.embed : deterministicEmbedding,
        modelVersion: embeddingProvider ? embeddingProvider.modelVersion : DEVELOPMENT_EMBEDDING_MODEL_VERSION,
        expectedDimensions: embeddingProvider ? embeddingProvider.dimensions : undefined
      });
      if (outcome.state !== 'COMPLETED') break;
      embeddings += 1;
    }
    if (embeddings > 0) console.log(`[worker] 向量 +${embeddings}`);
    worked += embeddings;

    if (imageDeps) {
      const imageAccounts = await discoverAccounts(`
        SELECT DISTINCT account_id FROM media_jobs
        WHERE type = 'IMAGE_GENERATION' AND state IN ('PENDING', 'RUNNING') AND deleted_at IS NULL`);
      for (const accountId of imageAccounts) {
        const advanced = await advanceImageJobs(accountId).catch((error) => {
          console.error(`[worker] 账户 ${accountId} 图片任务推进失败：`, error.message);
          return 0;
        });
        worked += advanced;
      }
    }

    const retentionAccounts = await discoverAccounts(`
      SELECT DISTINCT account_id FROM (
        SELECT c.account_id FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
        WHERE m.deleted_at IS NULL AND m.retention_expires_at IS NOT NULL AND m.retention_expires_at <= CURRENT_TIMESTAMP
        UNION
        SELECT account_id FROM media_assets
        WHERE deleted_at IS NULL AND type = 'ASR_INPUT_AUDIO' AND state = 'AVAILABLE'
          AND created_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
      ) due`);
    for (const accountId of retentionAccounts) {
      const swept = await sweepRetention(accountId).catch((error) => {
        console.error(`[worker] 账户 ${accountId} 保留期清理失败：`, error.message);
        return 0;
      });
      if (swept > 0) console.log(`[worker] 账户 ${accountId}：保留期清理 ${swept} 项`);
      worked += swept;
    }

    // 账户注销生产清理（P0 删除编排）：CLOSING 账户逐个推进到 COMPLETED/CLOSED。
    const closingAccounts = await discoverAccounts(`
      SELECT DISTINCT a.account_id FROM accounts a
      JOIN deletion_jobs d ON d.account_id = a.account_id AND d.scope = 'ACCOUNT'
        AND d.state NOT IN ('COMPLETED', 'CANCELLED') AND d.deleted_at IS NULL
      WHERE a.account_status = 'CLOSING'`);
    for (const accountId of closingAccounts) {
      await store.withAccountTransaction(accountId, async (scoped) => {
        const account = [...scoped.accounts.values()][0];
        if (!account) return;
        const job = [...scoped.deletionJobs.values()]
          .filter((item) => item.scope === 'ACCOUNT' && item.state !== 'COMPLETED' && item.state !== 'CANCELLED')
          .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))[0];
        if (!job) return;
        await runAccountDeletionCleanup(scoped, account, job, { mediaStore, imageStore: imageDeps?.imageStore || null });
        console.log(`[worker] 账户注销清理 ${job.deletion_job_id} → ${job.state}（${job.physical_cleanup_state}）`);
      }).catch((error) => console.error(`[worker] 账户 ${accountId} 注销清理失败：`, error.message));
    }

    if (cleanupWorker) {
      for (let round = 0; round < 10; round += 1) {
        const outcome = await cleanupWorker.runOnce().catch((error) => {
          console.error('[worker] 内容权利清理失败：', error.message);
          return { state: 'FAILED' };
        });
        if (outcome.state !== 'COMPLETED') break;
        console.log(`[worker] 内容权利清理：${JSON.stringify(outcome)}`);
        worked += 1;
      }
    }

    return worked;
  }

  console.log(`[worker] 独立 Worker 已启动（间隔 ${intervalMs}ms；摘要模型：${summaryGenerator ? 'qwen' : '未配置——跳过摘要队列'}；资产向量：${embeddingProvider ? `qwen ${embeddingProvider.modelVersion}（${embeddingProvider.dimensions} 维）` : '确定性开发嵌入'}；图片推进：${imageDeps ? '启用' : '未配置——跳过'}；权利清理：${cleanupWorker ? '启用' : '未配置——跳过'}）。`);
  let running = true;
  process.on('SIGINT', () => { running = false; });

  while (running) {
    const pending = await tick().catch((error) => { console.error('[worker] 队列发现失败：', error.message); return 0; });
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (pending === 0) continue;
  }

  await pool.end();
  if (cleanupPool) await cleanupPool.end();
  console.log('[worker] 已退出。');
}

main().catch((error) => { console.error('[worker] 启动失败：', error.message); process.exit(1); });
