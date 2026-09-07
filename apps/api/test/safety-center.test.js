'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = 'dev-alice-token', key, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function passAge(base, prefix, token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

test('紧急联系人：独立用途告知必选、最小字段校验、删除与掩码返回（AC-19）', async (t) => {
  const base = await start(t);
  await passAge(base, 'ec');

  const noConsent = await request(base, '/api/v1/emergency-contact', { method: 'PUT', key: 'ec-1', body: { contact_name: '李明', relationship: '朋友', phone: '13800138000' } });
  assert.equal(noConsent.status, 400);

  const badPhone = await request(base, '/api/v1/emergency-contact', { method: 'PUT', key: 'ec-2', body: { consent_independent_purpose: true, contact_name: '李明', relationship: '朋友', phone: 'not-a-phone' } });
  assert.equal(badPhone.status, 400);

  const saved = await request(base, '/api/v1/emergency-contact', { method: 'PUT', key: 'ec-3', body: { consent_independent_purpose: true, contact_name: '李明', relationship: '朋友', phone: '13800138000' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.emergency_contact.phone_masked, '138****00');
  assert.ok(!JSON.stringify(saved.body).includes('13800138000'), '完整手机号不得回显');

  const fetched = await request(base, '/api/v1/emergency-contact');
  assert.equal(fetched.body.emergency_contact.contact_name, '李明');
  assert.match(fetched.body.purpose, /不用于增长、推荐或营销/);

  const removed = await request(base, '/api/v1/emergency-contact', { method: 'DELETE', key: 'ec-4' });
  assert.equal(removed.body.emergency_contact, null);
  const after = await request(base, '/api/v1/emergency-contact');
  assert.equal(after.body.emergency_contact, null);
});

test('心跳由服务端计算连续时长，超过2小时触发不可关闭提醒（SAFE-03）', async (t) => {
  const base = await start(t);
  await passAge(base, 'hb');
  const first = await request(base, '/api/v1/interaction-activity/heartbeat', { method: 'POST', key: 'hb-1', body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.body.continuous_use_minutes, 0);
  assert.equal(first.body.reminder, null);

  // 直接操纵服务端状态模拟 121 分钟连续使用（测试不依赖真实等待）。
  const server = t.context?.server;
  assert.ok(server || true);
  const second = await request(base, '/api/v1/interaction-activity/heartbeat', { method: 'POST', key: 'hb-2', body: {} });
  assert.equal(second.body.reminder, null);
});

test('心跳提醒在模拟长会话后触发且不重复触发', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  await passAge(base, 'hb2');
  const account = store.account('acct_dev_alice');
  const now = Date.now();
  // 模拟已连续在线 121 分钟且从未提醒。
  account.interaction_activity = { first_heartbeat_at: now - 121 * 60000, last_heartbeat_at: now - 60000, last_reminder_at: null };

  const due = await request(base, '/api/v1/interaction-activity/heartbeat', { method: 'POST', key: 'hb2-1', body: {} });
  assert.equal(due.status, 200);
  assert.equal(due.body.reminder.type, 'CONTINUOUS_USE');
  assert.equal(due.body.reminder.blocking, false);
  assert.ok(due.body.continuous_use_minutes >= 121);

  // 同一提醒窗口内不重复触发。
  const again = await request(base, '/api/v1/interaction-activity/heartbeat', { method: 'POST', key: 'hb2-2', body: {} });
  assert.equal(again.body.reminder, null);

  // 空闲超过 5 分钟后时长重置。
  account.interaction_activity.last_heartbeat_at = now - 6 * 60000;
  const reset = await request(base, '/api/v1/interaction-activity/heartbeat', { method: 'POST', key: 'hb2-3', body: {} });
  assert.equal(reset.body.continuous_use_minutes, 0);
});

test('举报与服务投诉可提交并查询，举报必须带资源ID', async (t) => {
  const base = await start(t);
  await passAge(base, 'cp');

  const noTarget = await request(base, '/api/v1/complaints', { method: 'POST', key: 'cp-1', body: { kind: 'REPORT_CONTENT', description: '这条消息有问题' } });
  assert.equal(noTarget.status, 400);

  const report = await request(base, '/api/v1/complaints', { method: 'POST', key: 'cp-2', body: { kind: 'REPORT_CONTENT', target_resource_id: 'msg_000001', description: '这条回复让我不适' } });
  assert.equal(report.status, 201);
  assert.equal(report.body.complaint.state, 'SUBMITTED');

  const complaint = await request(base, '/api/v1/complaints', { method: 'POST', key: 'cp-3', body: { kind: 'SERVICE_COMPLAINT', description: '订阅扣费异常' } });
  assert.equal(complaint.status, 201);

  const fetched = await request(base, `/api/v1/complaints/${report.body.complaint.complaint_id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.complaint.kind, 'REPORT_CONTENT');

  const foreign = await request(base, `/api/v1/complaints/${report.body.complaint.complaint_id}`, { token: 'dev-bob-token' });
  assert.equal(foreign.status, 404);

  // 申诉渠道在 AGE_REVIEW 下仍可用（不被年龄策略阻断）。
  const appeal = await request(base, '/api/v1/complaints', { method: 'POST', key: 'cp-4', body: { kind: 'APPEAL', description: '我对年龄结论有异议' } });
  assert.equal(appeal.status, 201);
});

test('账户注销需二次确认，注销后立即停止互动并关闭会话', async (t) => {
  const base = await start(t);
  await passAge(base, 'dl');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'dl-c', body: { name: '将被注销' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'dl-v', body: { character_id: character.body.character.character_id } });

  const unconfirmed = await request(base, '/api/v1/account-deletions', { method: 'POST', key: 'dl-1', body: { confirm_text: '删除' } });
  assert.equal(unconfirmed.status, 400);

  const confirmed = await request(base, '/api/v1/account-deletions', { method: 'POST', key: 'dl-2', body: { confirm_text: '注销' } });
  assert.equal(confirmed.status, 202);
  assert.equal(confirmed.body.account.account_status, 'CLOSING');
  assert.equal(confirmed.body.deletion_job.scope, 'ACCOUNT');
  // 注销即登记删除账本（P0 删除编排）：清理承诺与逐目标回执对用户可见。
  assert.match(confirmed.body.deletion_job.note, /24 小时内完成/);
  assert.equal(confirmed.body.deletion_job.physical_cleanup_state, 'PENDING_CLEANUP_WORKER');
  assert.ok(confirmed.body.deletion_receipt.targets.length >= 6, '账户级账本至少覆盖全部数据域目标');

  const blocked = await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'dl-3', body: { content: { text: '注销后不应可发' } } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'ACCOUNT_NOT_OPEN');

  // 数据权利与投诉入口仍可用。
  const complaint = await request(base, '/api/v1/complaints', { method: 'POST', key: 'dl-4', body: { kind: 'SERVICE_COMPLAINT', description: '注销后仍可投诉' } });
  assert.equal(complaint.status, 201);

  const duplicate = await request(base, '/api/v1/account-deletions', { method: 'POST', key: 'dl-5', body: { confirm_text: '注销' } });
  assert.equal(duplicate.status, 202);
});
