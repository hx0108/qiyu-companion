'use strict';

// 供应商调用埋点（PRD 6.6 成本埋点）：HTTP 路由与独立 Worker 进程共用同一份
// 实现，保证请求路径与后台任务化路径产出的指标形状一致（可观测性依赖它）。

function recordOperationMetric(store, { accountId, capability = 'CHAT_GENERATION', provider, modelVersion, inputTokens, outputTokens, latencyMs, outcome }) {
  if (!store.operationMetrics) return;
  const metric = { metric_id: store.next('met'), account_id: accountId, capability, provider: provider || 'unknown', model_version: modelVersion || null, input_tokens: Math.max(0, Number(inputTokens) || 0), output_tokens: Math.max(0, Number(outputTokens) || 0), latency_ms: Math.max(0, Number(latencyMs) || 0), outcome, created_at: new Date().toISOString() };
  store.operationMetrics.set(metric.metric_id, metric);
}

function providerName(provider, fallback) { return typeof provider?.provider === 'string' ? provider.provider : fallback || 'development-synthetic'; }
function providerModelVersion(provider, fallback = 'development-synthetic-v1') { return typeof provider?.modelVersion === 'string' ? provider.modelVersion : fallback; }

async function moderateTextWithMetric(store, account, textModerator, { text, conversationId, direction }) {
  const startedAt = Date.now();
  try {
    const moderation = await textModerator({ text, accountId: account.account_id, conversationId, direction });
    const outcome = moderation && moderation.decision === 'PASS' ? 'COMPLETED'
      : moderation && ['REVIEW', 'BLOCK'].includes(moderation.decision) ? 'BLOCKED' : 'FAILED';
    recordOperationMetric(store, { accountId: account.account_id, capability: 'TEXT_MODERATION', provider: providerName(textModerator, 'content-moderation'), modelVersion: moderation?.policyVersion || providerModelVersion(textModerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, outcome });
    return moderation;
  } catch (error) {
    recordOperationMetric(store, { accountId: account.account_id, capability: 'TEXT_MODERATION', provider: providerName(textModerator, 'content-moderation'), modelVersion: providerModelVersion(textModerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, outcome: 'FAILED' });
    throw error;
  }
}

async function moderateImageWithMetric(store, account, imageModerator, { fileUrl, dataId }) {
  const startedAt = Date.now();
  try {
    const moderation = await imageModerator({ fileUrl, dataId });
    const outcome = moderation && moderation.decision === 'PASS' ? 'COMPLETED'
      : moderation && ['REVIEW', 'BLOCK'].includes(moderation.decision) ? 'BLOCKED' : 'FAILED';
    recordOperationMetric(store, { accountId: account.account_id, capability: 'IMAGE_MODERATION', provider: providerName(imageModerator, 'image-moderation'), modelVersion: moderation?.policyVersion || providerModelVersion(imageModerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, outcome });
    return moderation;
  } catch (error) {
    recordOperationMetric(store, { accountId: account.account_id, capability: 'IMAGE_MODERATION', provider: providerName(imageModerator, 'image-moderation'), modelVersion: providerModelVersion(imageModerator), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, outcome: 'FAILED' });
    throw error;
  }
}

module.exports = { recordOperationMetric, providerName, providerModelVersion, moderateTextWithMetric, moderateImageWithMetric };
