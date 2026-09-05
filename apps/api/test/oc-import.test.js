'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

async function start(t) { const server = createApp(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve))); return `http://127.0.0.1:${server.address().port}`; }
async function request(base, path, { method = 'GET', key, body } = {}) { const headers = { authorization: 'Bearer dev-alice-token' }; if (key) headers['idempotency-key'] = key; if (body !== undefined) headers['content-type'] = 'application/json'; const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function passAge(base) { const notices = await request(base, '/api/v1/required-notices'); await request(base, `/api/v1/required-notices/${notices.body.notices[0].notice_id}/displayed`, { method: 'POST', key: 'notice', body: { notice_version: notices.body.notices[0].notice_version } }); await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'age', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } }); }

test('OC 导入要求权利声明、默认隔离并提供可申诉审核记录', async (t) => {
  const base = await start(t);
  await passAge(base);
  const missing = await request(base, '/api/v1/characters/imports', { method: 'POST', key: 'missing', body: { source_text: '性格：冷静' } });
  assert.equal(missing.status, 422);
  assert.equal(missing.body.error.code, 'OC_RIGHTS_REVIEW_REQUIRED');
  const imported = await request(base, '/api/v1/characters/imports', { method: 'POST', key: 'import', body: { original_or_authorized: true, declaration_version: 'oc-rights-v1', source_text: '世界观：海边小城\n性格：冷静温柔\n表达风格：短句' } });
  assert.equal(imported.status, 202);
  assert.equal(imported.body.oc_import.state, 'REVIEW_REQUIRED');
  assert.equal(imported.body.oc_import.proposed_persona.personality, '冷静温柔');
  assert.equal(imported.body.content_rights_review.state, 'REVIEW_REQUIRED');
  assert.ok(imported.body.content_rights_review.risk_codes.includes('MANUAL_RIGHTS_REVIEW_REQUIRED'));
  const create = await request(base, '/api/v1/characters', { method: 'POST', key: 'create-from-unapproved', body: { name: '不应创建', import_id: imported.body.oc_import.import_id } });
  assert.equal(create.status, 422);
  const read = await request(base, `/api/v1/content-rights-reviews/${imported.body.content_rights_review.review_id}`);
  assert.equal(read.status, 200);
  const appeal = await request(base, `/api/v1/content-rights-reviews/${imported.body.content_rights_review.review_id}/appeals`, { method: 'POST', key: 'appeal', body: { statement: '我确认拥有原创权利，可按要求补充证明。' } });
  assert.equal(appeal.status, 202);
  assert.equal(appeal.body.appeal.state, 'SUBMITTED');
});

test('OC 风险信号只进入复核理由码，绝不当作侵权事实或自动批准', async (t) => {
  const base = await start(t);
  await passAge(base);
  const imported = await request(base, '/api/v1/characters/imports', { method: 'POST', key: 'risky-import', body: { original_or_authorized: true, source_text: '这是我现实中的同学，想复刻她的声音。' } });
  assert.equal(imported.status, 202);
  assert.equal(imported.body.content_rights_review.state, 'REVIEW_REQUIRED');
  assert.ok(imported.body.content_rights_review.risk_codes.includes('REAL_PERSON_FACE'));
  assert.ok(imported.body.content_rights_review.risk_codes.includes('VOICE_CLONE_RISK'));
});
