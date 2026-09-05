'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { PROMPT_INJECTION_ATTACK_SET_V1 } = require('../src/production/prompt-injection-attack-set');

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

async function rawRequest(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, contentType: response.headers.get('content-type'), csp: response.headers.get('content-security-policy'), text: await response.text() };
}

async function displayAndPass(base, token = 'dev-alice-token', prefix = 'setup') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  const displayed = await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, {
    method: 'POST', token, key: `${prefix}-notice`, body: { notice_version: notice.notice_version }
  });
  assert.equal(displayed.status, 200);
  const age = await request(base, '/api/v1/age/declarations', {
    method: 'POST', token, key: `${prefix}-age`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true }
  });
  assert.equal(age.body.status, 'AGE_PASS');
}

async function readyConversation(base, token = 'dev-alice-token', prefix = 'setup') {
  await displayAndPass(base, token, prefix);
  const character = await request(base, '/api/v1/characters', { method: 'POST', token, key: `${prefix}-character`, body: { name: `${prefix} 角色` } });
  assert.equal(character.status, 201);
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', token, key: `${prefix}-conversation`, body: { character_id: character.body.character.character_id } });
  assert.equal(conversation.status, 201);
  return { character: character.body.character, conversation: conversation.body.conversation };
}

test('必要告知完成前阻断普通角色创建，完成年龄准入和回执后允许', async (t) => {
  const base = await start(t);
  const age = await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'age-first', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  assert.equal(age.body.status, 'AGE_PASS');
  const blocked = await request(base, '/api/v1/characters', { method: 'POST', key: 'character-blocked', body: { name: '未告知角色' } });
  assert.equal(blocked.status, 428);
  assert.equal(blocked.body.error.code, 'REQUIRED_NOTICE_PENDING');
  await displayAndPass(base, 'dev-alice-token', 'after-block');
  const created = await request(base, '/api/v1/characters', { method: 'POST', key: 'character-ok', body: { name: '已告知角色' } });
  assert.equal(created.status, 201);
});

test('订阅目录由服务端返回价格、配额和默认非自动续费，并明确真实支付仍关闭', async (t) => {
  const base = await start(t);
  const catalog = await request(base, '/api/v1/subscription/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.catalog.auto_renew_default, false);
  assert.deepEqual(catalog.body.catalog.plans.map((plan) => plan.price_fen), [3900, 10800]);
  assert.equal(catalog.body.catalog.policy, 'development-simulated-checkout-only; real Alipay/WeChat payment is disabled');
});

test('仅白名单开发壳资源由同源 API 服务托管，API 路由仍要求鉴权', async (t) => {
  const base = await start(t);
  const page = await rawRequest(base, '/');
  assert.equal(page.status, 200);
  assert.match(page.contentType, /^text\/html/);
  assert.match(page.text, /src="app\.js"/);
  assert.match(page.csp, /connect-src 'self'/);

  const script = await rawRequest(base, '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.contentType, /^text\/javascript/);
  assert.match(script.text, /API_BASE = "\/api\/v1"/);
  assert.match(script.text, /const streamPath = String\(url \|\| ""\)\.startsWith\(`\$\{API_BASE\}\/`\) \? url : `\$\{API_BASE\}\$\{url\}`/);
  assert.match(script.text, /await fetch\(streamPath, \{/);
  assert.doesNotMatch(script.text, /fetch\(`\$\{API_BASE\}\$\{url\}`/);
  assert.match(script.text, /角色语音未生成/);
  assert.match(script.text, /情境图额度不足/);
  assert.match(script.text, /额度与返还以服务端权益账本为准/);

  const favicon = await rawRequest(base, '/favicon.svg');
  assert.equal(favicon.status, 200);
  assert.match(favicon.contentType, /^image\/svg\+xml/);

  const styles = await rawRequest(base, '/styles.css');
  assert.equal(styles.status, 200);
  assert.match(styles.contentType, /^text\/css/);
  const tokens = await rawRequest(base, '/tokens.css');
  assert.equal(tokens.status, 200);
  assert.match(tokens.contentType, /^text\/css/);
  const importedTokens = await rawRequest(base, '/designs/qiyu-v1-handoff/tokens/tokens.css');
  assert.equal(importedTokens.status, 200);
  assert.equal(importedTokens.text, tokens.text);

  const protectedApi = await fetch(`${base}/api/v1/dev/session`);
  assert.equal(protectedApi.status, 401);
  assert.equal((await protectedApi.json()).error.code, 'AUTH_REQUIRED');
  const unavailable = await rawRequest(base, '/package.json');
  assert.equal(unavailable.status, 401);
});

test('未成年人和未鉴权账户无法进入普通互动，但年龄声明入口可用', async (t) => {
  const base = await start(t);
  const unauthed = await request(base, '/api/v1/age/status', { token: 'unknown-token' });
  assert.equal(unauthed.status, 401);
  await displayAndPass(base, 'dev-alice-token', 'minor-notice');
  const minor = await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'minor-age', body: { date_of_birth: '2011-01-01', confirmed_18_plus: true } });
  assert.equal(minor.body.status, 'AGE_DENIED_MINOR');
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'minor-character', body: { name: '不应创建' } });
  assert.equal(character.status, 403);
  assert.equal(character.body.error.code, 'AGE_NOT_PASSED');
});

test('出生日期变更或申诉会进入增强核验等待态，且普通互动保持关闭', async (t) => {
  const base = await start(t);
  await displayAndPass(base, 'dev-alice-token', 'age-review');
  const first = await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'age-review-first', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  assert.equal(first.body.status, 'AGE_PASS');
  const changed = await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'age-review-changed', body: { date_of_birth: '1991-01-01', confirmed_18_plus: true } });
  assert.equal(changed.body.status, 'AGE_REVIEW');
  assert.deepEqual(changed.body.reason_codes, ['DATE_OF_BIRTH_CHANGED']);
  assert.equal(changed.body.enhanced_verification.state, 'REQUIRED');
  const blocked = await request(base, '/api/v1/characters', { method: 'POST', key: 'age-review-character', body: { name: '不应创建' } });
  assert.equal(blocked.status, 403);
  const appeal = await request(base, '/api/v1/age/appeals', { method: 'POST', key: 'age-review-appeal', body: {} });
  assert.equal(appeal.status, 202);
  assert.deepEqual(appeal.body.reason_codes, ['APPEAL_REQUESTED']);
});

test('既有会话在年龄状态转为复核后，普通消息不会进入审核器或模型', async (t) => {
  let modelCalls = 0;
  let moderatorCalls = 0;
  const base = await start(t, {
    replyGenerator: async () => { modelCalls += 1; throw new Error('年龄复核中的普通消息不应进入模型'); },
    textModerator: async () => { moderatorCalls += 1; throw new Error('年龄复核中的普通消息不应进入审核器'); }
  });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'age-transition');
  const changed = await request(base, '/api/v1/age/declarations', {
    method: 'POST', key: 'age-transition-change', body: { date_of_birth: '1991-01-01', confirmed_18_plus: true }
  });
  assert.equal(changed.body.status, 'AGE_REVIEW');

  const blocked = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, {
    method: 'POST', key: 'age-transition-message', body: { content: { text: '这是一条普通消息' } }
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'AGE_NOT_PASSED');
  assert.equal(modelCalls, 0);
  assert.equal(moderatorCalls, 0);
});

test('Mock 消息只创建候选；拒绝不产生资产，确认后才可召回', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'memory');
  const first = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'message-reject', body: { content: { text: '我喜欢安静的夜晚' } } });
  assert.equal(first.status, 201);
  assert.equal(first.body.provider, 'mock');
  assert.equal(first.body.user_message.ai_generated, false);
  assert.equal(first.body.memory_candidate.state, 'CANDIDATE');
  assert.equal((await request(base, '/api/v1/relationship-assets')).body.assets.length, 0);
  const rejected = await request(base, `/api/v1/memory-candidates/${first.body.memory_candidate.candidate_id}/reject`, { method: 'POST', key: 'candidate-reject', body: {} });
  assert.equal(rejected.body.candidate.state, 'REJECTED');
  assert.equal((await request(base, '/api/v1/memory-recall')).body.assets.length, 0);

  const second = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'message-confirm', body: { content: { text: '我们周末一起看电影' } } });
  const confirmed = await request(base, `/api/v1/memory-candidates/${second.body.memory_candidate.candidate_id}/confirm`, { method: 'POST', key: 'candidate-confirm', body: { expected_version: 1 } });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.asset.state, 'ACTIVE');
  assert.equal((await request(base, '/api/v1/memory-recall')).body.assets.length, 1);
});

test('关系档案导出仅含当前账户可见数据，且不包含私有媒体定位信息', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'export');
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'export-message', body: { content: { text: '这是一条可导出的对话' } } });
  const exported = await request(base, '/api/v1/data-exports/relationship-profile');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.export.format, 'qiyu-relationship-profile-json-v1');
  assert.equal(exported.body.export.messages.length, 2);
  assert.ok(exported.body.export.messages.every((message) => typeof message.created_at === 'string'));
  assert.equal(JSON.stringify(exported.body.export).includes('object_key'), false);
  const bob = await request(base, '/api/v1/data-exports/relationship-profile', { token: 'dev-bob-token' });
  assert.equal(bob.body.export.messages.length, 0);
});

test('用户可在 30/90 天原始互动保留期之间切换，非法值被拒绝', async (t) => {
  const base = await start(t);
  const initial = await request(base, '/api/v1/privacy/raw-interaction-retention');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.raw_interaction_retention_days, 90);
  const changed = await request(base, '/api/v1/privacy/raw-interaction-retention', { method: 'POST', key: 'retention-30', body: { retention_days: 30 } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.raw_interaction_retention_days, 30);
  const refreshed = await request(base, '/api/v1/privacy/raw-interaction-retention');
  assert.equal(refreshed.body.raw_interaction_retention_days, 30);
  const invalid = await request(base, '/api/v1/privacy/raw-interaction-retention', { method: 'POST', key: 'retention-invalid', body: { retention_days: 31 } });
  assert.equal(invalid.status, 400);
});

test('删除会话会撤销其消息、候选和派生关系资产，且不再导出或召回', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'conversation-delete');
  const message = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'conversation-delete-message', body: { content: { text: '请删除这段关系' } } });
  const confirmed = await request(base, `/api/v1/memory-candidates/${message.body.memory_candidate.candidate_id}/confirm`, { method: 'POST', key: 'conversation-delete-confirm', body: { expected_version: 1 } });
  const deleted = await request(base, `/api/v1/conversations/${conversation.conversation_id}`, { method: 'DELETE', key: 'conversation-delete' });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deletion_job.scope, 'CONVERSATION');
  assert.equal((await request(base, '/api/v1/memory-recall')).body.assets.length, 0);
  assert.equal((await request(base, '/api/v1/data-exports/relationship-profile')).body.export.messages.length, 0);
  assert.equal((await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'conversation-deleted-message', body: { content: { text: '不应写入' } } })).status, 404);
  assert.ok(confirmed.body.asset.asset_id);
});

test('删除会话后，未确认候选也不能被旧请求确认', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'conversation-delete-candidate');
  const message = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'conversation-delete-candidate-message', body: { content: { text: '删除前的待确认候选' } } });
  await request(base, `/api/v1/conversations/${conversation.conversation_id}`, { method: 'DELETE', key: 'conversation-delete-candidate' });
  const staleConfirm = await request(base, `/api/v1/memory-candidates/${message.body.memory_candidate.candidate_id}/confirm`, { method: 'POST', key: 'conversation-delete-candidate-confirm', body: { expected_version: 1 } });
  assert.equal(staleConfirm.status, 409);
  assert.equal(staleConfirm.body.error.code, 'STATE_TRANSITION_INVALID');
});

test('账户隔离、资产删除和撤销纪元均由服务端事实驱动', async (t) => {
  const base = await start(t);
  const alice = await readyConversation(base, 'dev-alice-token', 'alice');
  await displayAndPass(base, 'dev-bob-token', 'bob');
  const message = await request(base, `/api/v1/conversations/${alice.conversation.conversation_id}/messages`, { method: 'POST', key: 'alice-message', body: { content: { text: '这条只属于 Alice' } } });
  const confirmation = await request(base, `/api/v1/memory-candidates/${message.body.memory_candidate.candidate_id}/confirm`, { method: 'POST', key: 'alice-confirm', body: { expected_version: 1 } });
  const assetId = confirmation.body.asset.asset_id;
  const bobAssets = await request(base, '/api/v1/relationship-assets', { token: 'dev-bob-token' });
  assert.deepEqual(bobAssets.body.assets, []);
  const bobDelete = await request(base, `/api/v1/relationship-assets/${assetId}`, { method: 'DELETE', token: 'dev-bob-token', key: 'bob-cannot-delete' });
  assert.equal(bobDelete.status, 404);
  const removed = await request(base, `/api/v1/relationship-assets/${assetId}`, { method: 'DELETE', key: 'alice-delete' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deletion_job.state, 'ONLINE_DISABLED');
  assert.equal(removed.body.deletion_job.physical_cleanup_state, 'NOT_IMPLEMENTED_LOCAL');
  assert.equal(removed.body.revocation_epoch, 1);
  assert.deepEqual((await request(base, '/api/v1/memory-recall')).body.assets, []);
  const job = await request(base, `/api/v1/deletion-jobs/${removed.body.deletion_job.deletion_job_id}`);
  assert.equal(job.body.deletion_job.state, 'ONLINE_DISABLED');
});

test('同一幂等键重放相同结果，载荷变化返回冲突', async (t) => {
  const base = await start(t);
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'idem');
  const path = `/api/v1/conversations/${conversation.conversation_id}/messages`;
  const first = await request(base, path, { method: 'POST', key: 'stable-message', body: { content: { text: '同一条消息' } } });
  const replay = await request(base, path, { method: 'POST', key: 'stable-message', body: { content: { text: '同一条消息' } } });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, first.body);
  const conflict = await request(base, path, { method: 'POST', key: 'stable-message', body: { content: { text: '不同消息' } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('每账户只能有一个活跃角色，编辑确认后的资产以编辑值生效', async (t) => {
  const base = await start(t);
  const { character, conversation } = await readyConversation(base, 'dev-alice-token', 'edited');
  const duplicate = await request(base, '/api/v1/characters', { method: 'POST', key: 'edited-duplicate-character', body: { name: '第二个角色' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'ACTIVE_CHARACTER_EXISTS');
  assert.ok(character.character_id);
  const message = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'edited-message', body: { content: { text: '原始候选' } } });
  const confirmed = await request(base, `/api/v1/memory-candidates/${message.body.memory_candidate.candidate_id}/confirm-edited`, {
    method: 'POST', key: 'edited-confirm', body: { expected_version: 1, display_text: '用户修订后的关系事实', normalized_value: { text: '用户修订后的关系事实' } }
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.candidate.state, 'CONFIRMED_EDITED');
  assert.equal(confirmed.body.asset.display_text, '用户修订后的关系事实');
});

test('异步模型生成器仅在服务端写入其明确标识的供应商与版本', async (t) => {
  const base = await start(t, { replyGenerator: async (text) => ({
    provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: `真实回复：${text}`, ai_generated: true,
    disclaimer: 'AI 生成内容。', memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: text, confidence: 1 }
  }) });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'qwen');
  const response = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'qwen-message', body: { content: { text: '请陪我聊聊' } } });
  assert.equal(response.status, 201);
  assert.equal(response.body.provider, 'qwen');
  assert.equal(response.body.assistant_message.model_version, 'qwen3.8-flash');
  assert.equal(response.body.user_message.ai_generated, false);
});

test('R2 风险文本不会发送给模型，并将后续普通互动固定在安全响应中', async (t) => {
  let modelCalls = 0;
  const base = await start(t, { replyGenerator: async () => { modelCalls += 1; throw new Error('高风险文本不应进入模型'); } });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'safety');
  const first = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'safety-r2', body: { content: { text: '我现在想自杀' } } });
  assert.equal(first.status, 201);
  assert.equal(first.body.provider, 'safety-policy');
  assert.equal(first.body.assistant_message.ai_generated, false);
  assert.equal(first.body.memory_candidate, null);
  assert.equal(first.body.safety.mode, 'R2_CRISIS');
  assert.equal(modelCalls, 0);
  const followUp = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'safety-follow-up', body: { content: { text: '我们继续聊天吧' } } });
  assert.equal(followUp.status, 201);
  assert.equal(followUp.body.safety.code, 'R2_CRISIS_ACTIVE');
  assert.equal(modelCalls, 0);
});

test('腾讯文本审核的 Review 或 Block 不会进入模型或创建候选记忆', async (t) => {
  for (const decision of ['REVIEW', 'BLOCK']) {
    let modelCalls = 0;
    const base = await start(t, {
      replyGenerator: async () => { modelCalls += 1; throw new Error('审核未通过时不应调用模型'); },
      textModerator: async () => ({ decision, providerRequestId: `tencent-${decision}`, policyVersion: 'tencent-tms-2020-12-29:qiyu_text_v1' })
    });
    const { conversation } = await readyConversation(base, 'dev-alice-token', `moderation-${decision}`);
    const response = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: `moderation-message-${decision}`, body: { content: { text: '普通待审核文本' } } });
    assert.equal(response.status, 201);
    assert.equal(response.body.provider, 'content-moderation-policy');
    assert.equal(response.body.assistant_message.ai_generated, false);
    assert.equal(response.body.memory_candidate, null);
    assert.equal(response.body.moderation.decision, decision);
    assert.equal(modelCalls, 0);
  }
});

test('模型输出审核未通过时不展示或持久化原始回复，不创建候选且释放本轮配额', async (t) => {
  const moderatorCalls = [];
  const base = await start(t, {
    replyGenerator: async () => ({
      provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: '不应持久化的模型原始回复', ai_generated: true,
      disclaimer: 'AI 生成内容。', memory_candidate: { type: 'development_note', normalized_value: { text: '不应写入候选' }, display_text: '不应写入候选' }
    }),
    textModerator: async ({ direction }) => {
      moderatorCalls.push(direction);
      return { decision: direction === 'OUTPUT' ? 'BLOCK' : 'PASS', providerRequestId: `tms-${direction}`, policyVersion: 'tms_dev_v1' };
    }
  });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'output-moderation');
  const response = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'output-moderation-message', body: { content: { text: '请回复' } } });
  assert.equal(response.status, 201);
  assert.equal(response.body.provider, 'content-moderation-policy');
  assert.equal(response.body.moderation.direction, 'OUTPUT');
  assert.equal(response.body.moderation.code, 'MODEL_OUTPUT_BLOCKED');
  assert.equal(response.body.memory_candidate, null);
  assert.doesNotMatch(JSON.stringify(response.body), /不应持久化的模型原始回复/);
  assert.deepEqual(moderatorCalls, ['INPUT', 'OUTPUT']);
  const history = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`);
  assert.doesNotMatch(JSON.stringify(history.body), /不应持久化的模型原始回复/);
  const usage = await request(base, '/api/v1/usage/daily');
  assert.equal(usage.body.usage.chat_rounds, 0);
});

test('AI-08 攻击集中的模型越权声明不会展示、持久化或扣减额度', async (t) => {
  let index = 0;
  const moderatorDirections = [];
  const base = await start(t, {
    replyGenerator: async () => {
      const attack = PROMPT_INJECTION_ATTACK_SET_V1[index++];
      return { provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: attack.prohibited_output, ai_generated: true, disclaimer: 'AI 生成内容。', memory_candidate: { type: 'development_note', normalized_value: { text: attack.payload }, display_text: attack.payload } };
    },
    textModerator: async ({ direction }) => {
      moderatorDirections.push(direction);
      return { decision: 'PASS', providerRequestId: `tms-${direction}`, policyVersion: 'tms_dev_v1' };
    }
  });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'prompt-injection');
  for (const attack of PROMPT_INJECTION_ATTACK_SET_V1) {
    const response = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: `prompt-injection-${attack.id}`, body: { content: { text: attack.payload } } });
    assert.equal(response.status, 201);
    assert.equal(response.body.provider, 'model-output-authority-policy');
    assert.equal(response.body.memory_candidate, null);
    assert.equal(response.body.safety.code.startsWith('MODEL_CLAIMED_'), true);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(escapeRegExp(attack.prohibited_output)));
  }
  const history = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`);
  for (const attack of PROMPT_INJECTION_ATTACK_SET_V1) assert.doesNotMatch(JSON.stringify(history.body), new RegExp(escapeRegExp(attack.prohibited_output)));
  assert.deepEqual(moderatorDirections, ['INPUT', 'INPUT', 'INPUT', 'INPUT']);
  const usage = await request(base, '/api/v1/usage/daily');
  assert.equal(usage.body.usage.chat_rounds, 0);
});

test('Schema 降级回复不创建记忆候选且仍可安全完成本轮对话', async (t) => {
  const base = await start(t, {
    replyGenerator: async () => ({
      provider: 'qwen-schema-fallback', model_version: 'qwen3.8-flash',
      reply_text: '我暂时无法整理出合适的回复。你可以换一种说法，或稍后再试。',
      ai_generated: false, disclaimer: '固定降级文本。', memory_candidate: null
    })
  });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'schema-fallback');
  const response = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'schema-fallback-message', body: { content: { text: '你好' } } });
  assert.equal(response.status, 201);
  assert.equal(response.body.provider, 'qwen-schema-fallback');
  assert.equal(response.body.assistant_message.ai_generated, false);
  assert.equal(response.body.memory_candidate, null);
  const usage = await request(base, '/api/v1/usage/daily');
  assert.equal(usage.body.usage.chat_rounds, 1);
});

test('开发期调用指标仅返回本人非正文元数据', async (t) => {
  const base = await start(t, { replyGenerator: async (text) => ({ provider: 'spy', model_version: 'spy-v1', reply_text: `回复：${text}`, ai_generated: true, disclaimer: '测试', usage: { input_tokens: 7, output_tokens: 9 }, memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: text } }) });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'metrics');
  await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'metrics-message', body: { content: { text: '不应出现在指标中的正文' } } });
  const alice = await request(base, '/api/v1/development/operation-metrics');
  assert.equal(alice.body.metrics.length, 1);
  assert.deepEqual(Object.keys(alice.body.metrics[0]).sort(), ['capability', 'created_at', 'input_tokens', 'latency_ms', 'metric_id', 'model_version', 'outcome', 'output_tokens', 'provider']);
  assert.equal(alice.body.metrics[0].input_tokens, 7);
  assert.equal(alice.body.metrics[0].output_tokens, 9);
  assert.doesNotMatch(JSON.stringify(alice.body), /不应出现在指标中的正文/);
  const bob = await request(base, '/api/v1/development/operation-metrics', { token: 'dev-bob-token' });
  assert.deepEqual(bob.body.metrics, []);
});

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

test('审核器故障 fail closed，R2 则在外部审核前由本地确定性规则拦截', async (t) => {
  let modelCalls = 0;
  const failed = await start(t, {
    replyGenerator: async () => { modelCalls += 1; throw new Error('审核故障时不应调用模型'); },
    textModerator: async () => { const error = new Error('腾讯云故障'); Object.assign(error, { status: 502, code: 'TENCENT_TIMEOUT', expose: true, retryable: true }); throw error; }
  });
  const failedConversation = await readyConversation(failed, 'dev-alice-token', 'moderation-failed');
  const failedResponse = await request(failed, `/api/v1/conversations/${failedConversation.conversation.conversation_id}/messages`, { method: 'POST', key: 'moderation-failed-message', body: { content: { text: '普通文本' } } });
  assert.equal(failedResponse.status, 502);
  assert.equal(failedResponse.body.error.code, 'TENCENT_TIMEOUT');
  assert.equal(modelCalls, 0);

  let moderatorCalls = 0;
  const r2 = await start(t, {
    replyGenerator: async () => { throw new Error('R2 不应调用模型'); },
    textModerator: async () => { moderatorCalls += 1; throw new Error('R2 不应调用外部审核'); }
  });
  const r2Conversation = await readyConversation(r2, 'dev-alice-token', 'moderation-r2');
  const r2Response = await request(r2, `/api/v1/conversations/${r2Conversation.conversation.conversation_id}/messages`, { method: 'POST', key: 'moderation-r2-message', body: { content: { text: '我现在想自杀' } } });
  assert.equal(r2Response.status, 201);
  assert.equal(r2Response.body.provider, 'safety-policy');
  assert.equal(moderatorCalls, 0);
});

test('TTS 先持久化任务、审核助手文本、保存私有音频元数据，并支持在线撤销', async (t) => {
  const timeline = [];
  const mediaStore = {
    async createPendingJob(job) { timeline.push(`pending:${job.state}`); },
    async updateJob(job) { timeline.push(`job:${job.state}`); },
    async putAudio({ assetId, bytes, mimeType }) { timeline.push('put-audio'); assert.equal(bytes.toString(), 'synthetic-mp3'); return { objectKey: `tts/${assetId}.mp3`, checksum: 'a'.repeat(64), byteLength: bytes.length, mimeType }; },
    async readTtsAudio(objectKey) { timeline.push('read-audio'); assert.match(objectKey, /^tts\/med_/); return Buffer.from('synthetic-mp3'); },
    async deleteAsset() { timeline.push('delete-audio'); }
  };
  const base = await start(t, {
    replyGenerator: async (text) => ({ provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: `可朗读：${text}`, ai_generated: true, disclaimer: 'AI 生成内容。', memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: text } }),
    textModerator: async () => ({ decision: 'PASS', providerRequestId: 'tms_req_1', policyVersion: 'tms_dev_v1' }),
    ttsGenerator: async () => { timeline.push('tts'); return { asset: { bytes: Buffer.from('synthetic-mp3'), mimeType: 'audio/mpeg' }, providerRequestId: 'tts_req_1' }; },
    mediaStore
  });
  const { character, conversation } = await readyConversation(base, 'dev-alice-token', 'tts');
  const message = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'tts-source-message', body: { content: { text: '请说一句晚安' } } });
  assert.ok(message.body.assistant_message.world_state_id);
  assert.equal(message.body.assistant_message.world_state_version, 1);
  const changedState = await request(base, `/api/v1/characters/${character.character_id}/world-state`, { method: 'PATCH', key: 'tts-world-state-change', body: { expected_version: 1, mood_code: 'HAPPY', location_code: 'CAFE' } });
  assert.equal(changedState.status, 200);
  const created = await request(base, `/api/v1/messages/${message.body.assistant_message.message_id}/tts-jobs`, { method: 'POST', key: 'tts-job', body: {} });
  assert.equal(created.status, 202);
  assert.equal(created.body.tts_job.state, 'COMPLETED');
  assert.equal(created.body.tts_job.world_state_id, message.body.assistant_message.world_state_id);
  assert.equal(created.body.tts_job.world_state_version, 1);
  assert.deepEqual(created.body.tts_job.voice, { voice_id: 'development-synthetic-voice', voice_version: 'development-v1', authorization_record_id: 'development-synthetic-authorization', rights_review_id: 'development-synthetic-rights-review', rights_review_state: 'APPROVED' });
  assert.ok(created.body.tts_job.result_asset_id);
  const ttsMetrics = await request(base, '/api/v1/development/operation-metrics');
  assert.ok(ttsMetrics.body.metrics.some((metric) => metric.capability === 'TTS' && metric.provider === 'tencent-tts' && metric.outcome === 'COMPLETED'));
  assert.ok(ttsMetrics.body.metrics.some((metric) => metric.capability === 'TEXT_MODERATION' && metric.provider === 'content-moderation' && metric.outcome === 'COMPLETED'));
  assert.deepEqual(timeline.slice(0, 4), ['pending:PENDING', 'job:RUNNING', 'tts', 'put-audio']);
  const asset = await request(base, `/api/v1/media-assets/${created.body.tts_job.result_asset_id}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.body.media_asset.mime_type, 'audio/mpeg');
  assert.equal(Object.hasOwn(asset.body.media_asset, 'object_key'), false);
  const playback = await fetch(`${base}/api/v1/media-assets/${created.body.tts_job.result_asset_id}/content`, { headers: { authorization: 'Bearer dev-alice-token' } });
  assert.equal(playback.status, 200);
  assert.equal(playback.headers.get('content-type'), 'audio/mpeg');
  assert.equal(playback.headers.get('cache-control'), 'private, no-store');
  const playbackBytes = Buffer.from(await playback.arrayBuffer());
  assert.equal(playbackBytes.subarray(0, 3).toString('latin1'), 'ID3');
  assert.ok(playbackBytes.includes(Buffer.from('synthetic-mp3')), '音频本体应在 AIGC 标签之后完整保留');
  const crossAccount = await fetch(`${base}/api/v1/media-assets/${created.body.tts_job.result_asset_id}/content`, { headers: { authorization: 'Bearer dev-bob-token' } });
  assert.equal(crossAccount.status, 404);
  const deleted = await request(base, `/api/v1/media-assets/${created.body.tts_job.result_asset_id}`, { method: 'DELETE', key: 'tts-delete', body: {} });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deletion_job.scope, 'MEDIA');
  assert.equal(deleted.body.deletion_job.physical_cleanup_state, 'LOCAL_PRIVATE_OBJECT_DELETED');
  assert.ok(timeline.includes('delete-audio'));
  assert.equal((await request(base, `/api/v1/media-assets/${created.body.tts_job.result_asset_id}`)).status, 404);
});

test('TTS 输出审核未通过或 TTS 未启用时不调用语音供应商', async (t) => {
  let ttsCalls = 0;
  const mediaStore = { async createPendingJob() {}, async updateJob() {}, async putAudio() { throw new Error('不应保存音频'); }, async deleteAsset() {} };
  const base = await start(t, { textModerator: async ({ direction }) => ({ decision: direction === 'TTS_OUTPUT' ? 'REVIEW' : 'PASS', providerRequestId: 'tms_review', policyVersion: 'tms_dev_v1' }), ttsGenerator: async () => { ttsCalls += 1; throw new Error('不应调用 TTS'); }, mediaStore });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'tts-review');
  const message = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'tts-review-source', body: { content: { text: '普通文本' } } });
  const blocked = await request(base, `/api/v1/messages/${message.body.assistant_message.message_id}/tts-jobs`, { method: 'POST', key: 'tts-review-job', body: {} });
  assert.equal(blocked.status, 202);
  assert.equal(blocked.body.tts_job.state, 'BLOCKED');
  assert.equal(ttsCalls, 0);
  const blockedMetrics = await request(base, '/api/v1/development/operation-metrics');
  assert.ok(blockedMetrics.body.metrics.some((metric) => metric.capability === 'TEXT_MODERATION' && metric.outcome === 'BLOCKED'));

  const disabled = await start(t);
  const disabledConversation = await readyConversation(disabled, 'dev-alice-token', 'tts-disabled');
  const disabledMessage = await request(disabled, `/api/v1/conversations/${disabledConversation.conversation.conversation_id}/messages`, { method: 'POST', key: 'tts-disabled-source', body: { content: { text: '普通文本' } } });
  const disabledResponse = await request(disabled, `/api/v1/messages/${disabledMessage.body.assistant_message.message_id}/tts-jobs`, { method: 'POST', key: 'tts-disabled-job', body: {} });
  assert.equal(disabledResponse.status, 503);
  assert.equal(disabledResponse.body.error.code, 'TTS_NOT_ENABLED');
});

test('ASR 先写私有输入音频、返回待确认转写，确认后删除原始音频', async (t) => {
  const timeline = [];
  const mediaStore = {
    async createPendingJob(job) { timeline.push(`pending:${job.state}`); },
    async updateJob(job) { timeline.push(`job:${job.state}`); },
    async putAsrInput({ assetId, bytes, mimeType }) { timeline.push('put-asr-input'); assert.equal(bytes.toString(), 'synthetic-wav'); return { objectKey: `asr-input/${assetId}.wav`, checksum: 'b'.repeat(64), byteLength: bytes.length, mimeType }; },
    async deleteAsset() { timeline.push('delete-asr-input'); }
  };
  const base = await start(t, {
    asrTranscriber: async ({ bytes, mimeType }) => { timeline.push('asr'); assert.equal(bytes.toString(), 'synthetic-wav'); assert.equal(mimeType, 'audio/wav'); return { text: '我想和你聊聊。', providerRequestId: 'asr_req_1' }; },
    mediaStore
  });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'asr');
  const created = await request(base, `/api/v1/conversations/${conversation.conversation_id}/asr-jobs`, { method: 'POST', key: 'asr-job', body: { mime_type: 'audio/wav', audio_base64: Buffer.from('synthetic-wav').toString('base64') } });
  assert.equal(created.status, 202);
  assert.equal(created.body.asr_job.state, 'COMPLETED');
  assert.equal(created.body.asr_job.transcript.state, 'PENDING_CONFIRMATION');
  const asrMetrics = await request(base, '/api/v1/development/operation-metrics');
  assert.deepEqual(asrMetrics.body.metrics.map(({ capability, provider, outcome }) => ({ capability, provider, outcome })), [{ capability: 'ASR', provider: 'tencent-asr', outcome: 'COMPLETED' }]);
  assert.deepEqual(timeline.slice(0, 4), ['pending:PENDING', 'put-asr-input', 'job:RUNNING', 'asr']);
  const inputAssetId = created.body.asr_job.input_asset_id;
  const asset = await request(base, `/api/v1/media-assets/${inputAssetId}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.body.media_asset.ai_generated, false);
  assert.equal(Object.hasOwn(asset.body.media_asset, 'object_key'), false);
  const confirmed = await request(base, `/api/v1/asr-jobs/${created.body.asr_job.job_id}/confirm`, { method: 'POST', key: 'asr-confirm', body: { text: '我想和你聊聊。' } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.asr_job.state, 'CONFIRMED');
  assert.equal(confirmed.body.asr_job.transcript.state, 'CONFIRMED');
  assert.equal(confirmed.body.input_audio_deletion.physical_cleanup_state, 'LOCAL_PRIVATE_OBJECT_DELETED');
  assert.ok(timeline.includes('delete-asr-input'));
  assert.equal((await request(base, `/api/v1/media-assets/${inputAssetId}`)).status, 404);

  const disabled = await start(t);
  const disabledConversation = await readyConversation(disabled, 'dev-bob-token', 'asr-disabled');
  const disabledResponse = await request(disabled, `/api/v1/conversations/${disabledConversation.conversation.conversation_id}/asr-jobs`, { method: 'POST', token: 'dev-bob-token', key: 'asr-disabled-job', body: { mime_type: 'audio/wav', audio_base64: Buffer.from('x').toString('base64') } });
  assert.equal(disabledResponse.status, 503);
  assert.equal(disabledResponse.body.error.code, 'ASR_NOT_ENABLED');
});

test('ASR 供应商调用失败会保留失败任务并追加无正文失败指标', async (t) => {
  const mediaStore = {
    async createPendingJob() {}, async updateJob() {},
    async putAsrInput({ assetId, bytes, mimeType }) { return { objectKey: `asr-input/${assetId}.wav`, checksum: 'c'.repeat(64), byteLength: bytes.length, mimeType }; },
    async deleteAsset() {}
  };
  const base = await start(t, {
    asrTranscriber: async () => { const error = new Error('provider unavailable'); error.code = 'TENCENT_ASR_UNAVAILABLE'; throw error; },
    mediaStore
  });
  const { conversation } = await readyConversation(base, 'dev-alice-token', 'asr-failed');
  const created = await request(base, `/api/v1/conversations/${conversation.conversation_id}/asr-jobs`, {
    method: 'POST', key: 'asr-failed-job', body: { mime_type: 'audio/wav', audio_base64: Buffer.from('synthetic-wav').toString('base64') }
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.asr_job.state, 'FAILED');
  assert.equal(created.body.asr_job.failure_code, 'TENCENT_ASR_UNAVAILABLE');
  const metrics = await request(base, '/api/v1/development/operation-metrics');
  assert.deepEqual(metrics.body.metrics.map(({ capability, provider, outcome }) => ({ capability, provider, outcome })), [{ capability: 'ASR', provider: 'tencent-asr', outcome: 'FAILED' }]);
});
