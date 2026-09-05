'use strict';

const { applyRawInteractionRetention } = require('./retention');

// 保留期主动清理 Worker（技术设计 13.2/13.3 的进程内开发实现）：
// 1) 逐账户应用 30/90 天原始消息保留策略（与请求路径惰性清理同一逻辑）；
// 2) 超过 24 小时仍可用的 ASR 原始音频立即下线（PRD 3.5 上传后最迟 24 小时删除）。
// 生产部署必须换成带重试队列、删除账本与人工告警的隔离 Worker。
const ASR_INPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function runRetentionSweep(store, now = new Date()) {
  const accountResults = [];
  for (const account of store.accounts.values()) {
    const result = applyRawInteractionRetention(store, account, now);
    if (result.expired_message_count > 0) accountResults.push({ account_id: account.account_id, ...result });
  }
  const expiredAudio = [];
  for (const asset of store.mediaAssets.values()) {
    if (asset.type !== 'ASR_INPUT_AUDIO' || asset.state !== 'AVAILABLE') continue;
    if (now.getTime() - new Date(asset.created_at).getTime() <= ASR_INPUT_MAX_AGE_MS) continue;
    asset.state = 'DELETED';
    asset.deleted_at = now.toISOString();
    expiredAudio.push(asset.asset_id);
  }
  return { accounts: accountResults, expired_asr_input_assets: expiredAudio, swept_at: now.toISOString() };
}

function startRetentionWorker(store, { intervalMs = 60_000, sweep = runRetentionSweep } = {}) {
  const timer = setInterval(() => {
    try { sweep(store); } catch { /* 本地开发 Worker 失败不中断服务；生产必须告警。 */ }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = { ASR_INPUT_MAX_AGE_MS, runRetentionSweep, startRetentionWorker };
