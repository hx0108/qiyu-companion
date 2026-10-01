'use strict';

// 六项能力 A4 固定回归集：主动跟进许可与投递裁决（evaluateFollowupPublish
// 唯一写者的全分支）。15 条 = PUBLISH 正路径 1 + 14 分支精确 (action,reason)
// 对（CANCEL 9 / EXPIRE 3 / DEFER 2）。数据均为合成；每条只从健康基线改动
// 一个维度，保证失败可归因。

const BASE = Object.freeze({
  // now 取 due 前 30 秒：过了 NOT_DUE 的 60 秒宽限线（now+60s 已过 due），
  // 本地时区（+8）落在 14:29 白天——不在默认 23-8 静默窗内。
  now: '2026-10-05T06:29:30.000Z',
  event: Object.freeze({ event_id: 'levt_base', account_id: 'acct_reg', character_id: 'chr_reg', version: 3, deleted_at: null, timezone: 'Asia/Shanghai', status: 'PLANNED', title: '周五面试' }),
  grant: Object.freeze({ grant_id: 'fgr_base', state: 'ACTIVE', event_id: 'levt_base' }),
  job: Object.freeze({ job_id: 'fjob_base', event_id: 'levt_base', event_version: 3, followup_kind: 'BEFORE_EVENT', due_at: '2026-10-05T06:30:00.000Z', expires_at: '2026-10-06T06:30:00.000Z' }),
  account: Object.freeze({ account_id: 'acct_reg', account_status: 'OPEN', user_pause_state: 'ACTIVE', safety_mode: 'R0_NORMAL', age_status: 'AGE_PASS', required_notice: Object.freeze({ state: 'DISPLAYED', displayed_at: '2026-10-01T00:00:00.000Z' }) }),
  preferences: Object.freeze({ enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 480 }),
  sentAt: Object.freeze([])
});

// patch 深合并一层（数组/对象整体替换）。
function fixture(patch = {}) {
  const merged = { ...BASE, ...patch };
  for (const key of ['event', 'grant', 'job', 'account', 'preferences']) {
    if (patch[key]) merged[key] = { ...BASE[key], ...patch[key] };
  }
  return merged;
}

const CASES = Object.freeze([
  { case_id: 'FPR-01', label: '正路径：全部健康 → 放行', patch: {}, expect: { action: 'PUBLISH', reason: null } },
  { case_id: 'FPR-02', label: '事件已删除 → CANCEL/EVENT_DELETED', patch: { event: { deleted_at: '2026-10-04T00:00:00.000Z' } }, expect: { action: 'CANCEL', reason: 'EVENT_DELETED' } },
  { case_id: 'FPR-03', label: '许可非 ACTIVE → CANCEL/GRANT_NOT_ACTIVE', patch: { grant: { state: 'REVOKED' } }, expect: { action: 'CANCEL', reason: 'GRANT_NOT_ACTIVE' } },
  { case_id: 'FPR-04', label: '任务版本落后事件 → CANCEL/EVENT_VERSION_MISMATCH', patch: { job: { event_version: 2 } }, expect: { action: 'CANCEL', reason: 'EVENT_VERSION_MISMATCH' } },
  { case_id: 'FPR-05', label: '账户非开放 → CANCEL/ACCOUNT_NOT_OPEN', patch: { account: { account_status: 'CLOSING' } }, expect: { action: 'CANCEL', reason: 'ACCOUNT_NOT_OPEN' } },
  { case_id: 'FPR-06', label: '用户暂停 → CANCEL/USER_PAUSED', patch: { account: { user_pause_state: 'PAUSED' } }, expect: { action: 'CANCEL', reason: 'USER_PAUSED' } },
  { case_id: 'FPR-07', label: '安全模式非 R0 → CANCEL/SAFETY_MODE', patch: { account: { safety_mode: 'R2_LIMITED' } }, expect: { action: 'CANCEL', reason: 'SAFETY_MODE' } },
  { case_id: 'FPR-08', label: '年龄复核中 → CANCEL/AGE_REVIEW', patch: { account: { age_status: 'AGE_REVIEW_PENDING' } }, expect: { action: 'CANCEL', reason: 'AGE_REVIEW' } },
  { case_id: 'FPR-09', label: '必要告知未展示 → CANCEL/NOTICE_PENDING', patch: { account: { required_notice: { state: 'DUE', displayed_at: null } } }, expect: { action: 'CANCEL', reason: 'NOTICE_PENDING' } },
  { case_id: 'FPR-10', label: '用户关闭主动消息 → CANCEL/USER_OPTED_OUT', patch: { preferences: { enabled: false } }, expect: { action: 'CANCEL', reason: 'USER_OPTED_OUT' } },
  { case_id: 'FPR-11', label: '超过允许窗口 → EXPIRE/WINDOW_PASSED', patch: { now: '2026-10-07T00:00:00.000Z' }, expect: { action: 'EXPIRE', reason: 'WINDOW_PASSED' } },
  { case_id: 'FPR-12', label: '未到期（60 秒宽限外）→ DEFER/NOT_DUE', patch: { now: '2026-10-05T05:00:00.000Z' }, expect: { action: 'DEFER', reason: 'NOT_DUE' } },
  { case_id: 'FPR-13', label: '静默时段内且静默结束在窗口内 → DEFER/QUIET_HOURS', patch: { now: '2026-10-05T02:00:00.000Z', job: { due_at: '2026-10-05T01:59:30.000Z', expires_at: '2026-10-06T06:30:00.000Z' }, preferences: { quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 0 } }, expect: { action: 'DEFER', reason: 'QUIET_HOURS' } },
  { case_id: 'FPR-14', label: '静默结束超出允许窗口 → EXPIRE/QUIET_WINDOW_PASSED', patch: { now: '2026-10-06T05:00:00.000Z', job: { due_at: '2026-10-06T04:00:00.000Z', expires_at: '2026-10-06T06:00:00.000Z' }, preferences: { quiet_start_hour: 22, quiet_end_hour: 8, timezone_offset_minutes: 0 } }, expect: { action: 'EXPIRE', reason: 'QUIET_WINDOW_PASSED' } },
  { case_id: 'FPR-15', label: '当日已发一条 → EXPIRE/DAILY_LIMIT_REACHED', patch: { sentAt: ['2026-10-05T05:00:00.000Z'] }, expect: { action: 'EXPIRE', reason: 'DAILY_LIMIT_REACHED' } }
]);

module.exports = { BASE, CASES, fixture };
