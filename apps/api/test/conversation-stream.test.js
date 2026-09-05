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

async function rawStream(base, path, token = 'dev-alice-token') {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
}

function parseEvents(raw) {
  return raw.split('\n\n').filter((block) => block.startsWith('event: ')).map((block) => {
    const [eventLine, dataLine] = block.split('\n');
    return { event: eventLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) };
  });
}

async function setup(base, prefix) {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: `${prefix}-c`, body: { name: `${prefix} 角色` } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: `${prefix}-v`, body: { character_id: character.body.character.character_id } });
  return conversation.body.conversation;
}

test('带生成器的 SSE 全链路：令牌鉴权、一次性、过期与事件内容', async (t) => {
  const base = await start(t, {
    replyGenerator: async (text) => ({
      provider: 'spy', model_version: 'spy-v1', reply_text: '先休息一下也可以。我陪着你。慢慢来，不着急。',
      ai_generated: true, disclaimer: '测试生成器。',
      memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: `你提到：“${text}”` }
    })
  });
  const conversation = await setup(base, 'sse2');
  const sent = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'sse-m2', body: { content: { text: '我今天很累' } } });
  assert.equal(sent.status, 201);
  const stream = sent.body.stream;
  assert.ok(stream.stream_url.startsWith('/api/v1/conversation-streams/st_'));

  const replay = await rawStream(base, stream.stream_url);
  assert.equal(replay.status, 200);
  assert.match(replay.contentType, /^text\/event-stream/);
  const events = parseEvents(replay.text);
  assert.equal(events[0].event, 'message.accepted');
  assert.equal(events[0].data.assistant_message_id, sent.body.assistant_message.message_id);
  const chunks = events.filter((item) => item.event === 'message.chunk');
  assert.equal(chunks.length, 3);
  assert.equal(chunks.map((item) => item.data.text).join(''), '先休息一下也可以。我陪着你。慢慢来，不着急。');
  assert.deepEqual(chunks.map((item) => item.data.sequence), [1, 2, 3]);
  const completed = events.at(-1);
  assert.equal(completed.event, 'message.completed');
  assert.equal(completed.data.message_id, sent.body.assistant_message.message_id);
  assert.equal(completed.data.media_eligible.tts, true);

  // 令牌一次性：再次使用返回 409。
  const reused = await rawStream(base, stream.stream_url);
  assert.equal(reused.status, 409);

  // 他人令牌不可用。
  const foreign = await rawStream(base, stream.stream_url, 'dev-bob-token');
  assert.equal(foreign.status, 404);
  const missing = await rawStream(base, '/api/v1/conversation-streams/st_missing');
  assert.equal(missing.status, 404);
});

test('安全响应与审核响应不发放流式令牌', async (t) => {
  const base = await start(t);
  const conversation = await setup(base, 'sse3');
  const safety = await request(base, `/api/v1/conversations/${conversation.conversation_id}/messages`, { method: 'POST', key: 'sse-safety', body: { content: { text: '我不想活了' } } });
  assert.equal(safety.status, 201);
  assert.equal(safety.body.provider, 'safety-policy');
  assert.equal(safety.body.stream, undefined);
});
