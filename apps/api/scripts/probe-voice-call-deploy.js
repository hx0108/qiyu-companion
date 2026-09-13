'use strict';

// 公网真链路 1:1 通话验收探针（步骤 9）：邀请码登录 → 完整开通流程 → 发起通话
// → 边录边传 2 秒 WAV → 封账 → SSE 消费（逐事件时延）→ 挂断 → 服务端事实读取。
// 用量即真实计费量级：2 秒音频 + 一轮短回复，成本可忽略。

const BASE = 'https://qiyu.qualisense.top/api/v1';
const INVITE = process.argv[2];
if (!INVITE) { console.error('用法：node probe-voice-call-deploy.js <INVITE_CODE>'); process.exit(1); }

function uuid() { return crypto.randomUUID(); }
async function api(path, { method = 'GET', token, body, key } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, ms: Date.now() - started };
}

// 2 秒 16k PCM16 WAV：640Hz 正弦、幅值 0.25（真实可识别的轻音量，够触发一句话识别）。
function makeWav(seconds = 2) {
  const rate = 16_000; const samples = rate * seconds;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 640 * index) / rate) * 0.25 * 0x7fff), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function consumeSse(url, token, onEvent) {
  const started = Date.now();
  // 服务端返回的 stream_url 以根路径开头（/api/v1/...）：接站点根，不重复拼 /api/v1。
  const streamUrl = /^https?:\/\//.test(url) ? url : `https://qiyu.qualisense.top${url}`;
  const response = await fetch(streamUrl, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  const headers = Object.fromEntries(response.headers.entries());
  if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (eventLine && dataLine) onEvent(eventLine.slice(7).trim(), JSON.parse(dataLine.slice(6)), Date.now() - started);
    }
  }
  return headers;
}

(async () => {
  const report = [];
  const log = (line) => { report.push(line); console.log(line); };

  // 1. 邀请码登录
  const login = await api('/auth/trial-sessions', { method: 'POST', body: { invite_code: INVITE } });
  if (login.status !== 201) throw new Error(`登录失败 ${login.status} ${JSON.stringify(login.payload)}`);
  const token = login.payload.tokens.access_token;
  log(`登录 OK（${login.ms}ms，账户 ${login.payload.account?.account_id ?? 'n/a'}）`);

  // 2. 告知 + 年龄（新账户需走完开通链路）
  const notices = await api('/required-notices', { token });
  for (const notice of notices.payload.notices ?? []) {
    await api(`/required-notices/${notice.notice_id}/displayed`, { method: 'POST', token, key: `probe-n-${notice.notice_id}`, body: { notice_version: notice.notice_version } });
  }
  const age = await api('/age/declarations', { method: 'POST', token, key: `probe-age-${uuid()}`, body: { date_of_birth: '1990-01-01', confirmed_18_plus: true } });
  log(`告知+年龄 OK（age_status=${age.payload.status ?? 'n/a'}）`);

  // 3. 角色 + 会话 + 试用（语音额度）——探针可重复跑：角色已存在则复用。
  let characterId;
  const existing = await api('/characters', { token });
  const existingCharacter = (existing.payload.characters ?? []).find((item) => item.status === 'ACTIVE');
  if (existingCharacter) {
    characterId = existingCharacter.character_id;
    log(`复用既有角色（${characterId}）`);
  } else {
    const character = await api('/characters', { method: 'POST', token, key: `probe-c-${uuid()}`, body: { name: '通话探针角色', persona: { worldview: '压力测试', relationship_to_user: '朋友', personality: '温和', expression_style: '自然', hard_boundaries: [], example_behaviors: [] }, rights_confirmed: true, original_work: true } });
    if (character.status !== 201) throw new Error(`角色创建 ${character.status} ${JSON.stringify(character.payload)}`);
    characterId = character.payload.character.character_id;
  }
  const conversation = await api('/conversations', { method: 'POST', token, key: `probe-v-${uuid()}`, body: { character_id: characterId } });
  const conversationId = conversation.payload.conversation.conversation_id;
  const current = await api('/subscriptions/current', { token });
  const subState = current.payload.subscription?.state ?? null;
  if (!['TRIAL', 'ACTIVE', 'GRACE_PERIOD', 'BILLING_RETRY'].includes(subState)) {
    const trial = await api('/subscription-trials', { method: 'POST', token, key: `probe-trial-${uuid()}` });
    if (trial.status >= 300) throw new Error(`试用开通 ${trial.status} ${JSON.stringify(trial.payload)}`);
  }
  log(`角色/会话/试用 OK（subscription=${subState ?? 'none→已开试用'}）`);

  // 4. 发起通话（真腾讯 ASR/TTS 链路）
  const started = Date.now();
  const call = await api(`/conversations/${conversationId}/calls`, { method: 'POST', token, key: `probe-call-${uuid()}` });
  if (call.status !== 201) throw new Error(`发起通话 ${call.status} ${JSON.stringify(call.payload)}`);
  const callId = call.payload.call.call_id;
  log(`发起通话 201（${call.ms}ms）问候文案：${call.payload.greeting?.text}`);

  // 5. 问候 SSE：记录首事件与 completed 时延
  let greetingFirstEventMs = null;
  const greetingHeaders = await consumeSse(call.payload.greeting.stream.stream_url, token, (event, data, ms) => {
    if (greetingFirstEventMs === null) greetingFirstEventMs = ms;
    if (event === 'call.turn.audio' && data.segment_index === 0) log(`问候首音频段（自连接起 ${ms}ms，base64 ${data.audio_base64?.length ?? 0}B）`);
    if (event === 'call.turn.completed') log(`问候完成（首事件 ${greetingFirstEventMs}ms / 完成 ${ms}ms）`);
  });
  log(`问候流响应头 x-accel-buffering=${greetingHeaders['x-accel-buffering'] ?? '缺失'}`);

  // 6. 说话回合：2 秒 WAV 分 1 块上传 → 封账 → SSE
  const turn = await api(`/calls/${callId}/turns`, { method: 'POST', token, key: `probe-turn-${uuid()}` });
  if (turn.status !== 201) throw new Error(`创建回合 ${turn.status} ${JSON.stringify(turn.payload)}`);
  const turnId = turn.payload.turn.turn_id;
  const wav = makeWav(2);
  const chunk = await api(`/calls/${callId}/turns/${turnId}/audio-chunks`, { method: 'POST', token, body: { chunk_index: 0, audio_base64: wav.toString('base64') } });
  if (chunk.status !== 200) throw new Error(`分块上传 ${chunk.status} ${JSON.stringify(chunk.payload)}`);
  log(`分块上传 OK（received_bytes=${chunk.payload.received_bytes}）`);
  const finalized = await api(`/calls/${callId}/turns/${turnId}/finalize`, { method: 'POST', token, key: `probe-fin-${uuid()}` });
  if (finalized.status !== 202) throw new Error(`封账 ${finalized.status} ${JSON.stringify(finalized.payload)}`);

  let firstEventMs = null; let transcriptMs = null; let firstAudioMs = null; let completedMs = null; let transcriptText = '';
  const turnHeaders = await consumeSse(finalized.payload.stream.stream_url, token, (event, data, ms) => {
    if (firstEventMs === null) firstEventMs = ms;
    if (event === 'call.turn.transcript') { transcriptMs = ms; transcriptText = data.text; }
    if (event === 'call.turn.audio' && firstAudioMs === null) firstAudioMs = ms;
    if (event === 'call.turn.completed') completedMs = ms;
  });
  log(`回合时延：首事件 ${firstEventMs}ms / 转写 ${transcriptMs}ms（「${transcriptText}」）/ 首音频 ${firstAudioMs}ms / 完成 ${completedMs}ms`);
  log(`回合流响应头 x-accel-buffering=${turnHeaders['x-accel-buffering'] ?? '缺失'}`);

  // 7. 挂断 + 服务端事实
  const end = await api(`/calls/${callId}/end`, { method: 'POST', token, key: `probe-end-${uuid()}` });
  log(`挂断 OK（state=${end.payload.call?.state} reason=${end.payload.call?.end_reason} asr=${end.payload.call?.asr_seconds_used}s tts=${end.payload.call?.tts_seconds_used}s turns=${end.payload.call?.turn_count}）`);

  const detail = await api(`/calls/${callId}`, { token });
  const messages = await api(`/conversations/${conversationId}/messages?limit=50`, { token });
  const card = (messages.payload.messages ?? []).find((message) => message.provider === 'call-record');
  log(`通话记录卡片：${card?.text ?? '缺失'}`);
  log(`通话来源消息数：${(messages.payload.messages ?? []).filter((message) => message.call_session_id === callId).length}`);

  // 数据权利：探针账户注销（不留测试数据）
  const deletion = await api('/account/deletion', { method: 'POST', token, key: `probe-del-${uuid()}` });
  log(`探针账户注销：${deletion.status}（${deletion.payload.deletion_job?.state ?? 'n/a'}，24h 内物理清理）`);
  console.log('\nPROBE_RESULT=' + JSON.stringify({ callId, firstEventMs, transcriptMs, firstAudioMs, completedMs, asrSeconds: end.payload.call?.asr_seconds_used, ttsSeconds: end.payload.call?.tts_seconds_used }));
})().catch((error) => { console.error('PROBE FAILED:', error.message); process.exit(1); });
