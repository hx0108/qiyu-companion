'use strict';

const { createApp } = require('./app');
const { assertRuntimeConfiguration, assertLocalSyntheticRuntimeAllowed } = require('./production/startup');
const { createPersistenceFromEnvironment } = require('./persistence/composition');
const { createQwenConversationSummaryGenerator, createQwenReplyGenerator } = require('./providers/qwen-adapter');
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

const port = Number(process.env.PORT || 3000);
const runtime = assertLocalSyntheticRuntimeAllowed(assertRuntimeConfiguration(process.env));
const store = createPersistenceFromEnvironment(process.env);
const replyGenerator = createQwenReplyGenerator(process.env) || undefined;
const summaryGenerator = createQwenConversationSummaryGenerator(process.env) || undefined;
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
createApp({ store, replyGenerator, summaryGenerator, summaryEnabled: runtime.mode !== 'production' || runtime.featureFlags.CONVERSATION_SUMMARY_WRITE, textModerator, asrTranscriber, ttsGenerator, mediaStore, imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService: mediaEntitlementService }).listen(port, '127.0.0.1', () => {
  console.log(`栖语 M1 本地合成 API 已监听 http://127.0.0.1:${port}`);
  console.log(`运行模式：${runtime.mode}；外部高风险能力默认关闭，必须经生产配置门禁启用。`);
  console.log(`持久化：${process.env.QIYU_PERSISTENCE || 'memory'}；模型：${process.env.QIYU_LLM_PROVIDER === 'qwen' ? 'qwen（本地开发接线）' : 'mock'}。`);
});

// 保留期主动清理：仅进程内内存存储可运行；Postgres 请求作用域存储需独立 Worker 部署。
if (process.env.QIYU_PERSISTENCE !== 'postgres') startRetentionWorker(store);
if (process.env.QIYU_PERSISTENCE !== 'postgres') startConversationSummaryWorker(store, summaryGenerator);
// 资产向量 Worker：仅进程内内存存储可运行；Postgres 模式须独立 Worker 部署。
// 开发嵌入为确定性字符 n-gram（可复现、无外呼）；生产须替换为供应商 embedding。
if (process.env.QIYU_PERSISTENCE !== 'postgres') startAssetEmbeddingWorker(store);
