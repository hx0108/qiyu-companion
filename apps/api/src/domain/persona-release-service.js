'use strict';

// 人格发布有两条确定性路径（2026-09-12 起）：
// 1) 运营管道（面向全部用户的发布）：DRAFT→EVALUATING→SHADOW→CANARY→STABLE，
//    模型、前端和普通用户都不能把草稿直接推成稳定版本；
// 2) 用户自助编辑（封测口径，产品决定）：本人保存自己角色的人格 → 立即生效，
//    只影响自己的角色；历史版本仍全量保留（旧 STABLE 转 RETIRED），运营回滚管道照常可用。
// 此服务只管理状态及其可验证前置条件；授权、存储和流量路由由调用方负责。
const PERSONA_VERSION_STATES = Object.freeze(['DRAFT', 'EVALUATING', 'SHADOW', 'CANARY', 'STABLE', 'REJECTED', 'ROLLED_BACK', 'RETIRED']);
const MAX_CANARY_TRAFFIC_PERCENT = 10;

function createDraft({ version, persona, changedFields, note, parentVersion, now = new Date().toISOString() }) {
  return Object.freeze({
    version, persona, changed_fields: [...changedFields], note, parent_version: parentVersion,
    state: 'DRAFT', evaluation: null, created_at: now, updated_at: now
  });
}

function promoteSelfEditStable(version, { accountId, now = new Date().toISOString() }) {
  requireState(version, 'DRAFT');
  requireText(accountId, 'accountId');
  return { ...version, state: 'STABLE', stable: { reviewer_id: `account:${accountId}`, canary_report_ref: 'self-edit-immediate', promoted_at: now }, updated_at: now };
}

function recordEvaluation(version, { suiteVersion, criticalPassRate, overallPassRate, reportRef, reviewerId, now = new Date().toISOString() }) {
  requireState(version, 'DRAFT');
  requireText(suiteVersion, 'suiteVersion');
  requireText(reportRef, 'reportRef');
  requireText(reviewerId, 'reviewerId');
  const critical = ratio(criticalPassRate, 'criticalPassRate');
  const overall = ratio(overallPassRate, 'overallPassRate');
  const passed = critical === 1 && overall >= 0.9;
  return { ...version, state: passed ? 'EVALUATING' : 'REJECTED', evaluation: { suite_version: suiteVersion, critical_pass_rate: critical, overall_pass_rate: overall, report_ref: reportRef, reviewer_id: reviewerId, result: passed ? 'PASSED' : 'FAILED', evaluated_at: now }, updated_at: now };
}

function startShadow(version, { reviewerId, now = new Date().toISOString() }) {
  requireState(version, 'EVALUATING');
  if (version.evaluation?.result !== 'PASSED') throw stateError('PERSONA_EVALUATION_REQUIRED', '人格版本尚未通过固定回归评测');
  requireText(reviewerId, 'reviewerId');
  return { ...version, state: 'SHADOW', updated_at: now };
}

function promoteCanary(version, { trafficPercent, reviewerId, shadowReportRef, now = new Date().toISOString() }) {
  requireState(version, 'SHADOW');
  const traffic = canaryTraffic(trafficPercent);
  requireText(reviewerId, 'reviewerId');
  requireText(shadowReportRef, 'shadowReportRef');
  return { ...version, state: 'CANARY', canary: { traffic_percent: traffic, reviewer_id: reviewerId, shadow_report_ref: shadowReportRef, started_at: now }, updated_at: now };
}

function promoteStable(version, { reviewerId, canaryReportRef, now = new Date().toISOString() }) {
  requireState(version, 'CANARY');
  requireText(reviewerId, 'reviewerId');
  requireText(canaryReportRef, 'canaryReportRef');
  return { ...version, state: 'STABLE', stable: { reviewer_id: reviewerId, canary_report_ref: canaryReportRef, promoted_at: now }, updated_at: now };
}

function rollback(current, rollbackTarget, { reviewerId, reason, now = new Date().toISOString() }) {
  if (!['CANARY', 'STABLE'].includes(current.state)) throw stateError('PERSONA_ROLLBACK_NOT_ALLOWED', '只有灰度或稳定人格可以回退');
  requireState(rollbackTarget, 'RETIRED');
  requireText(reviewerId, 'reviewerId');
  requireText(reason, 'reason');
  return {
    current: { ...current, state: 'ROLLED_BACK', rollback: { to_version: rollbackTarget.version, reviewer_id: reviewerId, reason, rolled_back_at: now }, updated_at: now },
    target: { ...rollbackTarget, state: 'STABLE', stable: { reviewer_id: reviewerId, canary_report_ref: 'rollback-existing-stable', promoted_at: now }, updated_at: now }
  };
}

function retireStable(version, now = new Date().toISOString()) {
  requireState(version, 'STABLE');
  return { ...version, state: 'RETIRED', updated_at: now };
}

function canaryTraffic(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_CANARY_TRAFFIC_PERCENT) throw stateError('PERSONA_CANARY_TRAFFIC_INVALID', `灰度流量必须是 1-${MAX_CANARY_TRAFFIC_PERCENT} 的整数`);
  return number;
}
function ratio(value, name) { const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) throw stateError('PERSONA_EVALUATION_INVALID', `${name} 必须是 0-1 之间的数值`); return number; }
function requireState(version, expected) { if (!version || version.state !== expected) throw stateError('PERSONA_STATE_TRANSITION_INVALID', `人格版本当前不是 ${expected} 状态`); }
function requireText(value, name) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) throw stateError('PERSONA_RELEASE_EVIDENCE_REQUIRED', `${name} 必须是 1-256 位的审计标识`); }
function stateError(code, message) { const error = new Error(message); error.code = code; return error; }

module.exports = { MAX_CANARY_TRAFFIC_PERCENT, PERSONA_VERSION_STATES, canaryTraffic, createDraft, promoteCanary, promoteSelfEditStable, promoteStable, recordEvaluation, retireStable, rollback, stateError, startShadow };
