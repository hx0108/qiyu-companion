'use strict';

const DAY_MS = 86_400_000;

function scheduleAccountNotifications(store, account, now = new Date()) {
  const created = [];
  for (const subscription of store.subscriptions?.values() ?? []) {
    if (subscription.account_id !== account.account_id) continue;
    const end = timestamp(subscription.period_end);
    if (subscription.channel === 'DEVELOPMENT_TRIAL' && subscription.state === 'TRIAL' && end && end > now && end - now <= DAY_MS) {
      created.push(recordOnce(store, account.account_id, {
        dedupeKey: `TRIAL_ENDING:${subscription.subscription_id}:${subscription.period_end}`,
        type: 'TRIAL_ENDING', title: '7 天体验即将到期',
        body: `体验将在 ${subscription.period_end} 到期，不会自动扣费；文字、人格、关系资产、导出和删除仍可使用。`
      }, now));
    }
    if (subscription.auto_renew === true && ['ACTIVE', 'GRACE'].includes(subscription.state) && end && end > now && end - now <= 5 * DAY_MS) {
      created.push(recordOnce(store, account.account_id, {
        dedupeKey: `RENEWAL_REMINDER:${subscription.subscription_id}:${subscription.period_end}`,
        type: 'SUBSCRIPTION_RENEWAL_REMINDER', title: '订阅将在 5 日内续费',
        body: `当前订阅周期将在 ${subscription.period_end} 结束；自动续费已开启，可在订阅页随时取消。`
      }, now));
    }
    if (subscription.refund_status && subscription.refund_status !== 'NONE') {
      created.push(recordOnce(store, account.account_id, {
        dedupeKey: `REFUND:${subscription.subscription_id}:${subscription.refund_status}`,
        type: 'REFUND_STATUS_CHANGED', title: '退款状态已更新',
        body: `订阅退款状态已更新为 ${subscription.refund_status}；权益变化以订阅页和服务端账本为准。`
      }, now));
    }
  }
  for (const event of store.paymentEvents?.values() ?? []) {
    if (event.account_id !== account.account_id || event.outcome !== 'APPLIED' || event.event_type !== 'RENEWAL_SUCCEEDED') continue;
    created.push(recordOnce(store, account.account_id, {
      dedupeKey: `RENEWAL_COMPLETED:${event.provider_event_id}`,
      type: 'SUBSCRIPTION_RENEWED', title: '订阅续费已完成',
      body: '续费回调已通过签名、幂等和状态机校验并入账；新周期与权益以订阅页为准。'
    }, now));
  }
  for (const job of store.deletionJobs?.values() ?? []) {
    if (job.account_id !== account.account_id || job.scope !== 'ACCOUNT' || job.state !== 'COMPLETED') continue;
    created.push(recordOnce(store, account.account_id, {
      dedupeKey: `DELETION_COMPLETED:${job.deletion_job_id}`,
      type: 'ACCOUNT_DELETION_COMPLETED', title: '账户数据清理已完成',
      body: '在线数据清理任务已完成；备份隔离与法定保留范围仍以删除回执为准。'
    }, now));
  }
  if (account.safety_mode === 'R2_CRISIS') {
    created.push(recordOnce(store, account.account_id, {
      dedupeKey: `SAFETY_R2:${account.revocation_epoch || 0}`,
      type: 'SAFETY_SUPPORT_STARTED', title: '安全支持模式已开启',
      body: '普通角色剧情已暂停，固定安全资源保持可用。该通知不表示外部联系已经送达。'
    }, now));
  }
  return created.filter(Boolean);
}

function recordOnce(store, accountId, payload, now) {
  if (!store.notifications) store.notifications = new Map();
  const exists = [...store.notifications.values()].some((item) => item.account_id === accountId && item.dedupe_key === payload.dedupeKey);
  if (exists) return null;
  const notification = {
    notification_id: store.next('ntf'), account_id: accountId, dedupe_key: payload.dedupeKey,
    type: payload.type, title: payload.title, body: payload.body,
    read: false, read_at: null, created_at: now.toISOString()
  };
  store.notifications.set(notification.notification_id, notification);
  return notification;
}

function timestamp(value) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

module.exports = { scheduleAccountNotifications };
