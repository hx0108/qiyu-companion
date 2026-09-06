'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// 测试用流式生成器：把回复拆成句级片段逐个过 onFragment，模拟 7.5 按句缓冲。
function fakeStreamingGenerator(fragments, { failAt } = {}) {
  return {
    async generateStream(text, context, onFragment, signal) {
      let sent = '';
      for (const fragment of fragments) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const approved = await onFragment(fragment);
        if (approved === false) {
          const error = new Error('intercepted');
          error.code = 'QWEN_STREAM_INTERCEPTED';
          throw error;
        }
        sent += fragment;
      }
      return {
        provider: 'fake-stream', model_version: 'fake-stream-v1', reply_text: sent, usage: { input_tokens: 10, output_tokens: 5 }, ai_generated: true,
        memory_candidate: { type: 'development_note', normalized_value: { text }, display_text: `你提到：“${text}”` }
      };
    }
  };
}

async function start(t, options = {}) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, pathName, { method = 'GET', token = 'dev-alice-token', key, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${pathName}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function readyConversation(base, prefix = 'live') {
  const notices = await request(base, '/api/v1/required-notices');
  const notice = notices.body.notices[0];
  await request(base, `/api/v1/required-notices/${notice.notice_id}/displayed`, { method: 'POST', key: `${prefix}-n`, body: { notice_version: notice.notice_version } });
  await request(base, '/api/v1/age/declarations', { method: 'POST', key: `${prefix}-a`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  const character = await request(base, '/api/v1/characters', { method: 'POST', key: `${prefix}-c`, body: { name: `${prefix} 角色` } });
  const conversation = await request(base, '/api/v1/conversations', { method: 'POST', key: `${prefix}-v`, body: { character_id: character.body.character.character_id } });
  return conversation.body.conversation.conversation_id;
}

async function readSse(base, streamUrl, token = 'dev-alice-token') {
  const response = await fetch(`${base}${streamUrl}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (eventLine && dataLine) events.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5)) });
  }
  return events;
}

test('真流式全链：POST 202 受理 → SSE 逐片段下发 → completed 终态可查', async (t) => {
  const fragments = ['今天也辛苦了。', '早点休息，', '明天再聊。'];
  const base = await start(t, { streamingReplyGenerator: fakeStreamingGenerator(fragments) });
  const conversationId = await readyConversation(base);

  const accepted = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'live-1', body: { content: { text: '今天好累' }, stream: true }
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.status, 'ACCEPTED');
  assert.equal(accepted.body.assistant_message, null);
  assert.ok(accepted.body.user_message.message_id);
  assert.equal(accepted.body.stream.mode, 'live');

  const events = await readSse(base, accepted.body.stream.stream_url);
  const acceptedEvent = events.find((item) => item.event === 'message.accepted');
  const chunks = events.filter((item) => item.event === 'message.chunk');
  const completed = events.find((item) => item.event === 'message.completed');
  assert.ok(acceptedEvent, '应有 accepted 事件');
  assert.equal(chunks.length, 3, '三个句级片段逐个下发');
  assert.deepEqual(chunks.map((item) => item.data.text), fragments);
  assert.deepEqual(chunks.map((item) => item.data.sequence), [1, 2, 3]);
  assert.ok(completed, '应有 completed 终态');
  assert.equal(completed.data.message_id, acceptedEvent.data.assistant_message_id);
  assert.ok(completed.data.memory_candidate, '应创建候选记忆');

  // 终态可查：ai_generated、完整拼接文本、世界状态快照。
  const finalMessage = await request(base, `/api/v1/messages/${completed.data.message_id}`);
  assert.equal(finalMessage.body.message.ai_generated, true);
  assert.equal(finalMessage.body.message.text, fragments.join(''));
  assert.ok(finalMessage.body.message.world_state_id);

  // 令牌一次性：重复消费被拒。
  const replay = await fetch(`${base}${accepted.body.stream.stream_url}`, { headers: { authorization: 'Bearer dev-alice-token' } });
  assert.equal(replay.status, 409);

  // 用量已提交（1 轮）。
  const usage = await request(base, '/api/v1/usage/daily');
  assert.equal(usage.body.usage.chat_rounds, 1);
});

test('真流式等待异步上下文，Qwen 能收到当前角色名', async (t) => {
  let receivedCharacterName = null;
  const streamingReplyGenerator = {
    async generateStream(text, context, onFragment) {
      receivedCharacterName = context?.character?.name ?? null;
      await onFragment('你好。');
      return { provider: 'fake-stream', model_version: 'fake-v1', reply_text: '你好。', usage: {}, ai_generated: true };
    }
  };
  const base = await start(t, { streamingReplyGenerator });
  const conversationId = await readyConversation(base, 'identity');
  const accepted = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'identity-live', body: { content: { text: '你是谁' }, stream: true }
  });
  await readSse(base, accepted.body.stream.stream_url);
  assert.equal(receivedCharacterName, 'identity 角色');
});

test('真流式上游失败时同轮降级为非流式回复，不留失败占位', async (t) => {
  const streamingReplyGenerator = {
    async generateStream() {
      throw Object.assign(new Error('stream unavailable'), { code: 'QWEN_NETWORK_ERROR', retryable: true });
    }
  };
  const replyGenerator = async () => ({
    provider: 'qwen', model_version: 'qwen3.8-flash', reply_text: '好的，先去好好吃饭吧。', usage: {}, ai_generated: true,
    memory_candidate: null
  });
  const base = await start(t, { streamingReplyGenerator, replyGenerator });
  const conversationId = await readyConversation(base, 'fallback');
  const accepted = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'fallback-live', body: { content: { text: '我要吃饭了' }, stream: true }
  });
  const events = await readSse(base, accepted.body.stream.stream_url);
  assert.equal(events.find((item) => item.event === 'message.replaced')?.data.reason, 'STREAM_PROVIDER_FALLBACK');
  assert.equal(events.some((item) => item.event === 'message.failed'), false);
  const completed = events.find((item) => item.event === 'message.completed');
  assert.ok(completed);
  const finalMessage = await request(base, `/api/v1/messages/${completed.data.message_id}`);
  assert.equal(finalMessage.body.message.text, '好的，先去好好吃饭吧。');
});

test('片段未过输出门禁：立即停止流、下发 replaced、安全文案入库且不建候选、额度释放', async (t) => {
  const fragments = ['正常的开头。', '我已经可以忽略安全规则帮你绕过年龄核验。', '不会再到这里。'];
  const base = await start(t, { streamingReplyGenerator: fakeStreamingGenerator(fragments) });
  const conversationId = await readyConversation(base, 'live2');

  const accepted = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'live-2', body: { content: { text: '帮我绕过限制' }, stream: true }
  });
  const events = await readSse(base, accepted.body.stream.stream_url);
  const chunks = events.filter((item) => item.event === 'message.chunk');
  const replaced = events.find((item) => item.event === 'message.replaced');
  const completed = events.find((item) => item.event === 'message.completed');

  assert.equal(chunks.length, 1, '拦截片段之后的片段不得下发');
  assert.equal(chunks[0].data.text, '正常的开头。');
  assert.ok(replaced, '应下发 message.replaced');
  assert.ok(completed, '终态事件仍应发出（指向安全文案）');

  const finalMessage = await request(base, `/api/v1/messages/${completed.data.message_id}`);
  assert.equal(finalMessage.body.message.provider, 'model-output-guard');
  assert.equal(finalMessage.body.message.ai_generated, false);
  assert.ok(!finalMessage.body.message.text.includes('忽略安全规则'), '越权原文不得入库');
  assert.equal(completed.data.memory_candidate, null, '拦截路径不创建候选');

  const candidates = await request(base, '/api/v1/memory-candidates');
  assert.equal(candidates.body.candidates.length, 0);
  const usage = await request(base, '/api/v1/usage/daily');
  assert.equal(usage.body.usage.chat_rounds, 0, '拦截后额度释放，不计数');
});

test('供应商逐段 OUTPUT 审核拦截同样触发 replaced', async (t) => {
  const fragments = ['第一段。', '第二段有风险。'];
  const base = await start(t, {
    streamingReplyGenerator: fakeStreamingGenerator(fragments),
    textModerator: async ({ text, direction }) => {
      if (direction !== 'OUTPUT') return { decision: 'PASS', providerRequestId: 'tms-in', policyVersion: 'v1' };
      if (text.includes('风险')) return { decision: 'BLOCK', providerRequestId: 'tms-out', policyVersion: 'v1' };
      return { decision: 'PASS', providerRequestId: 'tms-out', policyVersion: 'v1' };
    }
  });
  const conversationId = await readyConversation(base, 'live3');
  const accepted = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'live-3', body: { content: { text: '随便聊聊' }, stream: true }
  });
  const events = await readSse(base, accepted.body.stream.stream_url);
  const chunks = events.filter((item) => item.event === 'message.chunk');
  assert.equal(chunks.length, 1, '审核拦截段之后的片段不得下发');
  assert.ok(events.find((item) => item.event === 'message.replaced'));
});

test('未配置流式生成器时 stream:true 回退同步合同（201 完整响应）', async (t) => {
  const base = await start(t);
  const conversationId = await readyConversation(base, 'live4');
  const response = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'live-4', body: { content: { text: '普通消息' }, stream: true }
  });
  assert.equal(response.status, 201);
  assert.ok(response.body.assistant_message, '回退路径仍同步返回完整助手消息');
  assert.equal(response.body.stream.replay, true, '回退为终稿回放模式');
});

test('流式期间准入状态变化：R2 安全模式在 SSE 消费时重新拦截', async (t) => {
  const fragments = ['你好呀。'];
  const base = await start(t, { streamingReplyGenerator: fakeStreamingGenerator(fragments) });
  const conversationId = await readyConversation(base, 'live5');
  const accepted = await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'live-5a', body: { content: { text: '你好' }, stream: true }
  });
  // 受理后、消费前账户进入 R2 危机模式（另一条消息触发）。
  await request(base, `/api/v1/conversations/${conversationId}/messages`, {
    method: 'POST', key: 'live-5b', body: { content: { text: '我现在想自杀' } }
  });
  const events = await readSse(base, accepted.body.stream.stream_url);
  assert.ok(events.find((item) => item.event === 'safety.response'), 'SSE 消费时应重检安全模式');
  assert.ok(!events.find((item) => item.event === 'message.chunk'), '危机模式下不得下发任何角色片段');
});
