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

const PERSONA = {
  worldview: '近未来海边小城的插画师',
  age_setting: '27',
  relationship_to_user: '温柔可靠的朋友',
  personality: '安静、观察力强、偶尔冷幽默',
  expression_style: '短句为主，喜欢用画面感的比喻',
  hard_boundaries: ['不复刻任何真人', '不讨论自伤方法'],
  example_behaviors: ['用户难过时先承认情绪再给建议']
};

async function passAge(base, prefix, token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

test('创建角色可携带人格档案，读取时返回档案与版本记录', async (t) => {
  const base = await start(t);
  await passAge(base, 'persona-create');
  const created = await request(base, '/api/v1/characters', { method: 'POST', key: 'p-create', body: { name: '林默', persona: PERSONA } });
  assert.equal(created.status, 201);
  assert.equal(created.body.character.version, 1);
  assert.equal(created.body.character.persona.worldview, PERSONA.worldview);
  assert.deepEqual(created.body.character.persona.hard_boundaries, PERSONA.hard_boundaries);

  const fetched = await request(base, `/api/v1/characters/${created.body.character.character_id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.character.persona.personality, PERSONA.personality);
  assert.equal(fetched.body.character.persona_history.length, 1);
  assert.equal(fetched.body.character.persona_history[0].version, 1);
  assert.equal(fetched.body.character.persona_history[0].note, '创建角色');

  // 不带 persona 的创建返回空档案，字段齐全（用第二个开发账户避开单角色限制）。
  await passAge(base, 'persona-bob', 'dev-bob-token');
  const plain = await request(base, '/api/v1/characters', { method: 'POST', token: 'dev-bob-token', key: 'p-plain', body: { name: '简化角色' } });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.character.persona.worldview, '');
  assert.deepEqual(plain.body.character.persona.hard_boundaries, []);
});

test('人格内容不能由普通 PATCH 直接稳定发布，必须通过草稿流程', async (t) => {
  const base = await start(t);
  await passAge(base, 'persona-edit');
  const created = await request(base, '/api/v1/characters', { method: 'POST', key: 'pe-create', body: { name: '林默', persona: PERSONA } });
  const id = created.body.character.character_id;

  const conflict = await request(base, `/api/v1/characters/${id}`, { method: 'PATCH', key: 'pe-conflict', body: { expected_version: 99, persona: { ...PERSONA, personality: '热情外向' } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');

  const directPersona = await request(base, `/api/v1/characters/${id}`, { method: 'PATCH', key: 'pe-direct-persona', body: { expected_version: 1, persona: { ...PERSONA, personality: '热情外向' }, note: '调整性格' } });
  assert.equal(directPersona.status, 409);
  assert.equal(directPersona.body.error.code, 'PERSONA_DRAFT_REQUIRED');
  const renamed = await request(base, `/api/v1/characters/${id}`, { method: 'PATCH', key: 'pe-rename', body: { expected_version: 1, name: '林默（改名）' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.character.name, '林默（改名）');
  assert.equal(renamed.body.character.active_persona_version, 1);
  assert.equal(renamed.body.character.persona_history.length, 1);

  // 他人角色不可读写。
  const foreign = await request(base, `/api/v1/characters/${id}`, { method: 'PATCH', token: 'dev-bob-token', key: 'pe-foreign', body: { expected_version: 2 } });
  assert.equal(foreign.status, 404);
});

test('人格字段校验拒绝超长、错误类型与未知字段', async (t) => {
  const base = await start(t);
  await passAge(base, 'persona-validate');
  const overlong = await request(base, '/api/v1/characters', { method: 'POST', key: 'pv-long', body: { name: '超长', persona: { worldview: '字'.repeat(501) } } });
  assert.equal(overlong.status, 400);
  const wrongType = await request(base, '/api/v1/characters', { method: 'POST', key: 'pv-type', body: { name: '类型', persona: { hard_boundaries: '不是数组' } } });
  assert.equal(wrongType.status, 400);
  const unknown = await request(base, '/api/v1/characters', { method: 'POST', key: 'pv-unknown', body: { name: '未知', persona: { secret_field: 'x' } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error.message, /secret_field/);
});

test('模型上下文包包含当前人格档案', async (t) => {
  const observed = [];
  const base = await start(t, {
    replyGenerator: async (text, context) => {
      observed.push(context);
      return { provider: 'spy', model_version: 'spy-v1', reply_text: `回复：${text}`, ai_generated: true, disclaimer: '测试生成器。', memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: text } };
    }
  });
  await passAge(base, 'persona-context');
  const created = await request(base, '/api/v1/characters', { method: 'POST', key: 'pc-create', body: { name: '林默', persona: PERSONA } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'pc-conv', body: { character_id: created.body.character.character_id } });
  await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'pc-msg', body: { content: { text: '你好' } } });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].character.persona.worldview, PERSONA.worldview);
  assert.deepEqual(observed[0].character.persona.hard_boundaries, PERSONA.hard_boundaries);
});

test('人格草稿只能经审核员评测、影子、受限灰度后发布，并能回退上一稳定版本', async (t) => {
  const base = await start(t);
  await passAge(base, 'persona-release');
  const created = await request(base, '/api/v1/characters', { method: 'POST', key: 'pr-create', body: { name: '林默', persona: PERSONA } });
  const id = created.body.character.character_id;
  const draft = await request(base, `/api/v1/characters/${id}/persona-versions`, { method: 'POST', key: 'pr-draft', body: { expected_version: 1, persona: { ...PERSONA, personality: '更轻快，但仍尊重边界' }, note: '准备灰度的新表达' } });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.persona_version.state, 'DRAFT');
  assert.equal(draft.body.character.persona.personality, PERSONA.personality);
  const reviewer = 'reviewer-dev-token';
  const postReview = (suffix, body) => request(base, `/internal/persona-versions/${id}/2/${suffix}`, { method: 'POST', token: reviewer, key: `pr-${suffix}`, body });
  const evaluated = await postReview('evaluate', { suite_version: 'persona-golden-v1', critical_pass_rate: 1, overall_pass_rate: 0.95, report_ref: 'eval-pr-2' });
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.body.persona_version.state, 'EVALUATING');
  const shadow = await postReview('shadow', {});
  assert.equal(shadow.body.persona_version.state, 'SHADOW');
  const oversized = await postReview('canary', { traffic_percent: 11, shadow_report_ref: 'shadow-pr-2' });
  assert.equal(oversized.status, 409);
  assert.equal(oversized.body.error.code, 'PERSONA_CANARY_TRAFFIC_INVALID');
  const canary = await postReview('canary', { traffic_percent: 5, shadow_report_ref: 'shadow-pr-2' });
  assert.equal(canary.body.persona_version.state, 'CANARY');
  // stable 发布受双人审批门保护：发布员申请，另一名具备权限的账号批准（不同账号）。
  const blocked = await postReview('stable', { canary_report_ref: 'canary-pr-2' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'DUAL_APPROVAL_REQUIRED');
  const releaseLogin = await request(base, '/internal/auth/login', { method: 'POST', key: 'pr-login-1', body: { username: 'dev-release', password: 'dev-release-local-only' } });
  assert.equal(releaseLogin.status, 201);
  const approval = await request(base, '/internal/dual-approvals', { method: 'POST', token: releaseLogin.body.session_token, key: 'pr-appr', body: { action: 'PERSONA_STABLE_RELEASE', target_id: `${id}@v2`, reason: '灰度报告已复核，申请发布' } });
  assert.equal(approval.status, 201);
  const adminLogin = await request(base, '/internal/auth/login', { method: 'POST', key: 'pr-login-2', body: { username: 'dev-release-admin', password: 'dev-release-admin-local' } });
  const approved = await request(base, `/internal/dual-approvals/${approval.body.dual_approval.approval_id}/decisions`, { method: 'POST', token: adminLogin.body.session_token, key: 'pr-appr-dec', body: { decision: 'APPROVE', reason: '第二审批人核对灰度报告' } });
  assert.equal(approved.body.dual_approval.state, 'APPROVED');
  const stable = await postReview('stable', { canary_report_ref: 'canary-pr-2' });
  assert.equal(stable.body.persona_version.state, 'STABLE');
  assert.equal(stable.body.character.persona.personality, '更轻快，但仍尊重边界');
  const rollback = await postReview('rollback', { rollback_to_version: 1, reason: '发现 OOC Bad Case' });
  assert.equal(rollback.body.rolled_back.state, 'ROLLED_BACK');
  assert.equal(rollback.body.restored.state, 'STABLE');
  assert.equal(rollback.body.character.persona.personality, PERSONA.personality);
  const releases = await request(base, '/internal/persona-releases', { token: reviewer });
  assert.equal(releases.status, 200);
  assert.equal(releases.body.persona_releases[0].active_persona_version, 1);
});
