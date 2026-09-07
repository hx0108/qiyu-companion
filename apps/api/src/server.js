'use strict';

const { createApp } = require('./app');
const { assertRuntimeConfiguration, assertLocalSyntheticRuntimeAllowed } = require('./production/startup');
const { createPersistenceFromEnvironment } = require('./persistence/composition');
const { createQwenConversationSummaryGenerator, createQwenEmbeddingProvider, createQwenReplyGenerator, createQwenStreamingReplyGenerator } = require('./providers/qwen-adapter');
const { createTencentImageModeratorFromEnvironment, createTencentTextModeratorFromEnvironment } = require('./providers/tencent-moderation-adapter');
const { createTencentAsrTranscriberFromEnvironment } = require('./providers/tencent-asr-adapter');
const { createTencentTtsGeneratorFromEnvironment } = require('./providers/tencent-tts-adapter');
const { createTencentHunyuanImageGeneratorFromEnvironment } = require('./providers/tencent-hunyuan-image-adapter');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('./media/tencent-cos-private-image-store');
const { createTencentCosPrivateMediaStoreFromEnvironment } = require('./media/tencent-cos-private-media-store');
const { fetchTencentGeneratedImage } = require('./media/tencent-image-result-fetcher');
const { assertImagePipelineConfiguration } = require('./production/image-pipeline-config');
const { MediaEntitlementService } = require('./domain/media-entitlement-service');
const { startRetentionWorker } = require('./domain/retention-worker');
const { startConversationSummaryWorker } = require('./domain/conversation-summary-worker');
const { startAssetEmbeddingWorker } = require('./domain/asset-embedding-worker');
const { startAccountDeletionCleanupWorker } = require('./domain/deletion-orchestration');

const port = Number(process.env.PORT || 3000);
// Keep direct development launches local-only, while container deployments
// can explicitly bind their published API port to the container interface.
const host = process.env.HOST || '127.0.0.1';
const runtime = assertLocalSyntheticRuntimeAllowed(assertRuntimeConfiguration(process.env));
const store = createPersistenceFromEnvironment(process.env);
const replyGenerator = createQwenReplyGenerator(process.env) || undefined;
// 真流式生成器（技术设计 7.5）：请求 body.stream:true 且已配置 Qwen 时启用。
const streamingReplyGenerator = createQwenStreamingReplyGenerator(process.env) || null;
const summaryGenerator = createQwenConversationSummaryGenerator(process.env) || undefined;
// 语义向量（P1-4）：Qwen 配置时索引与查询同源；未配置回退确定性开发嵌入。
const embeddingProvider = createQwenEmbeddingProvider(process.env) || null;
const textModerator = createTencentTextModeratorFromEnvironment(process.env) || undefined;
const asrTranscriber = createTencentAsrTranscriberFromEnvironment(process.env) || undefined;
const ttsGenerator = createTencentTtsGeneratorFromEnvironment(process.env) || undefined;
assertImagePipelineConfiguration(process.env);
const imageGenerator = createTencentHunyuanImageGeneratorFromEnvironment(process.env) || undefined;
const imageModerator = createTencentImageModeratorFromEnvironment(process.env) || undefined;
const imageStore = createTencentCosPrivateImageStoreFromEnvironment(process.env) || undefined;
const mediaStore = createTencentCosPrivateMediaStoreFromEnvironment(process.env) || undefined;
const imageResultFetcher = imageGenerator ? fetchTencentGeneratedImage : undefined;
// 外层权益服务仅对进程内内存存储有效；Postgres 模式由 withAccountTransaction
// 在每个请求作用域 store 上挂载实例（请求级账本与订阅都在其中加载）。
const mediaEntitlementService = process.env.QIYU_PERSISTENCE === 'postgres' ? null : new MediaEntitlementService({ store });
createApp({ store, replyGenerator, streamingReplyGenerator, summaryGenerator, summaryEnabled: runtime.mode !== 'production' || runtime.featureFlags.CONVERSATION_SUMMARY_WRITE, textModerator, asrTranscriber, ttsGenerator, mediaStore, imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService: mediaEntitlementService, trialAuthEnabled: process.env.QIYU_TRIAL_AUTH === 'invite', embeddingProvider }).listen(port, host, () => {
  console.log(`栖语 M1 本地合成 API 已监听 http://${host}:${port}`);
  console.log(`运行模式：${runtime.mode}；外部高风险能力默认关闭，必须经生产配置门禁启用。`);
  console.log(`持久化：${process.env.QIYU_PERSISTENCE || 'memory'}；模型：${process.env.QIYU_LLM_PROVIDER === 'qwen' ? 'qwen（本地开发接线）' : 'mock'}。`);
});

// 保留期主动清理：仅进程内内存存储可运行；Postgres 请求作用域存储需独立 Worker 部署。
if (process.env.QIYU_PERSISTENCE !== 'postgres') startRetentionWorker(store);
if (process.env.QIYU_PERSISTENCE !== 'postgres') startConversationSummaryWorker(store, summaryGenerator);
// 资产向量 Worker：仅进程内内存存储可运行；Postgres 模式须独立 Worker 部署。
// Qwen 配置时用供应商语义向量（索引与查询同 model_version）；否则确定性开发嵌入。
if (process.env.QIYU_PERSISTENCE !== 'postgres') {
  startAssetEmbeddingWorker(store, embeddingProvider ? embeddingProvider.embed : undefined, embeddingProvider ? { modelVersion: embeddingProvider.modelVersion, expectedDimensions: embeddingProvider.dimensions } : {});
}
// 账户注销生产清理（P0 删除编排）：内存模式进程内执行；PG 模式由独立 Worker 部署。
if (process.env.QIYU_PERSISTENCE !== 'postgres') startAccountDeletionCleanupWorker(store, { mediaStore, imageStore });
