'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { runRetentionSweep, startRetentionWorker } = require('../src/domain/retention-worker');
const { tagWithAigcMetadata } = require('../src/media/aigc-metadata');

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, path, { method = 'GET', token = 'dev-alice-token', key, body, headers } = {}) {
  const allHeaders = { authorization: `Bearer ${token}`, ...(headers || {}) };
  if (key) allHeaders['idempotency-key'] = key;
  if (body !== undefined) allHeaders['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers: allHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function passAge(base, prefix, token = 'dev-alice-token') {
  const notices = await request(base, '/api/v1/required-notices', { token });
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', token, key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
}

test('注册鉴权骨架：挑战→注册→Token 可用→刷新轮换', async (t) => {
  const base = await start(t);

  const badPhone = await request(base, '/api/v1/auth/sms-challenges', { method: 'POST', key: 'au-0', body: { phone: '123' }, headers: { authorization: '' } });
  assert.equal(badPhone.status, 400);

  const challenge = await request(base, '/api/v1/auth/sms-challenges', { method: 'POST', key: 'au-1', body: { phone: '13800001111' }, headers: { authorization: '' } });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.dev_code, '000000');

  const badCode = await request(base, '/api/v1/auth/register', { method: 'POST', key: 'au-2', body: { phone: '13800001111', code: '111111' }, headers: { authorization: '' } });
  assert.equal(badCode.status, 400);

  const registered = await request(base, '/api/v1/auth/register', { method: 'POST', key: 'au-3', body: { phone: '13800001111', code: '000000' }, headers: { authorization: '' } });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.account.age_status, 'AGE_UNVERIFIED');
  const accessToken = registered.body.tokens.access_token;

  // 新注册账户走完整准入流程后可用动态 Token 互动。
  const notices = await request(base, '/api/v1/required-notices', { token: accessToken });
  assert.equal(notices.status, 200);
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token: accessToken, key: 'au-4', body: { notice_version: notice.notice_version } });
  const age = await request(base, '/api/v1/age/declarations', { method: 'POST', token: accessToken, key: 'au-5', body: { date_of_birth: '1991-02-02', confirmed_18_plus: true } });
  assert.equal(age.body.status, 'AGE_PASS');
  const character = await request(base, '/api/v1/characters', { method: 'POST', token: accessToken, key: 'au-6', body: { name: '动态账户角色' } });
  assert.equal(character.status, 201);

  // 重复注册同号被拒（需新挑战，旧挑战已被消耗）；刷新轮换旧 Token。
  await request(base, '/api/v1/auth/sms-challenges', { method: 'POST', key: 'au-6b', body: { phone: '13800001111' }, headers: { authorization: '' } });
  const duplicate = await request(base, '/api/v1/auth/register', { method: 'POST', key: 'au-7', body: { phone: '13800001111', code: '000000' }, headers: { authorization: '' } });
  assert.equal(duplicate.status, 409);
  const refreshed = await request(base, '/api/v1/auth/refresh', { method: 'POST', key: 'au-8', body: { refresh_token: registered.body.tokens.refresh_token }, headers: { authorization: '' } });
  assert.equal(refreshed.status, 200);
  const oldRefresh = await request(base, '/api/v1/auth/refresh', { method: 'POST', key: 'au-9', body: { refresh_token: registered.body.tokens.refresh_token }, headers: { authorization: '' } });
  assert.equal(oldRefresh.status, 401);
});

test('TTS 音频交付携带不可移除的 ID3 AIGC 标识', async () => {
  const raw = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 0x01)]);
  const tagged = tagWithAigcMetadata(raw);
  assert.equal(tagged.subarray(0, 3).toString('latin1'), 'ID3');
  assert.equal(tagged[3], 3);
  assert.ok(tagged.includes(Buffer.from('qiyu_aigc', 'utf16le')), '应包含 TXXX 标识帧（UTF-16）');
  // 音频本体保留在标签之后，且重复打标不叠加。
  assert.ok(tagged.subarray(tagged.length - raw.length).equals(raw), '原始音频字节应完整保留');
  assert.equal(tagWithAigcMetadata(tagged), tagged);
  // 标签大小为 syncsafe 编码：标签总长 = 10 + 声明大小。
  const size = (tagged[6] << 21) | (tagged[7] << 14) | (tagged[8] << 7) | tagged[9];
  assert.equal(tagged.length - raw.length, 10 + size);
});

test('图片交付隐式 AIGC 标识：PNG tEXt 与 JPEG COM 注入且幂等，非图片字节拒绝', () => {
  const { crc32 } = require('node:zlib');
  const { tagPngWithAigcMetadata, tagJpegWithAigcMetadata } = require('../src/media/aigc-metadata');
  // 构造最小 PNG：签名 + IHDR + IEND。
  const ihdrData = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])]);
  const ihdr = pngChunkForTest('IHDR', ihdrData, crc32);
  const iend = pngChunkForTest('IEND', Buffer.alloc(0), crc32);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, iend]);
  const taggedPng = tagPngWithAigcMetadata(png);
  assert.ok(taggedPng.includes(Buffer.from('qiyu_aigc')), 'PNG 应含 qiyu_aigc tEXt');
  assert.equal(tagPngWithAigcMetadata(taggedPng), taggedPng, '重复打标幂等');
  assert.ok(taggedPng.length > png.length, 'tEXt 块被插入');
  assert.ok(taggedPng.subarray(taggedPng.length - iend.length).equals(iend), 'IEND 仍收尾（结构合法）');
  // 标识块必须出现在 IHDR 之后（合法位置）。
  assert.ok(taggedPng.subarray(33, 58).includes(Buffer.from('tEXt')), 'tEXt 应紧跟 IHDR');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(60, 0xab), Buffer.from([0xff, 0xd9])]);
  const taggedJpeg = tagJpegWithAigcMetadata(jpeg);
  assert.equal(taggedJpeg[2], 0xff, 'COM 段紧跟 SOI');
  assert.equal(taggedJpeg[3], 0xfe, 'COM 标记');
  assert.ok(taggedJpeg.includes(Buffer.from('qiyu_aigc')), 'JPEG 应含 qiyu_aigc 注释');
  assert.equal(tagJpegWithAigcMetadata(taggedJpeg), taggedJpeg, '重复打标幂等');
  // 非对应格式拒绝（不得悄悄产出坏文件）。
  assert.throws(() => tagPngWithAigcMetadata(jpeg), /not a PNG/);
  assert.throws(() => tagJpegWithAigcMetadata(png), /not a JPEG/);
});

function pngChunkForTest(type, data, crc32Fn) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Fn(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

test('关系档案导出携带顶层 AIGC 声明与逐消息 ai_generated 标记', async (t) => {
  const { DevelopmentStore } = require('../src/domain/store');
  const store = new DevelopmentStore();
  const base = await start(t, { store });
  const notices = await request(base, '/api/v1/required-notices');
  await request(base, `/api/v1/required-notices/${notices.body.notices[0].notice_id}/displayed`, { method: 'POST', key: 'aigc-export-n', body: { notice_version: notices.body.notices[0].notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: 'aigc-export-a', body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: 'aigc-export-c', body: { name: '声明角色' } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: 'aigc-export-v', body: { character_id: character.body.character.character_id } });
  await request(base, `/api/v1/conversations/${conversation.body.conversation.conversation_id}/messages`, { method: 'POST', key: 'aigc-export-m', body: { content: { text: '记录一条' } } });
  const exported = await request(base, '/api/v1/data-exports/relationship-profile');
  assert.equal(exported.body.export.aigc_disclosure.audio_implicit_label, 'qiyu-aigc-id3v2.3-v1');
  assert.equal(exported.body.export.aigc_disclosure.image_implicit_label, 'qiyu-aigc-image-metadata-v1');
  const assistant = exported.body.export.messages.find((message) => message.actor === 'ASSISTANT');
  assert.equal(assistant.ai_generated, true);
  assert.ok(assistant.provider, '逐消息保留 provider 供溯源');
});

test('保留期 Worker：过期原始消息清理与 24 小时 ASR 原始音频下线', () => {
  const store = new DevelopmentStore();
  const account = store.account('acct_dev_alice');
  const now = new Date('2026-09-04T12:00:00Z');
  const conversation = { conversation_id: 'cnv_sweep', account_id: account.account_id, character_id: 'chr_x', status: 'OPEN', created_at: '2026-06-01T00:00:00Z' };
  store.conversations.set(conversation.conversation_id, conversation);
  store.messages.set('msg_old', { message_id: 'msg_old', conversation_id: conversation.conversation_id, actor: 'USER', text: '过期', created_at: '2026-05-01T00:00:00Z' });
  store.messages.set('msg_new', { message_id: 'msg_new', conversation_id: conversation.conversation_id, actor: 'USER', text: '保留', created_at: '2026-09-01T00:00:00Z' });
  store.mediaAssets.set('med_asr_old', { asset_id: 'med_asr_old', account_id: account.account_id, type: 'ASR_INPUT_AUDIO', state: 'AVAILABLE', media_type: 'AUDIO', created_at: '2026-09-01T00:00:00Z' });
  store.mediaAssets.set('med_asr_fresh', { asset_id: 'med_asr_fresh', account_id: account.account_id, type: 'ASR_INPUT_AUDIO', state: 'AVAILABLE', media_type: 'AUDIO', created_at: '2026-09-04T10:00:00Z' });

  const result = runRetentionSweep(store, now);
  assert.equal(store.messages.has('msg_old'), false);
  assert.equal(store.messages.has('msg_new'), true);
  assert.equal(store.mediaAssets.get('med_asr_old').state, 'DELETED');
  assert.equal(store.mediaAssets.get('med_asr_fresh').state, 'AVAILABLE');
  assert.deepEqual(result.expired_asr_input_assets, ['med_asr_old']);

  // 定时 Worker 可启动并可停止。
  const worker = startRetentionWorker(store, { intervalMs: 10 });
  worker.stop();
  assert.ok(worker);
});
