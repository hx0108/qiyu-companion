'use strict';
// 六项能力 A4 抑制原因指标（P4.5）：内存 Worker 三抑制点（DEFER/CANCEL/
// EXPIRE/抢槽失败）递增计数器；/internal/metrics 渲染
// qiyu_followup_suppressed_total{action,reason}。PG 路的 upsert 断言在
// pg-followup-dispatch 套件（同事务原子累加）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { bumpFollowupSuppression } = require('../src/domain/followup-service');
const { runNextFollowupJob } = require('../src/domain/followup-worker');
const { internalMetricsText } = require('../src/app');

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';
const NOW = new Date('2026-10-05T06:00:00.000Z');

function counter(store, action, reason) { return store.followupSuppressionCounters.get(`${action}|${reason}`) ?? 0; }

function seededStore(overrides = {}) {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  const event = { event_id: 'levt_1', account_id: ACCOUNT, character_id: CHARACTER, version: 1, timezone: 'Asia/Shanghai', clarification_required: false, status: 'PLANNED', scheduled_at: '2026-10-05T06:30:00.000Z', title: '周五面试', deleted_at: null, ...overrides.event };
  store.lifeEvents.set(event.event_id, event);
  const account = store.account(ACCOUNT);
  account.required_notice = { ...account.required_notice, state: 'DISPLAYED', displayed_at: NOW.toISOString() };
  Object.assign(account, { proactive_preferences: { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 }, ...overrides.account });
  const grant = { grant_id: 'fgr_1', account_id: ACCOUNT, character_id: CHARACTER, event_id: event.event_id, event_version: 1, followup_kind: 'BEFORE_EVENT', channel: 'IN_APP', allowed_from: NOW.toISOString(), expires_at: '2026-10-06T06:30:00.000Z', version: 1, state: 'ACTIVE', consented_at: NOW.toISOString(), revoked_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() };
  const job = { job_id: 'fjob_1', account_id: ACCOUNT, character_id: CHARACTER, event_id: event.event_id, event_version: 1, grant_id: grant.grant_id, followup_kind: 'BEFORE_EVENT', due_at: '2026-10-05T06:00:00.000Z', expires_at: '2026-10-06T06:30:00.000Z', local_date: '2026-10-05', state: 'PENDING', lease_owner: null, lease_expires_at: null, attempts: 0, next_attempt_at: NOW.toISOString(), last_error: null, created_at: NOW.toISOString(), published_at: null, ...overrides.job };
  store.followupGrants.set(grant.grant_id, grant);
  store.followupJobs.set(job.job_id, job);
  return { store, event, grant, job };
}

test('抑制计数：bumpFollowupSuppression 逐键累加；重复抑制翻倍', () => {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  bumpFollowupSuppression(store, 'EXPIRE', 'DAILY_LIMIT_REACHED');
  bumpFollowupSuppression(store, 'EXPIRE', 'DAILY_LIMIT_REACHED');
  bumpFollowupSuppression(store, 'DEFER', 'QUIET_HOURS');
  assert.equal(counter(store, 'EXPIRE', 'DAILY_LIMIT_REACHED'), 2);
  assert.equal(counter(store, 'DEFER', 'QUIET_HOURS'), 1);
  assert.equal(store.followupSuppressionCounters.size, 2);
});

test('抑制计数：Worker 路径——版本不符 CANCEL、静默 DEFER、每日一条 EXPIRE 各自计数', async () => {
  // CANCEL/EVENT_VERSION_MISMATCH：任务版本落后事件。
  const cancelled = seededStore({ event: { version: 2 } });
  await runNextFollowupJob({ store: cancelled.store, composer: null, workerId: 't-cancel', now: NOW });
  assert.equal(counter(cancelled.store, 'CANCEL', 'EVENT_VERSION_MISMATCH'), 1, '版本不符抑制计数');

  // DEFER/QUIET_HOURS：到期时刻落在静默窗（偏移 0，本地 23:30 在 23-8 内；
  // 静默结束次日 08:00Z 在允许窗内 → 顺延不耗尽）。
  const deferred = seededStore({
    account: { proactive_preferences: { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 0 } },
    job: { due_at: '2026-10-05T06:00:00.000Z', expires_at: '2026-10-07T12:00:00.000Z' }
  });
  const quietNow = new Date('2026-10-05T23:30:00.000Z');
  const deferOutcome = await runNextFollowupJob({ store: deferred.store, composer: null, workerId: 't-defer', now: quietNow });
  assert.equal(deferOutcome.state, 'DEFERRED');
  assert.equal(counter(deferred.store, 'DEFER', 'QUIET_HOURS'), 1, '静默顺延抑制计数');

  // EXPIRE/DAILY_LIMIT_REACHED：当日槽位已被占。
  const throttled = seededStore();
  const { claimDailySlot } = require('../src/domain/followup-service');
  claimDailySlot(throttled.store, ACCOUNT, '2026-10-05', 'manual');
  const throttleOutcome = await runNextFollowupJob({ store: throttled.store, composer: null, workerId: 't-throttle', now: NOW });
  assert.equal(throttleOutcome.state, 'EXPIRED');
  assert.equal(counter(throttled.store, 'EXPIRE', 'DAILY_LIMIT_REACHED'), 1, '每日一条抑制计数');

  // PUBLISH 不计抑制。
  const published = seededStore();
  const publishOutcome = await runNextFollowupJob({ store: published.store, composer: null, workerId: 't-publish', now: NOW });
  assert.equal(publishOutcome.state, 'PUBLISHED');
  assert.equal(published.store.followupSuppressionCounters.size, 0, '正常发布零抑制计数');
});

test('抑制计数：/internal/metrics 文本渲染 qiyu_followup_suppressed_total', async () => {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  bumpFollowupSuppression(store, 'CANCEL', 'USER_PAUSED');
  bumpFollowupSuppression(store, 'EXPIRE', 'DAILY_LIMIT_REACHED');
  // /internal/* 需评审员会话鉴权；此处直测渲染函数（HTTP 侧由既有 metrics
  // 端点接线覆盖）。
  const response = internalMetricsText(store);
  assert.equal(response.status, 200);
  assert.match(response.contentType, /text\/plain/);
  assert.match(response.body, /# HELP qiyu_followup_suppressed_total/);
  assert.match(response.body, /# TYPE qiyu_followup_suppressed_total counter/);
  assert.match(response.body, /qiyu_followup_suppressed_total\{action="CANCEL",reason="USER_PAUSED"\} 1/);
  assert.match(response.body, /qiyu_followup_suppressed_total\{action="EXPIRE",reason="DAILY_LIMIT_REACHED"\} 1/);
});
