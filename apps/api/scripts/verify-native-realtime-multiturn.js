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
const OUTPUT = path.join(ROOT, 'output/disconnect-2026-10-17/multiturn-probe.json');
const PLAN = Object.freeze({ reserve_cny: 0.6, sessions: 1, automatic_retries: 0, wall_clock_ms: 45000,
  max_input_audio_ms: 10000, max_prompt_utf8_bytes: 1000, max_received_output_audio_ms: 6000,
  max_tms_calls: 10, target_completed_responses: 3, target_interruptions: 1,
  strict_provider_spend_cap_enforced: false,
  caveat: '0.60 CNY is a planning reserve, not a billed hard cap. No retry. Remaining 0.40 CNY stays unused pending review.' });

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
    if (!isBinary || ++count > 140) return;
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

// Pure observer: ordinary next questions after response-complete are not interruptions.
function createInFlightInterruptionObserver() {
  let active = null; let count = 0;
  return {
    observe(event) {
      let interrupted = false;
      if (event.type === 'sentence-start') active = { questionId: event.questionId, replyId: event.replyId };
      if (event.type === 'response-complete' && active && event.replyId === active.replyId && event.questionId === active.questionId) active = null;
      if (event.type === 'speech-start' && active && event.questionId && event.questionId !== active.questionId) {
        count++; interrupted = true; active = null;
      }
      return interrupted;
    },
    get count() { return count; }
  };
}

async function main() {
  const execute = process.argv.includes('--execute-approved-multiturn');
  const began = performance.now(); const timeline = [];
  const record = (event, extra = {}) => timeline.push({ event, at_ms: Math.round(performance.now() - began), ...extra });
  const evidence = { status: 'PREPARING', plan: PLAN, timeline,
    measurement_scope: 'isolated local createApp, production media WS/SSE, real provider and moderation; excludes public proxy/browser/acoustics' };
  const controller = new AbortController();
  let local; let providerSession; let socket; let streamTask; let wallTimer; let executionMarkerCreated = false;
  let tmsCalls = 0; let rawBytes = 0; let approvedBytes = 0; let completed = 0; let interruptions = 0;
  const interruptionObserver = createInFlightInterruptionObserver(); let sseInterrupts = 0;
  let sentenceCount = 0; let sequence = 0; let acknowledged = 0; let sentBytes = 0; let secondAudio = false;
  const waitUntil = async (condition) => {
    while (!condition()) {
      if (controller.signal.aborted) throw Object.assign(new Error(), { code: 'PROBE_STOPPED_BEFORE_TARGET' });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    // Safe local-only loader: values never enter reports, argv, commands or logs.
    if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
    const source = readSyntheticWav(); const prepared = await preflight();
    const instructions = prepared.instructions + '\n这是合成验收。每次仅回答“你好呀”，不要主动打招呼，不唱歌。';
    evidence.prompt_utf8_bytes = Buffer.byteLength(instructions);
    evidence.planned_input_audio_ms = source.inputDurationMs * 4;
    evidence.local_mock_media_ws_preflight_passed = prepared.mediaProtocolChecked;
    evidence.credential_presence = {
      speech_key: Boolean(process.env.VOLCENGINE_REALTIME_API_KEY),
      tencent_id: Boolean(process.env.TENCENT_SECRET_ID), tencent_key: Boolean(process.env.TENCENT_SECRET_KEY),
      tms_policy: Boolean(process.env.TENCENT_TEXT_MODERATION_BIZ_TYPE)
    };
    if (evidence.prompt_utf8_bytes > PLAN.max_prompt_utf8_bytes || prepared.contextMessages || evidence.planned_input_audio_ms > PLAN.max_input_audio_ms)
      throw Object.assign(new Error(), { code: 'PROBE_PREFLIGHT_LIMIT' });
    if (!execute) { evidence.status = 'DRY_RUN_NO_EXTERNAL_NETWORK'; return; }
    if (process.env.QIYU_APPROVED_REALTIME_PROBE !== 'multiturn-synthetic-0.60') throw Object.assign(new Error(), { code: 'PROBE_INTERNAL_GO_REQUIRED' });
    if (fs.existsSync(OUTPUT)) throw Object.assign(new Error(), { code: 'PROBE_ALREADY_EXECUTED_NO_RETRY' });
    if (!Object.values(evidence.credential_presence).every(Boolean)) throw Object.assign(new Error(), { code: 'PROBE_CREDENTIAL_MISSING' });
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({ status: 'STARTED_NO_RETRY', plan: PLAN }), { flag: 'wx' }); executionMarkerCreated = true;
    wallTimer = setTimeout(() => { record('wall-clock-limit'); controller.abort(); providerSession?.close(); }, PLAN.wall_clock_ms);
    const wireRecorder = createWireSchemaRecorder(record);
    const native = new VolcengineRealtimeAdapter({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY, maxSessionMs: PLAN.wall_clock_ms, timeoutMs: 5000,
      wsFactory: (url, options) => { const { WebSocket } = require('ws'); const wire = new WebSocket(url, options); wire.on('message', wireRecorder); return wire; } });
    const moderator = createTencentTextModeratorFromEnvironment({ ...process.env, QIYU_TEXT_MODERATION_PROVIDER: 'tencent', TENCENT_MODERATION_TIMEOUT_MS: '3000' }, { fetchImpl: async (url, options) => {
      if (controller.signal.aborted || ++tmsCalls > PLAN.max_tms_calls || url !== 'https://tms.tencentcloudapi.com') throw Object.assign(new Error(), { code: 'PROBE_TMS_LIMIT' });
      record('tms-request', { number: tmsCalls });
      const response = await fetch(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) });
      record('tms-response', { number: tmsCalls, http_status: response.status }); return response;
    } });
    const limitedProvider = { model: native.model, async createSession(options) {
      record('provider-connect');
      providerSession = await native.createSession({ ...options, instructions, signal: controller.signal, onEvent: event => {
        if (interruptionObserver.observe(event)) { interruptions++; record('provider-in-flight-interrupt', { number: interruptions }); }
        if (event.type === 'usage') { evidence.provider_reported_usage = event.usage; record('provider-usage'); }
        if (event.type === 'sentence-start') { sentenceCount++; record('provider-sentence', { number: sentenceCount }); }
        if (event.type === 'transcript' && event.final) record('final-user-transcript');
        if (event.type === 'audio') {
          rawBytes += event.bytes.length;
          if (completed === 1) secondAudio = true;
          if (rawBytes > PLAN.max_received_output_audio_ms * 48) { record('output-cap'); controller.abort(); providerSession?.close(); return; }
        }
        options.onEvent(event);
      } });
      record('provider-ready'); return providerSession;
    } };
    local = await localApp(limitedProvider, moderator);
    const session = await local.request(`/conversations/${local.conversation.conversation_id}/realtime-calls`, {});
    let ready = false;
    const response = await fetch(local.base + session.stream_url, { headers: { authorization: `Bearer ${local.token}` }, signal: controller.signal });
    streamTask = readEvents(response, async (event, data) => {
      if (event === 'realtime.ready') ready = true;
      if (event === 'realtime.interrupt') { sseInterrupts++; record('sse-interrupt-not-proof', { number: sseInterrupts }); }
      if (event === 'realtime.audio') approvedBytes += Buffer.from(data.audio_base64, 'base64').length;
      if (event === 'realtime.response-completed') { completed++; record('response-completed', { number: completed }); }
      if (event === 'realtime.closed') { record('closed', { reason: data.reason }); controller.abort(); }
    }, controller.signal).catch(error => { if (!controller.signal.aborted) { record('stream-failed'); controller.abort(); } });
    await waitUntil(() => ready);
    const { WebSocket } = require('ws');
    const mediaUrl = new URL(session.audio_socket_url, local.base); mediaUrl.protocol = 'ws:';
    socket = new WebSocket(mediaUrl, [session.audio_socket_protocol, `ticket.${session.audio_socket_ticket}`], { origin: local.base, perMessageDeflate: false });
    socket.on('message', bytes => {
      try { const ack = JSON.parse(bytes.toString()); if (ack.type !== 'audio.ack' || !Number.isInteger(ack.next_sequence)) throw new Error(); acknowledged = ack.next_sequence; }
      catch { record('media-ack-invalid'); controller.abort(); }
    });
    socket.on('error', () => { record('media-error'); controller.abort(); });
    socket.on('close', () => { if (!controller.signal.aborted) { record('media-closed'); controller.abort(); } });
    controller.signal.addEventListener('abort', () => socket?.terminate(), { once: true });
    await waitUntil(() => socket.readyState === WebSocket.OPEN);
    const upload = async number => {
      const start = performance.now(); record('upload-start', { number });
      for (let offset = 0; offset < source.pcm.length; offset += 640) {
        const delay = start + offset / 32 - performance.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (controller.signal.aborted) throw Object.assign(new Error(), { code: 'PROBE_STOPPED_DURING_UPLOAD' });
        const block = source.pcm.subarray(offset, offset + 640);
        if (sentBytes + block.length > PLAN.max_input_audio_ms * 32) throw Object.assign(new Error(), { code: 'PROBE_INPUT_LIMIT' });
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64000 || sequence - acknowledged >= 100)
          throw Object.assign(new Error(), { code: 'PROBE_MEDIA_BACKPRESSURE' });
        const frame = Buffer.alloc(4 + block.length); frame.writeUInt32BE(sequence++); block.copy(frame, 4); socket.send(frame); sentBytes += block.length;
      }
      record('upload-finished', { number, elapsed_ms: Math.round(performance.now() - start) });
    };
    await upload(1); await waitUntil(() => completed >= 1);
    await upload(2); await waitUntil(() => secondAudio);
    // Start fresh speech while the second response is in flight. No API spoofed interrupt.
    await upload(3); await waitUntil(() => completed >= 2);
    await upload(4); await waitUntil(() => completed >= 3);
    evidence.status = interruptions >= 1 ? 'SUCCEEDED_THREE_COMPLETED_AND_INTERRUPTED' : 'THREE_COMPLETED_INTERRUPT_NOT_OBSERVED';
    await local.request(`/realtime-calls/${session.session_id}/end`, {});
  } catch (error) {
    evidence.status = execute ? 'FAILED' : 'DRY_RUN_FAILED';
    evidence.failure_code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'PROBE_FAILED';
  } finally {
    clearTimeout(wallTimer); controller.abort(); socket?.terminate(); providerSession?.close();
    if (local) await local.stop(); if (streamTask) await streamTask.catch(() => {});
    Object.assign(evidence, { tms_calls: tmsCalls, raw_pcm_ms: rawBytes / 48, approved_pcm_ms: approvedBytes / 48,
      input_audio_ms: sentBytes / 32, completed_responses: completed, observed_in_flight_interruptions: interruptions, sse_interrupt_events: sseInterrupts, provider_cost_verified: false });
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    const destination = execute ? OUTPUT : OUTPUT.replace('.json', '-preflight.json');
    if (!execute || executionMarkerCreated) fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
    if (!['SUCCEEDED_THREE_COMPLETED_AND_INTERRUPTED', 'DRY_RUN_NO_EXTERNAL_NETWORK'].includes(evidence.status)) process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { PLAN, createInFlightInterruptionObserver };
