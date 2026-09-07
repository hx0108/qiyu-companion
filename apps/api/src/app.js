'use strict';

const http = require('node:http');
const { randomUUID, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { evaluateAccess } = require('./domain/access-policy');
const { generateReply } = require('./domain/mock-adapter');
const { assessSafety, responseForExistingSafetyMode } = require('./domain/safety-policy');
const { assessModelOutputAuthority } = require('./domain/model-output-policy');
const { DevelopmentStore } = require('./domain/store');
const { LocalPrivateMediaStore } = require('./media/local-private-media-store');
const { applyRawInteractionRetention } = require('./domain/retention');
const { MAX_ASR_AUDIO_BYTES, VOICE_FORMATS } = require('./providers/tencent-asr-adapter');
const { DailyChatUsageError, commitDailyChatUsage, currentDailyChatUsage, estimateInputTokens, inputTokensFromProviderUsage, releaseDailyChatUsage, reserveDailyChatUsage } = require('./domain/daily-chat-usage');
const { SubscriptionLifecycle } = require('./domain/subscription-lifecycle');
const { MediaEntitlementService } = require('./domain/media-entitlement-service');
const personaRelease = require('./domain/persona-release-service');
const { evaluateProactiveDispatch } = require('./domain/proactive-policy');
const { PROACTIVE_TEMPLATES } = require('./domain/proactive-templates');
const { AuthService } = require('./domain/auth-service');
const { MemoryTrialInviteAuth, TrialAuthError } = require('./domain/trial-invite-auth');
const { tagWithAigcMetadata } = require('./media/aigc-metadata');
const { rankRelationshipAssets } = require('./domain/relationship-recall');
const { registerAccountDeletionTargets, registerConversationDeletionTargets, registerDeletionTargets, completeDeletionTarget, failDeletionTarget, runAccountDeletionCleanup, deletionReceipt } = require('./domain/deletion-orchestration');
const { advanceImageJob, releaseImageEntitlement } = require('./domain/image-job-advance');
const { recordOperationMetric, providerName, providerModelVersion, moderateTextWithMetric, moderateImageWithMetric } = require('./domain/operation-metrics');
const { invalidateSummaries, validSummary } = require('./domain/conversation-summary');
const { cancelConversationSummaryJobs, enqueueConversationSummary, replayConversationSummaryDeadLetter } = require('./domain/conversation-summary-worker');
const { DEVELOPMENT_EMBEDDING_MODEL_VERSION, cosineSimilarity, deterministicEmbedding, enqueueAssetEmbedding, invalidateAssetEmbedding, replayAssetEmbeddingDeadLetter, startAssetEmbeddingWorker } = require('./domain/asset-embedding-worker');

const TOKENS = new Map([
  ['dev-alice-token', 'acct_dev_alice'],
  ['dev-bob-token', 'acct_dev_bob']
]);
// 一次性 SSE 回放令牌：短 TTL、绑定账户与助手消息，进程级存储（不落库、不跨实例）。
const STREAM_TOKEN_TTL_MS = 30_000;
const streamTokens = new Map();
const SUBSCRIPTION_CATALOG = Object.freeze({
  currency: 'CNY', auto_renew_default: false, plans: [
    { sku: 'qiyu_public_monthly_v1', label: '公开 V1 月订阅', price_fen: 3900, billing_cycle: 'MONTH', image_quota: 15, tts_minutes: 30, asr_minutes: 15 },
    { sku: 'qiyu_public_quarterly_v1', label: '公开 V1 季度订阅', price_fen: 10800, billing_cycle: 'QUARTER', image_quota: 15, tts_minutes: 30, asr_minutes: 15 }
  ], policy: 'development-simulated-checkout-only; real Alipay/WeChat payment is disabled' });
const TRIAL_PRODUCT = Object.freeze({
  sku: 'qiyu_full_experience_trial_7d_v1', label: '7 天完整体验档', duration_days: 7,
  image_quota: 3, tts_minutes: 5, asr_minutes: 0
});
const TRIAL_DISCLOSURE_VERSION = 'trial_full_experience_7d_v1';
const DEVELOPMENT_TRIAL_CHANNEL = 'DEVELOPMENT_TRIAL';

// A locally generated secret keeps the development callback unforgeable even
// when no explicit test secret is configured. It is deliberately process-local
// and never represents a real payment-channel credential.
const DEVELOPMENT_PAYMENT_FALLBACK_SECRET = randomUUID();

// This is a deliberately closed local-development allowlist, not a general file server.
// API paths never pass through this mapping.
const STATIC_FILES = new Map([
  ['/', { file: path.resolve(__dirname, '../../web/index.html'), type: 'text/html; charset=utf-8' }],
  ['/favicon.svg', { file: path.resolve(__dirname, '../../web/favicon.svg'), type: 'image/svg+xml' }],
  ['/app.js', { file: path.resolve(__dirname, '../../web/app.js'), type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: path.resolve(__dirname, '../../web/styles.css'), type: 'text/css; charset=utf-8' }],
  ['/prototype-restoration.css', { file: path.resolve(__dirname, '../../web/prototype-restoration.css'), type: 'text/css; charset=utf-8' }],
  ['/assets/qiyu-character.png', { file: path.resolve(__dirname, '../../../designs/qiyu-v1-handoff/prototype/imgs/qiyu-character.png'), type: 'image/png' }],
  ['/assets/qiyu-night-scene.png', { file: path.resolve(__dirname, '../../../designs/qiyu-v1-handoff/prototype/imgs/qiyu-night-scene.png'), type: 'image/png' }],
  ['/tokens.css', { file: path.resolve(__dirname, '../../../designs/qiyu-v1-handoff/tokens/tokens.css'), type: 'text/css; charset=utf-8' }],
  // Compatibility with the existing relative @import in apps/web/styles.css.
  ['/designs/qiyu-v1-handoff/tokens/tokens.css', { file: path.resolve(__dirname, '../../../designs/qiyu-v1-handoff/tokens/tokens.css'), type: 'text/css; charset=utf-8' }]
]);

function createApp({ store = new DevelopmentStore(), replyGenerator = generateReply, streamingReplyGenerator = null, summaryGenerator = null, summaryEnabled = true, textModerator = null, asrTranscriber = null, ttsGenerator = null, mediaStore = new LocalPrivateMediaStore(), imageGenerator = null, imageModerator = null, imageStore = null, imageResultFetcher = null, imageEntitlementService = null, trialAuthEnabled = false, trialAuth = null, embeddingProvider = null, featureFlags = null } = {}) {
  return http.createServer(async (req, res) => {
    const requestId = validRequestId(req.headers['x-request-id']) || `req_${randomUUID()}`;
    try {
      const url = new URL(req.url, 'http://localhost');
      const staticFile = req.method === 'GET' && STATIC_FILES.get(url.pathname);
      if (staticFile) return await sendStatic(res, staticFile, requestId);
      const body = await readJson(req);
      const result = await routeWithPersistence({ req, body, url, store, replyGenerator, streamingReplyGenerator, summaryGenerator, summaryEnabled, textModerator, asrTranscriber, ttsGenerator, mediaStore, imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService, trialAuthEnabled, trialAuth, embeddingProvider, featureFlags, requestId });
      if (result.sseLive) return sendLiveEventStream(res, result, requestId);
      if (result.sse) return sendEventStream(res, result, requestId);
      if (result.binary) return sendBinary(res, result, requestId);
      send(res, result.status, result.body, requestId, result.contentType);
    } catch (error) {
      const status = error.status || 500;
      send(res, status, { error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.expose ? error.message : '开发服务发生未预期错误',
        request_id: requestId,
        retryable: Boolean(error.retryable),
        details: error.details || {}
      } }, requestId);
    }
  });
}

async function routeWithPersistence(context) {
  const { req, body, store, url, trialAuth, trialAuthEnabled } = context;
  // Postgres 模式的认证仓库由 store 延迟提供；登录、刷新和后续 Bearer
  // 校验必须复用同一个仓库，不能只在创建会话的路由里临时解析。
  const resolvedTrialAuth = trialAuth || (trialAuthEnabled ? trialAuthFor(store) : null);
  // 邀请码封测不能回退到旧的开发 token 或开发支付回调；两种认证模型必须互斥。
  const accountId = (await accountIdForRequest(req, store, resolvedTrialAuth, { allowDevelopmentTokens: !trialAuthEnabled }))
    || (!trialAuthEnabled ? verifiedDevelopmentCallbackAccountId(req, url, body, store) : null);
  if (accountId && typeof store.withAccountTransaction === 'function') {
    const lockDailyUsage = req.method === 'POST' && /^\/api\/v1\/conversations\/[^/]+\/messages$/.test(url.pathname);
    return store.withAccountTransaction(accountId, (scopedStore) => route({ ...context, store: scopedStore, trialAuth: resolvedTrialAuth, authenticatedAccountId: accountId }), { lockDailyUsage });
  }
  return route({ ...context, trialAuth: resolvedTrialAuth, authenticatedAccountId: accountId });
}

async function route(context) {
  const { req, body, url, store, replyGenerator, streamingReplyGenerator, summaryGenerator, summaryEnabled, textModerator, asrTranscriber, ttsGenerator, mediaStore, imageGenerator, imageModerator, imageStore, imageResultFetcher, requestId, trialAuthEnabled, trialAuth, authenticatedAccountId, embeddingProvider, featureFlags } = context;
  // 媒体权益服务：显式注入优先（测试），否则使用请求级 store 上挂载的实例（Postgres 请求作用域）。
  const imageEntitlementService = context.imageEntitlementService || store.mediaEntitlementService || null;
  const method = req.method;
  const path = url.pathname;
  if (method === 'GET' && path === '/health') return ok({ status: 'ok', mode: 'local-synthetic-development-only' });
  if (method === 'GET' && path === '/api/v1/trial-access') return ok({ enabled: Boolean(trialAuthEnabled), authentication: trialAuthEnabled ? 'closed-trial-invite' : 'synthetic-development-token-only', payment: 'disabled', external_age_verification: 'disabled' });
  // 渠道回调不带用户 Token：只信 HMAC 验签，且仅开发模拟通道存在。
  if (!trialAuthEnabled && method === 'POST' && path === '/api/v1/callbacks/payments/development-simulated') return developmentPaymentCallback(store, req, body, requestId);
  // 运营内部接口（技术设计 8.10）：独立审核员身份，与用户 Bearer 体系完全分离；
  // 生产部署须独立域名 + MFA + RBAC（迁移 024 的 qiyu_reviewer 角色已对齐）。
  if (path.startsWith('/internal/')) {
    const reviewer = requireReviewer(req);
    if (method === 'GET' && path === '/internal/content-rights-reviews') return listInternalContentRightsReviews(store, url);
    if (method === 'POST' && /^\/internal\/content-rights-reviews\/[^/]+\/decisions$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => decideInternalContentRightsReview(store, reviewer, path, body));
    if (method === 'GET' && path === '/internal/deletion-jobs') return listInternalDeletionJobs(store, url);
    if (method === 'GET' && path === '/internal/provider-health') return internalProviderHealth(store);
    if (method === 'GET' && path === '/internal/feature-flags') return internalFeatureFlags(featureFlags);
    if (method === 'GET' && path === '/internal/metrics') return internalMetricsText(store);
    if (method === 'GET' && path === '/internal/conversation-summary-dead-letters') return listInternalConversationSummaryDeadLetters(store);
    if (method === 'POST' && /^\/internal\/conversation-summary-dead-letters\/[^/]+\/replay$/.test(path)) return idempotent(context, { account_id: 'reviewer:' + reviewer.reviewer_id }, () => replayInternalConversationSummaryDeadLetter(store, reviewer, path, body));
    if (method === 'GET' && path === '/internal/asset-embedding-dead-letters') return listInternalAssetEmbeddingDeadLetters(store);
    if (method === 'POST' && /^\/internal\/asset-embedding-dead-letters\/[^/]+\/replay$/.test(path)) return idempotent(context, { account_id: 'reviewer:' + reviewer.reviewer_id }, () => replayInternalAssetEmbeddingDeadLetter(store, reviewer, path, body));
    if (method === 'GET' && path === '/internal/age-reviews') return listInternalAgeReviews(store);
    if (method === 'POST' && /^\/internal\/age-reviews\/[^/]+\/decisions$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => decideInternalAgeReview(store, reviewer, path, body));
    if (method === 'POST' && path === '/internal/subscriptions/manual-grant') return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => manualGrantSubscription(store, reviewer, body));
    if (method === 'POST' && /^\/internal\/subscriptions\/[^/]+\/revoke$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => revokeSubscriptionManually(store, reviewer, path, body));
    if (method === 'GET' && path === '/internal/persona-releases') return listInternalPersonaReleases(store);
    if (method === 'POST' && /^\/internal\/persona-versions\/[^/]+\/\d+\/evaluate$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => evaluatePersonaDraft(store, reviewer, path, body));
    if (method === 'POST' && /^\/internal\/persona-versions\/[^/]+\/\d+\/shadow$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => shadowPersonaVersion(store, reviewer, path));
    if (method === 'POST' && /^\/internal\/persona-versions\/[^/]+\/\d+\/canary$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => canaryPersonaVersion(store, reviewer, path, body));
    if (method === 'POST' && /^\/internal\/persona-versions\/[^/]+\/\d+\/stable$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => stabilizePersonaVersion(store, reviewer, path, body));
    if (method === 'POST' && /^\/internal\/persona-versions\/[^/]+\/\d+\/rollback$/.test(path)) return idempotent(context, { account_id: `reviewer:${reviewer.reviewer_id}` }, () => rollbackPersonaVersion(store, reviewer, path, body));
    throw apiError(404, 'ROUTE_NOT_FOUND', '内部接口不存在');
  }
  // 封闭试用：邀请码和一次性初始口令均由运营线下发放；服务端仅保存哈希。
  if (trialAuthEnabled && method === 'POST' && path === '/api/v1/auth/trial-sessions') return createTrialSession(trialAuthFor(store, trialAuth), body);
  if (trialAuthEnabled && method === 'POST' && path === '/api/v1/auth/trial-sessions/refresh') return refreshTrialSession(trialAuthFor(store, trialAuth), body);
  // 旧短信骨架仅用于内存开发回归；封闭试用不暴露此注册路径。
  if (!trialAuthEnabled && method === 'POST' && path === '/api/v1/auth/sms-challenges') return idempotent(context, { account_id: 'public' }, () => createSmsChallenge(store, body));
  if (!trialAuthEnabled && method === 'POST' && path === '/api/v1/auth/register') return idempotent(context, { account_id: 'public' }, () => registerAccount(store, body));
  if (!trialAuthEnabled && method === 'POST' && path === '/api/v1/auth/refresh') return idempotent(context, { account_id: 'public' }, () => refreshTokens(store, body));
  const account = requireAccount(req, store, authenticatedAccountId);
  applyRawInteractionRetention(store, account);
  expireTrials(store, account);

  if (method === 'GET' && path === '/api/v1/dev/session') return ok(publicAccount(account));
  if (method === 'GET' && path === '/api/v1/subscription/catalog') return ok({ catalog: SUBSCRIPTION_CATALOG });
  if (method === 'GET' && path === '/api/v1/subscriptions/current') return currentSubscription(store, account);
  if (method === 'POST' && path === '/api/v1/subscription-trials') return idempotent(context, account, () => startTrial(store, account));
  if (method === 'POST' && path === '/api/v1/checkout-sessions') return idempotent(context, account, () => createCheckoutSession(store, account, body));
  if (method === 'POST' && /^\/api\/v1\/subscriptions\/[^/]+\/cancel-renewal$/.test(path)) return idempotent(context, account, () => cancelRenewal(store, account, path));
  if (method === 'GET' && path === '/api/v1/entitlements') return entitlementsView(store, account, imageEntitlementService);
  if (method === 'GET' && path === '/api/v1/usage/daily') return ok({ usage: currentDailyChatUsage(store, account.account_id) });
  if (method === 'GET' && path === '/api/v1/development/operation-metrics') return ok({ metrics: ownOperationMetrics(store, account.account_id) });
  if (method === 'GET' && path === '/api/v1/trial-feedback') return ok({ feedback: ownTrialFeedback(store, account.account_id) });
  if (method === 'POST' && path === '/api/v1/trial-feedback') return idempotent(context, account, () => createTrialFeedback(store, account, body));
  if (method === 'GET' && path === '/api/v1/required-notices') return ok({ notices: [publicNotice(store.noticeFor(account.account_id))] });
  if (method === 'POST' && /^\/api\/v1\/required-notices\/[^/]+\/displayed$/.test(path)) {
    return idempotent(context, account, () => displayNotice(store, account, path, body));
  }
  if (method === 'POST' && path === '/api/v1/age/declarations') {
    return idempotent(context, account, () => declareAge(account, body));
  }
  if (method === 'POST' && path === '/api/v1/age/appeals') return idempotent(context, account, () => requestAgeAppeal(account));
  if (method === 'GET' && path === '/api/v1/age/status') return ok(ageStatus(account));
  if (method === 'POST' && path === '/api/v1/characters') {
    return idempotent(context, account, () => createCharacter(store, account, body));
  }
  if (method === 'POST' && path === '/api/v1/characters/imports') return idempotent(context, account, () => createOcImport(store, account, body));
  if (method === 'GET' && /^\/api\/v1\/content-rights-reviews\/[^/]+$/.test(path)) return getContentRightsReview(store, account, path);
  if (method === 'POST' && /^\/api\/v1\/content-rights-reviews\/[^/]+\/appeals$/.test(path)) return idempotent(context, account, () => appealContentRightsReview(store, account, path, body));
  if (method === 'GET' && path === '/api/v1/characters') return ok({ characters: ownCharacters(store, account.account_id) });
  if (method === 'GET' && /^\/api\/v1\/characters\/[^/]+\/world-state$/.test(path)) return getWorldState(store, account, path);
  if (method === 'PATCH' && /^\/api\/v1\/characters\/[^/]+\/world-state$/.test(path)) return idempotent(context, account, () => updateWorldState(store, account, path, body));
  if (method === 'POST' && /^\/api\/v1\/characters\/[^/]+\/world-state\/reset$/.test(path)) return idempotent(context, account, () => resetWorldState(store, account, path));
  if (method === 'GET' && /^\/api\/v1\/characters\/[^/]+$/.test(path)) return getCharacter(store, account, path);
  if (method === 'POST' && /^\/api\/v1\/characters\/[^/]+\/persona-versions$/.test(path)) return idempotent(context, account, () => createPersonaDraft(store, account, path, body));
  if (method === 'PATCH' && /^\/api\/v1\/characters\/[^/]+$/.test(path)) return idempotent(context, account, () => updateCharacter(store, account, path, body));
  if (method === 'GET' && path === '/api/v1/conversations') return ok({ conversations: ownConversations(store, account.account_id) });
  if (method === 'POST' && path === '/api/v1/conversations') {
    return idempotent(context, account, () => createConversation(store, account, body));
  }
  if (method === 'GET' && /^\/api\/v1\/conversations\/[^/]+\/messages$/.test(path)) return listMessages(store, account, path, url);
  if (method === 'GET' && /^\/api\/v1\/messages\/[^/]+$/.test(path)) return getMessage(store, account, path);
  if (method === 'POST' && /^\/api\/v1\/messages\/[^/]+\/feedback$/.test(path)) return idempotent(context, account, () => createMessageFeedback(store, account, path, body));
  if (method === 'GET' && /^\/api\/v1\/conversation-streams\/[^/]+$/.test(path)) return getConversationStream(store, account, path, requestId, streamingReplyGenerator, replyGenerator, textModerator, embeddingProvider);
  if (method === 'DELETE' && /^\/api\/v1\/conversations\/[^/]+$/.test(path)) return idempotent(context, account, () => deleteConversation(store, account, path));
  if (method === 'POST' && /^\/api\/v1\/conversations\/[^/]+\/pause$/.test(path)) return idempotent(context, account, () => pauseConversation(store, account, path));
  if (method === 'POST' && /^\/api\/v1\/conversations\/[^/]+\/resume$/.test(path)) return idempotent(context, account, () => resumeConversation(store, account, path));
  if (method === 'POST' && /^\/api\/v1\/conversations\/[^/]+\/messages$/.test(path)) {
    return idempotent(context, account, () => sendMessage(store, account, path, body, replyGenerator, summaryEnabled ? summaryGenerator : null, textModerator, streamingReplyGenerator, embeddingProvider));
  }
  if (method === 'POST' && /^\/api\/v1\/conversations\/[^/]+\/asr-jobs$/.test(path)) {
    return idempotent(context, account, () => createAsrJob(store, account, path, body, asrTranscriber, mediaStore, imageEntitlementService));
  }
  if (method === 'POST' && /^\/api\/v1\/characters\/[^/]+\/reference-images$/.test(path)) {
    return idempotent(context, account, () => createReferenceImage(store, account, path, body, imageModerator, imageStore));
  }
  if (method === 'GET' && /^\/api\/v1\/characters\/[^/]+\/reference-images$/.test(path)) return listReferenceImages(store, account, path);
  if (method === 'POST' && /^\/api\/v1\/characters\/[^/]+\/image-jobs$/.test(path)) {
    return idempotent(context, account, () => createImageJob(store, account, path, body, imageGenerator, imageStore, imageEntitlementService));
  }
  if (method === 'POST' && /^\/api\/v1\/image-jobs\/[^/]+\/refresh$/.test(path)) {
    return idempotent(context, account, () => refreshImageJob(store, account, path, imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService));
  }
  if (method === 'GET' && /^\/api\/v1\/image-jobs\/[^/]+$/.test(path)) return getImageJob(store, account, path);
  if (method === 'GET' && /^\/api\/v1\/asr-jobs\/[^/]+$/.test(path)) return getAsrJob(store, account, path);
  if (method === 'POST' && /^\/api\/v1\/asr-jobs\/[^/]+\/confirm$/.test(path)) {
    return idempotent(context, account, () => confirmAsrJob(store, account, path, body, mediaStore));
  }
  if (method === 'POST' && /^\/api\/v1\/messages\/[^/]+\/tts-jobs$/.test(path)) {
    return idempotent(context, account, () => createTtsJob(store, account, path, ttsGenerator, textModerator, mediaStore, imageEntitlementService));
  }
  if (method === 'GET' && /^\/api\/v1\/tts-jobs\/[^/]+$/.test(path)) return getTtsJob(store, account, path);
  if (method === 'GET' && /^\/api\/v1\/media-assets\/[^/]+\/content$/.test(path)) return getMediaAssetContent(store, account, path, mediaStore, imageStore);
  if (method === 'GET' && /^\/api\/v1\/media-assets\/[^/]+$/.test(path)) return getMediaAsset(store, account, path);
  if (method === 'DELETE' && /^\/api\/v1\/media-assets\/[^/]+$/.test(path)) {
    return idempotent(context, account, () => deleteMediaAsset(store, account, path, mediaStore, imageStore));
  }
  if (method === 'GET' && path === '/api/v1/memory-candidates') return ok({ candidates: ownCandidates(store, account.account_id) });
  if (method === 'POST' && /^\/api\/v1\/memory-candidates\/[^/]+\/(confirm|confirm-edited|reject)$/.test(path)) {
    return idempotent(context, account, () => resolveCandidate(store, account, path, body));
  }
  if (method === 'GET' && path === '/api/v1/relationship-assets') return ok({ assets: activeAssets(store, account.account_id) });
  if (method === 'GET' && path === '/api/v1/timeline') return ok({ entries: timelineEntries(store, account.account_id, url.searchParams.get('filter')) });
  if (method === 'PATCH' && /^\/api\/v1\/relationship-assets\/[^/]+$/.test(path)) {
    return idempotent(context, account, () => reviseAsset(store, account, path, body));
  }
  if (method === 'GET' && path === '/api/v1/memory-recall') return ok({ assets: activeAssets(store, account.account_id), source: store.recallSource || 'local-structured-development-store' });
  if (method === 'GET' && path === '/api/v1/data-exports/relationship-profile') return ok({ export: relationshipProfileExport(store, account) });
  if (method === 'GET' && path === '/api/v1/privacy/raw-interaction-retention') return ok({ raw_interaction_retention_days: account.raw_interaction_retention_days || 90 });
  if (method === 'POST' && path === '/api/v1/privacy/raw-interaction-retention') return idempotent(context, account, () => setRawInteractionRetention(store, account, body));
  if (method === 'DELETE' && /^\/api\/v1\/relationship-assets\/[^/]+$/.test(path)) {
    return idempotent(context, account, () => deleteAsset(store, account, path));
  }
  if (method === 'GET' && /^\/api\/v1\/deletion-jobs\/[^/]+$/.test(path)) return getDeletionJob(store, account, path);
  if (method === 'GET' && path === '/api/v1/emergency-contact') return getEmergencyContact(account);
  if (method === 'PUT' && path === '/api/v1/emergency-contact') return idempotent(context, account, () => putEmergencyContact(account, body));
  if (method === 'DELETE' && path === '/api/v1/emergency-contact') return idempotent(context, account, () => deleteEmergencyContact(account));
  if (method === 'POST' && path === '/api/v1/interaction-activity/heartbeat') return heartbeat(account);
  if (method === 'POST' && path === '/api/v1/complaints') return idempotent(context, account, () => createComplaint(store, account, body));
  if (method === 'GET' && /^\/api\/v1\/complaints\/[^/]+$/.test(path)) return getComplaint(store, account, path);
  if (method === 'GET' && path === '/api/v1/proactive-preferences') return getProactivePreferences(account);
  if (method === 'PUT' && path === '/api/v1/proactive-preferences') return idempotent(context, account, () => putProactivePreferences(account, body));
  if (method === 'GET' && path === '/api/v1/proactive-events') return listProactiveEvents(store, account);
  if (method === 'POST' && path === '/api/v1/proactive-events') return idempotent(context, account, () => createProactiveEvent(store, account, body));
  if (method === 'DELETE' && /^\/api\/v1\/proactive-events\/[^/]+$/.test(path)) return idempotent(context, account, () => deleteProactiveEvent(store, account, path));
  if (method === 'POST' && /^\/api\/v1\/proactive-events\/[^/]+\/trigger$/.test(path)) return idempotent(context, account, () => triggerProactiveEvent(store, account, path));
  if (method === 'GET' && path === '/api/v1/proactive-messages') return listProactiveMessages(store, account);
  if (method === 'POST' && path === '/api/v1/account-deletions') return idempotent(context, account, () => requestAccountDeletion(store, account, body));
  throw apiError(404, 'ROUTE_NOT_FOUND', '接口不存在');
}

function displayNotice(store, account, path, body) {
  const notice = store.noticeFor(account.account_id);
  const noticeId = path.split('/')[4];
  if (notice.notice_id !== noticeId) throw apiError(404, 'RESOURCE_NOT_FOUND', '必要告知不存在');
  if (body.notice_version !== notice.notice_version) throw apiError(400, 'VALIDATION_ERROR', '告知版本不匹配');
  notice.state = 'DISPLAYED';
  notice.displayed_at = new Date().toISOString();
  return ok({ notice: publicNotice(notice) });
}

function declareAge(account, body) {
  const dob = typeof body.date_of_birth === 'string' ? new Date(`${body.date_of_birth}T00:00:00Z`) : null;
  if (!dob || Number.isNaN(dob.getTime()) || body.confirmed_18_plus !== true) {
    account.age_status = 'AGE_REVIEW';
    account.age_reason_codes = ['DECLARATION_INVALID'];
  } else if (ageOn(dob) < 18) {
    account.age_status = 'AGE_DENIED_MINOR';
    account.age_reason_codes = ['DECLARED_MINOR'];
  } else if (account.declared_date_of_birth && account.declared_date_of_birth !== body.date_of_birth) {
    account.age_status = 'AGE_REVIEW';
    account.age_reason_codes = ['DATE_OF_BIRTH_CHANGED'];
  } else {
    account.age_status = 'AGE_PASS';
    account.age_reason_codes = [];
    account.declared_date_of_birth = body.date_of_birth;
  }
  return ok(ageStatus(account));
}

function requestAgeAppeal(account) {
  account.age_status = 'AGE_REVIEW';
  account.age_reason_codes = ['APPEAL_REQUESTED'];
  account.age_review_requested_at = new Date().toISOString();
  return accepted(ageStatus(account));
}

function createCharacter(store, account, body) {
  authorize(account, 'CREATE_CHARACTER', store);
  if (store.activeCharacter(account.account_id)) throw apiError(409, 'ACTIVE_CHARACTER_EXISTS', '每个开发账户只能有一个活跃角色');
  const imported = body?.import_id === undefined ? null : ownOcImport(store, account.account_id, body.import_id);
  if (imported && contentRightsReviewFor(store, imported.import_id)?.state !== 'APPROVED') throw apiError(422, 'OC_RIGHTS_REVIEW_REQUIRED', 'OC 导入尚未通过权利审核，不能写入人格');
  const persona = sanitizePersona(body?.persona === undefined && imported ? imported.proposed_persona : body?.persona);
  const character = { character_id: store.next('chr'), account_id: account.account_id, name: requiredText(body.name, 'name'), status: 'ACTIVE', version: 1, active_persona_version: 1, persona };
  const createdAt = new Date().toISOString();
  character.persona_history = [{ version: 1, persona, changed_fields: Object.keys(persona), note: '创建角色', parent_version: null, state: 'STABLE', evaluation: null, created_at: createdAt, updated_at: createdAt }];
  store.characters.set(character.character_id, character);
  initializeWorldState(store, account.account_id, character.character_id);
  return created({ character: publicCharacter(character) });
}

// OC 原文是非可信输入：本地开发只做最小的字段候选提取，不让它覆盖系统
// 指令、年龄、安全或关系资产。由于尚无人工审核队列，所有导入默认保持隔离。
const OC_IMPORT_MAX_LENGTH = 8_000;
const OC_RISK_PATTERNS = Object.freeze([
  ['REAL_PERSON_FACE', /(?:真人|现实中的|同学|前任|明星|演员|歌手)/u],
  ['PUBLIC_FIGURE_CANDIDATE', /(?:刘德华|周杰伦|杨幂|肖战|王一博)/u],
  ['KNOWN_IP_CANDIDATE', /(?:哈利[·・]?波特|漫威|原神|迪士尼)/u],
  ['VOICE_CLONE_RISK', /(?:复刻.*(?:声音|音色)|克隆.*(?:声音|音色))/u]
]);
function createOcImport(store, account, body) {
  authorize(account, 'CREATE_CHARACTER', store);
  if (body?.original_or_authorized !== true) throw apiError(422, 'OC_RIGHTS_REVIEW_REQUIRED', '请先确认内容为原创或已获授权');
  const sourceText = requiredText(body?.source_text, 'source_text');
  if (sourceText.length > OC_IMPORT_MAX_LENGTH) throw apiError(400, 'VALIDATION_ERROR', `source_text 超过 ${OC_IMPORT_MAX_LENGTH} 字`);
  const declarationVersion = optionalShortText(body?.declaration_version || 'oc-rights-v1', 'declaration_version', 64);
  const importId = store.next('oci');
  const riskCodes = OC_RISK_PATTERNS.filter(([, pattern]) => pattern.test(sourceText)).map(([code]) => code);
  const ocImport = { import_id: importId, account_id: account.account_id, source_text: sourceText, declaration_version: declarationVersion, state: 'QUARANTINED', proposed_persona: extractOcPersona(sourceText), created_at: new Date().toISOString(), retention_expires_at: plusDays(account.raw_interaction_retention_days || 90) };
  const review = { review_id: store.next('crr'), account_id: account.account_id, subject_type: 'OC_TEXT', subject_ref: importId, declaration_version: declarationVersion, risk_codes: [...riskCodes, 'MANUAL_RIGHTS_REVIEW_REQUIRED'], state: 'REVIEW_REQUIRED', reviewer_id: null, decision_reason: '本地开发未配置人工权利审核队列；导入保持隔离。', created_at: ocImport.created_at, updated_at: ocImport.created_at };
  ocImport.state = 'REVIEW_REQUIRED';
  store.ocImports.set(importId, ocImport);
  store.contentRightsReviews.set(review.review_id, review);
  return accepted({ oc_import: publicOcImport(ocImport), content_rights_review: publicContentRightsReview(review) });
}
function getContentRightsReview(store, account, path) { return ok({ content_rights_review: publicContentRightsReview(ownContentRightsReview(store, account.account_id, path.split('/')[4])) }); }
function appealContentRightsReview(store, account, path, body) {
  const review = ownContentRightsReview(store, account.account_id, path.split('/')[4]);
  const statement = optionalShortText(body?.statement, 'statement', 1_000);
  const appeal = { appeal_id: store.next('cra'), account_id: account.account_id, review_id: review.review_id, statement, state: 'SUBMITTED', created_at: new Date().toISOString() };
  store.contentRightsAppeals.set(appeal.appeal_id, appeal);
  return accepted({ appeal: { appeal_id: appeal.appeal_id, review_id: appeal.review_id, state: appeal.state, created_at: appeal.created_at }, content_rights_review: publicContentRightsReview(review) });
}
function extractOcPersona(sourceText) {
  const fields = Object.fromEntries(PERSONA_TEXT_FIELDS.map((field) => [field, '']));
  const aliases = { worldview: ['世界观', '背景'], age_setting: ['年龄'], relationship_to_user: ['关系', '定位'], personality: ['性格'], expression_style: ['说话方式', '表达风格'] };
  for (const [field, labels] of Object.entries(aliases)) {
    const line = sourceText.split(/\r?\n/u).find((value) => labels.some((label) => new RegExp(`^\\s*${label}\\s*[:：]`, 'u').test(value)));
    if (line) fields[field] = line.replace(/^\s*[^:：]+[:：]\s*/u, '').trim().slice(0, PERSONA_TEXT_MAX);
  }
  return { ...emptyPersona(), ...fields, hard_boundaries: [], example_behaviors: [] };
}
function ownOcImport(store, accountId, id) { const value = store.ocImports.get(id); if (!value || value.account_id !== accountId || new Date(value.retention_expires_at).getTime() <= Date.now()) throw apiError(404, 'RESOURCE_NOT_FOUND', 'OC 导入不存在'); return value; }
function contentRightsReviewFor(store, subjectRef) { return [...store.contentRightsReviews.values()].find((value) => value.subject_ref === subjectRef); }
function ownContentRightsReview(store, accountId, id) { const value = store.contentRightsReviews.get(id); if (!value || value.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '权利审核记录不存在'); return value; }
function publicOcImport(value) { return { import_id: value.import_id, state: value.state, proposed_persona: value.proposed_persona, created_at: value.created_at, retention_expires_at: value.retention_expires_at }; }
function publicContentRightsReview(value) { return { review_id: value.review_id, subject_type: value.subject_type, subject_ref: value.subject_ref, declaration_version: value.declaration_version, risk_codes: value.risk_codes, state: value.state, decision_reason: value.decision_reason, appeal_available: ['REVIEW_REQUIRED', 'REJECTED'].includes(value.state), created_at: value.created_at, updated_at: value.updated_at }; }

// ---- 运营内部接口（技术设计 8.10 开发实现）----
// 审核员身份：开发内置 token，可用 QIYU_REVIEWER_TOKENS="token:reviewer_id,..." 覆盖。
// 生产为独立域名 + MFA + 数据库身份（迁移 024 的 qiyu_reviewer / 身份表）；本进程
// 已被生产门禁禁止以生产身份运行，故该内置身份只在本地开发存在。
const DEFAULT_REVIEWER_IDENTITIES = Object.freeze(new Map([['reviewer-dev-token', Object.freeze({ reviewer_id: 'rev_dev_0001', display_name: '开发审核员' })]]));

function reviewerIdentities() {
  const fromEnvironment = process.env.QIYU_REVIEWER_TOKENS;
  if (typeof fromEnvironment !== 'string' || !fromEnvironment.trim()) return DEFAULT_REVIEWER_IDENTITIES;
  const identities = new Map();
  for (const pair of fromEnvironment.split(',')) {
    const [token, reviewerId] = pair.split(':').map((part) => part && part.trim());
    if (token && reviewerId && /^[A-Za-z0-9._-]{1,64}$/.test(reviewerId)) identities.set(token, Object.freeze({ reviewer_id: reviewerId, display_name: `审核员 ${reviewerId}` }));
  }
  return identities.size > 0 ? identities : DEFAULT_REVIEWER_IDENTITIES;
}

function requireReviewer(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const identity = token && reviewerIdentities().get(token);
  if (!identity) throw apiError(401, 'REVIEWER_AUTH_REQUIRED', '需要有效的运营审核员身份');
  return identity;
}

// 队列视图：给审核员看判断所需的最小材料。OC 原文只给截断摘要（技术设计：
// 默认脱敏，材料按需调取）；关联申诉一并展示。
function listInternalContentRightsReviews(store, url) {
  const state = url.searchParams.get('state') || 'REVIEW_REQUIRED';
  const validStates = ['REVIEW_REQUIRED', 'APPROVED', 'REJECTED'];
  if (!validStates.includes(state)) throw apiError(400, 'VALIDATION_ERROR', `state 只能是 ${validStates.join('/')}`);
  const reviews = [...store.contentRightsReviews.values()]
    .filter((review) => review.state === state)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
    .map((review) => {
      const ocImport = review.subject_type === 'OC_TEXT' ? store.ocImports.get(review.subject_ref) : null;
      const appeals = [...store.contentRightsAppeals.values()].filter((appeal) => appeal.review_id === review.review_id);
      const decision = [...store.contentRightsDecisions.values()].find((entry) => entry.review_id === review.review_id) ?? null;
      return {
        review_id: review.review_id, subject_type: review.subject_type, subject_ref: review.subject_ref,
        risk_codes: review.risk_codes, state: review.state, decision_reason: review.decision_reason,
        declaration_version: review.declaration_version, created_at: review.created_at, updated_at: review.updated_at,
        subject_preview: ocImport ? String(ocImport.source_text).slice(0, 500) : null,
        proposed_persona: ocImport ? ocImport.proposed_persona : null,
        appeals: appeals.map(({ appeal_id, state, created_at }) => ({ appeal_id, state, created_at })),
        decision: decision ? { decision_id: decision.decision_id, reviewer_id: decision.reviewer_id, decision: decision.decision, decided_at: decision.decided_at } : null
      };
    });
  return ok({ reviews, queue_state: state, note: 'OC 原文仅展示前 500 字摘要；完整材料调取须在生产审核台按需解密并记录理由。' });
}

// 决策：单次、不可逆（迁移 024 UNIQUE(review_id) 同语义）；REJECTED 为终态，
// 用户申诉留档但不开新决策（与数据库函数一致）。APPROVED 的参考图在此解除
// 隔离进入 AVAILABLE，生图任务的既有校验随之放行。
function decideInternalContentRightsReview(store, reviewer, path, body) {
  // Postgres 模式下应用角色无权更新审核状态（迁移 024：reviews 对 qiyu_app 不可变，
  // 决策必须由 qiyu_reviewer 会话经 app.decide_content_rights_review 执行）。
  if (typeof store.resolveAccountId === 'function') {
    throw apiError(503, 'REVIEW_DECISION_REQUIRES_REVIEWER_SESSION', '持久化运行时的决策须在生产审核台以 qiyu_reviewer 身份执行');
  }
  const review = store.contentRightsReviews.get(path.split('/')[3]);
  if (!review) throw apiError(404, 'RESOURCE_NOT_FOUND', '权利审核记录不存在');
  if (review.state !== 'REVIEW_REQUIRED') throw apiError(409, 'STATE_TRANSITION_INVALID', '该审核已决策，不能重复决策');
  const decision = body?.decision;
  if (!['APPROVED', 'REJECTED'].includes(decision)) throw apiError(400, 'VALIDATION_ERROR', 'decision 只能是 APPROVED 或 REJECTED');
  const reason = requiredText(body?.reason, 'reason');
  if (reason.length > 1000) throw apiError(400, 'VALIDATION_ERROR', 'reason 超过 1000 字');
  const decidedAt = new Date().toISOString();
  const record = {
    decision_id: store.next('crd'), review_id: review.review_id, account_id: review.account_id,
    reviewer_id: reviewer.reviewer_id, decision, reason, decided_at: decidedAt
  };
  store.contentRightsDecisions.set(record.decision_id, record);
  review.state = decision;
  review.reviewer_id = reviewer.reviewer_id;
  review.decision_reason = reason;
  review.updated_at = decidedAt;
  if (decision === 'APPROVED' && review.subject_type === 'REFERENCE_IMAGE') {
    const asset = store.mediaAssets.get(review.subject_ref);
    if (asset && asset.account_id === review.account_id && asset.state === 'REVIEW_REQUIRED') {
      asset.state = 'AVAILABLE';
      asset.confirmation_state = 'USER_CONFIRMED';
    }
  }
  return ok({ content_rights_review: publicContentRightsReview(review), decision: { decision_id: record.decision_id, reviewer_id: record.reviewer_id, decision, decided_at: decidedAt } });
}

function listInternalDeletionJobs(store, url) {
  const state = url.searchParams.get('state');
  const jobs = [...store.deletionJobs.values()]
    .filter((job) => !state || job.state === state)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(({ deletion_job_id, scope, state, physical_cleanup_state, created_at, note }) => ({ deletion_job_id, scope, state, physical_cleanup_state, created_at, note }));
  return ok({ deletion_jobs: jobs, note: '失败目标的重试由生产清理 Worker 执行；此处为只读队列。' });
}

function listInternalConversationSummaryDeadLetters(store) {
  if (typeof store.resolveAccountId === 'function') {
    throw apiError(503, 'SUMMARY_DLQ_REQUIRES_OPERATOR_SESSION', '持久化运行时的死信处置须在生产运营台以独立摘要 Worker 运营身份执行');
  }
  const deadLetters = [...store.conversationSummaryDeadLetters.values()]
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    .map(publicConversationSummaryDeadLetter);
  return ok({ dead_letters: deadLetters, note: '仅返回无正文死信元数据；本地开发每个任务最多允许一次人工重放。' });
}

function replayInternalConversationSummaryDeadLetter(store, reviewer, path, body) {
  if (typeof store.resolveAccountId === 'function') {
    throw apiError(503, 'SUMMARY_DLQ_REQUIRES_OPERATOR_SESSION', '持久化运行时的死信重放须在生产运营台以独立摘要 Worker 运营身份执行');
  }
  const reason = requiredText(body?.reason, 'reason');
  if (reason.length > 1000) throw apiError(400, 'VALIDATION_ERROR', 'reason 超过 1000 字');
  const jobId = decodeAccountId(path.split('/')[3]);
  const result = replayConversationSummaryDeadLetter({
    store, jobId, reviewerId: reviewer.reviewer_id,
    reasonHash: createHash('sha256').update(reason, 'utf8').digest('hex')
  });
  if (result.state === 'NOT_FOUND') throw apiError(404, 'RESOURCE_NOT_FOUND', '摘要死信任务不存在');
  if (result.state === 'NOT_EXHAUSTED') throw apiError(409, 'SUMMARY_DLQ_NOT_EXHAUSTED', '仅已耗尽的摘要任务可重放');
  if (result.state === 'SOURCE_REVOKED') throw apiError(409, 'SUMMARY_DLQ_SOURCE_REVOKED', '源消息或账户已撤销，不能重新调用模型');
  if (result.state === 'REPLAY_LIMIT_REACHED') throw apiError(409, 'SUMMARY_DLQ_REPLAY_LIMIT_REACHED', '该摘要任务已完成一次人工重放，不能重复重放');
  return ok({ dead_letter: publicConversationSummaryDeadLetter(result.dead_letter), summary_job: publicConversationSummaryJob(result.summary_job) });
}

function publicConversationSummaryDeadLetter(item) {
  return {
    dead_letter_id: item.dead_letter_id, job_id: item.job_id, account_id: item.account_id,
    conversation_id: item.conversation_id, source_to_id: item.source_to_id, attempt_count: item.attempt_count,
    error_code: item.error_code, state: item.state, replay_count: item.replay_count,
    occurred_at: item.occurred_at, last_replayed_at: item.last_replayed_at
  };
}

function publicConversationSummaryJob(item) {
  return {
    job_id: item.job_id, state: item.state, attempt_count: item.attempt_count,
    next_attempt_at: item.next_attempt_at, exhausted_at: item.exhausted_at || null
  };
}

function listInternalAssetEmbeddingDeadLetters(store) {
  const deadLetters = [...store.assetEmbeddingDeadLetters.values()]
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    .map((item) => ({
      dead_letter_id: item.dead_letter_id, job_id: item.job_id, account_id: item.account_id,
      asset_id: item.asset_id, attempt_count: item.attempt_count, error_code: item.error_code,
      state: item.state, replay_count: item.replay_count, occurred_at: item.occurred_at, last_replayed_at: item.last_replayed_at
    }));
  return ok({ dead_letters: deadLetters, note: '资产向量死信：重放仅一次且需 reason 留痕；生产向量服务接入后历史索引须按 model_version 全量重建。' });
}

function replayInternalAssetEmbeddingDeadLetter(store, reviewer, path, body) {
  if (typeof store.resolveAccountId === 'function') {
    throw apiError(503, 'EMBEDDING_DLQ_REQUIRES_OPERATOR_SESSION', '持久化运行时的死信重放须在生产运营台以独立向量 Worker 运营身份执行');
  }
  const reason = requiredText(body?.reason, 'reason');
  if (reason.length > 1000) throw apiError(400, 'VALIDATION_ERROR', 'reason 超过 1000 字');
  const jobId = decodeAccountId(path.split('/')[3]);
  const result = replayAssetEmbeddingDeadLetter({
    store, jobId, reviewerId: reviewer.reviewer_id,
    reasonHash: createHash('sha256').update(reason, 'utf8').digest('hex')
  });
  if (result.state === 'NOT_FOUND') throw apiError(404, 'RESOURCE_NOT_FOUND', '向量死信任务不存在');
  if (result.state === 'NOT_EXHAUSTED') throw apiError(409, 'EMBEDDING_DLQ_NOT_EXHAUSTED', '仅已耗尽的向量任务可重放');
  if (result.state === 'SOURCE_REVOKED') throw apiError(409, 'EMBEDDING_DLQ_SOURCE_REVOKED', '源资产已删除或被修订，不能重建该版本向量');
  if (result.state === 'REPLAY_LIMIT_REACHED') throw apiError(409, 'EMBEDDING_DLQ_REPLAY_LIMIT_REACHED', '该向量任务已完成一次人工重放，不能重复重放');
  return ok({ dead_letter: { dead_letter_id: result.dead_letter.dead_letter_id, state: result.dead_letter.state, replay_count: result.dead_letter.replay_count }, embedding_job: { job_id: result.embedding_job.job_id, state: result.embedding_job.state, next_attempt_at: result.embedding_job.next_attempt_at } });
}

function internalProviderHealth(store) {
  const aggregate = new Map();
  for (const metric of store.operationMetrics.values()) {
    const key = `${metric.provider}:${metric.model_version}`;
    const entry = aggregate.get(key) || { provider: metric.provider, model_version: metric.model_version, calls: 0, outcomes: {}, total_latency_ms: 0, last_call_at: null };
    entry.calls += 1;
    entry.outcomes[metric.outcome] = (entry.outcomes[metric.outcome] || 0) + 1;
    entry.total_latency_ms += metric.latency_ms;
    entry.last_call_at = metric.created_at > (entry.last_call_at ?? '') ? metric.created_at : entry.last_call_at;
    aggregate.set(key, entry);
  }
  const providers = [...aggregate.values()].map((entry) => ({ ...entry, avg_latency_ms: entry.calls > 0 ? Math.round(entry.total_latency_ms / entry.calls) : 0, total_latency_ms: undefined }));
  return ok({ providers, note: '本地开发只记录文字成功路径的调用指标，不含消息正文；无生产熔断与告警。' });
}

function internalFeatureFlags(featureFlags) {
  // P1-6 真实化：优先报告进程实际生效的运行时 flags（server.js 注入
  // assertRuntimeConfiguration 的结果）；未注入的测试/裸 createApp 场景退回
  // 本地合成默认值（全关），不再把“硬编码 false”伪装成运行时状态。
  if (featureFlags && typeof featureFlags === 'object') {
    return ok({ feature_flags: featureFlags, source: 'runtime', note: '进程实际生效的运行时 feature flags（生产由 QIYU_PROVIDER_CONFIG_JSON 门禁解析）。' });
  }
  return ok({ feature_flags: { LLM_CHAT: false, CONVERSATION_SUMMARY_WRITE: false, ENHANCED_AGE_VERIFICATION: false, PAYMENTS: false, ASR: false, TTS: false, IMAGE_GENERATION: false, TEXT_MODERATION: false, IMAGE_MODERATION: false }, source: 'local-synthetic-default', note: '本地合成运行时全部关闭；生产由 QIYU_PROVIDER_CONFIG_JSON 门禁开启。' });
}

// Prometheus 文本导出（P1-6 可观测性）：供应商调用量/结果/时延、队列深度
// （摘要与向量 DLQ、未完成注销清理、滞留图片任务）。口径与边界：
//   - 内存 Store 全量可见；Postgres 请求作用域 store 只装载单账户数据，
//     该模式下本端点是“最近账户作用域样本”，全实例口径须由独立 Worker/汇总表导出；
//   - 指标不含任何消息正文或个人数据，label 只含能力/供应商/结果枚举。
function internalMetricsText(store) {
  const lines = [];
  const calls = new Map();
  for (const metric of store.operationMetrics?.values() ?? []) {
    const key = `${metric.capability}|${metric.provider}|${metric.outcome}`;
    const entry = calls.get(key) || { count: 0, latencySum: 0 };
    entry.count += 1;
    entry.latencySum += metric.latency_ms || 0;
    calls.set(key, entry);
  }
  lines.push('# HELP qiyu_provider_calls_total 供应商调用总数（按能力/供应商/结果）');
  lines.push('# TYPE qiyu_provider_calls_total counter');
  for (const [key, entry] of calls) {
    const [capability, provider, outcome] = key.split('|');
    lines.push(`qiyu_provider_calls_total{capability="${escapeLabel(capability)}",provider="${escapeLabel(provider)}",outcome="${escapeLabel(outcome)}"} ${entry.count}`);
  }
  lines.push('# HELP qiyu_provider_latency_ms_sum 供应商调用时延总和（毫秒）');
  lines.push('# TYPE qiyu_provider_latency_ms_sum counter');
  for (const [key, entry] of calls) {
    const [capability, provider] = key.split('|');
    lines.push(`qiyu_provider_latency_ms_sum{capability="${escapeLabel(capability)}",provider="${escapeLabel(provider)}"} ${entry.latencySum}`);
  }
  const summaryDlq = [...store.conversationSummaryDeadLetters?.values() ?? []].filter((item) => item.state === 'OPEN').length;
  const embeddingDlq = [...store.assetEmbeddingDeadLetters?.values() ?? []].filter((item) => item.state === 'OPEN').length;
  const pendingDeletions = [...store.deletionJobs?.values() ?? []].filter((job) => job.scope === 'ACCOUNT' && !['COMPLETED', 'CANCELLED'].includes(job.state)).length;
  const stuckImageJobs = [...store.mediaJobs?.values() ?? []].filter((job) => job.type === 'IMAGE_GENERATION' && ['PENDING', 'RUNNING'].includes(job.state)).length;
  lines.push('# HELP qiyu_dead_letters_open 未解决死信数（队列健康告警口径）');
  lines.push('# TYPE qiyu_dead_letters_open gauge');
  lines.push(`qiyu_dead_letters_open{queue="conversation_summary"} ${summaryDlq}`);
  lines.push(`qiyu_dead_letters_open{queue="asset_embedding"} ${embeddingDlq}`);
  lines.push('# HELP qiyu_deletion_jobs_pending 未完成的账户注销清理数（超 24h 告警口径）');
  lines.push('# TYPE qiyu_deletion_jobs_pending gauge');
  lines.push(`qiyu_deletion_jobs_pending ${pendingDeletions}`);
  lines.push('# HELP qiyu_image_jobs_inflight 处于 PENDING/RUNNING 的图片任务数（滞留告警口径）');
  lines.push('# TYPE qiyu_image_jobs_inflight gauge');
  lines.push(`qiyu_image_jobs_inflight ${stuckImageJobs}`);
  return { status: 200, body: `${lines.join('\n')}\n`, contentType: 'text/plain; version=0.0.4; charset=utf-8' };
}

function escapeLabel(value) { return String(value ?? '').replace(/[\\"]/g, (character) => `\\${character}`); }

// ---- 年龄人工复核（FB 级：第三方断言接入前的运营复核，PRD 3.9/AC-13）----
// 队列只暴露复核所需最小字段：状态、原因码、申诉时间与历史复核结论；
// 不含证件材料（本切片本就不收集），复核依据由审核员在 reason 中留痕。
function listInternalAgeReviews(store) {
  const reviews = [...store.accounts.values()]
    .filter((account) => account.age_status === 'AGE_REVIEW')
    .sort((a, b) => String(a.age_review_requested_at ?? '').localeCompare(String(b.age_review_requested_at ?? '')))
    .map((account) => ({
      account_id: account.account_id,
      age_status: account.age_status,
      reason_codes: account.age_reason_codes ?? [],
      review_requested_at: account.age_review_requested_at ?? null,
      declared_date_of_birth: null,
      decisions: [...store.ageReviewDecisions.values()]
        .filter((decision) => decision.account_id === account.account_id)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        .map(({ decision, reviewer_id, reason, created_at }) => ({ decision, reviewer_id, reason, created_at }))
    }));
  return ok({ age_reviews: reviews, note: 'FB 级人工复核：结论留痕可审计；公开上线前须替换为第三方年龄断言。' });
}

function decideInternalAgeReview(store, reviewer, path, body) {
  const accountId = decodeAccountId(path.split('/')[3]);
  const account = store.accounts.get(accountId);
  if (!account) throw apiError(404, 'RESOURCE_NOT_FOUND', '账户不存在');
  if (account.age_status !== 'AGE_REVIEW') throw apiError(409, 'STATE_TRANSITION_INVALID', '仅 AGE_REVIEW 状态可复核');
  const decision = body?.decision;
  if (!['PASS', 'DENIED_MINOR', 'MAINTAIN_REVIEW'].includes(decision)) {
    throw apiError(400, 'VALIDATION_ERROR', 'decision 只能是 PASS / DENIED_MINOR / MAINTAIN_REVIEW');
  }
  const reason = requiredText(body?.reason, 'reason');
  if (reason.length > 1000) throw apiError(400, 'VALIDATION_ERROR', 'reason 超过 1000 字');
  const record = { decision_id: store.next('agd'), account_id: accountId, reviewer_id: reviewer.reviewer_id, decision, reason, created_at: new Date().toISOString() };
  store.ageReviewDecisions.set(record.decision_id, record);
  if (decision === 'PASS') {
    account.age_status = 'AGE_PASS';
    account.age_reason_codes = ['MANUAL_REVIEW_PASSED'];
  } else if (decision === 'DENIED_MINOR') {
    account.age_status = 'AGE_DENIED_MINOR';
    account.age_reason_codes = ['MANUAL_REVIEW_DENIED'];
  }
  return ok({ decision: { decision_id: record.decision_id, account_id: accountId, decision, reviewer_id: reviewer.reviewer_id, created_at: record.created_at }, age_status: account.age_status, note: '复核结论已留痕；申诉材料与本决策记录按 30 天留存策略清理。' });
}

// ---- 封测期线下收款：人工发放订阅周期（PRD 9.4 可退款预订阅路径）----
// 发放走真实订阅周期（channel=MANUAL_OFFLINE_PAYMENT），从而复用到期、撤销与
// 权益账本的全部既有语义；撤销后当期已用量不回收，新预留立即失败。
function manualGrantSubscription(store, reviewer, body) {
  const accountId = typeof body?.account_id === 'string' ? body.account_id.trim() : '';
  const account = accountId && store.accounts.get(accountId);
  if (!account) throw apiError(404, 'RESOURCE_NOT_FOUND', '目标账户不存在');
  const plan = findPlan(body?.sku);
  if (!plan) throw apiError(400, 'VALIDATION_ERROR', 'sku 不在服务端目录中');
  const reason = requiredText(body?.reason, 'reason');
  if (reason.length > 1000) throw apiError(400, 'VALIDATION_ERROR', 'reason 超过 1000 字');
  const now = new Date();
  const subscription = {
    subscription_id: store.next('sub'), account_id: accountId, sku: plan.sku,
    channel: 'MANUAL_OFFLINE_PAYMENT', state: 'ACTIVE', auto_renew: false,
    disclosure_version: 'manual-offline-v1',
    period_start: now.toISOString(),
    period_end: new Date(now.getTime() + (plan.billing_cycle === 'QUARTER' ? 92 : 31) * 86400000).toISOString(),
    grace_period_end: null, refund_status: 'NONE', transaction_ref_hash: null,
    created_at: now.toISOString(), updated_at: now.toISOString(),
    manual_grant: { reviewer_id: reviewer.reviewer_id, reason, granted_at: now.toISOString() }
  };
  const order = {
    order_id: store.next('ord'), account_id: accountId, subscription_id: subscription.subscription_id,
    sku: plan.sku, amount_fen: plan.price_fen, currency: SUBSCRIPTION_CATALOG.currency,
    state: 'PAID_OFFLINE', channel: 'MANUAL_OFFLINE_PAYMENT', auto_renew: false,
    disclosure_version: 'manual-offline-v1', created_at: now.toISOString()
  };
  store.subscriptions.set(subscription.subscription_id, subscription);
  store.subscriptionOrders.set(order.order_id, order);
  const mediaService = new MediaEntitlementService({ store });
  const grant = mediaService.grantSubscriptionCycle({ subscription, product: plan, sourceEventId: `manual-${subscription.subscription_id}` });
  return created({ subscription, order, entitlement_id: grant.entitlement_id, note: '线下收款人工发放：按完整订阅周期入账，撤销走 /internal/subscriptions/{id}/revoke。' });
}

function revokeSubscriptionManually(store, reviewer, path, body) {
  const subscription = store.subscriptions.get(path.split('/')[3]);
  if (!subscription) throw apiError(404, 'RESOURCE_NOT_FOUND', '订阅不存在');
  if (subscription.channel !== 'MANUAL_OFFLINE_PAYMENT') throw apiError(409, 'STATE_TRANSITION_INVALID', '仅线下人工发放的订阅可由运营撤销');
  if (subscription.state === 'REVOKED') return ok({ subscription, note: '订阅已处于撤销状态。' });
  if (subscription.state !== 'ACTIVE') throw apiError(409, 'STATE_TRANSITION_INVALID', '当前状态不能撤销');
  const reason = requiredText(body?.reason, 'reason');
  if (reason.length > 1000) throw apiError(400, 'VALIDATION_ERROR', 'reason 超过 1000 字');
  subscription.state = 'REVOKED';
  subscription.refund_status = 'FULL';
  subscription.updated_at = new Date().toISOString();
  subscription.manual_revoke = { reviewer_id: reviewer.reviewer_id, reason, revoked_at: subscription.updated_at };
  return ok({ subscription, note: '已撤销：新额度预留立即失败，当期已用量不回收；退款请按原收款渠道退回。' });
}

function decodeAccountId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function getCharacter(store, account, path) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  return ok({ character: publicCharacter(character, { includeHistory: true }) });
}

function requireDevelopmentPersonaReleaseStore(store) {
  if (typeof store.resolveAccountId === 'function') throw apiError(503, 'PERSONA_RELEASE_REQUIRES_REVIEWER_SESSION', '持久化运行时的人格发布须使用独立审核台和 reviewer 数据库会话');
}
function personaVersionPath(path) {
  const [, , , characterId, version] = path.split('/');
  return { characterId, version: Number(version) };
}
function internalPersonaVersion(store, path) {
  requireDevelopmentPersonaReleaseStore(store);
  const { characterId, version } = personaVersionPath(path);
  const character = store.characters.get(characterId);
  const entry = character?.persona_history?.find((item) => item.version === version);
  if (!character || !entry) throw apiError(404, 'RESOURCE_NOT_FOUND', '人格版本不存在');
  return { character, entry };
}
function replacePersonaVersion(character, entry) {
  const index = character.persona_history.findIndex((item) => item.version === entry.version);
  if (index < 0) throw new Error('人格版本替换目标不存在');
  character.persona_history[index] = entry;
}
function releaseApiError(error) { throw apiError(409, error.code || 'PERSONA_RELEASE_FAILED', error.message); }
function evaluatePersonaDraft(store, reviewer, path, body) {
  const { character, entry } = internalPersonaVersion(store, path);
  let updated;
  try { updated = personaRelease.recordEvaluation(entry, { suiteVersion: body?.suite_version, criticalPassRate: body?.critical_pass_rate, overallPassRate: body?.overall_pass_rate, reportRef: body?.report_ref, reviewerId: reviewer.reviewer_id }); } catch (error) { releaseApiError(error); }
  replacePersonaVersion(character, updated);
  return ok({ persona_version: publicPersonaVersion(updated) });
}
function shadowPersonaVersion(store, reviewer, path) {
  const { character, entry } = internalPersonaVersion(store, path);
  let updated;
  try { updated = personaRelease.startShadow(entry, { reviewerId: reviewer.reviewer_id }); } catch (error) { releaseApiError(error); }
  replacePersonaVersion(character, updated);
  return ok({ persona_version: publicPersonaVersion(updated) });
}
function canaryPersonaVersion(store, reviewer, path, body) {
  const { character, entry } = internalPersonaVersion(store, path);
  let updated;
  try { updated = personaRelease.promoteCanary(entry, { trafficPercent: body?.traffic_percent, reviewerId: reviewer.reviewer_id, shadowReportRef: body?.shadow_report_ref }); } catch (error) { releaseApiError(error); }
  replacePersonaVersion(character, updated);
  return ok({ persona_version: publicPersonaVersion(updated) });
}
function stabilizePersonaVersion(store, reviewer, path, body) {
  const { character, entry } = internalPersonaVersion(store, path);
  let updated;
  try { updated = personaRelease.promoteStable(entry, { reviewerId: reviewer.reviewer_id, canaryReportRef: body?.canary_report_ref }); } catch (error) { releaseApiError(error); }
  const priorStable = character.persona_history.find((item) => item.state === 'STABLE' && item.version !== updated.version);
  if (priorStable) replacePersonaVersion(character, personaRelease.retireStable(priorStable));
  replacePersonaVersion(character, updated);
  character.persona = updated.persona;
  character.version = updated.version;
  character.active_persona_version = updated.version;
  return ok({ persona_version: publicPersonaVersion(updated), character: publicCharacter(character) });
}
function rollbackPersonaVersion(store, reviewer, path, body) {
  const { character, entry } = internalPersonaVersion(store, path);
  const target = character.persona_history.find((item) => item.version === Number(body?.rollback_to_version));
  if (!target) throw apiError(404, 'RESOURCE_NOT_FOUND', '回退目标人格版本不存在');
  let result;
  try { result = personaRelease.rollback(entry, target, { reviewerId: reviewer.reviewer_id, reason: body?.reason }); } catch (error) { releaseApiError(error); }
  replacePersonaVersion(character, result.current);
  replacePersonaVersion(character, result.target);
  character.persona = result.target.persona;
  character.version = result.target.version;
  character.active_persona_version = result.target.version;
  return ok({ rolled_back: publicPersonaVersion(result.current), restored: publicPersonaVersion(result.target), character: publicCharacter(character) });
}
function listInternalPersonaReleases(store) {
  requireDevelopmentPersonaReleaseStore(store);
  return ok({ persona_releases: [...store.characters.values()].map((character) => ({ character_id: character.character_id, account_id: character.account_id, active_persona_version: character.active_persona_version ?? character.version, versions: (character.persona_history ?? []).map(publicPersonaVersion) })) });
}

function updateCharacter(store, account, path, body) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  if (body?.expected_version !== character.version) throw apiError(409, 'VERSION_CONFLICT', '角色版本冲突');
  const nextName = body?.name === undefined ? character.name : requiredText(body.name, 'name');
  const nextPersona = body?.persona === undefined ? character.persona : sanitizePersona(body.persona);
  const personaChanges = personaChangedFields(character.persona, nextPersona);
  if (body?.persona !== undefined && personaChanges.length > 0) {
    throw apiError(409, 'PERSONA_DRAFT_REQUIRED', '人格内容必须先创建草稿并完成评测、影子和灰度发布');
  }
  const changedFields = [...new Set([
    ...(nextName !== character.name ? ['name'] : []),
    ...personaChanges
  ])];
  if (changedFields.length === 0) return ok({ character: publicCharacter(character, { includeHistory: true }) });
  character.name = nextName;
  character.version += 1;
  return ok({ character: publicCharacter(character, { includeHistory: true }) });
}

function createPersonaDraft(store, account, path, body) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  if (body?.expected_version !== character.version) throw apiError(409, 'VERSION_CONFLICT', '角色版本冲突');
  const persona = sanitizePersona(body?.persona);
  const changedFields = personaChangedFields(character.persona, persona);
  if (changedFields.length === 0) throw apiError(400, 'VALIDATION_ERROR', '人格草稿必须包含至少一处变更');
  const nextVersion = Math.max(...(character.persona_history ?? []).map((entry) => entry.version), character.version) + 1;
  const draft = personaRelease.createDraft({ version: nextVersion, persona, changedFields, note: requiredNote(body?.note), parentVersion: character.active_persona_version ?? character.version });
  character.persona_history.push(draft);
  return created({ persona_version: publicPersonaVersion(draft), character: publicCharacter(character) });
}

// PRD 3.2.1 用户可见可改的人格档案字段；系统安全边界由服务端持有，不在此列。
const PERSONA_TEXT_FIELDS = ['worldview', 'age_setting', 'relationship_to_user', 'personality', 'expression_style'];
const PERSONA_LIST_FIELDS = ['hard_boundaries', 'example_behaviors'];
const PERSONA_TEXT_MAX = 500;
const PERSONA_LIST_ITEM_MAX = 200;

function sanitizePersona(input) {
  if (input === undefined || input === null) return emptyPersona();
  if (typeof input !== 'object' || Array.isArray(input)) throw apiError(400, 'VALIDATION_ERROR', 'persona 必须是对象');
  const persona = emptyPersona();
  for (const field of PERSONA_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw apiError(400, 'VALIDATION_ERROR', `persona.${field} 必须是字符串`);
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > PERSONA_TEXT_MAX) throw apiError(400, 'VALIDATION_ERROR', `persona.${field} 超过 ${PERSONA_TEXT_MAX} 字`);
    persona[field] = trimmed;
  }
  for (const field of PERSONA_LIST_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) throw apiError(400, 'VALIDATION_ERROR', `persona.${field} 必须是字符串数组`);
    const items = [];
    for (const item of value) {
      if (typeof item !== 'string') throw apiError(400, 'VALIDATION_ERROR', `persona.${field} 必须是字符串数组`);
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (trimmed.length > PERSONA_LIST_ITEM_MAX) throw apiError(400, 'VALIDATION_ERROR', `persona.${field} 单项超过 ${PERSONA_LIST_ITEM_MAX} 字`);
      items.push(trimmed);
    }
    if (items.length > 10) throw apiError(400, 'VALIDATION_ERROR', `persona.${field} 最多 10 项`);
    persona[field] = items;
  }
  const unknown = Object.keys(input).filter((key) => !PERSONA_TEXT_FIELDS.includes(key) && !PERSONA_LIST_FIELDS.includes(key));
  if (unknown.length > 0) throw apiError(400, 'VALIDATION_ERROR', `persona 不支持字段：${unknown.join(', ')}`);
  return persona;
}

function emptyPersona() {
  return { worldview: '', age_setting: '', relationship_to_user: '', personality: '', expression_style: '', hard_boundaries: [], example_behaviors: [] };
}

// 世界状态是短期、可理解的情境数据；人格、安全结论和确认关系事实均不能写入这里。
const WORLD_MOOD_CODES = new Set(['CALM', 'HAPPY', 'TIRED', 'CONCERNED', 'NEUTRAL']);
const WORLD_LOCATION_CODES = new Set(['UNSPECIFIED', 'HOME', 'CAFE', 'PARK', 'STUDIO', 'LIBRARY', 'WORKPLACE']);
const WORLD_STATE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getWorldState(store, account, path) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  return ok({ world_state: publicWorldState(currentWorldState(store, account, character)) });
}

function updateWorldState(store, account, path, body) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  const state = currentWorldState(store, account, character);
  if (!Number.isInteger(body?.expected_version) || body.expected_version !== state.state_version) throw apiError(409, 'VERSION_CONFLICT', '世界状态版本冲突');
  const patch = validatedWorldStatePatch(store, account, character, body);
  if (Object.keys(patch).length === 0) throw apiError(400, 'VALIDATION_ERROR', '至少修改一个世界状态字段');
  return ok({ world_state: publicWorldState(transitionWorldState(store, state, patch, 'USER_PATCH')) });
}

function resetWorldState(store, account, path) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  const state = currentWorldState(store, account, character);
  const defaults = defaultWorldStateValues();
  return ok({ world_state: publicWorldState(transitionWorldState(store, state, defaults, 'USER_RESET')), reset: true });
}

function currentWorldState(store, account, character) {
  const state = initializeWorldState(store, account.account_id, character.character_id);
  if (state.expires_at && new Date(state.expires_at).getTime() <= Date.now()) return transitionWorldState(store, state, defaultWorldStateValues(), 'SYSTEM_EXPIRED');
  return state;
}

function initializeWorldState(store, accountId, characterId) {
  const existing = store.worldStates.get(characterId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const state = { world_state_id: store.next('wst'), account_id: accountId, character_id: characterId, ...defaultWorldStateValues(), source: 'TEMPLATE_DEFAULT', state_version: 1, reset_at: now, updated_at: now };
  store.worldStates.set(characterId, state);
  recordWorldStateEvent(store, state, defaultWorldStateValues(), 'TEMPLATE_DEFAULT', 0, 1, now);
  return state;
}

function defaultWorldStateValues() {
  return { mood_code: 'NEUTRAL', location_code: 'UNSPECIFIED', wardrobe_asset_id: null, active_event_refs: [], expires_at: null };
}

function validatedWorldStatePatch(store, account, character, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, 'VALIDATION_ERROR', '世界状态必须是对象');
  const allowed = new Set(['expected_version', 'mood_code', 'location_code', 'wardrobe_asset_id', 'active_event_refs', 'expires_at']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw apiError(400, 'VALIDATION_ERROR', `世界状态不支持字段：${unknown.join(', ')}`);
  const patch = {};
  if (body.mood_code !== undefined) {
    if (!WORLD_MOOD_CODES.has(body.mood_code)) throw apiError(400, 'VALIDATION_ERROR', 'mood_code 不在批准枚举中');
    patch.mood_code = body.mood_code;
  }
  if (body.location_code !== undefined) {
    if (!WORLD_LOCATION_CODES.has(body.location_code)) throw apiError(400, 'VALIDATION_ERROR', 'location_code 不在批准枚举中');
    patch.location_code = body.location_code;
  }
  if (body.wardrobe_asset_id !== undefined) {
    if (body.wardrobe_asset_id !== null) throw apiError(409, 'WORLD_STATE_WARDROBE_UNAVAILABLE', '当前开发切片尚未接入已审核服装资产，不能绑定 wardrobe_asset_id');
    patch.wardrobe_asset_id = null;
  }
  if (body.active_event_refs !== undefined) {
    if (!Array.isArray(body.active_event_refs) || body.active_event_refs.length > 5 || body.active_event_refs.some((id) => typeof id !== 'string' || !id)) throw apiError(400, 'VALIDATION_ERROR', 'active_event_refs 必须是最多5项的资产 ID 数组');
    const uniqueRefs = [...new Set(body.active_event_refs)];
    for (const assetId of uniqueRefs) {
      const asset = ownAsset(store, account.account_id, assetId);
      if (asset.character_id !== character.character_id || asset.state !== 'ACTIVE') throw apiError(400, 'WORLD_STATE_EVENT_REF_INVALID', '世界状态事件只能引用当前角色的已确认有效资产');
    }
    patch.active_event_refs = uniqueRefs;
  }
  if (body.expires_at !== undefined) {
    if (body.expires_at === null) patch.expires_at = null;
    else {
      const expires = new Date(body.expires_at);
      if (typeof body.expires_at !== 'string' || Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now() || expires.getTime() - Date.now() > WORLD_STATE_MAX_TTL_MS) throw apiError(400, 'VALIDATION_ERROR', 'expires_at 必须是未来7天内的 ISO 时间');
      patch.expires_at = expires.toISOString();
    }
  }
  return patch;
}

function transitionWorldState(store, state, patch, source) {
  const previousVersion = state.state_version;
  const now = new Date().toISOString();
  Object.assign(state, patch, { source, state_version: previousVersion + 1, updated_at: now });
  if (source === 'USER_RESET') state.reset_at = now;
  recordWorldStateEvent(store, state, patch, source, previousVersion, state.state_version, now);
  return state;
}

function recordWorldStateEvent(store, state, patch, source, previousVersion, newVersion, occurredAt) {
  const event = { event_id: store.next('wse'), world_state_id: state.world_state_id, account_id: state.account_id, character_id: state.character_id, patch, source_type: source, previous_version: previousVersion, new_version: newVersion, occurred_at: occurredAt };
  store.worldStateEvents.set(event.event_id, event);
}

function publicWorldState(state) {
  return { world_state_id: state.world_state_id, state_version: state.state_version, mood_code: state.mood_code, location_code: state.location_code, wardrobe_asset_id: state.wardrobe_asset_id, active_event_refs: state.active_event_refs, expires_at: state.expires_at, reset_at: state.reset_at, updated_at: state.updated_at };
}

function personaChangedFields(previous, next) {
  return [...Object.keys(emptyPersona())].filter((field) => JSON.stringify(previous?.[field] ?? null) !== JSON.stringify(next[field] ?? null));
}

function requiredNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw apiError(400, 'VALIDATION_ERROR', 'note 必须是字符串');
  const trimmed = value.trim();
  if (trimmed.length > 200) throw apiError(400, 'VALIDATION_ERROR', 'note 超过 200 字');
  return trimmed;
}

function createConversation(store, account, body) {
  authorize(account, 'CREATE_CONVERSATION', store);
  const character = ownCharacter(store, account.account_id, body.character_id);
  const conversation = { conversation_id: store.next('cnv'), account_id: account.account_id, character_id: character.character_id, status: 'OPEN', created_at: new Date().toISOString() };
  store.conversations.set(conversation.conversation_id, conversation);
  return created({ conversation });
}

function pauseConversation(store, account, path) {
  // Pause is an exit/control action, so it remains available during safety or
  // account-review states. It never sends content or changes safety status.
  authorize(account, 'DATA_RIGHTS', store);
  const conversation = ownConversation(store, account.account_id, path.split('/')[4]);
  if (conversation.status === 'USER_PAUSED') return ok({ conversation, paused: true });
  if (conversation.status !== 'OPEN') throw apiError(409, 'STATE_TRANSITION_INVALID', '当前会话不能暂停');
  conversation.status = 'USER_PAUSED';
  conversation.paused_at = new Date().toISOString();
  return ok({ conversation, paused: true });
}

function resumeConversation(store, account, path) {
  // 用户显式请求恢复即解除退出意图设置的账户级暂停；年龄、安全模式、
  // 必要告知与服务状态仍必须重新通过（authorize 在下方统一重检）。
  if (account.user_pause_state === 'PAUSED') account.user_pause_state = 'ACTIVE';
  authorize(account, 'SEND_MESSAGE', store);
  const conversation = ownConversation(store, account.account_id, path.split('/')[4]);
  if (conversation.status === 'OPEN') return ok({ conversation, resumed: true });
  if (conversation.status !== 'USER_PAUSED') throw apiError(409, 'STATE_TRANSITION_INVALID', '当前会话不能恢复');
  conversation.status = 'OPEN';
  conversation.resumed_at = new Date().toISOString();
  return ok({ conversation, resumed: true });
}

function deleteConversation(store, account, path) {
  const conversation = ownConversation(store, account.account_id, path.split('/')[4]);
  const messageIds = new Set([...store.messages.values()].filter((item) => item.conversation_id === conversation.conversation_id).map((item) => item.message_id));
  const candidateIds = new Set([...store.candidates.values()].filter((item) => item.account_id === account.account_id && messageIds.has(item.source_message_id)).map((item) => item.candidate_id));
  const deletedAt = new Date().toISOString();
  for (const summary of invalidateSummaries([...store.conversationSummaries.values()], [...store.messages.values()], conversation.conversation_id, [...messageIds], deletedAt)) store.conversationSummaries.set(summary.summary_id, summary);
  cancelConversationSummaryJobs(store, conversation.conversation_id, deletedAt);
  for (const messageId of messageIds) store.messages.delete(messageId);
  for (const [feedbackId, feedback] of store.messageFeedback) if (messageIds.has(feedback.message_id)) store.messageFeedback.delete(feedbackId);
  for (const candidate of store.candidates.values()) if (candidateIds.has(candidate.candidate_id)) { candidate.state = 'DELETED'; candidate.deleted_at = deletedAt; }
  for (const asset of store.assets.values()) if (candidateIds.has(asset.source_candidate_id) && asset.state !== 'DELETED') { asset.state = 'DELETED'; asset.deleted_at = deletedAt; invalidateAssetEmbedding(store, asset.asset_id, 'conversation deleted'); }
  conversation.status = 'DELETED'; conversation.deleted_at = deletedAt;
  account.revocation_epoch += 1;
  const deletionJob = { deletion_job_id: store.next('del'), account_id: account.account_id, asset_id: null, scope: 'CONVERSATION', state: 'COMPLETED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'ROWS_CLEANED_INLINE', created_at: deletedAt, note: '会话消息、候选与派生关系资产已在本请求内清理；向量随资产下线（PG 模式转交 Embedding Worker）。媒体对象不隶属会话删除范围。' };
  store.deletionJobs.set(deletionJob.deletion_job_id, deletionJob);
  registerConversationDeletionTargets(store, account, deletionJob, conversation.conversation_id, deletedAt);
  return ok({ conversation: { conversation_id: conversation.conversation_id, status: conversation.status, deleted_at: deletedAt }, deletion_job: deletionJob, deletion_receipt: deletionReceipt(store, deletionJob) });
}

async function sendMessage(store, account, path, body, replyGenerator, summaryGenerator, textModerator, streamingReplyGenerator = null, embeddingProvider = null) {
  const conversationId = path.split('/')[4];
  const text = requiredText(body?.content?.text, 'content.text');
  // 注销/封禁是硬阻断，优先于资源解析与固定安全响应（与 access-policy 的 ACCOUNT_NOT_OPEN 同源）。
  if (account.account_status !== 'OPEN') throw apiError(403, 'ACCOUNT_NOT_OPEN', '账户当前不可进行伴侣互动');
  const conversation = ownConversation(store, account.account_id, conversationId);
  requireOpenConversation(conversation);
  const activeSafety = responseForExistingSafetyMode(account.safety_mode);
  if (activeSafety) return createSafetyResponse(store, account, conversation, text, activeSafety);
  const safety = assessSafety(text);
  if (safety) return createSafetyResponse(store, account, conversation, text, safety);
  // A conversation can outlive a change to age, notice, service, or user-pause
  // state.  Fixed crisis responses above remain available without involving a
  // model; every ordinary interaction must re-check admission before content
  // moderation, quota reservation, or provider invocation.
  authorize(account, 'SEND_MESSAGE', store);
  if (typeof textModerator === 'function') {
    const moderation = await moderateTextWithMetric(store, account, textModerator, { text, conversationId: conversation.conversation_id, direction: 'INPUT' });
    if (!moderation || !['PASS', 'REVIEW', 'BLOCK'].includes(moderation.decision)) throw apiError(502, 'TEXT_MODERATION_RESPONSE_INVALID', '内容审核未返回有效决策');
    if (moderation.decision !== 'PASS') return createModerationResponse(store, account, conversation, text, moderation);
  }
  // 技术设计 8.4/7.5：请求 stream:true 且配置了流式生成器时走 202 ACCEPTED——
  // 模型调用、额度预留与终稿持久化全部发生在一次性 SSE 令牌的消费请求中，
  // 未消费的令牌不产生任何模型调用或额度副作用。
  if (body?.stream === true && streamingReplyGenerator && typeof streamingReplyGenerator.generateStream === 'function') {
    return acceptStreamingMessage(store, account, conversation, text);
  }
  let reservation;
  const modelStartedAt = Date.now();
  try {
    reservation = reserveDailyChatUsage(store, { accountId: account.account_id, estimatedInputTokens: estimateInputTokens(text) });
  } catch (error) {
    throw dailyUsageApiError(error);
  }
  try {
    const contextPack = await buildContextPack(store, account, conversation, text, embeddingProvider);
    const modelReply = normalizeUnpromptedCharacterSelfIntroduction(
      await replyGenerator(text, contextPack),
      text,
      contextPack.character?.name
    );
    recordOperationMetric(store, { accountId: account.account_id, provider: modelReply.provider, modelVersion: modelReply.model_version, inputTokens: inputTokensFromProviderUsage(modelReply.usage, reservation.reservation_tokens), outputTokens: Number(modelReply.usage?.output_tokens ?? modelReply.usage?.completion_tokens ?? 0), latencyMs: Date.now() - modelStartedAt, outcome: modelReply.ai_generated === false ? 'FALLBACK' : 'COMPLETED' });
    const authorityClaim = assessModelOutputAuthority(modelReply.reply_text);
    if (authorityClaim) {
      releaseDailyChatUsage(store, reservation);
      reservation = null;
      return createModelAuthorityGuardResponse(store, account, conversation, text, authorityClaim);
    }
    if (typeof textModerator === 'function') {
      const moderation = await moderateTextWithMetric(store, account, textModerator, { text: modelReply.reply_text, conversationId: conversation.conversation_id, direction: 'OUTPUT' });
      if (!moderation || !['PASS', 'REVIEW', 'BLOCK'].includes(moderation.decision)) throw apiError(502, 'TEXT_MODERATION_RESPONSE_INVALID', '内容审核未返回有效决策');
      if (moderation.decision !== 'PASS') {
        // The provider response is deliberately neither persisted nor exposed.
        // This is a final output gate, so the user is not charged for a reply
        // that the system replaces with a deterministic safety message.
        releaseDailyChatUsage(store, reservation);
        reservation = null;
        return createOutputModerationResponse(store, account, conversation, text, moderation);
      }
    }
    const createdAt = new Date().toISOString();
    const retentionExpiresAt = plusDays(account.raw_interaction_retention_days || 90);
    const userMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'USER', text, provider: null, ai_generated: false, created_at: createdAt, retention_expires_at: retentionExpiresAt };
    // The state used to generate this response belongs to the response itself,
    // not to whatever state the character may have when TTS is requested later.
    const assistantMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT', text: modelReply.reply_text, provider: modelReply.provider, model_version: modelReply.model_version, ai_generated: modelReply.ai_generated !== false, world_state_id: contextPack.world_state.world_state_id, world_state_version: contextPack.world_state.state_version, created_at: createdAt, retention_expires_at: retentionExpiresAt };
    const candidate = modelReply.memory_candidate ? {
      candidate_id: store.next('memc'), account_id: account.account_id, character_id: conversation.character_id,
      state: 'CANDIDATE', version: 1, type: modelReply.memory_candidate.type,
      normalized_value: modelReply.memory_candidate.normalized_value, display_text: modelReply.memory_candidate.display_text,
      provider: modelReply.provider, expires_at: plusDays(30), source_message_id: userMessage.message_id,
      conflicts_with: detectAssetConflicts(store, account.account_id, conversation.character_id, modelReply.memory_candidate.display_text)
    } : null;
    store.messages.set(userMessage.message_id, userMessage);
    store.messages.set(assistantMessage.message_id, assistantMessage);
    if (candidate) store.candidates.set(candidate.candidate_id, candidate);
    // The user-facing transaction only records a deterministic task. The
    // separate worker owns the second model call, retries and derived write.
    if (summaryGenerator) enqueueConversationSummary({ store, account, conversation });
    const usage = commitDailyChatUsage(store, reservation, { billedInputTokens: inputTokensFromProviderUsage(modelReply.usage, reservation.reservation_tokens) });
    const stream = mintStreamToken(store, account, conversation, assistantMessage);
    return created({ user_message: userMessage, assistant_message: assistantMessage, memory_candidate: candidate, provider: modelReply.provider, disclaimer: modelReply.disclaimer, usage, stream });
  } catch (error) {
    try { releaseDailyChatUsage(store, reservation); } catch { /* The original failure remains primary. */ }
    throw dailyUsageApiError(error);
  }
}

// 上下文包按技术设计 7.2/7.3 的开发子集构建：安全指令由 Adapter 负责，
// 这里提供有限最近对话、当前角色、Top-K 已确认关系资产与短期世界状态。
const RECENT_CONTEXT_LIMIT = 20;
const CONFIRMED_ASSET_TOP_K = 20;

async function buildContextPack(store, account, conversation, text, embeddingProvider = null) {
  const character = store.characters.get(conversation.character_id);
  const messages = conversationMessages(store, conversation.conversation_id);
  const summary = validSummary([...store.conversationSummaries.values()], messages, conversation.conversation_id, account.revocation_epoch);
  const unSummarized = summary ? messages.slice(messages.findIndex((message) => message.message_id === summary.source_to_id) + 1) : messages;
  const recentContext = unSummarized
    .slice(-RECENT_CONTEXT_LIMIT)
    .map(({ actor, text }) => ({ actor, text }));
  return {
    prompt_bundle_version: 'pb_1.0_dev',
    character: character ? publicCharacter(character) : null,
    conversation_id: conversation.conversation_id,
    user_message: text,
    recent_context: recentContext,
    conversation_summary: summary ? { summary_id: summary.summary_id, source_to_id: summary.source_to_id, version: 1, text: summary.text } : null,
    confirmed_assets: (await rankAssetsForContext(store, account.account_id, conversation.character_id, text, embeddingProvider))
      .map(({ type, display_text, version }) => ({ type, display_text, version })),
    world_state: publicWorldState(currentWorldState(store, account, character))
  };
}

// 混合召回（技术设计 7.7）：index_state=READY 且向量可用的资产按向量余弦相似度
// 排序；未就绪（PENDING）、向量缺失或 embedding_model_version 与查询侧不一致的
// 资产保留词法召回排序，保证索引未建好/重建期间不丢失召回。
// embeddingProvider（Qwen 语义向量）配置时查询与索引同源同版本；未配置时
// 用确定性开发嵌入。查询向量获取失败时本轮回退词法，不混用不同版本向量。
async function rankAssetsForContext(store, accountId, characterId, query, embeddingProvider = null) {
  const lexicalAssets = rankRelationshipAssets(activeAssets(store, accountId), { accountId, characterId, query, limit: CONFIRMED_ASSET_TOP_K });
  const queryModelVersion = embeddingProvider?.modelVersion || DEVELOPMENT_EMBEDDING_MODEL_VERSION;
  let queryVector = null;
  try {
    queryVector = embeddingProvider && typeof embeddingProvider.embed === 'function' ? await embeddingProvider.embed(query) : deterministicEmbedding(query);
  } catch {
    queryVector = null; // 供应商查询向量失败：本轮回退词法，不阻塞对话主链路。
  }
  let vectorAssetIds = [];
  if (queryVector && typeof store.rankActiveAssetsByVector === 'function') {
    vectorAssetIds = await store.rankActiveAssetsByVector({ accountId, characterId, queryVector, embeddingModelVersion: queryModelVersion, limit: CONFIRMED_ASSET_TOP_K });
  }
  const vectorsById = new Map(vectorAssetIds.map((item) => [item.asset_id, item.score]));
  const vectorAssets = vectorAssetIds
    .map((item) => store.assets.get(item.asset_id))
    .filter((asset) => asset?.account_id === accountId && asset.character_id === characterId && asset.state === 'ACTIVE' && asset.index_state === 'READY' && !asset.deleted_at);
  const remainingLexical = lexicalAssets.filter((asset) => !vectorsById.has(asset.asset_id));
  const candidates = vectorAssetIds.length > 0 ? [...vectorAssets, ...remainingLexical] : lexicalAssets;
  return candidates
    .map((asset) => {
      const embedding = store.assetEmbeddings.get(asset.asset_id);
      if (vectorsById.has(asset.asset_id)) return { asset, score: vectorsById.get(asset.asset_id) };
      if (queryVector && asset.index_state === 'READY' && embedding && embedding.version === asset.version && embedding.embedding_model_version === queryModelVersion) {
        return { asset, score: cosineSimilarity(embedding.embedding, queryVector) };
      }
      return { asset, score: null };
    })
    .sort((left, right) => {
      // 有向量分的在前（按相似度降序），无向量分的保持词法序（sort 稳定性）。
      if (left.score !== null && right.score !== null && left.score !== right.score) return right.score - left.score;
      if (left.score !== null && right.score === null) return -1;
      if (left.score === null && right.score !== null) return 1;
      return 0;
    })
    .map(({ asset }) => asset)
    .filter((asset, index, items) => items.findIndex((item) => item.asset_id === asset.asset_id) === index)
    .slice(0, CONFIRMED_ASSET_TOP_K);
}

// 角色名只在用户明确询问身份时才需要出现。该门禁补充提示词约束：
// 它只移除回复开头的机械自报姓名，不改写正文、不创造新的角色内容。
function normalizeUnpromptedCharacterSelfIntroduction(modelReply, userText, characterName, allowEmpty = false) {
  if (!modelReply || typeof modelReply.reply_text !== 'string' || typeof characterName !== 'string' || !characterName.trim() || asksCharacterIdentity(userText)) return modelReply;
  const replyText = modelReply.reply_text.trimStart();
  const prefixes = [`我是${characterName.trim()}`, `我叫${characterName.trim()}`];
  const prefix = prefixes.find((item) => replyText.startsWith(item));
  if (!prefix) return modelReply;
  const stripped = replyText.slice(prefix.length).replace(/^[\s，,。！!：:、-]+/, '');
  return stripped || allowEmpty ? { ...modelReply, reply_text: stripped } : modelReply;
}

function asksCharacterIdentity(value) {
  if (typeof value !== 'string') return false;
  const text = value.replace(/\s+/g, '');
  return /(?:你|您)(?:是谁|叫什么(?:名字)?|叫啥|的?名字(?:是什么|是啥)|怎么称呼|是什么身份)|(?:介绍一下你自己|自我介绍|你的身份)/.test(text);
}

function conversationMessages(store, conversationId) {
  return [...store.messages.values()]
    .filter((item) => item.conversation_id === conversationId && !item.deleted_at)
    .sort(chronological);
}

function chronological(a, b) {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.message_id < b.message_id ? -1 : 1;
}

function ownCharacters(store, accountId) {
  return [...store.characters.values()].filter((item) => item.account_id === accountId)
    .sort(chronological)
    .map(publicCharacter);
}

function ownConversations(store, accountId) {
  return [...store.conversations.values()].filter((item) => item.account_id === accountId && item.status !== 'DELETED')
    .sort(chronological)
    .map(({ conversation_id, character_id, status, created_at }) => ({ conversation_id, character_id, status, created_at }));
}

function listMessages(store, account, path, url) {
  const conversation = ownConversation(store, account.account_id, path.split('/')[4]);
  const limit = messagePageLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor');
  const all = conversationMessages(store, conversation.conversation_id);
  let page;
  let nextCursor = null;
  if (cursor) {
    const cursorIndex = all.findIndex((item) => item.message_id === cursor);
    if (cursorIndex === -1) throw apiError(404, 'RESOURCE_NOT_FOUND', '分页游标不存在');
    const start = Math.max(0, cursorIndex - limit);
    page = all.slice(start, cursorIndex);
    nextCursor = start > 0 ? all[start].message_id : null;
  } else {
    page = all.slice(-limit);
    nextCursor = all.length > page.length ? page[0].message_id : null;
  }
  return ok({ messages: page.map(publicMessage), next_cursor: nextCursor });
}

function getMessage(store, account, path) {
  const item = store.messages.get(path.split('/')[4]);
  const conversation = item && store.conversations.get(item.conversation_id);
  if (!item || !conversation || conversation.account_id !== account.account_id || conversation.status === 'DELETED') {
    throw apiError(404, 'RESOURCE_NOT_FOUND', '消息不存在');
  }
  return ok({ message: publicMessage(item) });
}

// SSE 回放（技术设计 8.4/7.5 的开发子集）：POST 已持久化完整回复，本端点把终稿按句
// 切分为 chunk 事件一次性回放。它不是供应商 token 级实时流，也不含逐段输出审核；
// 那些属于生产化流式安全范围。
function mintStreamToken(store, account, conversation, assistantMessage) {
  const token = `st_${randomUUID()}`;
  const now = Date.now();
  for (const [key, value] of streamTokens) if (value.expiresAt < now) streamTokens.delete(key);
  streamTokens.set(token, { accountId: account.account_id, conversationId: conversation.conversation_id, assistantMessageId: assistantMessage.message_id, text: assistantMessage.text, expiresAt: now + STREAM_TOKEN_TTL_MS, used: false });
  return { stream_url: `/api/v1/conversation-streams/${token}`, stream_token: token, stream_expires_at: new Date(now + STREAM_TOKEN_TTL_MS).toISOString(), replay: true };
}

// ---- 真流式（技术设计 8.4 ACCEPTED 合同 + 7.5 逐段输出门禁）----
// POST stream:true 只受理与签发一次性令牌；模型调用、额度预留、逐段审核、
// 终稿持久化都在 SSE 消费请求内完成。令牌未消费则无任何副作用。
function acceptStreamingMessage(store, account, conversation, text) {
  const userMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'USER', text, provider: null, ai_generated: false, created_at: new Date().toISOString() };
  store.messages.set(userMessage.message_id, userMessage);
  const token = `st_${randomUUID()}`;
  const now = Date.now();
  streamTokens.set(token, { mode: 'live', accountId: account.account_id, conversationId: conversation.conversation_id, text, expiresAt: now + STREAM_TOKEN_TTL_MS, used: false });
  return accepted({
    status: 'ACCEPTED', user_message: userMessage, assistant_message: null, memory_candidate: null,
    stream: { stream_url: `/api/v1/conversation-streams/${token}`, stream_token: token, stream_expires_at: new Date(now + STREAM_TOKEN_TTL_MS).toISOString(), mode: 'live' },
    note: '已受理。在 30 秒内以 GET 消费 stream_url 建立流式连接；令牌一次性，未消费不产生模型调用或额度扣减。'
  });
}

function getConversationStream(store, account, path, requestId, streamingReplyGenerator, replyGenerator, textModerator, embeddingProvider = null) {
  const token = path.split('/')[4];
  const entry = streamTokens.get(token);
  if (!entry || entry.accountId !== account.account_id) throw apiError(404, 'RESOURCE_NOT_FOUND', '流式回放不存在');
  if (entry.used) throw apiError(409, 'STATE_TRANSITION_INVALID', '流式令牌已使用，请用消息接口读取终态');
  if (entry.expiresAt < Date.now()) { streamTokens.delete(token); throw apiError(410, 'CONTENT_REVOKED', '流式令牌已过期'); }
  entry.used = true;
  if (entry.mode === 'live') return liveConversationStream(store, account, entry, requestId, streamingReplyGenerator, replyGenerator, textModerator, embeddingProvider);
  const assistantMessage = store.messages.get(entry.assistantMessageId);
  const finalText = assistantMessage ? assistantMessage.text : entry.text;
  return {
    status: 200,
    sse: {
      requestId,
      events: [
        { event: 'message.accepted', data: { request_id: requestId, assistant_message_id: entry.assistantMessageId } },
        ...streamChunks(finalText).map((chunk, index) => ({ event: 'message.chunk', data: { sequence: index + 1, text: chunk } })),
        { event: 'message.completed', data: { message_id: entry.assistantMessageId, version: assistantMessage?.version ?? 1, media_eligible: { tts: true, image: false } } }
      ]
    }
  };
}

// 真流式执行体（技术设计 7.5）：额度预留→Qwen 流式→按句片段过本地权限门禁
// 与 OUTPUT 审核→通过才下发 chunk；拦截/失败走 replaced/failed 终态并释放额度。
// SSE 请求与 POST 同处账户事务模型：流式期间同账户其他请求按公平使用语义排队。
function liveConversationStream(store, account, entry, requestId, streamingReplyGenerator, replyGenerator, textModerator, embeddingProvider = null) {
  return {
    status: 200,
    sseLive: {
      requestId,
      produce: async (emit, signal) => {
        const conversation = ownConversation(store, account.account_id, entry.conversationId);
        requireOpenConversation(conversation);
        const activeSafety = responseForExistingSafetyMode(account.safety_mode) || assessSafety(entry.text);
        if (activeSafety) {
          const assistantMessageId = store.next('msg');
          emit('safety.response', { request_id: requestId, code: activeSafety.code, assistant_message_id: assistantMessageId });
          persistStreamingFinal(store, account, conversation, { reply_text: activeSafety.text, provider: 'safety-policy', model_version: 'deterministic-safety-v1', ai_generated: false }, { assistantMessageId, emit, requestId, usage: null, candidate: null });
          return;
        }
        authorize(account, 'SEND_MESSAGE', store);
        let reservation;
        try {
          reservation = reserveDailyChatUsage(store, { accountId: account.account_id, estimatedInputTokens: estimateInputTokens(entry.text) });
        } catch (error) {
          emit('message.failed', { request_id: requestId, code: error.code || 'DAILY_CHAT_LIMIT_REACHED', retryable: false });
          return;
        }
        const assistantMessageId = store.next('msg');
        emit('message.accepted', { request_id: requestId, assistant_message_id: assistantMessageId });
        let sequence = 0;
        let settled = false;
        const release = () => { if (!settled) { settled = true; try { releaseDailyChatUsage(store, reservation); } catch { /* 事务已回滚则忽略 */ } } };
        const commitUsage = (modelReply) => { if (!settled) { settled = true; return commitDailyChatUsage(store, reservation, { billedInputTokens: inputTokensFromProviderUsage(modelReply.usage, reservation.reservation_tokens) }); } return null; };
        let contextPack;
        try {
          // buildContextPack 包含异步的 pgvector 召回。必须先等待完成，
          // 否则 Qwen 只会收到 Promise，角色姓名、人格与记忆都会丢失。
          contextPack = await buildContextPack(store, account, conversation, entry.text, embeddingProvider);
          const onFragment = async (fragment) => {
            const visibleFragment = normalizeUnpromptedCharacterSelfIntroduction(
              { reply_text: fragment },
              entry.text,
              contextPack.character?.name,
              true
            ).reply_text;
            // 模型偶发地把“我是角色名”单独作为首句时，去除后不应产生一个空 SSE 气泡。
            if (!visibleFragment) return true;
            // 本地确定性门禁（7.5 本地规则，零成本）先于供应商审核。
            if (assessModelOutputAuthority(visibleFragment)) return false;
            if (typeof textModerator === 'function') {
              const moderation = await textModerator({ text: visibleFragment, accountId: account.account_id, conversationId: conversation.conversation_id, direction: 'OUTPUT' });
              if (!moderation || moderation.decision !== 'PASS') return false;
            }
            sequence += 1;
            emit('message.chunk', { sequence, text: visibleFragment });
            return true;
          };
          const modelReply = normalizeUnpromptedCharacterSelfIntroduction(
            await streamingReplyGenerator.generateStream(entry.text, contextPack, onFragment, signal),
            entry.text,
            contextPack.character?.name
          );
          // 终稿复核：片段全过不代表拼接终稿安全（跨片段可能拼出新表述）。
          if (assessModelOutputAuthority(modelReply.reply_text)) throw apiError(200, 'MODEL_CLAIMED_AUTHORITY', '终稿未通过输出门禁');
          const usage = commitUsage(modelReply);
          persistStreamingFinal(store, account, conversation, modelReply, { assistantMessageId, emit, requestId, usage, candidate: true });
        } catch (error) {
          const intercepted = error?.code === 'QWEN_STREAM_INTERCEPTED' || error?.code === 'MODEL_CLAIMED_AUTHORITY';
          if (intercepted) {
            release();
            emit('message.replaced', { request_id: requestId, reason: 'OUTPUT_MODERATION' });
            persistStreamingFinal(store, account, conversation, { reply_text: '这条回复的部分内容未通过安全审核，已停止生成。你可以换一个话题继续。', provider: 'model-output-guard', model_version: 'stream-gate-v1', ai_generated: false }, { assistantMessageId, emit, requestId, usage: null, candidate: null });
            return;
          }
          if (signal?.aborted) { release(); emit('message.cancelled', { request_id: requestId, reason: 'CLIENT_DISCONNECTED' }); return; }
          // 真流式在网络、SSE 或上游协议层失败时，同一轮自动降级为
          // 非流式 Qwen 请求。不重复写入用户消息，也不把临时占位当成 AI 回复。
          if (typeof replyGenerator === 'function') {
            try {
              const fallbackContext = contextPack || await buildContextPack(store, account, conversation, entry.text, embeddingProvider);
              const fallbackReply = normalizeUnpromptedCharacterSelfIntroduction(
                await replyGenerator(entry.text, fallbackContext),
                entry.text,
                fallbackContext.character?.name
              );
              if (assessModelOutputAuthority(fallbackReply.reply_text)) throw apiError(200, 'MODEL_CLAIMED_AUTHORITY', '降级终稿未通过输出门禁');
              if (typeof textModerator === 'function') {
                const moderation = await moderateTextWithMetric(store, account, textModerator, { text: fallbackReply.reply_text, conversationId: conversation.conversation_id, direction: 'OUTPUT' });
                if (!moderation || moderation.decision !== 'PASS') throw apiError(200, 'OUTPUT_MODERATION_REJECTED', '降级终稿未通过输出审核');
              }
              emit('message.replaced', { request_id: requestId, reason: 'STREAM_PROVIDER_FALLBACK' });
              const usage = commitUsage(fallbackReply);
              persistStreamingFinal(store, account, conversation, fallbackReply, { assistantMessageId, emit, requestId, usage, candidate: true });
              return;
            } catch {
              // 降级也失败时由下方统一释放额度并返回可重试终态。
            }
          }
          release();
          emit('message.failed', { request_id: requestId, code: error?.code || 'MODEL_UNAVAILABLE', retryable: Boolean(error?.retryable ?? true) });
        }
      }
    }
  };
}

// 流式终态统一持久化：助手消息（含世界状态快照）与可选候选；拦截/安全路径
// 不创建候选。最后发 message.completed（断线后客户端以 GET /messages/{id} 恢复终态）。
function persistStreamingFinal(store, account, conversation, modelReply, { assistantMessageId, emit, requestId, usage, candidate }) {
  const createdAt = new Date().toISOString();
  const contextCharacter = store.characters.get(conversation.character_id);
  const worldState = contextCharacter ? publicWorldState(currentWorldState(store, account, contextCharacter)) : null;
  const assistantMessage = {
    message_id: assistantMessageId, conversation_id: conversation.conversation_id, actor: 'ASSISTANT',
    text: modelReply.reply_text, provider: modelReply.provider, model_version: modelReply.model_version,
    ai_generated: modelReply.ai_generated !== false, world_state_id: worldState?.world_state_id ?? null,
    world_state_version: worldState?.state_version ?? null, created_at: createdAt
  };
  store.messages.set(assistantMessage.message_id, assistantMessage);
  let memoryCandidate = null;
  if (candidate && modelReply.memory_candidate) {
    memoryCandidate = {
      candidate_id: store.next('memc'), account_id: account.account_id, character_id: conversation.character_id,
      state: 'CANDIDATE', version: 1, type: modelReply.memory_candidate.type,
      normalized_value: modelReply.memory_candidate.normalized_value, display_text: modelReply.memory_candidate.display_text,
      provider: modelReply.provider, expires_at: plusDays(30), source_message_id: null,
      conflicts_with: detectAssetConflicts(store, account.account_id, conversation.character_id, modelReply.memory_candidate.display_text)
    };
    store.candidates.set(memoryCandidate.candidate_id, memoryCandidate);
  }
  emit('message.completed', { request_id: requestId, message_id: assistantMessage.message_id, version: 1, media_eligible: { tts: true, image: false }, usage: usage ?? null, memory_candidate: memoryCandidate ? { candidate_id: memoryCandidate.candidate_id } : null });
}

// 真流式 SSE 传输：逐事件写出；客户端断开时中止模型调用（AbortController）。
function sendLiveEventStream(res, result, requestId) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    res.writeHead(result.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      connection: 'keep-alive'
    });
    let closed = false;
    res.on('close', () => { closed = true; controller.abort(); });
    const emit = (event, data) => {
      if (closed) return;
      res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
    };
    result.sseLive.produce(emit, controller.signal)
      .catch(() => { emit('message.failed', { request_id: requestId, code: 'STREAM_INTERNAL_ERROR', retryable: true }); })
      .finally(() => { if (!closed) res.end(); resolve(); });
  });
}

function streamChunks(text, maxLength = 60) {
  const segments = String(text).split(/(?<=[。！？!?；;\n])/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  for (const segment of segments) {
    for (let offset = 0; offset < segment.length; offset += maxLength) chunks.push(segment.slice(offset, offset + maxLength));
  }
  return chunks.length > 0 ? chunks : [String(text)];
}

function sendEventStream(res, result, requestId) {
  res.writeHead(result.status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
    connection: 'keep-alive'
  });
  for (const { event, data } of result.sse.events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}

function messagePageLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return 50;
  return parsed;
}

function publicCharacter(character, { includeHistory = false } = {}) {
  const view = { character_id: character.character_id, name: character.name, status: character.status, version: character.version, active_persona_version: character.active_persona_version ?? character.version, persona: character.persona ?? emptyPersona() };
  if (includeHistory) view.persona_history = (character.persona_history ?? []).map(publicPersonaVersion);
  return view;
}
function publicPersonaVersion(entry) { return { version: entry.version, parent_version: entry.parent_version ?? null, state: entry.state || 'STABLE', changed_fields: entry.changed_fields ?? [], note: entry.note ?? '', evaluation: entry.evaluation ? { suite_version: entry.evaluation.suite_version, critical_pass_rate: entry.evaluation.critical_pass_rate, overall_pass_rate: entry.evaluation.overall_pass_rate, report_ref: entry.evaluation.report_ref, result: entry.evaluation.result, evaluated_at: entry.evaluation.evaluated_at } : null, canary: entry.canary ? { traffic_percent: entry.canary.traffic_percent, shadow_report_ref: entry.canary.shadow_report_ref, started_at: entry.canary.started_at } : null, rollback: entry.rollback ? { to_version: entry.rollback.to_version, reason: entry.rollback.reason, rolled_back_at: entry.rollback.rolled_back_at } : null, created_at: entry.created_at, updated_at: entry.updated_at ?? entry.created_at }; }

function publicMessage(message) {
  return { message_id: message.message_id, conversation_id: message.conversation_id, actor: message.actor, text: message.text, provider: message.provider ?? null, model_version: message.model_version ?? null, ai_generated: message.ai_generated, world_state_id: message.world_state_id ?? null, world_state_version: message.world_state_version ?? null, created_at: message.created_at };
}

const FEEDBACK_TYPES = new Set(['OOC', 'MEMORY_ERROR', 'IMAGE_FACE_MISMATCH', 'IMAGE_WARDROBE_ERROR', 'IMAGE_SCENE_CONFLICT', 'UNSAFE_OR_UNCOMFORTABLE']);
const FEEDBACK_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);
function createMessageFeedback(store, account, path, body) {
  // Feedback is a user-controlled correction signal, never an automatic model
  // instruction or relationship-memory write.
  authorize(account, 'DATA_RIGHTS', store);
  const message = ownMessage(store, account.account_id, path.split('/')[4]);
  if (message.actor !== 'ASSISTANT') throw apiError(409, 'STATE_TRANSITION_INVALID', '仅可对助手消息提交模型反馈');
  if (!FEEDBACK_TYPES.has(body?.type) || !FEEDBACK_SEVERITIES.has(body?.severity)) throw apiError(400, 'VALIDATION_ERROR', '反馈类型或严重度无效');
  const note = body?.note === undefined ? null : optionalShortText(body.note, 'note', 500);
  const feedback = {
    feedback_id: store.next('mfb'), account_id: account.account_id, message_id: message.message_id,
    conversation_id: message.conversation_id, type: body.type, severity: body.severity, note,
    provider: message.provider || null, model_version: message.model_version || null,
    world_state_id: message.world_state_id || null, world_state_version: message.world_state_version || null,
    created_at: new Date().toISOString()
  };
  store.messageFeedback.set(feedback.feedback_id, feedback);
  return created({ feedback });
}
const TRIAL_FEEDBACK_CATEGORIES = new Set(['ONBOARDING', 'PERSONA', 'MEMORY', 'SAFETY', 'USABILITY', 'OTHER']);
function createTrialFeedback(store, account, body) {
  authorize(account, 'DATA_RIGHTS', store);
  const category = body?.category;
  const rating = Number(body?.rating);
  if (!TRIAL_FEEDBACK_CATEGORIES.has(category) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw apiError(400, 'VALIDATION_ERROR', '反馈分类或评分无效');
  }
  const note = body?.note === undefined || body.note === null || body.note === '' ? '' : optionalShortText(body.note, 'note', 1200);
  const feedback = { feedback_id: store.next('tfb'), account_id: account.account_id, category, rating, note, created_at: new Date().toISOString() };
  store.trialFeedback.set(feedback.feedback_id, feedback);
  return created({ feedback: publicTrialFeedback(feedback) });
}
function optionalShortText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw apiError(400, 'VALIDATION_ERROR', `${label} 必须为 1-${maxLength} 个字符`);
  return value.trim();
}

function createModerationResponse(store, account, conversation, text, moderation) {
  const userMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'USER', text, provider: null, ai_generated: false, created_at: new Date().toISOString() };
  const code = moderation.decision === 'BLOCK' ? 'CONTENT_BLOCKED' : 'CONTENT_REVIEW_REQUIRED';
  const assistantMessage = {
    message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT',
    text: moderation.decision === 'BLOCK' ? '这条内容暂时无法继续处理。你可以调整表达后再试。' : '这条内容需要进一步审核，暂时无法继续处理。',
    provider: 'content-moderation-policy', model_version: moderation.policyVersion, ai_generated: false, created_at: new Date().toISOString()
  };
  store.messages.set(userMessage.message_id, userMessage);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  return created({
    user_message: userMessage, assistant_message: assistantMessage, memory_candidate: null,
    provider: 'content-moderation-policy', disclaimer: '这是固定内容审核响应，文本未发送给角色模型。',
    moderation: { code, direction: 'INPUT', decision: moderation.decision, provider_request_id: moderation.providerRequestId, policy_version: moderation.policyVersion }
  });
}

function createOutputModerationResponse(store, account, conversation, text, moderation) {
  const userMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'USER', text, provider: null, ai_generated: false, created_at: new Date().toISOString() };
  const code = moderation.decision === 'BLOCK' ? 'MODEL_OUTPUT_BLOCKED' : 'MODEL_OUTPUT_REVIEW_REQUIRED';
  const assistantMessage = {
    message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT',
    text: moderation.decision === 'BLOCK' ? '这条回复未通过安全审核，已不向你展示。你可以换一个话题继续。' : '这条回复需要进一步安全审核，暂时不向你展示。你可以换一个话题继续。',
    provider: 'content-moderation-policy', model_version: moderation.policyVersion, ai_generated: false, created_at: new Date().toISOString()
  };
  store.messages.set(userMessage.message_id, userMessage);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  return created({
    user_message: userMessage, assistant_message: assistantMessage, memory_candidate: null,
    provider: 'content-moderation-policy', disclaimer: '模型回复未通过输出审核，原始回复未持久化或展示。',
    moderation: { code, direction: 'OUTPUT', decision: moderation.decision, provider_request_id: moderation.providerRequestId, policy_version: moderation.policyVersion }
  });
}

function createModelAuthorityGuardResponse(store, account, conversation, text, authorityClaim) {
  const userMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'USER', text, provider: null, ai_generated: false, created_at: new Date().toISOString() };
  const assistantMessage = {
    message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT',
    text: '这条回复包含不能由角色模型执行或承诺的系统操作，已不向你展示。相关状态请通过产品中的正式设置入口查看或修改。',
    provider: 'model-output-authority-policy', model_version: 'deterministic-authority-v1', ai_generated: false, created_at: new Date().toISOString()
  };
  store.messages.set(userMessage.message_id, userMessage);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  return created({
    user_message: userMessage, assistant_message: assistantMessage, memory_candidate: null,
    provider: 'model-output-authority-policy', disclaimer: '模型回复包含越权系统操作声明，原始回复未持久化或展示。',
    safety: { code: authorityClaim.code, mode: account.safety_mode }
  });
}

function createSafetyResponse(store, account, conversation, text, safety) {
  if (safety.safetyMode) account.safety_mode = safety.safetyMode;
  // AC-10：退出意图立即暂停普通互动；数据权利与恢复入口保持可用。
  if (safety.pause) account.user_pause_state = 'PAUSED';
  const userMessage = { message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'USER', text, provider: null, ai_generated: false, created_at: new Date().toISOString() };
  const assistantMessage = {
    message_id: store.next('msg'), conversation_id: conversation.conversation_id, actor: 'ASSISTANT', text: safety.text,
    provider: 'safety-policy', model_version: 'deterministic-safety-v1', ai_generated: false, created_at: new Date().toISOString()
  };
  store.messages.set(userMessage.message_id, userMessage);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  return created({
    user_message: userMessage, assistant_message: assistantMessage, memory_candidate: null,
    provider: 'safety-policy', disclaimer: '这是固定安全响应，普通角色互动已按风险等级受控。',
    safety: { code: safety.code, mode: account.safety_mode }
  });
}

async function createAsrJob(store, account, path, body, asrTranscriber, mediaStore, mediaEntitlementService) {
  authorize(account, 'TRANSCRIBE_ASR', store);
  if (typeof asrTranscriber !== 'function') throw apiError(503, 'ASR_NOT_ENABLED', '本地开发未显式启用 ASR');
  const conversation = ownConversation(store, account.account_id, path.split('/')[4]);
  const mimeType = requiredAsrMimeType(body?.mime_type);
  const bytes = decodeAsrAudio(body?.audio_base64);
  const job = {
    job_id: store.next('asr'), account_id: account.account_id, character_id: conversation.character_id, conversation_id: conversation.conversation_id,
    source_message_id: null, input_asset_id: null, entitlement_id: null, type: 'ASR', state: 'PENDING', attempts: 0, provider: 'tencent-asr', provider_request_id: null,
    moderation_policy_version: null, result_asset_id: null, transcript_text: null, transcript_state: null, failure_code: null, created_at: new Date().toISOString()
  };
  store.mediaJobs.set(job.job_id, job);
  await mediaStore.createPendingJob(job);
  const reservedSeconds = estimateAudioSeconds(bytes.length);
  let reservation = null;
  if (mediaEntitlementService) {
    try {
      reservation = mediaEntitlementService.reserve({ accountId: account.account_id, jobId: job.job_id, capability: 'TRANSCRIBE_ASR', quantity: reservedSeconds });
      job.entitlement_id = reservation.entitlement_id;
    } catch (error) {
      job.state = 'FAILED'; job.failure_code = error.code || 'ENTITLEMENT_RESERVE_FAILED';
      await mediaStore.updateJob(job);
      return accepted({ asr_job: publicAsrJob(job) });
    }
  }
  try {
    const assetId = store.next('med');
    const persisted = await mediaStore.putAsrInput({ assetId, jobId: job.job_id, bytes, mimeType });
    const inputAsset = {
      asset_id: assetId, account_id: account.account_id, character_id: conversation.character_id, job_id: job.job_id, type: 'ASR_INPUT_AUDIO', state: 'AVAILABLE',
      media_type: 'AUDIO', mime_type: persisted.mimeType, byte_length: persisted.byteLength, checksum: persisted.checksum, object_key: persisted.objectKey,
      provider: 'local-private-development-upload', provider_request_id: job.job_id, ai_generated: false, aigc_mark_version: 'not-applicable-user-input-development', created_at: new Date().toISOString(), deleted_at: null
    };
    store.mediaAssets.set(assetId, inputAsset);
    job.input_asset_id = assetId;
    job.state = 'RUNNING'; job.attempts = 1;
    await mediaStore.updateJob(job);
    const providerStartedAt = Date.now();
    let result;
    try {
      result = await asrTranscriber({ bytes, mimeType, sessionId: job.job_id });
      recordOperationMetric(store, { accountId: account.account_id, capability: 'ASR', provider: providerName(asrTranscriber, job.provider), modelVersion: providerModelVersion(asrTranscriber), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'COMPLETED' });
    } catch (error) {
      recordOperationMetric(store, { accountId: account.account_id, capability: 'ASR', provider: providerName(asrTranscriber, job.provider), modelVersion: providerModelVersion(asrTranscriber), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'FAILED' });
      throw error;
    }
    job.provider_request_id = result.providerRequestId;
    job.transcript_text = result.text;
    job.transcript_state = 'PENDING_CONFIRMATION';
    job.state = 'COMPLETED';
    if (reservation) mediaEntitlementService.commit({ accountId: account.account_id, jobId: job.job_id, capability: 'TRANSCRIBE_ASR', quantity: reservedSeconds });
    await mediaStore.updateJob(job);
  } catch (error) {
    job.state = 'FAILED'; job.failure_code = error.code || 'ASR_TRANSCRIPTION_FAILED';
    releaseMediaEntitlement(mediaEntitlementService, job, 'TRANSCRIBE_ASR');
    await mediaStore.updateJob(job);
  }
  return accepted({ asr_job: publicAsrJob(job) });
}

// 语音时长估算（开发口径）：按 32kbps 等效码率从字节数折算秒数并向上取整。
// 供应商未返回精确时长前这是可审计的下限估算；生产必须改用供应商 duration 字段。
function estimateAudioSeconds(byteLength) {
  return Math.max(1, Math.ceil(byteLength * 8 / 32000));
}

function estimateTtsSeconds(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function releaseMediaEntitlement(service, job, capability) {
  if (!service || !job.entitlement_id) return;
  try { service.release({ accountId: job.account_id, jobId: job.job_id, capability }); }
  catch { job.failure_code = 'ENTITLEMENT_RELEASE_FAILED'; }
}

function getAsrJob(store, account, path) {
  const job = store.mediaJobs.get(path.split('/')[4]);
  if (!job || job.account_id !== account.account_id || job.type !== 'ASR') throw apiError(404, 'RESOURCE_NOT_FOUND', '语音转写任务不存在');
  return ok({ asr_job: publicAsrJob(job) });
}

async function confirmAsrJob(store, account, path, body, mediaStore) {
  const job = store.mediaJobs.get(path.split('/')[4]);
  if (!job || job.account_id !== account.account_id || job.type !== 'ASR') throw apiError(404, 'RESOURCE_NOT_FOUND', '语音转写任务不存在');
  if (job.state !== 'COMPLETED' || job.transcript_state !== 'PENDING_CONFIRMATION') throw apiError(409, 'STATE_TRANSITION_INVALID', '当前转写不可确认');
  job.transcript_text = requiredText(body?.text || job.transcript_text, 'text');
  job.transcript_state = 'CONFIRMED';
  job.state = 'CONFIRMED';
  await mediaStore.updateJob(job);
  const inputAsset = store.mediaAssets.get(job.input_asset_id);
  let deletion = null;
  if (inputAsset && inputAsset.account_id === account.account_id && inputAsset.state === 'AVAILABLE') {
    deletion = await deleteMediaAsset(store, account, `/api/v1/media-assets/${inputAsset.asset_id}`, mediaStore);
  }
  return ok({ asr_job: publicAsrJob(job), input_audio_deletion: deletion && deletion.body.deletion_job });
}

async function createTtsJob(store, account, path, ttsGenerator, textModerator, mediaStore, mediaEntitlementService) {
  authorize(account, 'SYNTHESIZE_TTS', store);
  if (typeof ttsGenerator !== 'function') throw apiError(503, 'TTS_NOT_ENABLED', '本地开发未显式启用 TTS');
  const voiceProfile = resolvedTtsVoiceProfile(ttsGenerator);
  const source = ownAssistantMessage(store, account.account_id, path.split('/')[4]);
  const conversation = ownConversation(store, account.account_id, source.conversation_id);
  const worldState = source.world_state_id
    ? { world_state_id: source.world_state_id, state_version: source.world_state_version }
    : publicWorldState(currentWorldState(store, account.account_id, store.characters.get(conversation.character_id)));
  const job = {
    job_id: store.next('tts'), account_id: account.account_id, character_id: conversation.character_id, conversation_id: conversation.conversation_id,
    source_message_id: source.message_id, entitlement_id: null, type: 'TTS', state: 'PENDING', attempts: 0, provider: 'tencent-tts', provider_request_id: null,
    moderation_policy_version: null, result_asset_id: null, failure_code: null,
    voice_id: voiceProfile.voice_id, voice_version: voiceProfile.voice_version, authorization_record_id: voiceProfile.authorization_record_id,
    rights_review_id: voiceProfile.rights_review_id, rights_review_state: voiceProfile.rights_review_state,
    world_state_id: worldState.world_state_id, world_state_version: worldState.state_version, created_at: new Date().toISOString()
  };
  store.mediaJobs.set(job.job_id, job);
  await mediaStore.createPendingJob(job);
  if (typeof textModerator === 'function') {
    try {
      const moderation = await moderateTextWithMetric(store, account, textModerator, { text: source.text, conversationId: conversation.conversation_id, direction: 'TTS_OUTPUT' });
      if (!moderation || !['PASS', 'REVIEW', 'BLOCK'].includes(moderation.decision)) throw apiError(502, 'TEXT_MODERATION_RESPONSE_INVALID', '内容审核未返回有效决策');
      job.moderation_policy_version = moderation.policyVersion;
      if (moderation.decision !== 'PASS') {
        job.state = 'BLOCKED'; job.failure_code = moderation.decision === 'BLOCK' ? 'TTS_OUTPUT_BLOCKED' : 'TTS_OUTPUT_REVIEW_REQUIRED';
        await mediaStore.updateJob(job);
        return accepted({ tts_job: publicTtsJob(job) });
      }
    } catch (error) {
      job.state = 'FAILED'; job.failure_code = error.code || 'TTS_OUTPUT_MODERATION_FAILED';
      await mediaStore.updateJob(job);
      return accepted({ tts_job: publicTtsJob(job) });
    }
  }
  // 语音额度：按文本长度预留秒数，成功按同口径提交，失败/拦截全额返还（PRD 3.5）。
  const reservedSeconds = estimateTtsSeconds(source.text);
  if (mediaEntitlementService) {
    try {
      const reservation = mediaEntitlementService.reserve({ accountId: account.account_id, jobId: job.job_id, capability: 'SYNTHESIZE_TTS', quantity: reservedSeconds });
      job.entitlement_id = reservation.entitlement_id;
    } catch (error) {
      job.state = 'FAILED'; job.failure_code = error.code || 'ENTITLEMENT_RESERVE_FAILED';
      await mediaStore.updateJob(job);
      return accepted({ tts_job: publicTtsJob(job), note: '角色语音额度不足；文字回复不受影响。' });
    }
  }
  job.state = 'RUNNING'; job.attempts = 1;
  await mediaStore.updateJob(job);
  try {
    const providerStartedAt = Date.now();
    let result;
    try {
      result = await ttsGenerator({ text: source.text, sessionId: job.job_id });
      recordOperationMetric(store, { accountId: account.account_id, capability: 'TTS', provider: providerName(ttsGenerator, job.provider), modelVersion: providerModelVersion(ttsGenerator, voiceProfile.voice_version), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'COMPLETED' });
    } catch (error) {
      recordOperationMetric(store, { accountId: account.account_id, capability: 'TTS', provider: providerName(ttsGenerator, job.provider), modelVersion: providerModelVersion(ttsGenerator, voiceProfile.voice_version), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'FAILED' });
      throw error;
    }
    const assetId = store.next('med');
    const persisted = await mediaStore.putAudio({ assetId, jobId: job.job_id, bytes: result.asset.bytes, mimeType: result.asset.mimeType });
    const asset = {
      asset_id: assetId, account_id: account.account_id, character_id: conversation.character_id, job_id: job.job_id, type: 'TTS_AUDIO', state: 'AVAILABLE',
      media_type: 'AUDIO', mime_type: persisted.mimeType, byte_length: persisted.byteLength, checksum: persisted.checksum, object_key: persisted.objectKey,
      provider: 'tencent-tts', provider_request_id: result.providerRequestId, ai_generated: true, aigc_mark_version: 'not-implemented-development', created_at: new Date().toISOString(), deleted_at: null
    };
    store.mediaAssets.set(asset.asset_id, asset);
    job.state = 'COMPLETED'; job.provider_request_id = result.providerRequestId; job.result_asset_id = asset.asset_id;
    if (mediaEntitlementService) mediaEntitlementService.commit({ accountId: account.account_id, jobId: job.job_id, capability: 'SYNTHESIZE_TTS', quantity: reservedSeconds });
    await mediaStore.updateJob(job);
  } catch (error) {
    job.state = 'FAILED'; job.failure_code = error.code || 'TTS_GENERATION_FAILED';
    releaseMediaEntitlement(mediaEntitlementService, job, 'SYNTHESIZE_TTS');
    await mediaStore.updateJob(job);
  }
  return accepted({ tts_job: publicTtsJob(job) });
}

function getTtsJob(store, account, path) {
  const job = store.mediaJobs.get(path.split('/')[4]);
  if (!job || job.account_id !== account.account_id) throw apiError(404, 'RESOURCE_NOT_FOUND', '语音任务不存在');
  return ok({ tts_job: publicTtsJob(job) });
}

async function createReferenceImage(store, account, path, body, imageModerator, imageStore) {
  authorize(account, 'GENERATE_IMAGE', store);
  requireImagePipeline(imageModerator, imageStore);
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  if (body?.user_confirms_image_rights !== true) throw apiError(400, 'VALIDATION_ERROR', '必须确认拥有或已获图片使用授权');
  const mimeType = requiredImageMimeType(body?.mime_type);
  const bytes = decodeImage(body?.image_base64);
  const asset = {
    asset_id: store.next('med'), account_id: account.account_id, character_id: character.character_id, job_id: null,
    type: 'REFERENCE_IMAGE', state: 'PENDING_MODERATION', confirmation_state: 'PENDING', media_type: 'IMAGE', mime_type: mimeType,
    byte_length: null, checksum: null, object_key: null, provider: 'user-upload-private-cos', provider_request_id: null,
    rights_review_id: null, ai_generated: false, aigc_mark_version: 'not-applicable-user-input', created_at: new Date().toISOString(), deleted_at: null
  };
  store.mediaAssets.set(asset.asset_id, asset);
  try {
    const persisted = await imageStore.putImage({ assetId: asset.asset_id, bytes, mimeType });
    Object.assign(asset, { object_key: persisted.objectKey, checksum: persisted.checksum, byte_length: persisted.byteLength });
    const moderation = await moderateImageWithMetric(store, account, imageModerator, { fileUrl: await imageStore.createModerationUrl(asset.object_key), dataId: `reference-${asset.asset_id}` });
    asset.provider_request_id = moderation.providerRequestId;
    asset.moderation_policy_version = moderation.policyVersion;
    if (moderation.decision === 'PASS') {
      // IMS decides content safety, not copyright, portrait, or IP rights.
      // Keep the object private and unusable for generation until a separate
      // approved rights review is recorded by an authorized review service.
      const declarationVersion = optionalShortText(body?.rights_declaration_version || 'reference-image-rights-v1', 'rights_declaration_version', 64);
      const rightsReview = {
        review_id: store.next('crr'), account_id: account.account_id, subject_type: 'REFERENCE_IMAGE', subject_ref: asset.asset_id,
        declaration_version: declarationVersion, risk_codes: ['MANUAL_RIGHTS_REVIEW_REQUIRED'], state: 'REVIEW_REQUIRED', reviewer_id: null,
        decision_reason: '本地开发未配置参考图人工权利审核队列；素材保持私有隔离。', created_at: asset.created_at, updated_at: new Date().toISOString()
      };
      asset.state = 'REVIEW_REQUIRED';
      asset.confirmation_state = 'USER_CONFIRMED';
      asset.rights_review_id = rightsReview.review_id;
      store.contentRightsReviews.set(rightsReview.review_id, rightsReview);
      return created({ media_asset: publicMediaAsset(asset), moderation: publicModeration(moderation), content_rights_review: publicContentRightsReview(rightsReview) });
    } else {
      asset.state = moderation.decision === 'BLOCK' ? 'BLOCKED' : 'REVIEW_REQUIRED';
      asset.confirmation_state = 'REJECTED';
      await imageStore.deleteAsset(asset.object_key);
    }
    return created({ media_asset: publicMediaAsset(asset), moderation: publicModeration(moderation) });
  } catch (error) {
    asset.state = 'FAILED';
    asset.failure_code = error.code || 'REFERENCE_IMAGE_PROCESSING_FAILED';
    if (asset.object_key) await safeDeleteImage(imageStore, asset.object_key);
    throw error;
  }
}

function listReferenceImages(store, account, path) {
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  const mediaAssets = [...store.mediaAssets.values()]
    .filter((asset) => asset.account_id === account.account_id && asset.character_id === character.character_id && asset.type === 'REFERENCE_IMAGE' && asset.state !== 'DELETED')
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .map((asset) => publicReferenceImage(store, asset));
  return ok({ media_assets: mediaAssets });
}

async function createImageJob(store, account, path, body, imageGenerator, imageStore, imageEntitlementService) {
  authorize(account, 'GENERATE_IMAGE', store);
  if (!imageGenerator || typeof imageGenerator.generateScene !== 'function' || !imageStore || typeof imageStore.createModerationUrl !== 'function') throw apiError(503, 'IMAGE_GENERATION_NOT_ENABLED', '本地开发未显式启用图片链路');
  const character = ownCharacter(store, account.account_id, path.split('/')[4]);
  const referenceAsset = ownMediaAsset(store, account.account_id, body?.reference_asset_id);
  if (referenceAsset.character_id !== character.character_id || referenceAsset.type !== 'REFERENCE_IMAGE' || referenceAsset.confirmation_state !== 'USER_CONFIRMED') {
    throw apiError(409, 'REFERENCE_IMAGE_NOT_CONFIRMED', '必须使用当前角色已确认的参考立绘');
  }
  const rightsReview = referenceAsset.rights_review_id ? store.contentRightsReviews.get(referenceAsset.rights_review_id) : null;
  if (!rightsReview || rightsReview.account_id !== account.account_id || rightsReview.subject_type !== 'REFERENCE_IMAGE' || rightsReview.subject_ref !== referenceAsset.asset_id || rightsReview.state !== 'APPROVED') {
    throw apiError(409, 'REFERENCE_IMAGE_RIGHTS_REVIEW_REQUIRED', '参考立绘尚未通过独立权利审核');
  }
  if (referenceAsset.state !== 'AVAILABLE') throw apiError(409, 'REFERENCE_IMAGE_NOT_CONFIRMED', '参考立绘当前不可用于生成');
  // Freeze the short-lived state before reserving entitlement or submitting to
  // the provider. Later user changes must never rewrite an already accepted job.
  const worldState = publicWorldState(currentWorldState(store, account.account_id, character));
  const job = {
    job_id: store.next('img'), account_id: account.account_id, character_id: character.character_id, reference_asset_id: referenceAsset.asset_id,
    type: 'IMAGE_GENERATION', state: 'PENDING', attempts: 0, provider: 'tencent-hunyuan', provider_request_id: null, provider_job_id: null, entitlement_id: null,
    moderation_policy_version: null, result_asset_id: null, failure_code: null, provider_error_code: null,
    world_state_id: worldState.world_state_id, world_state_version: worldState.state_version, scene_contract: null, created_at: new Date().toISOString()
  };
  store.mediaJobs.set(job.job_id, job);
  if (imageEntitlementService) {
    try {
      const reservation = imageEntitlementService.reserveImage({ accountId: account.account_id, jobId: job.job_id });
      job.entitlement_id = reservation.entitlement_id;
    } catch (error) {
      job.state = 'FAILED';
      job.failure_code = error.code || 'ENTITLEMENT_RESERVE_FAILED';
      return accepted({ image_job: publicImageJob(job) });
    }
  }
  try {
    const providerStartedAt = Date.now();
    let result;
    try {
      result = await imageGenerator.generateScene({
        character, referenceAsset, scene: body?.scene, confirmedAssets: activeAssets(store, account.account_id), worldState,
        referenceImageUrl: await imageStore.createModerationUrl(referenceAsset.object_key), style: body?.style, resolution: body?.resolution
      });
      recordOperationMetric(store, { accountId: account.account_id, capability: 'IMAGE_GENERATION', provider: providerName(imageGenerator, job.provider), modelVersion: providerModelVersion(imageGenerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'COMPLETED' });
    } catch (error) {
      recordOperationMetric(store, { accountId: account.account_id, capability: 'IMAGE_GENERATION', provider: providerName(imageGenerator, job.provider), modelVersion: providerModelVersion(imageGenerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - providerStartedAt, outcome: 'FAILED' });
      throw error;
    }
    job.attempts = 1;
    job.provider_request_id = result.providerRequestId;
    job.provider_job_id = result.asset.provider_job_id;
    job.scene_contract = result.sceneContract;
  } catch (error) {
    job.state = 'FAILED';
    job.failure_code = error.code || 'IMAGE_GENERATION_SUBMIT_FAILED';
    job.provider_error_code = safeProviderErrorCode(error);
    releaseImageEntitlement(job, account, imageEntitlementService);
  }
  return accepted({ image_job: publicImageJob(job) });
}

async function refreshImageJob(store, account, path, imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService) {
  authorize(account, 'GENERATE_IMAGE', store);
  requireImagePipeline(imageModerator, imageStore);
  if (!imageGenerator || typeof imageGenerator.query !== 'function' || typeof imageResultFetcher !== 'function') throw apiError(503, 'IMAGE_GENERATION_NOT_ENABLED', '本地开发未显式启用图片链路');
  const job = ownImageJob(store, account.account_id, path.split('/')[4]);
  // 状态推进与后台 Worker 共用同一状态机（./domain/image-job-advance.js）；
  // 本路由保留为用户手动刷新的兜底入口。
  await advanceImageJob(store, account, job, { imageGenerator, imageModerator, imageStore, imageResultFetcher, imageEntitlementService });
  return accepted({ image_job: publicImageJob(job) });
}

function getImageJob(store, account, path) { return ok({ image_job: publicImageJob(ownImageJob(store, account.account_id, path.split('/')[4])) }); }

function getMediaAsset(store, account, path) {
  const asset = store.mediaAssets.get(path.split('/')[4]);
  if (!asset || asset.account_id !== account.account_id || asset.state !== 'AVAILABLE') throw apiError(404, 'RESOURCE_NOT_FOUND', '媒体资源不存在');
  return ok({ media_asset: publicMediaAsset(asset) });
}

async function getMediaAssetContent(store, account, path, mediaStore, imageStore) {
  const asset = store.mediaAssets.get(path.split('/')[4]);
  if (!asset || asset.account_id !== account.account_id || asset.state !== 'AVAILABLE') throw apiError(404, 'RESOURCE_NOT_FOUND', '媒体资源不存在');
  try {
    if (asset.type === 'TTS_AUDIO' && asset.mime_type === 'audio/mpeg') {
      const raw = await mediaStore.readTtsAudio(asset.object_key);
      return { status: 200, binary: tagWithAigcMetadata(raw), contentType: 'audio/mpeg', filename: `${asset.asset_id}.mp3` };
    }
    if (asset.type === 'SCENE_IMAGE' && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.mime_type) && imageStore && typeof imageStore.readImage === 'function') {
      return { status: 200, binary: await imageStore.readImage(asset.object_key), contentType: asset.mime_type, filename: `${asset.asset_id}.${asset.mime_type.split('/')[1]}` };
    }
  } catch {
    throw apiError(404, 'MEDIA_CONTENT_UNAVAILABLE', '媒体内容不可用');
  }
  throw apiError(404, 'MEDIA_CONTENT_UNAVAILABLE', '媒体内容不可用');
}

async function deleteMediaAsset(store, account, path, mediaStore, imageStore) {
  const asset = store.mediaAssets.get(path.split('/')[4]);
  if (!asset || asset.account_id !== account.account_id) throw apiError(404, 'RESOURCE_NOT_FOUND', '媒体资源不存在');
  if (asset.state === 'DELETED') return ok({ media_asset: publicMediaAsset(asset), deletion_job: [...store.deletionJobs.values()].find((job) => job.asset_id === asset.asset_id) });
  asset.state = 'DELETED'; asset.deleted_at = new Date().toISOString(); account.revocation_epoch += 1;
  const privateStore = asset.media_type === 'IMAGE' ? imageStore : mediaStore;
  // Image assets always use the separate COS-only image pipeline. Media assets
  // can use either the local development vault or the explicit COS media store.
  const isCosPrivateStore = asset.media_type === 'IMAGE' || privateStore?.storageKind === 'COS_PRIVATE';
  const objectLocation = isCosPrivateStore ? 'COS 私有媒体对象' : '本地私有媒体对象';
  const deletionJob = { deletion_job_id: store.next('del'), account_id: account.account_id, asset_id: asset.asset_id, scope: 'MEDIA', state: 'ONLINE_DISABLED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'PENDING_DEVELOPMENT', created_at: asset.deleted_at, note: `${objectLocation}待删除。` };
  store.deletionJobs.set(deletionJob.deletion_job_id, deletionJob);
  // 对象级删除账本：无论成败逐目标留痕，供删除回执与恢复演练重放使用。
  registerDeletionTargets(store, deletionJob, [{ target_type: 'MEDIA_OBJECT', target_ref: asset.asset_id }], asset.deleted_at);
  try {
    if (!privateStore || typeof privateStore.deleteAsset !== 'function') throw new Error('Private media store is unavailable');
    await privateStore.deleteAsset(asset.object_key);
    deletionJob.state = 'COMPLETED';
    deletionJob.physical_cleanup_state = isCosPrivateStore ? 'COS_PRIVATE_OBJECT_DELETED' : 'LOCAL_PRIVATE_OBJECT_DELETED';
    deletionJob.note = `${objectLocation}已删除；不构成生产存储、备份或供应商删除证明。`;
    completeDeletionTarget(store, deletionJob, 'MEDIA_OBJECT', asset.asset_id, { object_key: asset.object_key, deleted_at: new Date().toISOString() });
  } catch (error) {
    deletionJob.physical_cleanup_state = 'DELETE_FAILED_DEVELOPMENT';
    deletionJob.note = '本地私有媒体对象删除失败，需重试；未声称物理删除完成。';
    failDeletionTarget(store, deletionJob, 'MEDIA_OBJECT', asset.asset_id, error.message);
  }
  return ok({ media_asset: publicMediaAsset(asset), deletion_job: deletionJob, deletion_receipt: deletionReceipt(store, deletionJob), revocation_epoch: account.revocation_epoch });
}

function resolveCandidate(store, account, path, body) {
  authorize(account, 'WRITE_MEMORY', store);
  const parts = path.split('/');
  const candidate = ownCandidate(store, account.account_id, parts[4]);
  const action = parts[5];
  if (candidate.state !== 'CANDIDATE') throw apiError(409, 'STATE_TRANSITION_INVALID', '候选记忆已处理');
  if (new Date(candidate.expires_at).getTime() <= Date.now()) { candidate.state = 'EXPIRED'; throw apiError(409, 'STATE_TRANSITION_INVALID', '候选记忆已过期'); }
  if (action === 'reject') {
    candidate.state = 'REJECTED'; candidate.version += 1;
    return ok({ candidate });
  }
  if (body.expected_version !== candidate.version) throw apiError(409, 'VERSION_CONFLICT', '候选记忆版本冲突');
  if (action === 'confirm-edited') {
    candidate.display_text = requiredText(body.display_text, 'display_text');
    candidate.normalized_value = body.normalized_value || { text: candidate.display_text };
    candidate.state = 'CONFIRMED_EDITED';
  } else {
    candidate.state = 'CONFIRMED';
  }
  candidate.version += 1;
  const asset = { asset_id: store.next('ras'), account_id: account.account_id, character_id: candidate.character_id, type: candidate.type, value: candidate.normalized_value, display_text: candidate.display_text, state: 'ACTIVE', version: 1, index_state: 'PENDING', source_candidate_id: candidate.candidate_id, created_at: new Date().toISOString() };
  store.assets.set(asset.asset_id, asset);
  // 技术设计 6.3.2/8.5：确认响应返回 index_state=PENDING；异步建索引就绪后变 READY，
  // 未就绪期间该资产仍以确定性词法召回参与上下文（不得丢失召回）。
  enqueueAssetEmbedding({ store, asset });
  return created({ candidate, asset });
}

function deleteAsset(store, account, path) {
  const asset = ownAsset(store, account.account_id, path.split('/')[4]);
  if (asset.state === 'DELETED') return ok({ asset, deletion_job: [...store.deletionJobs.values()].find((job) => job.asset_id === asset.asset_id) });
  asset.state = 'DELETED';
  asset.deleted_at = new Date().toISOString();
  account.revocation_epoch += 1;
  // 向量是派生数据：删除即刻下线并取消未完成索引任务（技术设计 8.9 VECTOR_INDEX 目标）。
  const embeddingCleanup = invalidateAssetEmbedding(store, asset.asset_id, 'asset deleted by user');
  const vectorState = embeddingCleanup.deferred_to_worker ? 'PENDING_WORKER_CLEANUP' : (embeddingCleanup.vector_removed ? 'INVALIDATED' : 'NOT_INDEXED');
  const deletionJob = { deletion_job_id: store.next('del'), account_id: account.account_id, asset_id: asset.asset_id, scope: 'RELATIONSHIP_ASSET', state: 'COMPLETED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'ROWS_CLEANED_INLINE', created_at: asset.deleted_at, note: '关系资产已撤销；向量随资产下线（PG 模式转交 Embedding Worker）。', targets: [ { type: 'RELATIONSHIP_ASSET', state: 'COMPLETED' }, { type: 'VECTOR_INDEX', state: vectorState, cancelled_jobs: embeddingCleanup.jobs_cancelled } ] };
  store.deletionJobs.set(deletionJob.deletion_job_id, deletionJob);
  registerDeletionTargets(store, deletionJob, [
    { target_type: 'RELATIONSHIP_ASSET', target_ref: asset.asset_id },
    { target_type: 'RELATIONSHIP_ASSET_EMBEDDINGS', target_ref: asset.asset_id }
  ], asset.deleted_at);
  completeDeletionTarget(store, deletionJob, 'RELATIONSHIP_ASSET', asset.asset_id, { cleaned_inline: true, completed_at: asset.deleted_at }, asset.deleted_at);
  completeDeletionTarget(store, deletionJob, 'RELATIONSHIP_ASSET_EMBEDDINGS', asset.asset_id, { vector_state: vectorState, completed_at: asset.deleted_at }, asset.deleted_at);
  return ok({ asset, deletion_job: deletionJob, deletion_receipt: deletionReceipt(store, deletionJob), revocation_epoch: account.revocation_epoch });
}

// AC-06/PATCH 修订：旧资产转 SUPERSEDED，新版本以新资产 ID 生效并保留来源链；
// 在线召回只返回新版本。不允许原地改写（保留版本历史）。
function reviseAsset(store, account, path, body) {
  authorize(account, 'WRITE_MEMORY', store);
  const asset = ownAsset(store, account.account_id, path.split('/')[4]);
  if (asset.state === 'DELETED') throw apiError(409, 'STATE_TRANSITION_INVALID', '资产已删除，不能修订');
  if (asset.state !== 'ACTIVE') throw apiError(409, 'STATE_TRANSITION_INVALID', '只有 ACTIVE 资产能修订');
  if (body?.expected_version !== asset.version) throw apiError(409, 'VERSION_CONFLICT', '关系资产版本冲突');
  const displayText = requiredText(body?.display_text, 'display_text');
  const normalizedValue = body?.normalized_value || { text: displayText };
  asset.state = 'SUPERSEDED';
  asset.superseded_at = new Date().toISOString();
  const revision = {
    asset_id: store.next('ras'), account_id: account.account_id, character_id: asset.character_id,
    type: asset.type, value: normalizedValue, display_text: displayText, state: 'ACTIVE', version: 1, index_state: 'PENDING',
    source_candidate_id: asset.source_candidate_id, supersedes_asset_id: asset.asset_id, superseded_by: null, created_at: new Date().toISOString()
  };
  asset.superseded_by = revision.asset_id;
  store.assets.set(revision.asset_id, revision);
  // 旧版本向量立即失效；新版本进入异步建索引流程。
  invalidateAssetEmbedding(store, asset.asset_id, 'asset superseded by revision');
  enqueueAssetEmbedding({ store, asset: revision });
  return ok({ asset, revision });
}

// 时间线：当前只包含仍有效的确认资产（PRD 3.3“确认事件、纪念日、约定”中
// 纪念日/约定随主动事件接入）；被替代与已删除版本不进入在线时间线。
function timelineEntries(store, accountId, filter) {
  const validFilters = ['all', 'memory', 'commitment', 'boundary', 'event'];
  if (filter && !validFilters.includes(filter)) throw apiError(400, 'VALIDATION_ERROR', `filter 只能是 ${validFilters.join('/')}`);
  return activeAssets(store, accountId)
    .filter((asset) => !filter || filter === 'all' || filter === typeToFilter(asset.type))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((asset) => ({
      entry_type: 'CONFIRMED_ASSET', asset_id: asset.asset_id, character_id: asset.character_id,
      type: asset.type, filter_group: typeToFilter(asset.type), display_text: asset.display_text,
      version: asset.version, supersedes_asset_id: asset.supersedes_asset_id ?? null, created_at: asset.created_at
    }));
}

function typeToFilter(type) {
  if (type === 'commitment' || type === 'anniversary') return 'commitment';
  if (type === 'boundary') return 'boundary';
  if (type === 'shared_event' || type === 'event') return 'event';
  return 'memory';
}

// AC-06 冲突检测：新候选与同角色 ACTIVE 资产文本 bigram 相似但不相等时标记冲突，
// 由用户在确认时选择有效版本；模型与系统均不得自动覆盖。
function detectAssetConflicts(store, accountId, characterId, candidateText) {
  const target = String(candidateText ?? '').trim();
  if (!target) return [];
  return activeAssets(store, accountId)
    .filter((asset) => asset.character_id === characterId)
    .filter((asset) => {
      const existing = String(asset.display_text ?? '').trim();
      if (!existing || existing === target) return false;
      return bigramJaccard(existing, target) >= 0.5;
    })
    .map((asset) => ({ asset_id: asset.asset_id, display_text: asset.display_text, similarity: 'similar' }));
}

function bigramJaccard(a, b) {
  const bigrams = (text) => {
    const normalized = text.replace(/[\s，。！？、,.!?~～]/g, '');
    const set = new Set();
    for (let index = 0; index < normalized.length - 1; index += 1) set.add(normalized.slice(index, index + 2));
    return set;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function relationshipProfileExport(store, account) {
  const conversations = [...store.conversations.values()].filter((item) => item.account_id === account.account_id && item.status !== 'DELETED');
  const conversationIds = new Set(conversations.map((item) => item.conversation_id));
  return {
    format: 'qiyu-relationship-profile-json-v1', generated_at: new Date().toISOString(), account_id: account.account_id,
    characters: [...store.characters.values()].filter((item) => item.account_id === account.account_id).map(({ character_id, name, status, version }) => ({ character_id, name, status, version })),
    relationship_assets: activeAssets(store, account.account_id).map(({ asset_id, character_id, type, value, display_text, version, created_at }) => ({ asset_id, character_id, type, value, display_text, version, created_at })),
    conversations: conversations.map(({ conversation_id, character_id, created_at }) => ({ conversation_id, character_id, created_at })),
    messages: [...store.messages.values()].filter((item) => conversationIds.has(item.conversation_id)).map(({ message_id, conversation_id, actor, text, ai_generated, provider, model_version, created_at }) => ({ message_id, conversation_id, actor, text, ai_generated, provider: provider || null, model_version: model_version || null, created_at: created_at || null }))
  };
}

function setRawInteractionRetention(store, account, body) {
  const days = body?.retention_days;
  if (![30, 90].includes(days)) throw apiError(400, 'VALIDATION_ERROR', 'retention_days 只能为 30 或 90');
  account.raw_interaction_retention_days = days;
  const result = applyRawInteractionRetention(store, account);
  return ok({ raw_interaction_retention_days: days, retention_applied: result });
}

function getDeletionJob(store, account, path) {
  const job = store.deletionJobs.get(path.split('/')[4]);
  if (!job || job.account_id !== account.account_id) throw apiError(404, 'RESOURCE_NOT_FOUND', '删除任务不存在');
  // 删除回执（PRD 7.0/AC-15）：用户可见的逐目标清理状态；FAILED 目标如实展示。
  return ok({ deletion_job: job, deletion_receipt: deletionReceipt(store, job) });
}

// ---- 紧急联系人（AC-19）：最小字段 + 独立用途告知；仅用于法规与生命/重大财产安全响应。----
const EMERGENCY_CONTACT_CONSENT_VERSION = 'emergency_contact_purpose_1.0';

function getEmergencyContact(account) {
  return ok({ emergency_contact: publicEmergencyContact(account), consent_version: EMERGENCY_CONTACT_CONSENT_VERSION, purpose: '仅用于法律要求与生命健康或重大财产安全响应，不用于增长、推荐或营销。' });
}

function putEmergencyContact(account, body) {
  if (body?.consent_independent_purpose !== true) throw apiError(400, 'VALIDATION_ERROR', '必须确认联系人独立用途告知');
  const contact = {
    contact_name: requiredText(body?.contact_name, 'contact_name'),
    relationship: requiredText(body?.relationship, 'relationship'),
    phone: requiredPhone(body?.phone),
    consent_version: EMERGENCY_CONTACT_CONSENT_VERSION,
    updated_at: new Date().toISOString()
  };
  if (contact.contact_name.length > 80 || contact.relationship.length > 40) throw apiError(400, 'VALIDATION_ERROR', '联系人姓名或关系字段过长');
  account.emergency_contact = contact;
  return ok({ emergency_contact: publicEmergencyContact(account) });
}

function deleteEmergencyContact(account) {
  account.emergency_contact = null;
  return ok({ emergency_contact: null, note: '联系人已删除；法定安全案件进行中的留存按适用法律处理。' });
}

function publicEmergencyContact(account) {
  const contact = account.emergency_contact;
  if (!contact) return null;
  return { contact_name: contact.contact_name, relationship: contact.relationship, phone_masked: maskPhone(contact.phone), consent_version: contact.consent_version, updated_at: contact.updated_at };
}

function requiredPhone(value) {
  if (typeof value !== 'string') throw apiError(400, 'VALIDATION_ERROR', 'phone 必填');
  const trimmed = value.trim();
  if (!/^\+?[0-9]{5,20}$/.test(trimmed)) throw apiError(400, 'VALIDATION_ERROR', 'phone 格式不合法');
  return trimmed;
}

function maskPhone(phone) {
  if (phone.length <= 4) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

// ---- 连续使用时长提醒（SAFE-03）：服务端依据心跳计算，模型与客户端不可关闭或伪造。----
const HEARTBEAT_GAP_RESET_MS = 5 * 60 * 1000;
const CONTINUOUS_USE_REMIND_MINUTES = 120;

function heartbeat(account) {
  const now = Date.now();
  const activity = account.interaction_activity || { first_heartbeat_at: null, last_heartbeat_at: null, last_reminder_at: null };
  const gap = activity.last_heartbeat_at ? now - activity.last_heartbeat_at : null;
  if (!activity.first_heartbeat_at || gap === null || gap > HEARTBEAT_GAP_RESET_MS) {
    activity.first_heartbeat_at = now;
    activity.last_reminder_at = null;
  }
  activity.last_heartbeat_at = now;
  account.interaction_activity = activity;
  const continuousMinutes = Math.floor((now - activity.first_heartbeat_at) / 60000);
  const sinceReminder = activity.last_reminder_at ? now - activity.last_reminder_at : Infinity;
  const reminderDue = continuousMinutes >= CONTINUOUS_USE_REMIND_MINUTES && sinceReminder >= CONTINUOUS_USE_REMIND_MINUTES * 60000;
  if (reminderDue) activity.last_reminder_at = now;
  return ok({
    continuous_use_minutes: continuousMinutes,
    reminder: reminderDue ? { type: 'CONTINUOUS_USE', notice_version: 'use_1.0', blocking: false, text: '你已连续使用超过 2 小时。建议休息一下；此提醒不可由角色关闭。' } : null,
    policy: { remind_every_minutes: CONTINUOUS_USE_REMIND_MINUTES, computed_by: 'server-heartbeat' }
  });
}

// ---- 举报 / 投诉 / 申诉（技术设计 8.9）：默认不附带完整私聊。----
const COMPLAINT_KINDS = new Set(['REPORT_CONTENT', 'SERVICE_COMPLAINT', 'APPEAL']);

function createComplaint(store, account, body) {
  const kind = body?.kind;
  if (!COMPLAINT_KINDS.has(kind)) throw apiError(400, 'VALIDATION_ERROR', 'kind 只能是 REPORT_CONTENT / SERVICE_COMPLAINT / APPEAL');
  const description = requiredText(body?.description, 'description');
  if (description.length > 2000) throw apiError(400, 'VALIDATION_ERROR', 'description 超过 2000 字');
  const targetResourceId = body?.target_resource_id === undefined || body?.target_resource_id === null ? null : String(body.target_resource_id).slice(0, 128);
  if (!targetResourceId && kind === 'REPORT_CONTENT') throw apiError(400, 'VALIDATION_ERROR', '举报内容必须提供 target_resource_id');
  const complaint = {
    complaint_id: store.next('cpl'), account_id: account.account_id, kind,
    target_resource_id: targetResourceId, description, state: 'SUBMITTED',
    resolution_note: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  store.complaints.set(complaint.complaint_id, complaint);
  return created({ complaint: publicComplaint(complaint) });
}

function getComplaint(store, account, path) {
  const complaint = store.complaints.get(path.split('/')[4]);
  if (!complaint || complaint.account_id !== account.account_id) throw apiError(404, 'RESOURCE_NOT_FOUND', '投诉不存在');
  return ok({ complaint: publicComplaint(complaint) });
}

function publicComplaint(complaint) {
  return { complaint_id: complaint.complaint_id, kind: complaint.kind, target_resource_id: complaint.target_resource_id, description: complaint.description, state: complaint.state, resolution_note: complaint.resolution_note, created_at: complaint.created_at, updated_at: complaint.updated_at };
}

// ---- 订阅入口（技术设计 8.7 开发子集）：目录只读、开发模拟渠道、验签回调、幂等发放。----
const CHECKOUT_DISCLOSURE_VERSION = 'checkout_disclosure_1.0';
const DEVELOPMENT_PAYMENT_CHANNEL = 'DEVELOPMENT_SIMULATED';

function lifecycleFor(store) {
  return new SubscriptionLifecycle({
    subscriptions: store.subscriptions, orders: store.subscriptionOrders, events: store.paymentEvents,
    quarantinedEvents: store.paymentEventQuarantines, transactionOwners: store.paymentTransactionOwners
  });
}

function findPlan(sku) { return SUBSCRIPTION_CATALOG.plans.find((plan) => plan.sku === sku); }

// PRD 1.6: the complete-experience trial is seven days, has no automatic
// charge, and is available only once. It is deliberately separate from the
// payment lifecycle: there is no fabricated order, provider event, or payment
// credential to later mistake for a real transaction.
function startTrial(store, account, now = new Date()) {
  authorize(account, 'START_TRIAL', store);
  const priorTrial = [...store.subscriptions.values()].find((item) => item.account_id === account.account_id && item.channel === DEVELOPMENT_TRIAL_CHANNEL);
  if (priorTrial) throw apiError(409, 'TRIAL_ALREADY_CLAIMED', '每个账户只能领取一次 7 天完整体验档');
  const periodStart = now.toISOString();
  const periodEnd = new Date(now.getTime() + TRIAL_PRODUCT.duration_days * 86400000).toISOString();
  const subscription = {
    subscription_id: store.next('sub'), account_id: account.account_id, sku: TRIAL_PRODUCT.sku,
    channel: DEVELOPMENT_TRIAL_CHANNEL, state: 'TRIAL', auto_renew: false,
    disclosure_version: TRIAL_DISCLOSURE_VERSION, period_start: periodStart, period_end: periodEnd,
    grace_period_end: null, refund_status: 'NONE', transaction_ref_hash: null, created_at: periodStart, updated_at: periodStart
  };
  store.subscriptions.set(subscription.subscription_id, subscription);
  const mediaService = new MediaEntitlementService({ store });
  const grant = mediaService.grantSubscriptionCycle({ subscription, product: TRIAL_PRODUCT, sourceEventId: `trial-${subscription.subscription_id}` });
  return created({ subscription, entitlement_id: grant.entitlement_id, note: '7 天完整体验已开始：不自动扣费；到期后文字、人格、关系资产、导出与删除仍可用。' });
}

function expireTrials(store, account, now = new Date()) {
  for (const subscription of store.subscriptions.values()) {
    if (subscription.account_id !== account.account_id || subscription.state !== 'TRIAL' || !validTimestamp(subscription.period_end) || new Date(subscription.period_end) > now) continue;
    store.subscriptions.set(subscription.subscription_id, Object.freeze({ ...subscription, state: 'EXPIRED', updated_at: now.toISOString() }));
  }
}

function validTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }

function createCheckoutSession(store, account, body) {
  const plan = findPlan(body?.sku);
  if (!plan) throw apiError(400, 'VALIDATION_ERROR', 'sku 不在服务端目录中');
  const autoRenew = body?.auto_renew === true;
  const lifecycle = lifecycleFor(store);
  const orderId = store.next('ord');
  const subscriptionId = store.next('sub');
  try {
    const { subscription, order } = lifecycle.createCheckout({
      orderId, subscriptionId, accountId: account.account_id,
      product: { sku: plan.sku, price_fen: plan.price_fen, currency: SUBSCRIPTION_CATALOG.currency },
      channel: DEVELOPMENT_PAYMENT_CHANNEL, autoRenew, disclosureVersion: CHECKOUT_DISCLOSURE_VERSION
    });
    // 开发模拟渠道：服务端在 checkout 时生成一份已签名 PURCHASE_SUCCEEDED 回调载荷并返回给
    // 本地前端执行。签名密钥不出服务器；回调端点仍按 HMAC 验签（防伪造其他事件）。
    // 生产模式该通道必须被生产门禁禁用。
    const now = new Date();
    const periodStart = now.toISOString();
    const periodEnd = new Date(now.getTime() + (plan.billing_cycle === 'QUARTER' ? 92 : 31) * 86400000).toISOString();
    const callbackPayload = {
      provider_event_id: `evt_${subscriptionId}`, type: 'PURCHASE_SUCCEEDED', account_id: account.account_id,
      subscription_id: subscriptionId, transaction_ref: `txn_${orderId}`, sku: plan.sku,
      effective_at: now.toISOString(), period_start: periodStart, period_end: periodEnd, verified: true
    };
    return created({
      checkout: {
        order_id: order.order_id, subscription_id: subscription.subscription_id, sku: plan.sku,
        amount_fen: order.amount_fen, currency: order.currency, auto_renew: order.auto_renew,
        state: order.state, disclosure_version: order.disclosure_version,
        price_transparency: { auto_renew_default: false, cancellation_note: '到期后文字、人格、关系资产、导出与删除仍可用；不因不付费制造关系惩罚。' }
      },
      development_payment: {
        channel: DEVELOPMENT_PAYMENT_CHANNEL,
        callback_path: '/api/v1/callbacks/payments/development-simulated',
        callback_body: callbackPayload,
        signature: developmentPaymentSignature(callbackPayload),
        note: '仅本地开发模拟渠道：真实支付宝/微信支付必须接入商户、验签回调后才能启用。'
      }
    });
  } catch (error) {
    throw subscriptionApiError(error);
  }
}

function developmentPaymentSignature(payload) {
  return createHmac('sha256', process.env.QIYU_DEV_PAYMENT_SECRET || DEVELOPMENT_PAYMENT_FALLBACK_SECRET).update(JSON.stringify(payload)).digest('hex');
}

function developmentPaymentCallback(store, req, body, requestId) {
  if (!hasValidDevelopmentPaymentSignature(req, body)) {
    throw apiError(401, 'PAYMENT_SIGNATURE_INVALID', '支付回调验签失败');
  }
  const lifecycle = lifecycleFor(store);
  const event = {
    providerEventId: body?.provider_event_id, type: body?.type, accountId: body?.account_id,
    subscriptionId: body?.subscription_id, transactionRef: body?.transaction_ref, sku: body?.sku,
    effectiveAt: body?.effective_at, periodStart: body?.period_start, periodEnd: body?.period_end,
    gracePeriodEnd: body?.grace_period_end, verified: true
  };
  let result;
  try {
    result = lifecycle.applyVerifiedEvent(event);
  } catch (error) {
    throw subscriptionApiError(error);
  }
  if (result.outcome === 'APPLIED' && result.entitlement_grant) {
    const mediaService = new MediaEntitlementService({ store });
    const subscription = result.subscription;
    const plan = findPlan(subscription.sku);
    try {
      mediaService.grantSubscriptionCycle({ subscription, product: plan, sourceEventId: event.providerEventId });
    } catch (error) {
      throw subscriptionApiError(error);
    }
  }
  return ok({ outcome: result.outcome, reason: result.reason || null, subscription_id: event.subscriptionId, request_id: requestId });
}

function verifiedDevelopmentCallbackAccountId(req, url, body, store) {
  if (req.method !== 'POST' || url.pathname !== '/api/v1/callbacks/payments/development-simulated') return null;
  if (!hasValidDevelopmentPaymentSignature(req, body)) return null;
  const accountId = body?.account_id;
  // This path is only used by the Postgres request store. Checkout puts the
  // scoped UUID into the signed body, so no unauthenticated caller can choose
  // a transaction scope before the HMAC is verified.
  return typeof store.resolveAccountId === 'function' && isUuid(accountId) ? accountId : null;
}

function hasValidDevelopmentPaymentSignature(req, body) {
  const supplied = req.headers['x-qiyu-payment-signature'];
  const expected = developmentPaymentSignature(body);
  if (typeof supplied !== 'string' || supplied.length !== expected.length || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));
}

function currentSubscription(store, account) {
  const subscriptions = [...store.subscriptions.values()].filter((item) => item.account_id === account.account_id);
  const latest = (items) => items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;
  const trial = latest(subscriptions.filter((item) => item.channel === DEVELOPMENT_TRIAL_CHANNEL));
  const paid = latest(subscriptions.filter((item) => item.channel !== DEVELOPMENT_TRIAL_CHANNEL && ['ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD', 'CANCEL_AT_PERIOD_END'].includes(item.state)));
  const subscription = paid || (trial?.state === 'TRIAL' ? trial : null);
  return ok({ subscription, trial: publicTrial(trial), trial_product: TRIAL_PRODUCT, catalog_policy: SUBSCRIPTION_CATALOG.policy });
}

function publicTrial(trial, now = new Date()) {
  if (!trial) return { state: 'NOT_STARTED', eligible: true, phase: 'NOT_STARTED' };
  if (trial.state !== 'TRIAL') return { ...trial, phase: 'EXPIRED', eligible: false };
  const ending = validTimestamp(trial.period_end) && Date.parse(trial.period_end) - now.getTime() <= 86400000;
  return { ...trial, phase: ending ? 'ENDING' : 'ACTIVE', eligible: false };
}

function cancelRenewal(store, account, path) {
  const subscription = store.subscriptions.get(path.split('/')[4]);
  if (!subscription || subscription.account_id !== account.account_id) throw apiError(404, 'RESOURCE_NOT_FOUND', '订阅不存在');
  if (!['ACTIVE', 'BILLING_RETRY', 'GRACE_PERIOD'].includes(subscription.state)) {
    throw apiError(409, 'STATE_TRANSITION_INVALID', '当前订阅状态不能取消续费');
  }
  const next = Object.freeze({ ...subscription, state: 'CANCEL_AT_PERIOD_END', auto_renew: false, updated_at: new Date().toISOString() });
  store.subscriptions.set(subscription.subscription_id, next);
  return ok({ subscription: next, note: '已关闭自动续费；当期权益保留至周期结束，到期后数据权利不受影响。' });
}

function entitlementsView(store, account, mediaService) {
  // 查询是只读操作：未注入服务时按当前请求 store 动态构造，避免权益已入账却查不到。
  const service = mediaService && typeof mediaService.entitlementBalances === 'function' ? mediaService : new MediaEntitlementService({ store });
  return ok({ entitlements: service.entitlementBalances(account.account_id), text_fair_use: currentDailyChatUsage(store, account.account_id) });
}

function subscriptionApiError(error) {
  const status = error.code === 'VALIDATION_ERROR' || error.code === 'SUBSCRIPTION_PRODUCT_INVALID' ? 400
    : error.code === 'SUBSCRIPTION_ALREADY_EXISTS' || error.code === 'PAYMENT_EVENT_REPLAY_CONFLICT' ? 409
    : error.code === 'ENTITLEMENT_QUOTA_EXCEEDED' ? 429
    : error.code === 'PAYMENT_EVENT_UNVERIFIED' ? 401
    : 502;
  return apiError(status, error.code || 'SUBSCRIPTION_ERROR', error.message);
}

// ---- 主动消息（PRD 3.7 / 技术设计 8.8）：规则引擎决定是否发送，模型只填模板槽。----
const PROACTIVE_EVENT_TYPES = new Set(['SUBSCRIBED_MORNING', 'SUBSCRIBED_EVENING', 'CONFIRMED_ANNIVERSARY', 'CONFIRMED_BIRTHDAY', 'CONFIRMED_APPOINTMENT', 'CONFIRMED_REALITY_ACTION']);

function getProactivePreferences(account) {
  return ok({ preferences: publicProactivePreferences(account), policy: { max_normal_per_day: 1, paid_does_not_raise: true, rule_engine: 'deterministic' } });
}

function putProactivePreferences(account, body) {
  const current = account.proactive_preferences || { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 0 };
  const enabled = body?.enabled === undefined ? current.enabled : body.enabled === true;
  const quietStart = body?.quiet_start_hour === undefined ? current.quiet_start_hour : body.quiet_start_hour;
  const quietEnd = body?.quiet_end_hour === undefined ? current.quiet_end_hour : body.quiet_end_hour;
  const timezone = body?.timezone_offset_minutes === undefined ? current.timezone_offset_minutes : body.timezone_offset_minutes;
  if (!Number.isInteger(quietStart) || !Number.isInteger(quietEnd) || quietStart < 0 || quietStart > 23 || quietEnd < 0 || quietEnd > 23 || quietStart === quietEnd) {
    throw apiError(400, 'VALIDATION_ERROR', '静默时段小时必须为 0-23 且起止不同');
  }
  if (!Number.isInteger(timezone) || timezone < -720 || timezone > 840) throw apiError(400, 'VALIDATION_ERROR', '时区偏移不合法');
  account.proactive_preferences = { enabled, quiet_start_hour: quietStart, quiet_end_hour: quietEnd, timezone_offset_minutes: timezone };
  return ok({ preferences: publicProactivePreferences(account) });
}

function publicProactivePreferences(account) {
  const preferences = account.proactive_preferences || {};
  return { enabled: preferences.enabled === true, quiet_start_hour: preferences.quiet_start_hour ?? 23, quiet_end_hour: preferences.quiet_end_hour ?? 8, timezone_offset_minutes: preferences.timezone_offset_minutes ?? 0 };
}

function createProactiveEvent(store, account, body) {
  const type = body?.type;
  if (!PROACTIVE_EVENT_TYPES.has(type)) throw apiError(400, 'VALIDATION_ERROR', 'type 不支持');
  const title = requiredText(body?.title, 'title');
  if (title.length > 80) throw apiError(400, 'VALIDATION_ERROR', 'title 超过 80 字');
  const character = store.activeCharacter(account.account_id);
  const event = {
    event_id: store.next('pev'), account_id: account.account_id, character_id: character?.character_id ?? null,
    type, title, due_at: optionalTimestamp(body?.due_at), time_of_day_local: optionalHour(body?.time_of_day_local),
    state: 'ACTIVE', created_at: new Date().toISOString()
  };
  store.proactiveEvents.set(event.event_id, event);
  return created({ event: publicProactiveEvent(event) });
}

function deleteProactiveEvent(store, account, path) {
  const event = ownProactiveEvent(store, account.account_id, path.split('/')[4]);
  if (event.state === 'DELETED') return ok({ event: publicProactiveEvent(event), cancelled_pending: true });
  event.state = 'DELETED';
  return ok({ event: publicProactiveEvent(event), cancelled_pending: true, note: '未发送的任务已取消；已发送记录保留供审计。' });
}

function triggerProactiveEvent(store, account, path) {
  const event = ownProactiveEvent(store, account.account_id, path.split('/')[4]);
  if (event.state !== 'ACTIVE') throw apiError(409, 'STATE_TRANSITION_INVALID', '事件已删除');
  const sentAt = [...store.proactiveMessages.values()]
    .filter((item) => item.account_id === account.account_id && item.kind === 'NORMAL')
    .map((item) => item.sent_at);
  const preferences = publicProactivePreferences(account);
  const decision = evaluateProactiveDispatch({
    preferences: { enabled: preferences.enabled, quietStartHour: preferences.quiet_start_hour, quietEndHour: preferences.quiet_end_hour, timezoneOffsetMinutes: preferences.timezone_offset_minutes },
    trigger: { type: event.type }, sentAt
  });
  if (!decision.allowed) {
    return ok({ dispatched: false, reason: decision.reason, policy: '规则引擎拒绝；不会由模型改写。' });
  }
  const text = (PROACTIVE_TEMPLATES[event.type] || '').replaceAll('{title}', event.title);
  const message = {
    message_id: store.next('pmsg'), account_id: account.account_id, character_id: event.character_id,
    event_id: event.event_id, kind: decision.kind, template_slot: decision.template_slot,
    text, sent_at: new Date().toISOString()
  };
  store.proactiveMessages.set(message.message_id, message);
  return created({ dispatched: true, message: publicProactiveMessage(message), note: '开发切片使用固定模板措辞；生产由模型在模板槽内生成。' });
}

function listProactiveEvents(store, account) {
  const events = [...store.proactiveEvents.values()]
    .filter((item) => item.account_id === account.account_id && item.state === 'ACTIVE')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(publicProactiveEvent);
  return ok({ events });
}

function listProactiveMessages(store, account) {
  const messages = [...store.proactiveMessages.values()]
    .filter((item) => item.account_id === account.account_id)
    .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
    .map(publicProactiveMessage);
  return ok({ messages });
}

function ownProactiveEvent(store, accountId, id) {
  const event = store.proactiveEvents.get(id);
  if (!event || event.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '主动事件不存在');
  return event;
}

function publicProactiveEvent(event) {
  return { event_id: event.event_id, type: event.type, title: event.title, due_at: event.due_at, time_of_day_local: event.time_of_day_local, state: event.state, created_at: event.created_at };
}

function publicProactiveMessage(message) {
  return { message_id: message.message_id, kind: message.kind, template_slot: message.template_slot, text: message.text, sent_at: message.sent_at };
}

function optionalTimestamp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw apiError(400, 'VALIDATION_ERROR', 'due_at 必须是有效时间');
  return value;
}

function optionalHour(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 23) throw apiError(400, 'VALIDATION_ERROR', 'time_of_day_local 必须为 0-23');
  return value;
}

// ---- 账户注销：二次确认后立即停止互动与召回；生产清理按删除任务编排。----
function requestAccountDeletion(store, account, body) {
  if (body?.confirm_text !== '注销') throw apiError(400, 'VALIDATION_ERROR', '请输入“注销”以二次确认');
  if (account.account_status === 'CLOSED') throw apiError(409, 'STATE_TRANSITION_INVALID', '账户已注销');
  account.account_status = 'CLOSING';
  account.revocation_epoch += 1;
  const deletedAt = new Date().toISOString();
  for (const conversation of store.conversations.values()) {
    if (conversation.account_id !== account.account_id || conversation.status === 'DELETED') continue;
    conversation.status = 'DELETED';
    conversation.deleted_at = deletedAt;
    const messageIds = [...store.messages.values()].filter((message) => message.conversation_id === conversation.conversation_id).map((message) => message.message_id);
    for (const summary of invalidateSummaries([...store.conversationSummaries.values()], [...store.messages.values()], conversation.conversation_id, messageIds, deletedAt)) store.conversationSummaries.set(summary.summary_id, summary);
    cancelConversationSummaryJobs(store, conversation.conversation_id, deletedAt);
  }
  const deletionJob = {
    deletion_job_id: store.next('del'), account_id: account.account_id, asset_id: null, scope: 'ACCOUNT',
    state: 'ONLINE_DISABLED', revocation_epoch: account.revocation_epoch, physical_cleanup_state: 'PENDING_CLEANUP_WORKER',
    created_at: new Date().toISOString(),
    note: '注销已确认：互动与召回立即停止。删除账本已登记，生产清理由后台 Worker 在 24 小时内完成、备份最长 30 天；法定留存进入隔离库。'
  };
  store.deletionJobs.set(deletionJob.deletion_job_id, deletionJob);
  // P0 删除编排：登记逐数据域删除账本；回执经 GET /deletion-jobs/:id 可见。
  registerAccountDeletionTargets(store, account, deletionJob, deletionJob.created_at);
  return accepted({ account: { account_id: account.account_id, account_status: account.account_status }, deletion_job: deletionJob, deletion_receipt: deletionReceipt(store, deletionJob) });
}

function authorize(account, action, store) {
  const notice = store.noticeFor(account.account_id);
  const decision = evaluateAccess(account, action, { noticeDisplayed: Boolean(notice.displayed_at) });
  if (!decision.allowed) throw apiError(decision.status, decision.code, decision.message);
}

function ownCharacter(store, accountId, id) { const item = store.characters.get(id); if (!item || item.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '角色不存在'); return item; }
function ownConversation(store, accountId, id) { const item = store.conversations.get(id); if (!item || item.account_id !== accountId || item.status === 'DELETED') throw apiError(404, 'RESOURCE_NOT_FOUND', '会话不存在'); return item; }
function requireOpenConversation(conversation) { if (conversation.status === 'USER_PAUSED') throw apiError(409, 'CONVERSATION_PAUSED', '会话已暂停，请恢复后继续互动'); if (conversation.status !== 'OPEN') throw apiError(409, 'STATE_TRANSITION_INVALID', '会话当前不可互动'); }
function ownMessage(store, accountId, id) { const item = store.messages.get(id); const conversation = item && store.conversations.get(item.conversation_id); if (!item || !conversation || conversation.account_id !== accountId || conversation.status === 'DELETED') throw apiError(404, 'RESOURCE_NOT_FOUND', '消息不存在'); return item; }
function ownAssistantMessage(store, accountId, id) { const item = store.messages.get(id); const conversation = item && store.conversations.get(item.conversation_id); if (!item || item.actor !== 'ASSISTANT' || !item.ai_generated || !conversation || conversation.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '可合成的助手消息不存在'); return item; }
function ownMediaAsset(store, accountId, id) { const item = store.mediaAssets.get(id); if (!item || item.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '媒体资源不存在'); return item; }
function ownImageJob(store, accountId, id) { const item = store.mediaJobs.get(id); if (!item || item.account_id !== accountId || item.type !== 'IMAGE_GENERATION') throw apiError(404, 'RESOURCE_NOT_FOUND', '图片任务不存在'); return item; }
function ownCandidate(store, accountId, id) { const item = store.candidates.get(id); if (!item || item.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '候选记忆不存在'); return item; }
function ownAsset(store, accountId, id) { const item = store.assets.get(id); if (!item || item.account_id !== accountId) throw apiError(404, 'RESOURCE_NOT_FOUND', '关系资产不存在'); return item; }
function ownCandidates(store, accountId) { return [...store.candidates.values()].filter((item) => item.account_id === accountId && item.state === 'CANDIDATE' && new Date(item.expires_at).getTime() > Date.now()); }
function activeAssets(store, accountId) { return [...store.assets.values()].filter((item) => item.account_id === accountId && item.state === 'ACTIVE'); }
async function accountIdForRequest(req, store, trialAuth = null, { allowDevelopmentTokens = true } = {}) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const developmentId = TOKENS.get(token);
  if (allowDevelopmentTokens && developmentId) return typeof store.resolveAccountId === 'function' ? store.resolveAccountId(developmentId) : developmentId;
  if (trialAuth && typeof trialAuth.resolveAccessToken === 'function') {
    const trialAccountId = await trialAuth.resolveAccessToken(token);
    if (trialAccountId) return trialAccountId;
  }
  // 注册鉴权骨架签发的动态 Access Token（仅内存 store 支持）。
  if (authServiceFor(store)) return authServiceFor(store).resolveAccessToken(token);
  return null;
}

function trialAuthFor(store, injectedTrialAuth = null) {
  if (injectedTrialAuth) return injectedTrialAuth;
  if (store.__trialInviteAuth) return store.__trialInviteAuth;
  if (typeof store.createTrialSession === 'function' && typeof store.resolveTrialAccessToken === 'function') {
    store.__trialInviteAuth = {
      createSession: (input) => store.createTrialSession(input),
      resolveAccessToken: (token) => store.resolveTrialAccessToken(token),
      refreshSession: (input) => store.refreshTrialSession(input)
    };
    return store.__trialInviteAuth;
  }
  store.__trialInviteAuth = new MemoryTrialInviteAuth({ store });
  return store.__trialInviteAuth;
}

function authServiceFor(store) {
  if (store.__authService) return store.__authService;
  if (typeof store.resolveAccountId === 'function') return null; // Postgres 请求作用域 store 不支持进程内 Token。
  store.__authService = new AuthService({ store });
  return store.__authService;
}

function createSmsChallenge(store, body) {
  const service = authServiceFor(store);
  if (!service) throw apiError(503, 'AUTH_NOT_AVAILABLE', '该运行时未启用注册鉴权');
  try {
    return ok(service.createSmsChallenge({ phone: body?.phone }));
  } catch (error) { throw authApiError(error); }
}

function registerAccount(store, body) {
  const service = authServiceFor(store);
  if (!service) throw apiError(503, 'AUTH_NOT_AVAILABLE', '该运行时未启用注册鉴权');
  try {
    const { account, tokens } = service.register({
      phone: body?.phone, code: body?.code, dateOfBirth: body?.date_of_birth, confirmed18Plus: body?.confirmed_18_plus
    });
    return created({ account: { account_id: account.account_id, age_status: account.age_status }, tokens, note: '注册创建 AGE_UNVERIFIED 账户；完成必要告知与年龄声明后才能进入伴侣互动。' });
  } catch (error) { throw authApiError(error); }
}

function refreshTokens(store, body) {
  const service = authServiceFor(store);
  if (!service) throw apiError(503, 'AUTH_NOT_AVAILABLE', '该运行时未启用注册鉴权');
  try {
    return ok({ tokens: service.refresh({ refreshToken: body?.refresh_token }) });
  } catch (error) { throw authApiError(error); }
}

async function createTrialSession(trialAuth, body) {
  try {
    const result = await trialAuth.createSession({ inviteCode: body?.invite_code, initialSecret: body?.initial_secret });
    return created({ account: { account_id: result.account_id, age_status: 'AGE_UNVERIFIED' }, tokens: result.tokens,
      authentication: 'closed-trial-invite', note: '封闭试用账户已建立。完成 AI 告知和年龄声明后才能进入互动。' });
  } catch (error) { throw trialAuthApiError(error); }
}

async function refreshTrialSession(trialAuth, body) {
  try {
    const result = await trialAuth.refreshSession({ refreshToken: body?.refresh_token });
    return ok({ account: { account_id: result.account_id }, tokens: result.tokens, authentication: 'closed-trial-invite' });
  } catch (error) { throw trialAuthApiError(error); }
}

function trialAuthApiError(error) {
  if (error instanceof TrialAuthError) return apiError(error.code === 'TRIAL_SESSION_INVALID' ? 401 : 401, error.code, error.message);
  return apiError(503, 'TRIAL_AUTH_UNAVAILABLE', '试用登录暂不可用，请稍后重试');
}

function authApiError(error) {
  const status = error.code === 'VALIDATION_ERROR' || error.code === 'SMS_CODE_INVALID' || error.code === 'SMS_CHALLENGE_NOT_FOUND' ? 400
    : error.code === 'PHONE_ALREADY_REGISTERED' ? 409
    : error.code === 'REGISTRATION_RATE_LIMITED' ? 429
    : error.code === 'REFRESH_TOKEN_INVALID' ? 401
    : 502;
  return apiError(status, error.code || 'AUTH_ERROR', error.message);
}
function requireAccount(req, store, authenticatedAccountId = null) { const account = authenticatedAccountId && store.account(authenticatedAccountId); if (!account) throw apiError(401, 'AUTH_REQUIRED', '需要有效的试用会话或开发 Bearer token'); return account; }
function ageStatus(account) { return { status: account.age_status, reason_codes: account.age_reason_codes || [], allowed_actions: account.age_status === 'AGE_PASS' ? ['COMPANION_INTERACTION', 'DATA_RIGHTS'] : ['VIEW_NOTICE', 'DECLARE_AGE', 'APPEAL_AGE', 'DATA_RIGHTS'], policy: 'deterministic-development-only', enhanced_verification: account.age_status === 'AGE_REVIEW' ? { state: 'REQUIRED', provider: null, assertion: null } : { state: 'NOT_REQUIRED' } }; }
function publicAccount(account) { return { account_id: account.account_id, account_status: account.account_status, age_status: account.age_status, revocation_epoch: account.revocation_epoch, authentication: 'synthetic-development-token-only' }; }
// 供应商调用埋点与图片任务状态机已抽至领域模块，与独立 Worker 进程共用：
// ./domain/operation-metrics.js、./domain/image-job-advance.js。
function ownOperationMetrics(store, accountId) { return [...(store.operationMetrics?.values() || [])].filter((item) => item.account_id === accountId).map(({ metric_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome, created_at }) => ({ metric_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome, created_at })); }
function ownTrialFeedback(store, accountId) { return [...(store.trialFeedback?.values() || [])].filter((item) => item.account_id === accountId).map(publicTrialFeedback); }
function publicTrialFeedback(feedback) { return { feedback_id: feedback.feedback_id, category: feedback.category, rating: feedback.rating, note: feedback.note, created_at: feedback.created_at }; }
function publicNotice(notice) { return { ...notice }; }
function publicTtsJob(job) { return { job_id: job.job_id, type: job.type, state: job.state, attempts: job.attempts, source_message_id: job.source_message_id, voice: { voice_id: job.voice_id || null, voice_version: job.voice_version || null, authorization_record_id: job.authorization_record_id || null, rights_review_id: job.rights_review_id || null, rights_review_state: job.rights_review_state || null }, world_state_id: job.world_state_id || null, world_state_version: job.world_state_version || null, result_asset_id: job.result_asset_id, failure_code: job.failure_code, created_at: job.created_at }; }
function publicAsrJob(job) { return { job_id: job.job_id, type: job.type, state: job.state, attempts: job.attempts, input_asset_id: job.input_asset_id, transcript: job.transcript_text ? { text: job.transcript_text, state: job.transcript_state, version: 1 } : null, failure_code: job.failure_code, created_at: job.created_at }; }
function publicImageJob(job) { return { job_id: job.job_id, type: job.type, state: job.state, attempts: job.attempts, reference_asset_id: job.reference_asset_id, world_state_id: job.world_state_id || null, world_state_version: job.world_state_version || null, result_asset_id: job.result_asset_id, failure_code: job.failure_code, created_at: job.created_at }; }
function resolvedTtsVoiceProfile(ttsGenerator) {
  // Direct function injection is only used by the local synthetic test harness.
  // Runtime-created Tencent adapters must supply an operator-recorded profile.
  const profile = ttsGenerator.voiceProfile || {
    voice_id: 'development-synthetic-voice', voice_version: 'development-v1',
    authorization_record_id: 'development-synthetic-authorization', rights_review_id: 'development-synthetic-rights-review',
    rights_review_state: 'APPROVED'
  };
  if (!['voice_id', 'voice_version', 'authorization_record_id', 'rights_review_id'].every((key) => typeof profile[key] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(profile[key]))) {
    throw apiError(503, 'TTS_VOICE_PROVENANCE_INVALID', 'TTS 音色授权溯源配置无效');
  }
  if (profile.rights_review_state !== 'APPROVED') throw apiError(503, 'TTS_VOICE_RIGHTS_NOT_APPROVED', 'TTS 音色权利审核尚未通过');
  return profile;
}
function safeProviderErrorCode(error) {
  const value = error?.details?.upstream_error_code;
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}
function dailyUsageApiError(error) {
  if (!(error instanceof DailyChatUsageError)) return error;
  if (error.code === 'DAILY_CHAT_LIMIT_REACHED' || error.code === 'TOKEN_LIMIT_REACHED') {
    return apiError(429, error.code, error.message, error.details);
  }
  return apiError(502, error.code, '普通对话用量结算失败，请稍后重试');
}
function publicModeration(moderation) { return { decision: moderation.decision, provider_request_id: moderation.providerRequestId, policy_version: moderation.policyVersion }; }
function publicMediaAsset(asset) { return { asset_id: asset.asset_id, type: asset.type, state: asset.state, confirmation_state: asset.confirmation_state || null, rights_review_id: asset.rights_review_id || null, media_type: asset.media_type, mime_type: asset.mime_type, byte_length: asset.byte_length, checksum: asset.checksum, ai_generated: asset.ai_generated, aigc_mark_version: asset.aigc_mark_version, created_at: asset.created_at }; }
function publicReferenceImage(store, asset) {
  const review = asset.rights_review_id ? store.contentRightsReviews.get(asset.rights_review_id) : null;
  return { ...publicMediaAsset(asset), content_rights_review: review ? publicContentRightsReview(review) : null };
}
function requiredText(value, field) { if (typeof value !== 'string' || !value.trim()) throw apiError(400, 'VALIDATION_ERROR', `${field} 必填`); return value.trim(); }
function requiredAsrMimeType(value) { if (typeof value !== 'string' || !VOICE_FORMATS[value]) throw apiError(400, 'VALIDATION_ERROR', 'mime_type 不支持'); return value; }
function requiredImageMimeType(value) { if (!['image/jpeg', 'image/png', 'image/webp'].includes(value)) throw apiError(400, 'VALIDATION_ERROR', '图片 mime_type 不支持'); return value; }
function decodeAsrAudio(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_ASR_AUDIO_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw apiError(400, 'VALIDATION_ERROR', 'audio_base64 无效或超过开发限制');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ASR_AUDIO_BYTES || bytes.toString('base64') !== value) throw apiError(400, 'VALIDATION_ERROR', 'audio_base64 无效或超过开发限制');
  return bytes;
}
function decodeImage(value) {
  const maxImageBytes = 2 * 1024 * 1024;
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maxImageBytes * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw apiError(400, 'VALIDATION_ERROR', 'image_base64 无效或超过开发限制');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > maxImageBytes || bytes.toString('base64') !== value) throw apiError(400, 'VALIDATION_ERROR', 'image_base64 无效或超过开发限制');
  return bytes;
}
function requireImagePipeline(imageModerator, imageStore) {
  if (typeof imageModerator !== 'function' || !imageStore || typeof imageStore.putImage !== 'function' || typeof imageStore.createModerationUrl !== 'function' || typeof imageStore.deleteAsset !== 'function') {
    throw apiError(503, 'IMAGE_GENERATION_NOT_ENABLED', '本地开发未显式启用图片链路');
  }
}
async function safeDeleteImage(imageStore, objectKey) { try { await imageStore.deleteAsset(objectKey); } catch {} }
function ageOn(dob) { const now = new Date(); let age = now.getUTCFullYear() - dob.getUTCFullYear(); const month = now.getUTCMonth() - dob.getUTCMonth(); if (month < 0 || (month === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1; return age; }
function plusDays(days) { return new Date(Date.now() + days * 86400000).toISOString(); }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validRequestId(value) { return typeof value === 'string' && value.length <= 128 ? value : null; }
function ok(body) { return { status: 200, body }; }
function created(body) { return { status: 201, body }; }
function accepted(body) { return { status: 202, body }; }
function apiError(status, code, message, details) { const error = new Error(message); Object.assign(error, { status, code, expose: true, details }); return error; }

async function idempotent(context, account, operation) {
  const key = context.req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') throw apiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '写操作需要 Idempotency-Key');
  const storageKey = context.store.idempotencyKey(account.account_id, context.req.method, context.url.pathname, key);
  const bodyHash = stableHash(context.body);
  const previous = context.store.idempotency.get(storageKey);
  if (previous) {
    if (previous.bodyHash !== bodyHash) throw apiError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能使用不同请求体');
    return previous.result;
  }
  const result = await operation();
  context.store.idempotency.set(storageKey, { bodyHash, result });
  return result;
}

function stableHash(value) { return createHash('sha256').update(JSON.stringify(sortValue(value))).digest('hex'); }
function sortValue(value) { if (Array.isArray(value)) return value.map(sortValue); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])])); return value; }
function readJson(req) { return new Promise((resolve, reject) => { if (['GET', 'DELETE'].includes(req.method)) return resolve({}); let data = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { data += chunk; if (data.length > 3 * 1024 * 1024) reject(apiError(413, 'PAYLOAD_TOO_LARGE', '开发 API 请求过大')); }); req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(apiError(400, 'INVALID_JSON', '请求体必须是 JSON')); } }); req.on('error', reject); }); }
function send(res, status, body, requestId, contentType) { res.writeHead(status, { 'content-type': contentType || 'application/json; charset=utf-8', 'x-request-id': requestId, 'cache-control': 'no-store' }); res.end(contentType ? String(body) : JSON.stringify(body)); }
function sendBinary(res, result, requestId) {
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.binary.length,
    'content-disposition': `inline; filename="${result.filename}"`,
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
    'cache-control': 'private, no-store'
  });
  res.end(result.binary);
}

async function sendStatic(res, staticFile, requestId) {
  try {
    const file = await readFile(staticFile.file);
    res.writeHead(200, {
      'content-type': staticFile.type,
      'x-request-id': requestId,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // blob: 仅用于经 /api/v1/media-assets 鉴权代理取得的私有图片/音频对象 URL；
      // 供应商与对象存储地址仍然被排除，浏览器不得直连。
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(file);
  } catch {
    send(res, 404, { error: { code: 'STATIC_ASSET_NOT_FOUND', message: '本地开发静态资源不存在', request_id: requestId, retryable: false, details: {} } }, requestId);
  }
}

module.exports = { createApp, TOKENS, rankAssetsForContext };
