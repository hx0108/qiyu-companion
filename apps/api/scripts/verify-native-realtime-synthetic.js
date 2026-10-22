'use strict';

// Default is strictly local preflight. Execution requires a separate internal go.
// Never import server.js here: that could load live persistence/worker configuration.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { VolcengineRealtimeAdapter, decodeRealtimeFrame } = require('../src/providers/volcengine-realtime-adapter');
const { createTencentTextModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');

const ROOT = path.resolve(__dirname, '../../..');
const INPUT = path.join(ROOT, 'output/voice-latency-2026-10-14/real-synthetic-input.wav');
const OUTPUT = path.join(ROOT, 'output/native-realtime-2026-10-16/synthetic-probe.json');
const PLAN = Object.freeze({ reserve_cny: 0.2, sessions: 1, automatic_retries: 0, wall_clock_ms: 8000,
  max_input_audio_ms: 2300, max_prompt_utf8_bytes: 1000, max_received_output_audio_ms: 3000, max_tms_calls: 4,
  price_per_million_tokens_cny: { input_text: 10, input_audio: 80, output_text: 80, output_audio: 300 },
  tms_per_request_cny: 0.0025,
  planned_base_cny: 0.04877, generation_and_tokenization_reserve_cny: 0.15123,
  price_sources: ['https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh', 'https://cloud.tencent.com/document/product/1124/37118'],
  strict_provider_spend_cap_enforced: false,
  caveat: 'Received PCM cap and socket close do not enforce cloud generation tokens; 0.20 is a conservative planning reserve, not a guaranteed billed maximum. Stop and confirm billing if provider usage is unavailable.' });

function readSyntheticWav(file = INPUT) {
  const bytes = fs.readFileSync(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw Object.assign(new Error(), { code: 'PROBE_WAV_INVALID' });
  let format; let samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); offset += 8;
    if (offset + size > bytes.length) throw Object.assign(new Error(), { code: 'PROBE_WAV_INVALID' });
    if (name === 'fmt ' && size >= 16) format = { codec: bytes.readUInt16LE(offset), channels: bytes.readUInt16LE(offset + 2), sampleRate: bytes.readUInt32LE(offset + 4), bits: bytes.readUInt16LE(offset + 14) };
    if (name === 'data') samples = bytes.subarray(offset, offset + size);
    offset += size + size % 2;
  }
  if (!format || format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16 || !samples?.length || samples.length % 2) throw Object.assign(new Error(), { code: 'PROBE_WAV_FORMAT_UNSUPPORTED' });
  // Preserve the complete known synthetic utterance, including its final word.
  // Permit at most 1.8s source + 0.5s silence under this separately approved plan.
  if (samples.length > 57600) throw Object.assign(new Error(), { code: 'PROBE_SYNTHETIC_INPUT_LIMIT' });
  const pcm = Buffer.concat([samples, Buffer.alloc(16000)]);
  return { pcm, sourceDurationMs: samples.length / 32, inputDurationMs: pcm.length / 32, sourceClipped: false };
}

// Private probe telemetry only: never retain text, actual IDs, headers or audio.
function createWireSchemaRecorder(record) {
  let question; let reply; let count = 0;
  return (bytes, isBinary) => {
    if (!isBinary || ++count > 30) return;
    try {
      const frame = decodeRealtimeFrame(bytes); const payload = frame.payload;
      if (Buffer.isBuffer(payload)) { record('wire-schema', { event_id: frame.event, payload_type: 'binary', payload_bytes: payload.length }); return; }
      const object = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const hasQuestion = typeof object.question_id === 'string' && object.question_id.trim().length > 0;
      const hasReply = typeof object.reply_id === 'string' && object.reply_id.trim().length > 0;
      const types = {};
      for (const key of Object.keys(object).slice(0, 32)) if (/^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/.test(key)) types[key] = Array.isArray(object[key]) ? 'array' : object[key] === null ? 'null' : typeof object[key];
      record('wire-schema', { event_id: frame.event, payload_type: 'json', field_types: types,
        text_length: typeof object.text === 'string' ? object.text.length : null,
        tts_type: ['default', 'audit_content_risky', 'chat_tts_text', 'network', 'external_rag', 'sing'].includes(object.tts_type) ? object.tts_type : object.tts_type === undefined ? null : 'OTHER',
        question_id_present: hasQuestion, reply_id_present: hasReply,
        question_matches_latest_asr: hasQuestion && question !== undefined ? object.question_id === question : null,
        reply_matches_previous: hasReply && reply !== undefined ? object.reply_id === reply : null });
      if (frame.event === 450 && hasQuestion) question = object.question_id;
      if ([350, 550].includes(frame.event) && hasReply) reply = object.reply_id;
    } catch { record('wire-schema-decode-failed'); }
  };
}

async function localApp(provider, moderator) {
  const store = new DevelopmentStore(); const token = `probe-${randomUUID()}`;
  const app = createApp({ store, summaryEnabled: false, realtimeCallEnabled: true, realtimeProvider: provider,
    textModerator: moderator, voiceCallEnabled: true, asrTranscriber: async () => { throw new Error('BATCH_ASR_NOT_USED'); },
    trialAuthEnabled: true, trialAuth: { resolveAccessToken: async (candidate) => candidate === token ? 'acct_dev_alice' : null } });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(`${base}/api/v1${route}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID()
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(), { code: payload.error?.code || 'PROBE_LOCAL_HTTP_FAILED' });
    return payload;
  };
  const stop = async () => { app.closeAllConnections(); await new Promise((resolve) => app.close(resolve)); };
  try {
    const notice = (await request('/required-notices')).notices[0];
    await request(`/required-notices/${notice.notice_id}/displayed`, { notice_version: notice.notice_version });
    await request('/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
    const character = (await request('/characters', { name: '林语' })).character;
    const conversation = (await request('/conversations', { character_id: character.character_id })).conversation;
    return { app, store, base, token, request, stop, conversation };
  } catch (error) { await stop(); throw error; }
}

async function readEvents(response, callback, signal) {
  if (!response.ok || !response.body) throw Object.assign(new Error(), { code: 'PROBE_STREAM_FAILED' });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read(); if (done) return;
      pending += decoder.decode(value, { stream: true }); pending = pending.replace(/\r\n/g, '\n');
      if (pending.length > 2_000_000) throw Object.assign(new Error(), { code: 'PROBE_STREAM_LIMIT' });
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const lines = pending.slice(0, boundary).split('\n'); pending = pending.slice(boundary + 2);
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        const json = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (event && json) await callback(event, JSON.parse(json));
      }
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
}

async function preflight() {
  let captured; let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const provider = { model: 'offline-preflight', async createSession(options) { captured = options; readyResolve(); return { close() {}, sendAudio() {} }; } };
  const local = await localApp(provider, async () => ({ decision: 'PASS' }));
  const controller = new AbortController();
  try {
    const session = await local.request(`/conversations/${local.conversation.conversation_id}/realtime-calls`, {});
    const stream = fetch(local.base + session.stream_url, { headers: { authorization: `Bearer ${local.token}` }, signal: controller.signal }).then((response) => readEvents(response, () => {}, controller.signal)).catch(() => {});
    await ready;
    const promptUtf8Bytes = Buffer.byteLength(captured.instructions, 'utf8');
    // Exercise the production browser media protocol locally before any paid call.
    const { WebSocket } = require('ws');
    const mediaUrl = new URL(session.audio_socket_url, local.base); mediaUrl.protocol = 'ws:';
    const socket = new WebSocket(mediaUrl, [session.audio_socket_protocol, `ticket.${session.audio_socket_ticket}`], { origin: local.base, perMessageDeflate: false });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error(), { code: 'PROBE_LOCAL_MEDIA_TIMEOUT' })), 2000);
        socket.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error(), { code: 'PROBE_LOCAL_MEDIA_FAILED' })); });
        socket.once('message', (bytes) => {
          clearTimeout(timer);
          try { const ack = JSON.parse(bytes.toString()); if (ack.type !== 'audio.ack' || ack.next_sequence !== 1) throw new Error(); resolve(); }
          catch { reject(Object.assign(new Error(), { code: 'PROBE_LOCAL_MEDIA_ACK_INVALID' })); }
        });
        socket.once('open', () => { const frame = Buffer.alloc(644); frame.writeUInt32BE(0); socket.send(frame); });
      });
    } finally { socket.terminate(); }
    await local.request(`/realtime-calls/${session.session_id}/end`, {}); controller.abort(); await stream;
    return { promptUtf8Bytes, contextMessages: captured.context.length, instructions: captured.instructions, mediaProtocolChecked: true };
  } finally { controller.abort(); await local.stop(); }
}

async function main() {
  const execute = process.argv.includes('--execute-approved-synthetic');
  const timeline = []; const evidence = { status: 'PREPARING', plan: PLAN, timeline, measurement_scope: 'isolated localhost createApp + production media WS framing + real provider + real moderation; no public network proxy, browser playback or acoustic onset' };
  const record = (event, extra = {}) => timeline.push({ event, at_ms: Math.round(performance.now() - began), ...extra });
  const began = performance.now(); let local; let providerSession; let mediaSocket; let wallTimer; let streamTask; let tmsCalls = 0; let rawOutputBytes = 0; let approvedOutputBytes = 0; let lastInputEnergyAt = null;
  const controller = new AbortController();
  try {
    const source = readSyntheticWav(); const prepared = await preflight();
    Object.assign(evidence, { prompt_utf8_bytes_before_probe_instruction: prepared.promptUtf8Bytes, input_audio_ms: source.inputDurationMs, source_audio_ms: source.sourceDurationMs, source_clipped: source.sourceClipped,
      local_mock_media_ws_preflight_passed: prepared.mediaProtocolChecked,
      credential_presence: { speech_key: Boolean(process.env.VOLCENGINE_REALTIME_API_KEY || process.env.Doubao_API_KEY), tencent_id: Boolean(process.env.TENCENT_SECRET_ID), tencent_key: Boolean(process.env.TENCENT_SECRET_KEY), tms_policy: Boolean(process.env.TENCENT_TEXT_MODERATION_BIZ_TYPE) } });
    const probeInstruction = '\n这是一次合成验收。每次仅回答“你好呀”，不要主动打招呼，不唱歌。';
    // Static synthetic fixture only. No real persona/memory or customer data is transmitted.
    const instructions = prepared.instructions + probeInstruction;
    evidence.prompt_utf8_bytes = Buffer.byteLength(instructions);
    if (evidence.prompt_utf8_bytes > 1000 || prepared.contextMessages || source.inputDurationMs > 2300) throw Object.assign(new Error(), { code: 'PROBE_PREFLIGHT_LIMIT' });
    if (!execute) { evidence.status = 'DRY_RUN_NO_EXTERNAL_NETWORK'; return; }
    if (process.env.QIYU_APPROVED_REALTIME_PROBE !== 'single-synthetic-0.20') throw Object.assign(new Error(), { code: 'PROBE_INTERNAL_GO_REQUIRED' });
    if (!Object.values(evidence.credential_presence).every(Boolean)) throw Object.assign(new Error(), { code: 'PROBE_CREDENTIAL_MISSING' });
    const externalStarted = performance.now();
    wallTimer = setTimeout(() => { record('wall-clock-limit'); controller.abort(); providerSession?.close(); }, 8000);
    const wireRecorder = createWireSchemaRecorder(record);
    const native = new VolcengineRealtimeAdapter({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY || process.env.Doubao_API_KEY, maxSessionMs: 8000, timeoutMs: 5000,
      wsFactory: (url, options) => { const { WebSocket } = require('ws'); const socket = new WebSocket(url, options); socket.on('message', wireRecorder); return socket; } });
    const moderator = createTencentTextModeratorFromEnvironment({ ...process.env, QIYU_TEXT_MODERATION_PROVIDER: 'tencent', TENCENT_MODERATION_TIMEOUT_MS: '3000' }, { fetchImpl: async (url, options) => {
      if (controller.signal.aborted || ++tmsCalls > 4 || url !== 'https://tms.tencentcloudapi.com') throw Object.assign(new Error(), { code: 'PROBE_TMS_LIMIT' });
      record('tms-request', { number: tmsCalls });
      const response = await fetch(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) });
      record('tms-response', { number: tmsCalls, http_status: response.status }); return response;
    } });
    const limitedProvider = { model: native.model, async createSession(options) {
      record('provider-connect');
      providerSession = await native.createSession({ ...options, instructions, signal: controller.signal, onEvent: (event) => {
        if (event.type === 'usage') { evidence.provider_reported_usage = event.usage; record('provider-usage'); }
        if (event.type === 'transcript' && event.final) record('final-user-transcript');
        if (event.type === 'sentence-start') record('provider-sentence');
        if (event.type === 'audio') {
          if (!rawOutputBytes) { record('first-raw-pcm'); evidence.first_raw_pcm_from_last_upload_energy_ms = lastInputEnergyAt === null ? null : Math.round(performance.now() - lastInputEnergyAt); } rawOutputBytes += event.bytes.length;
          if (rawOutputBytes > 144000) { record('output-cap'); controller.abort(); providerSession?.close(); return; }
        }
        options.onEvent(event);
      } });
      record('provider-ready'); return providerSession;
    } };
    local = await localApp(limitedProvider, moderator);
    const session = await local.request(`/conversations/${local.conversation.conversation_id}/realtime-calls`, {});
    let readyResolve; const ready = new Promise((resolve) => { readyResolve = resolve; });
    const response = await fetch(local.base + session.stream_url, { headers: { authorization: `Bearer ${local.token}` }, signal: controller.signal });
    streamTask = readEvents(response, async (event, data) => {
      if (event === 'realtime.ready') readyResolve();
      if (event === 'realtime.audio') {
        if (!approvedOutputBytes) { record('first-approved-sse-pcm'); evidence.first_approved_sse_pcm_from_last_upload_energy_ms = lastInputEnergyAt === null ? null : Math.round(performance.now() - lastInputEnergyAt); }
        approvedOutputBytes += Buffer.from(data.audio_base64, 'base64').length;
      }
      if (event === 'realtime.response-completed') {
        record('response-completed'); evidence.status = 'SUCCEEDED'; await local.request(`/realtime-calls/${session.session_id}/end`, {});
      }
      if (event === 'realtime.closed') { record('closed', { reason: data.reason }); controller.abort(); }
    }, controller.signal).catch((error) => { if (!controller.signal.aborted) throw error; });
    // Readiness must fail visibly even if the provider rejects before ready.
    await Promise.race([ready, streamTask.then(() => { throw Object.assign(new Error(), { code: 'PROBE_CLOSED_BEFORE_READY' }); })]);
    const { WebSocket } = require('ws');
    const mediaUrl = new URL(session.audio_socket_url, local.base); mediaUrl.protocol = 'ws:';
    mediaSocket = new WebSocket(mediaUrl, [session.audio_socket_protocol, `ticket.${session.audio_socket_ticket}`], { origin: local.base, perMessageDeflate: false });
    let acknowledged = 0; let mediaError;
    mediaSocket.on('message', (bytes) => {
      try { const ack = JSON.parse(bytes.toString()); if (ack.type !== 'audio.ack' || !Number.isInteger(ack.next_sequence)) throw new Error(); acknowledged = ack.next_sequence; }
      catch { mediaError = 'PROBE_MEDIA_ACK_INVALID'; controller.abort(); }
    });
    mediaSocket.on('error', () => { mediaError = 'PROBE_MEDIA_CONNECTION_FAILED'; controller.abort(); });
    controller.signal.addEventListener('abort', () => mediaSocket?.terminate(), { once: true });
    await new Promise((resolve, reject) => {
      mediaSocket.once('open', resolve);
      mediaSocket.once('error', () => reject(Object.assign(new Error(), { code: 'PROBE_MEDIA_CONNECTION_FAILED' })));
      mediaSocket.once('close', () => reject(Object.assign(new Error(), { code: 'PROBE_MEDIA_CONNECTION_CLOSED' })));
    });
    record('upload-start'); let sequence = 0; const uploadStarted = performance.now();
    for (let offset = 0; offset < source.pcm.length && !controller.signal.aborted; offset += 640) {
      const target = uploadStarted + offset / 32; const delay = target - performance.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (controller.signal.aborted) break;
      const block = source.pcm.subarray(offset, offset + 640); let energy = 0;
      for (let sample = 0; sample < block.length; sample += 2) energy += (block.readInt16LE(sample) / 32768) ** 2;
      if (Math.sqrt(energy / (block.length / 2)) >= 0.045) lastInputEnergyAt = performance.now();
      if (mediaSocket.readyState !== WebSocket.OPEN || mediaSocket.bufferedAmount > 32000 || sequence - acknowledged >= 10) throw Object.assign(new Error(), { code: mediaError || 'PROBE_MEDIA_BACKPRESSURE' });
      const frame = Buffer.alloc(4 + block.length); frame.writeUInt32BE(sequence++); block.copy(frame, 4); mediaSocket.send(frame);
    }
    record('upload-finished');
    evidence.last_non_silent_input_block_sent_at_ms = lastInputEnergyAt === null ? null : Math.round(lastInputEnergyAt - began);
    evidence.actual_upload_wall_ms = Math.round(performance.now() - uploadStarted);
    await streamTask;
    evidence.external_wall_ms = Math.round(performance.now() - externalStarted);
    if (evidence.status !== 'SUCCEEDED') evidence.status = approvedOutputBytes ? 'FIRST_AUDIO_OBSERVED_INCOMPLETE' : 'FAILED_NO_APPROVED_AUDIO';
  } catch (error) {
    evidence.status = execute ? 'FAILED' : 'DRY_RUN_FAILED';
    evidence.failure_code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : controller.signal.aborted ? 'PROBE_DEADLINE_OR_LIMIT' : 'PROBE_FAILED';
  } finally {
    clearTimeout(wallTimer); controller.abort(); mediaSocket?.terminate(); providerSession?.close();
    if (local) await local.stop();
    if (streamTask) await streamTask.catch(() => {});
    evidence.tms_calls = tmsCalls; evidence.received_raw_pcm_ms = rawOutputBytes / 48; evidence.approved_pcm_ms = approvedOutputBytes / 48;
    evidence.provider_cost_verified = false;
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    const destination = execute ? OUTPUT : OUTPUT.replace('.json', '-preflight.json');
    fs.writeFileSync(destination, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (!['SUCCEEDED', 'DRY_RUN_NO_EXTERNAL_NETWORK'].includes(evidence.status)) process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { readSyntheticWav, PLAN, createWireSchemaRecorder };
