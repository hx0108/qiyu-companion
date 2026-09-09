'use strict';

function publicPushEnvelope(notification) {
  if (!notification?.notification_id) throw new TypeError('notification_id is required');
  return Object.freeze({
    notification_id: notification.notification_id,
    title: '栖语有一条账户通知', body: '打开栖语后查看详情。', route: '/notifications',
    privacy: 'NO_SENSITIVE_CONTENT', collapse_key: 'qiyu-account-notice'
  });
}

module.exports = { publicPushEnvelope };
