'use strict';

const { FOLLOWUP_KIND_TO_TRIGGER } = require('./followup-schema');
const { evaluateProactiveDispatch, nextNonQuietMinute } = require('./proactive-policy');

// 六项能力 A2（方案 §4.2）：跟进许可与调度任务的域服务。投递决定的不可逆
// 部分归 evaluateProactiveDispatch + evaluateFollowupPublish（本模块），模型
// 只收模板槽。life_events 是投影只读方（findLifeEvent），许可/任务状态由本
// 模块独占写入。

const FOLLOWUP_JOB_IN_FLIGHT_STATES = Object.freeze(['PENDING', 'LEASED', 'READY']);

// —— 时区折算（Node 22 Intl，零依赖）——
// due_at(UTC) 按事件 IANA timezone 折算本地日期字符串（YYYY-MM-DD），作为
// 每日槽位键。无效/未知时区返回 null（调用方不得调度）。
function computeLocalDateInZone(iso, timeZone) {
  if (!iso || typeof timeZone !== 'string' || !timeZone.trim()) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return formatter.format(new Date(iso));
  } catch {
    return null;
  }
}

// —— 许可与任务派生 ——

// 开启一次跟进（幂等）：同 (event_id, event_version, kind, due_at) 已有在途
// 任务时返回既有行（PUT 重放语义）。字段合法性由 followup-schema 校验。
function grantFollowup({ store, account, event, validated, now = new Date() } = {}) {
  const existing = [...store.followupJobs.values()].find((job) =>
    job.event_id === event.event_id && job.event_version === event.version
    && job.followup_kind === validated.followup_kind && job.due_at === validated.due_at
    && FOLLOWUP_JOB_IN_FLIGHT_STATES.includes(job.state));
  if (existing) {
    const grant = store.followupGrants.get(existing.grant_id) ?? null;
    return { grant, job: existing, replayed: true };
  }
  // 同 (event, version, kind) 已有 ACTIVE 许可但 due_at 不同（用户改了提醒时刻）：
  // 旧许可失效、旧在途任务取消，一个事件版本+种类同时只有一个生效许可。
  let superseded = { grants_revoked: 0, jobs_cancelled: 0 };
  for (const grant of store.followupGrants.values()) {
    if (grant.account_id === account.account_id && grant.event_id === event.event_id
      && grant.event_version === event.version && grant.followup_kind === validated.followup_kind
      && grant.state === 'ACTIVE') {
      store.followupGrants.set(grant.grant_id, Object.freeze({ ...grant, state: 'REVOKED', revoked_at: now.toISOString(), version: grant.version + 1 }));
      superseded.grants_revoked += 1;
    }
  }
  for (const job of store.followupJobs.values()) {
    if (job.account_id === account.account_id && job.event_id === event.event_id
      && job.event_version === event.version && job.followup_kind === validated.followup_kind
      && job.state === 'PENDING') {
      store.followupJobs.set(job.job_id, Object.freeze({ ...job, state: 'CANCELLED', last_error: 'superseded by re-grant with new due_at' }));
      superseded.jobs_cancelled += 1;
    }
  }
  const localDate = computeLocalDateInZone(validated.due_at, event.timezone);
  const grant = {
    grant_id: store.next('fgr'), account_id: account.account_id, character_id: event.character_id,
    event_id: event.event_id, event_version: event.version, followup_kind: validated.followup_kind,
    channel: 'IN_APP', allowed_from: validated.allowed_from, expires_at: validated.expires_at,
    version: 1, state: 'ACTIVE', consented_at: now.toISOString(), revoked_at: null,
    created_at: now.toISOString(), updated_at: now.toISOString()
  };
  const job = {
    job_id: store.next('fjob'), account_id: account.account_id, character_id: event.character_id,
    event_id: event.event_id, event_version: event.version, grant_id: grant.grant_id,
    followup_kind: validated.followup_kind, due_at: validated.due_at, expires_at: validated.expires_at,
    local_date: localDate, state: 'PENDING', lease_owner: null, lease_expires_at: null,
    attempts: 0, next_attempt_at: validated.allowed_from, last_error: null,
    created_at: now.toISOString(), published_at: null
  };
  store.followupGrants.set(grant.grant_id, grant);
  store.followupJobs.set(job.job_id, job);
  return { grant, job, replayed: false, superseded };
}

// 撤销许可 + 取消在途任务（同一次调用=同事务语义；HTTP DELETE 与删除事件联动共用）。
function revokeFollowup({ store, accountId, eventId, now = new Date() } = {}) {
  let grantsRevoked = 0;
  let jobsCancelled = 0;
  for (const grant of store.followupGrants.values()) {
    if (grant.account_id === accountId && grant.event_id === eventId && grant.state === 'ACTIVE') {
      store.followupGrants.set(grant.grant_id, Object.freeze({ ...grant, state: 'REVOKED', revoked_at: now.toISOString(), version: grant.version + 1 }));
      grantsRevoked += 1;
    }
  }
  for (const job of store.followupJobs.values()) {
    if (job.account_id === accountId && job.event_id === eventId && FOLLOWUP_JOB_IN_FLIGHT_STATES.includes(job.state)) {
      store.followupJobs.set(job.job_id, Object.freeze({ ...job, state: 'CANCELLED', lease_owner: null, lease_expires_at: null, last_error: 'followup revoked' }));
      jobsCancelled += 1;
    }
  }
  return { grants_revoked: grantsRevoked, jobs_cancelled: jobsCancelled };
}

// A3 计划联动：按 grant_id 精确撤销一条许可（含其在途任务）。计划暂停/取消
// 只撤 linked 的那条——同一事件上可能还有用户独立开启的提醒，不归计划管，
// 禁止用 byEvent 版本（会把用户自己的许可一起撤掉）。
function revokeFollowupGrantById({ store, accountId, grantId, now = new Date() } = {}) {
  const grant = store.followupGrants.get(grantId);
  if (!grant || grant.account_id !== accountId || grant.state !== 'ACTIVE') {
    return { grants_revoked: 0, jobs_cancelled: 0 };
  }
  store.followupGrants.set(grantId, Object.freeze({ ...grant, state: 'REVOKED', revoked_at: now.toISOString(), version: grant.version + 1 }));
  let jobsCancelled = 0;
  for (const job of store.followupJobs.values()) {
    if (job.grant_id === grantId && FOLLOWUP_JOB_IN_FLIGHT_STATES.includes(job.state)) {
      store.followupJobs.set(job.job_id, Object.freeze({ ...job, state: 'CANCELLED', lease_owner: null, lease_expires_at: null, last_error: 'plan paused or cancelled; linked grant revoked' }));
      jobsCancelled += 1;
    }
  }
  return { grants_revoked: 1, jobs_cancelled: jobsCancelled };
}

// 事件维度状态（GET followup 与前端开关卡）。
function listFollowupStatus({ store, accountId, eventId } = {}) {
  const grants = [...store.followupGrants.values()]
    .filter((grant) => grant.account_id === accountId && grant.event_id === eventId)
    .sort((left, right) => (left.created_at < right.created_at ? -1 : 1))
    .map(publicFollowupGrant);
  const jobs = [...store.followupJobs.values()]
    .filter((job) => job.account_id === accountId && job.event_id === eventId)
    .sort((left, right) => (left.created_at < right.created_at ? -1 : 1))
    .map(publicFollowupJob);
  return {
    event_id: eventId,
    channel: 'IN_APP',
    push_configured: false,
    active_grant: grants.find((grant) => grant.state === 'ACTIVE') ?? null,
    grants, jobs,
    note: '当前仅站内投递（写进对话消息流）；未配置 Push 渠道。'
  };
}

// —— 联动（由 app.js 路由层在修订/删除成功后同事务调用）——

// 改期联动：旧 event_version 的许可全部失效 + 在途任务取消；返回计数进 PATCH
// 响应，前端据此渲染"为新时间重新开启提醒"确认卡。
function invalidateFollowupsOnRevision({ store, event, previousVersion, now = new Date() } = {}) {
  let grantsRevoked = 0;
  let jobsCancelled = 0;
  for (const grant of store.followupGrants.values()) {
    if (grant.account_id === event.account_id && grant.event_id === event.event_id
      && grant.event_version === previousVersion && grant.state === 'ACTIVE') {
      store.followupGrants.set(grant.grant_id, Object.freeze({ ...grant, state: 'REVOKED', revoked_at: now.toISOString(), version: grant.version + 1 }));
      grantsRevoked += 1;
    }
  }
  for (const job of store.followupJobs.values()) {
    if (job.account_id === event.account_id && job.event_id === event.event_id
      && job.event_version === previousVersion && FOLLOWUP_JOB_IN_FLIGHT_STATES.includes(job.state)) {
      store.followupJobs.set(job.job_id, Object.freeze({ ...job, state: 'CANCELLED', lease_owner: null, lease_expires_at: null, last_error: 'event revised; grant for previous version invalidated' }));
      jobsCancelled += 1;
    }
  }
  return { grants_revoked: grantsRevoked, jobs_cancelled: jobsCancelled };
}

// 删除联动：全量撤销（无论版本）。
function revokeFollowupsOnDeletion({ store, event, now = new Date() } = {}) {
  return revokeFollowup({ store, accountId: event.account_id, eventId: event.event_id, now });
}

// —— 发布决策（内存 Worker 与 PG repository 共用的唯一写者）——

// 输入均为当前快照（调用方短事务内重读）。返回 action：
// - CANCEL：不可投递且不该重试（撤销/版本不符/暂停/安全/年龄/告知/opt-out）
// - EXPIRE：超过允许窗口（含限额占满不补发过时提醒的场景由调用方置 EXPIRED）
// - DEFER：静默时段内，顺延到静默结束（reason + defer_until）
// - PUBLISH：放行
function evaluateFollowupPublish({ event, grant, job, account, preferences, sentAt = [], now = new Date() } = {}) {
  const fail = (action, reason, extra = {}) => ({ action, reason, ...extra });
  if (!event || event.deleted_at) return fail('CANCEL', 'EVENT_DELETED');
  if (!grant || grant.state !== 'ACTIVE') return fail('CANCEL', 'GRANT_NOT_ACTIVE');
  if (job.event_version !== event.version) return fail('CANCEL', 'EVENT_VERSION_MISMATCH');
  if (!account || account.account_status !== 'OPEN') return fail('CANCEL', 'ACCOUNT_NOT_OPEN');
  if (account.user_pause_state === 'PAUSED') return fail('CANCEL', 'USER_PAUSED');
  if (account.safety_mode && account.safety_mode !== 'R0_NORMAL') return fail('CANCEL', 'SAFETY_MODE');
  if (account.age_status && account.age_status !== 'AGE_VERIFIED' && account.age_status !== 'AGE_PASS' && account.age_status !== 'AGE_UNVERIFIED') return fail('CANCEL', 'AGE_REVIEW');
  if (account.required_notice && account.required_notice.state === 'DUE') return fail('CANCEL', 'NOTICE_PENDING');
  if (now.getTime() > new Date(job.expires_at).getTime()) return fail('EXPIRE', 'WINDOW_PASSED');
  if (now.getTime() + 60000 < new Date(job.due_at).getTime()) return fail('DEFER', 'NOT_DUE', { defer_until: job.due_at });

  const triggerType = FOLLOWUP_KIND_TO_TRIGGER[job.followup_kind] ?? FOLLOWUP_KIND_TO_TRIGGER.BEFORE_EVENT;
  const dispatch = evaluateProactiveDispatch({
    preferences: {
      enabled: preferences?.enabled !== false,
      quietStartHour: preferences?.quiet_start_hour ?? preferences?.quietStartHour ?? 23,
      quietEndHour: preferences?.quiet_end_hour ?? preferences?.quietEndHour ?? 8,
      timezoneOffsetMinutes: preferences?.timezone_offset_minutes ?? preferences?.timezoneOffsetMinutes ?? 0
    },
    trigger: { type: triggerType },
    sentAt,
    now
  });
  if (dispatch.allowed) return { action: 'PUBLISH', reason: null, template_slot: dispatch.template_slot };
  if (dispatch.reason === 'QUIET_HOURS') {
    const deferUntil = nextNonQuietMinute({
      quietStartHour: preferences?.quiet_start_hour ?? 23,
      quietEndHour: preferences?.quiet_end_hour ?? 8,
      timezoneOffsetMinutes: preferences?.timezone_offset_minutes ?? 0
    }, now);
    if (deferUntil && deferUntil.getTime() <= new Date(job.expires_at).getTime()) {
      return fail('DEFER', 'QUIET_HOURS', { defer_until: deferUntil.toISOString() });
    }
    return fail('EXPIRE', 'QUIET_WINDOW_PASSED');
  }
  if (dispatch.reason === 'DAILY_LIMIT_REACHED') return fail('EXPIRE', 'DAILY_LIMIT_REACHED');
  return fail('CANCEL', dispatch.reason);
}

// —— 内存模式每日槽位（PG 走 store.claimProactiveDailySlot SQL 原子）——
function claimDailySlot(store, accountId, localDate, claimedBy) {
  const key = `${accountId}:${localDate}`;
  if (store.proactiveDailySlots.has(key)) return false;
  store.proactiveDailySlots.set(key, Object.freeze({ account_id: accountId, local_date: localDate, claimed_by: claimedBy, created_at: new Date().toISOString() }));
  return true;
}

// —— 内存模式任务 CAS（双 Worker 恰一胜的内存防线；照提取任务冻结风格）——
function transitionFollowupJob(store, jobId, fromStates, patch) {
  const job = store.followupJobs.get(jobId);
  if (!job || !fromStates.includes(job.state)) return null;
  const next = Object.freeze({ ...job, ...patch });
  store.followupJobs.set(jobId, next);
  return next;
}

function publicFollowupGrant(grant) {
  return {
    grant_id: grant.grant_id, event_id: grant.event_id, event_version: grant.event_version,
    followup_kind: grant.followup_kind, channel: grant.channel,
    allowed_from: grant.allowed_from, expires_at: grant.expires_at,
    version: grant.version, state: grant.state, consented_at: grant.consented_at,
    revoked_at: grant.revoked_at ?? null, created_at: grant.created_at
  };
}

function publicFollowupJob(job) {
  return {
    job_id: job.job_id, event_id: job.event_id, event_version: job.event_version,
    followup_kind: job.followup_kind, due_at: job.due_at, expires_at: job.expires_at,
    local_date: job.local_date, state: job.state, attempts: job.attempts,
    next_attempt_at: job.next_attempt_at, last_error: job.last_error ?? null,
    published_at: job.published_at ?? null, created_at: job.created_at
  };
}

module.exports = {
  FOLLOWUP_JOB_IN_FLIGHT_STATES,
  computeLocalDateInZone, grantFollowup, revokeFollowup, revokeFollowupGrantById, listFollowupStatus,
  invalidateFollowupsOnRevision, revokeFollowupsOnDeletion,
  evaluateFollowupPublish, claimDailySlot, transitionFollowupJob,
  publicFollowupGrant, publicFollowupJob
};
