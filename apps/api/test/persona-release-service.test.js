'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const release = require('../src/domain/persona-release-service');

const persona = Object.freeze({ personality: '安静可靠' });
const at = '2026-09-05T00:00:00.000Z';
function draft(version = 2) { return release.createDraft({ version, persona, changedFields: ['personality'], note: '调整表达', parentVersion: 1, now: at }); }
function evaluation(version) { return release.recordEvaluation(version, { suiteVersion: 'persona-golden-v1', criticalPassRate: 1, overallPassRate: 0.9, reportRef: 'eval_20260905_001', reviewerId: 'rev_1', now: at }); }

test('人格版本必须通过固定回归、影子证据和受限灰度，才能稳定发布', () => {
  const evaluated = evaluation(draft());
  assert.equal(evaluated.state, 'EVALUATING');
  const shadow = release.startShadow(evaluated, { reviewerId: 'rev_1', now: at });
  const canary = release.promoteCanary(shadow, { trafficPercent: 10, reviewerId: 'rev_1', shadowReportRef: 'shadow_20260905_001', now: at });
  assert.equal(canary.state, 'CANARY');
  assert.equal(canary.canary.traffic_percent, 10);
  const stable = release.promoteStable(canary, { reviewerId: 'rev_2', canaryReportRef: 'canary_20260905_001', now: at });
  assert.equal(stable.state, 'STABLE');
  assert.equal(stable.stable.reviewer_id, 'rev_2');
});

test('人格发布拒绝未通过关键评测、跳过影子或越过灰度流量上限', () => {
  const rejected = release.recordEvaluation(draft(), { suiteVersion: 'persona-golden-v1', criticalPassRate: 0.99, overallPassRate: 1, reportRef: 'eval_bad', reviewerId: 'rev_1', now: at });
  assert.equal(rejected.state, 'REJECTED');
  assert.throws(() => release.startShadow(rejected, { reviewerId: 'rev_1', now: at }), { code: 'PERSONA_STATE_TRANSITION_INVALID' });
  assert.throws(() => release.promoteCanary(evaluation(draft()), { trafficPercent: 1, reviewerId: 'rev_1', shadowReportRef: 'shadow_1', now: at }), { code: 'PERSONA_STATE_TRANSITION_INVALID' });
  assert.throws(() => release.promoteCanary(release.startShadow(evaluation(draft()), { reviewerId: 'rev_1', now: at }), { trafficPercent: 11, reviewerId: 'rev_1', shadowReportRef: 'shadow_1', now: at }), { code: 'PERSONA_CANARY_TRAFFIC_INVALID' });
});

test('稳定人格回退必须指向已退役的上一稳定版本，并留下责任人与原因', () => {
  const current = release.promoteStable(release.promoteCanary(release.startShadow(evaluation(draft(2)), { reviewerId: 'rev_1', now: at }), { trafficPercent: 5, reviewerId: 'rev_1', shadowReportRef: 'shadow_2', now: at }), { reviewerId: 'rev_2', canaryReportRef: 'canary_2', now: at });
  const previous = release.retireStable({ version: 1, persona, state: 'STABLE', created_at: at, updated_at: at }, at);
  const result = release.rollback(current, previous, { reviewerId: 'rev_emergency', reason: 'OOC 回归失败', now: at });
  assert.equal(result.current.state, 'ROLLED_BACK');
  assert.equal(result.current.rollback.to_version, 1);
  assert.equal(result.target.state, 'STABLE');
  assert.throws(() => release.rollback(result.current, result.target, { reviewerId: 'rev_emergency', reason: '重复回退', now: at }), { code: 'PERSONA_ROLLBACK_NOT_ALLOWED' });
});
