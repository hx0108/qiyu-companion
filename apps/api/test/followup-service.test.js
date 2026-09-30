'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const {
  computeLocalDateInZone, grantFollowup, revokeFollowup, listFollowupStatus,
  invalidateFollowupsOnRevision, revokeFollowupsOnDeletion,
  evaluateFollowupPublish, claimDailySlot, transitionFollowupJob
} = require('../src/domain/followup-service');
const { validateFollowupGrantRequest } = require('../src/domain/followup-schema');
const { nextNonQuietMinute } = require('../src/domain/proactive-policy');

const ACCOUNT = 'acct_dev_alice';
const CHARACTER = 'char_1';
const NOW = new Date('2026-10-01T08:00:00.000Z');
const EVENT = { event_id: 'levt_1', account_id: ACCOUNT, character_id: CHARACTER, version: 1, timezone: 'Asia/Shanghai', clarification_required: false, status: 'PLANNED', scheduled_at: '2026-10-02T06:30:00.000Z', title: '周五的产品经理面试', deleted_at: null };

function freshStore() {
  const store = new DevelopmentStore({ accountIds: [ACCOUNT] });
  store.characters.set(CHARACTER, { character_id: CHARACTER, account_id: ACCOUNT, name: '栖夏', status: 'ACTIVE' });
  store.lifeEvents.set(EVENT.event_id, EVENT);
  return store;
}

function validated(kind = 'BEFORE_EVENT', overrides = {}) {
  return validateFollowupGrantRequest({ followup_kind: kind, ...overrides }, { event: EVENT, now: NOW }).value;
}

// —— 许可与任务派生 ——

test('followup-service: grant 派生 job（local_date 按事件 IANA 折算）且 PUT 重放幂等', () => {
  const store = freshStore();
  const first = grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated(), now: NOW });
  assert.equal(first.replayed, false);
  assert.equal(first.grant.state, 'ACTIVE');
  assert.equal(first.grant.channel, 'IN_APP');
  assert.equal(first.job.state, 'PENDING');
  assert.equal(first.job.local_date, '2026-10-02'); // 06:30Z = 上海 14:30 当日
  assert.equal(first.job.next_attempt_at, NOW.toISOString());

  const replay = grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated(), now: NOW });
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.job_id, first.job.job_id);
  assert.equal([...store.followupJobs.values()].length, 1);
});

test('followup-service: 同 (event,version,kind) 新 due_at 的再授权——旧许可撤销、旧任务取消', () => {
  const store = freshStore();
  grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated(), now: NOW });
  const second = grantFollowup({
    store, account: store.account(ACCOUNT), event: EVENT,
    validated: validated('BEFORE_EVENT', { due_at: '2026-10-02T08:00:00Z' }), now: NOW
  });
  assert.equal(second.replayed, false);
  assert.equal(second.superseded.grants_revoked, 1);
  assert.equal(second.superseded.jobs_cancelled, 1);
  const jobs = [...store.followupJobs.values()];
  assert.equal(jobs.filter((job) => job.state === 'CANCELLED').length, 1);
  assert.equal(jobs.filter((job) => job.state === 'PENDING').length, 1);
});

test('followup-service: revoke 撤销许可+取消在途任务；状态列表含 push_configured:false', () => {
  const store = freshStore();
  grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated(), now: NOW });
  const outcome = revokeFollowup({ store, accountId: ACCOUNT, eventId: EVENT.event_id, now: NOW });
  assert.deepEqual(outcome, { grants_revoked: 1, jobs_cancelled: 1 });
  const status = listFollowupStatus({ store, accountId: ACCOUNT, eventId: EVENT.event_id });
  assert.equal(status.active_grant, null);
  assert.equal(status.push_configured, false);
  assert.match(status.note, /仅站内投递/);
  assert.equal(status.jobs[0].state, 'CANCELLED');
});

// —— 联动 ——

test('followup-service: 改期联动只失效旧版本；删除联动全量撤销', () => {
  const store = freshStore();
  grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated(), now: NOW });
  const revised = { ...EVENT, version: 2 };
  store.lifeEvents.set(EVENT.event_id, revised);
  const outcome = invalidateFollowupsOnRevision({ store, event: revised, previousVersion: 1, now: NOW });
  assert.deepEqual(outcome, { grants_revoked: 1, jobs_cancelled: 1 });

  // 新版本重新授权后再删除
  grantFollowup({ store, account: store.account(ACCOUNT), event: revised, validated: validated('BEFORE_EVENT', { due_at: '2026-10-03T06:30:00Z' }), now: NOW });
  const deleted = revokeFollowupsOnDeletion({ store, event: { ...revised, deleted_at: NOW.toISOString() }, now: NOW });
  assert.equal(deleted.grants_revoked, 1);
  assert.equal(deleted.jobs_cancelled, 1);
});

// —— 发布决策全分支 ——

function decisionCase(overrides = {}) {
  const store = freshStore();
  const { grant, job } = grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated('BEFORE_EVENT', { due_at: '2026-10-02T06:30:00Z' }), now: NOW });
  // 已过必要告知的账户（DevelopmentStore 默认 DUE 会被 NOTICE_PENDING 拦）。
  const account = { ...store.account(ACCOUNT), required_notice: { ...store.account(ACCOUNT).required_notice, state: 'DISPLAYED', displayed_at: NOW.toISOString() } };
  return evaluateFollowupPublish({
    event: overrides.event ?? store.lifeEvents.get(EVENT.event_id),
    grant: overrides.grant ?? grant,
    job: overrides.job ?? job,
    account: overrides.account ?? account,
    preferences: overrides.preferences ?? { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 },
    sentAt: overrides.sentAt ?? [],
    now: overrides.now ?? new Date('2026-10-02T06:35:00.000Z')
  });
}

test('followup-service: 决策——正常放行 PUBLISH 带模板槽', () => {
  const decision = decisionCase();
  assert.equal(decision.action, 'PUBLISH');
  assert.equal(decision.template_slot, 'CONFIRMED_APPOINTMENT');
});

test('followup-service: 决策——事件删除/版本不符/许可撤销/账户暂停/安全态/告知未显全部 CANCEL', () => {
  assert.equal(decisionCase({ event: { ...EVENT, deleted_at: NOW.toISOString() } }).reason, 'EVENT_DELETED');
  assert.equal(decisionCase({ event: { ...EVENT, version: 2 } }).reason, 'EVENT_VERSION_MISMATCH');
  const store = freshStore();
  const granted = grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated('BEFORE_EVENT', { due_at: '2026-10-02T06:30:00Z' }), now: NOW });
  assert.equal(decisionCase({ grant: { ...granted.grant, state: 'REVOKED' } }).reason, 'GRANT_NOT_ACTIVE');
  const paused = { ...store.account(ACCOUNT), user_pause_state: 'PAUSED' };
  assert.equal(decisionCase({ account: paused }).reason, 'USER_PAUSED');
  const crisis = { ...store.account(ACCOUNT), safety_mode: 'R2_CRISIS' };
  assert.equal(decisionCase({ account: crisis }).reason, 'SAFETY_MODE');
  const noticeDue = { ...store.account(ACCOUNT), required_notice: { ...store.account(ACCOUNT).required_notice, state: 'DUE' } };
  assert.equal(decisionCase({ account: noticeDue }).reason, 'NOTICE_PENDING');
});

test('followup-service: 决策——静默顺延到精确静默结束时刻；顺延超窗 EXPIRE', () => {
  // 上海 2026-10-02 06:35Z=14:35 不在静默；构造 16:05Z=北京 10-03 00:05（静默中）。
  const inQuiet = decisionCase({ now: new Date('2026-10-02T16:05:00.000Z') });
  assert.equal(inQuiet.action, 'DEFER');
  assert.equal(inQuiet.reason, 'QUIET_HOURS');
  assert.equal(inQuiet.defer_until, '2026-10-03T00:00:00.000Z'); // 北京 10-03 08:00 = 静默结束
});

test('followup-service: 决策——窗口已过 EXPIRE；每日已发 EXPIRE 不补发；opt-out CANCEL；未到期 DEFER 到 due', () => {
  assert.equal(decisionCase({ now: new Date('2026-10-04T00:00:00.000Z') }).action, 'EXPIRE');
  assert.equal(decisionCase({ sentAt: ['2026-10-02T05:00:00.000Z'] }).action, 'EXPIRE');
  assert.equal(decisionCase({ preferences: { enabled: false, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 } }).action, 'CANCEL');
  const early = decisionCase({ now: new Date('2026-10-02T05:00:00.000Z') });
  assert.equal(early.action, 'DEFER');
  assert.equal(early.defer_until, '2026-10-02T06:30:00.000Z');
});

// —— 时区与槽位 ——

test('followup-service: computeLocalDateInZone（+8 / -5 样例；无效时区 null）', () => {
  assert.equal(computeLocalDateInZone('2026-10-02T16:30:00.000Z', 'Asia/Shanghai'), '2026-10-03');
  assert.equal(computeLocalDateInZone('2026-10-02T06:30:00.000Z', 'America/New_York'), '2026-10-02');
  assert.equal(computeLocalDateInZone('2026-10-02T06:30:00.000Z', null), null);
  assert.equal(computeLocalDateInZone('2026-10-02T06:30:00.000Z', 'Not/AZone'), null);
});

test('followup-service: 内存每日槽位一次成功一次失败（不同日不互相影响）', () => {
  const store = freshStore();
  assert.equal(claimDailySlot(store, ACCOUNT, '2026-10-02', 'fjob_1'), true);
  assert.equal(claimDailySlot(store, ACCOUNT, '2026-10-02', 'fjob_2'), false);
  assert.equal(claimDailySlot(store, ACCOUNT, '2026-10-03', 'fjob_3'), true);
});

test('followup-service: 任务 CAS——状态不符返回 null（双 Worker 输家放弃）', () => {
  const store = freshStore();
  const { job } = grantFollowup({ store, account: store.account(ACCOUNT), event: EVENT, validated: validated(), now: NOW });
  assert.ok(transitionFollowupJob(store, job.job_id, ['PENDING'], { state: 'LEASED', lease_owner: 'w1' }));
  assert.equal(transitionFollowupJob(store, job.job_id, ['PENDING'], { state: 'LEASED', lease_owner: 'w2' }), null);
  assert.ok(transitionFollowupJob(store, job.job_id, ['LEASED'], { state: 'PUBLISHED', published_at: NOW.toISOString() }));
});

test('proactive-policy: nextNonQuietMinute 跨午夜窗口返回结束时刻（UTC）', () => {
  const preferences = { quietStartHour: 23, quietEndHour: 8, timezoneOffsetMinutes: 480 };
  // 北京 10-02 00:05（UTC 10-01 16:05）在静默中；结束=北京 10-02 08:00=UTC 10-02 00:00
  const first = nextNonQuietMinute(preferences, new Date('2026-10-01T16:05:00.000Z'));
  assert.equal(first.toISOString(), '2026-10-02T00:00:00.000Z');
  // 白天（北京 10:00）调用：返回最近的未来 end 点（次日 08:00）
  const daytime = nextNonQuietMinute(preferences, new Date('2026-10-02T02:00:00.000Z'));
  assert.equal(daytime.toISOString(), '2026-10-03T00:00:00.000Z');
  assert.equal(nextNonQuietMinute({ quietStartHour: 8, quietEndHour: 8 }, new Date()), null); // 无效窗口
});
