'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { confirmLifeEventFromCandidate } = require('../src/domain/life-event-service');
const { grantFollowup } = require('../src/domain/followup-service');
const { claimDueFollowupJobs, runNextFollowupJob, failFollowupJob, MAX_FOLLOWUP_ATTEMPTS } = require('../src/domain/followup-worker');

// A2 Worker 竞态矩阵（方案验收硬门禁）：双 Worker 恰一胜、租约过期重领
//（进程重启恢复）、静默顺延、改期/撤销竞态零投递、调度偏差 P95。

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';
const DUE = '2026-10-02T06:30:00.000Z';

function seededStore({ scheduledAt = DUE, preferences } = {}) {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  store.conversations.set('cnv_1', { conversation_id: 'cnv_1', account_id: ACCOUNT, character_id: CHARACTER, status: 'OPEN', created_at: '2026-09-01T00:00:00.000Z' });
  const account = store.account(ACCOUNT);
  account.required_notice.state = 'DISPLAYED';
  account.proactive_preferences = preferences ?? { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 };
  const { event } = confirmLifeEventFromCandidate({
    store, account,
    candidate: {
      candidate_id: 'memc_1', account_id: ACCOUNT, character_id: CHARACTER, state: 'CANDIDATE', version: 1, type: 'life_event',
      normalized_value: { life_event: { title: '周五的产品经理面试', domain: 'REAL_LIFE', event_kind: 'INTERVIEW', scheduled_at: scheduledAt, timezone: 'Asia/Shanghai' } },
      display_text: '', provider: 't', expires_at: '2099-01-01', source_message_id: 'msg_1', conflicts_with: []
    }
  });
  const { job } = grantFollowup({
    store, account, event,
    validated: { followup_kind: 'BEFORE_EVENT', due_at: scheduledAt, allowed_from: '2026-09-01T00:00:00.000Z', expires_at: '2026-10-03T06:30:00.000Z' },
    now: new Date('2026-09-01T00:00:00Z')
  });
  return { store, event, job };
}

test('worker：双 Worker 并发恰一胜——慢 composer 下仅一条 PUBLISHED 消息', async () => {
  const { store } = seededStore();
  const slowComposer = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { text: '「周五的产品经理面试」到时间啦，按你练过的来就好。', provider: 'qwen', modelVersion: 'm' }; };
  const now = new Date('2026-10-02T06:31:00.000Z');
  const results = await Promise.all([
    runNextFollowupJob({ store, composer: slowComposer, workerId: 'w1', now }),
    runNextFollowupJob({ store, composer: slowComposer, workerId: 'w2', now })
  ]);
  const published = results.filter((item) => item.state === 'PUBLISHED');
  assert.equal(published.length, 1, `恰一胜（实际：${results.map((item) => item.state).join(',')}）`);
  const followupMessages = [...store.messages.values()].filter((message) => message.provider === 'proactive-followup');
  assert.equal(followupMessages.length, 1, '聊天流只落一条主动消息');
  assert.equal([...store.proactiveMessages.values()].filter((item) => item.kind === 'NORMAL').length, 1, '审计只一条');
});

test('worker：租约过期重领（进程重启恢复）——LEASED 且租约到期的任务被重新领取', async () => {
  const { store, job } = seededStore();
  // 手工置 LEASED 且租约已过期（模拟 Worker 崩溃遗留）
  store.followupJobs.set(job.job_id, { ...job, state: 'LEASED', lease_owner: 'crashed', lease_expires_at: '2026-10-02T06:00:00.000Z', attempts: 1 });
  const claimed = claimDueFollowupJobs(store, new Date('2026-10-02T06:31:00.000Z'), { workerId: 'recovered' });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].lease_owner, 'recovered');
  assert.equal(claimed[0].attempts, 2);
});

test('worker：静默顺延——defer_until=静默结束，顺延不耗 attempts', async () => {
  // 偏移 0（UTC），静默 23-8：06:31Z 在静默中，结束=08:00Z
  const { store } = seededStore({ preferences: { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 0 } });
  const deferred = await runNextFollowupJob({ store, composer: null, workerId: 'w', now: new Date('2026-10-02T06:31:00.000Z') });
  assert.equal(deferred.state, 'DEFERRED');
  assert.equal(deferred.defer_until, '2026-10-02T08:00:00.000Z');
  const job = [...store.followupJobs.values()][0];
  assert.equal(job.state, 'PENDING');
  assert.equal(job.next_attempt_at, '2026-10-02T08:00:00.000Z');
  // 静默结束后再跑 → PUBLISHED
  const published = await runNextFollowupJob({ store, composer: null, workerId: 'w', now: new Date('2026-10-02T08:01:00.000Z') });
  assert.equal(published.state, 'PUBLISHED');
});

test('worker：LEASED 中任务被改期取消 → 发布 CAS 放弃、零投递（删除复活防线）', async () => {
  const { store, event, job } = seededStore();
  // 领取（LEASED）后、发布前，用户改期：旧版本任务被取消
  const leased = claimDueFollowupJobs(store, new Date('2026-10-02T06:31:00.000Z'), { workerId: 'w1' });
  assert.equal(leased.length, 1);
  const { invalidateFollowupsOnRevision } = require('../src/domain/followup-service');
  const revised = { ...event, version: 2, scheduled_at: '2026-10-05T06:30:00.000Z' };
  store.lifeEvents.set(event.event_id, revised);
  invalidateFollowupsOnRevision({ store, event: revised, previousVersion: 1, now: new Date('2026-10-02T06:31:30.000Z') });
  // Worker 迟到的发布：决策层 CANCEL（版本不符/任务已取消 → CAS 输家）
  const outcome = await runNextFollowupJob({ store, composer: null, workerId: 'w1', now: new Date('2026-10-02T06:32:00.000Z') });
  assert.ok(['CANCELLED', 'SUPERSEDED', 'IDLE'].includes(outcome.state), `迟到发布必须放弃（实际 ${outcome.state}）`);
  assert.equal([...store.messages.values()].filter((message) => message.provider === 'proactive-followup').length, 0, '零投递');
});

test('worker：每日槽位占用 → EXPIRED 不补发过时提醒；手动触发共享上限', async () => {
  const { store } = seededStore();
  // 手动触发已占今日槽位（直接置槽模拟 manual 抢占）
  const { claimDailySlot } = require('../src/domain/followup-service');
  claimDailySlot(store, ACCOUNT, '2026-10-02', 'manual');
  const outcome = await runNextFollowupJob({ store, composer: null, workerId: 'w', now: new Date('2026-10-02T06:31:00.000Z') });
  assert.equal(outcome.state, 'EXPIRED');
  assert.equal(outcome.reason, 'DAILY_LIMIT_REACHED');
  assert.equal([...store.messages.values()].filter((message) => message.provider === 'proactive-followup').length, 0);
});

test('worker：账户暂停/未过告知 → 到期零投递 CANCEL', async () => {
  const paused = seededStore();
  paused.store.account(ACCOUNT).user_pause_state = 'PAUSED';
  assert.equal((await runNextFollowupJob({ store: paused.store, composer: null, workerId: 'w', now: new Date('2026-10-02T06:31:00.000Z') })).state, 'CANCELLED');

  const noticeDue = seededStore();
  noticeDue.store.account(ACCOUNT).required_notice.state = 'DUE';
  assert.equal((await runNextFollowupJob({ store: noticeDue.store, composer: null, workerId: 'w', now: new Date('2026-10-02T06:31:00.000Z') })).state, 'CANCELLED');
});

test('worker：失败退避 3 次后 FAILED；调度偏差 P95 ≤10min', async () => {
  const { store, job } = seededStore();
  // 领取条件要求 due_at 已到：时钟从「事件准点+1分钟」起步，每轮推进到重试时刻。
  let clockNow = new Date(new Date(DUE).getTime() + 60_000);
  let current = job;
  for (let round = 0; round < MAX_FOLLOWUP_ATTEMPTS; round += 1) {
    const leased = claimDueFollowupJobs(store, clockNow, { workerId: 'w' });
    assert.equal(leased.length, 1, `round ${round} 应恰好领取 1 条`);
    const outcome = failFollowupJob(store, leased[0], new Error('compose blew up'), clockNow);
    current = store.followupJobs.get(job.job_id);
    if (round < MAX_FOLLOWUP_ATTEMPTS - 1) {
      assert.equal(outcome.state, 'RETRY_SCHEDULED');
      clockNow = new Date(current.next_attempt_at);
    }
  }
  assert.equal(current.state, 'FAILED');

  // 调度偏差：注入时钟批量 100 任务立即到期批量 drain，P95(published_at-due_at)。
  const batchStore = new DevelopmentStore({ accountIds: [ACCOUNT] });
  batchStore.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  batchStore.conversations.set('cnv_b', { conversation_id: 'cnv_b', account_id: ACCOUNT, character_id: CHARACTER, status: 'OPEN', created_at: '2026-09-01T00:00:00.000Z' });
  const account = batchStore.account(ACCOUNT);
  account.required_notice.state = 'DISPLAYED';
  account.proactive_preferences = { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 };
  const { event } = confirmLifeEventFromCandidate({
    store: batchStore, account,
    candidate: {
      candidate_id: 'memc_b', account_id: ACCOUNT, character_id: CHARACTER, state: 'CANDIDATE', version: 1, type: 'life_event',
      normalized_value: { life_event: { title: '批量事件', domain: 'REAL_LIFE', event_kind: 'OTHER', scheduled_at: DUE, timezone: 'Asia/Shanghai' } },
      display_text: '', provider: 't', expires_at: '2099-01-01', source_message_id: 'msg_b', conflicts_with: []
    }
  });
  const drifts = [];
  const now = new Date('2026-10-02T06:31:00.000Z');
  for (let index = 0; index < 100; index += 1) {
    // 每个任务显式不同 due（错开域唯一键），全部已到期
    const dueAt = new Date(new Date(DUE).getTime() - index * 1000).toISOString();
    const { job: oneJob } = grantFollowup({
      store: batchStore, account, event,
      validated: { followup_kind: 'AFTER_EVENT', due_at: dueAt, allowed_from: '2026-09-01T00:00:00.000Z', expires_at: '2026-10-03T06:30:00.000Z' },
      now: new Date('2026-09-01T00:00:00Z')
    });
    assert.ok(oneJob, `任务 ${index} 应创建（域唯一键已错开）`);
    const outcome = await runNextFollowupJob({ store: batchStore, composer: null, workerId: 'bench', now });
    const finished = batchStore.followupJobs.get(oneJob.job_id);
    if (finished.state === 'PUBLISHED') drifts.push(new Date(finished.published_at).getTime() - new Date(finished.due_at).getTime());
  }
  // 首个任务抢到槽位，其余 99 个因每日一条 EXPIRED（不补发）——这正是硬门禁；
  // 调度偏差只对成功投递计算。
  assert.equal(drifts.length, 1, `states: ${[...batchStore.followupJobs.values()].map((item) => item.state).join(',')}`);
  assert.ok(drifts[0] <= 10 * 60 * 1000, `P95 调度偏差 ${drifts[0]}ms ≤ 10min`);
  assert.equal([...batchStore.followupJobs.values()].filter((item) => item.state === 'EXPIRED').length, 99, '同日其余任务全部 EXPIRED');
});
