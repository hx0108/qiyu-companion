'use strict';

// Client/source-scheduling acceptance, not an acoustic or human-microphone test.
// Default is entirely Mock. Real mode needs explicit root GO and its own budget.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright-core');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');
const { VolcengineRealtimeAdapter } = require('../src/providers/volcengine-realtime-adapter');
const { createTencentTextModeratorFromEnvironment } = require('../src/providers/tencent-moderation-adapter');
const ROOT = path.resolve(__dirname, '../../..');
const PLAN = Object.freeze({ reserve_cny: 0.50, sessions: 1, automatic_retries: 0, wall_clock_ms: 45000,
  max_input_audio_ms: 7000, max_received_output_audio_ms: 12000, max_prompt_utf8_bytes: 1200,
  max_tms_calls: 8, strict_provider_spend_cap_enforced: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function sourcePcm() {
  const wav = fs.readFileSync(path.join(ROOT, 'output/voice-latency-2026-10-14/real-synthetic-input.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let pcm; let valid = false;
  for (let i = 12; i + 8 <= wav.length;) {
    const kind = wav.toString('ascii', i, i + 4), size = wav.readUInt32LE(i + 4); i += 8;
    assert.ok(i + size <= wav.length);
    if (kind === 'fmt ') valid = wav.readUInt16LE(i) === 1 && wav.readUInt16LE(i + 2) === 1 && wav.readUInt32LE(i + 4) === 16000 && wav.readUInt16LE(i + 14) === 16;
    if (kind === 'data') pcm = Buffer.from(wav.subarray(i, i + size));
    i += size + size % 2;
  }
  assert.ok(valid && pcm?.length && pcm.length <= 57600 && pcm.length % 2 === 0);
  // Preserve all words. Peak-normalize once; browser energy uses these exact samples.
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 0);
  const gain = Math.min(4, 30000 / peak);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i);
  let continuous = 0; let best = 0; let normalizedPeak = 0;
  for (let offset = 0; offset < pcm.length; offset += 640) {
    let squared = 0; const count = Math.min(640, pcm.length - offset) / 2;
    for (let index = offset; index < offset + count * 2; index += 2) {
      const value = pcm.readInt16LE(index) / 32768; squared += value ** 2; normalizedPeak = Math.max(normalizedPeak, Math.abs(value));
    }
    continuous = Math.sqrt(squared / count) >= 0.12 ? continuous + count / 16 : 0; best = Math.max(best, continuous);
  }
  assert.ok(normalizedPeak < 1 && best >= 150, 'source must genuinely satisfy unchanged RMS threshold without clipping');
  return { pcm: Buffer.concat([pcm, Buffer.alloc(16000)]), gain, peak: normalizedPeak, continuousThresholdMs: best };
}
function tone(ms) {
  const pcm = Buffer.alloc(ms * 48);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 24000) * 3000), i * 2);
  return pcm;
}
async function main() {
  const execute = process.argv.includes('--execute-approved-browser-barge');
  const providerFirst = process.argv.includes('--mock-provider-first');
  const dir = path.join(ROOT, 'output/playwright', execute ? 'real-browser-barge-20261017-attempt-1' : `mock-browser-barge-${Date.now()}`);
  const report = path.join(dir, 'result.json');
  if (execute) {
    assert.equal(process.env.QIYU_APPROVED_REALTIME_PROBE, 'browser-barge-synthetic-0.50', 'root GO required');
    assert.ok(!fs.existsSync(report), 'paid attempt already exists; no retry');
  }
  fs.mkdirSync(dir, { recursive: true });
  if (execute) fs.writeFileSync(report, JSON.stringify({ status: 'STARTED_NO_RETRY', plan: PLAN }), { flag: 'wx' });
  const source = sourcePcm(); assert.ok(source.pcm.length / 32 * 3 <= PLAN.max_input_audio_ms);
  const state = { status: 'PREPARING', real_provider: execute, plan: PLAN,
    scope: 'Actual Edge AudioContext/BufferSource and production RealtimeCallClient; paced known synthetic PCM microphone input; no human microphone or acoustic verification; localhost proxy only',
    source_gain: source.gain, source_peak: source.peak, source_continuous_rms_above_threshold_ms: source.continuousThresholdMs, mock_trigger_case: execute ? null : providerFirst ? 'provider_speech_start' : 'local_energy', input_audio_ms: 0, raw_pcm_ms: 0, tms_calls: 0, provider_sessions: 0, provider_cost_verified: false, usage_snapshots: [], page_errors: [] };
  let browser; let page; let server; let providerSession; let wall; let mockBytes = 0; let options;
  const controller = new AbortController();
  const token = `local-browser-${randomUUID()}`; const store = new DevelopmentStore();
  const mockEvent = event => options.onEvent(event);
  function mockSpeech(n) {
    mockEvent({ type: 'speech-start', questionId: `q${n}` });
    if (n === 2) {
      // Late interrupted output must not be re-enqueued by the actual client.
      mockEvent({ type: 'audio', questionId: 'q1', replyId: 'r1', segmentId: 's1', bytes: tone(100) });
      mockEvent({ type: 'sentence-end', questionId: 'q1', replyId: 'r1', segmentId: 's1' });
      mockEvent({ type: 'response-complete', questionId: 'q1', replyId: 'r1' });
    }
  }
  function mockReply(n) {
    const ids = { questionId: `q${n}`, replyId: `r${n}`, segmentId: `s${n}` };
    mockEvent({ type: 'transcript', role: 'user', text: '你好呀。', final: true, questionId: ids.questionId });
    mockEvent({ type: 'sentence-start', text: '你好呀，我在听。', ...ids });
    mockEvent({ type: 'audio', ...ids, bytes: tone(n === 1 ? 4000 : 300), sampleRate: 24000, format: 'pcm_s16le' });
    if (n > 1) { mockEvent({ type: 'sentence-end', ...ids }); mockEvent({ type: 'response-complete', ...ids }); }
    else if (providerFirst) setTimeout(() => {
      // Generation completes while four seconds of audio remain queued for playback.
      mockEvent({ type: 'sentence-end', ...ids }); mockEvent({ type: 'response-complete', ...ids });
    }, 100);
  }
  let provider = { model: 'mock-browser-barge', async createSession(value) {
    options = value; state.provider_sessions++;
    return { close() {}, sendAudio(bytes) {
      const before = mockBytes; mockBytes += bytes.length; state.input_audio_ms = mockBytes / 32;
      for (let n = 1; n <= 3; n++) {
        const start = (n - 1) * source.pcm.length + (providerFirst ? 12800 : 38400);
        if (before < start && mockBytes >= start) mockSpeech(n);
        const replyAt = n * source.pcm.length - (n === 1 && providerFirst ? 8000 : 0);
        if (before < replyAt && mockBytes >= replyAt) mockReply(n);
      }
    } };
  } };
  let moderator = async () => ({ decision: 'PASS', policyVersion: 'mock-browser-barge' });
  try {
    if (execute) {
      process.loadEnvFile(path.join(ROOT, '.env'));
      assert.ok(process.env.VOLCENGINE_REALTIME_API_KEY);
      const native = new VolcengineRealtimeAdapter({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY, timeoutMs: 5000, maxSessionMs: PLAN.wall_clock_ms });
      provider = { model: native.model, async createSession(value) {
        assert.equal(++state.provider_sessions, 1);
        const instructions = value.instructions + '\n这是合成验收。第一次严格回答：你好呀，我在这里认真听着，你可以慢慢说，我会陪你聊下去。之后只答“你好呀”。';
        assert.ok(Buffer.byteLength(instructions) <= PLAN.max_prompt_utf8_bytes);
        providerSession = await native.createSession({ ...value, instructions, signal: controller.signal, onEvent(event) {
          if (event.type === 'usage') state.usage_snapshots.push(event.usage);
          if (event.type === 'audio') {
            state.raw_pcm_ms += event.bytes.length / 48;
            if (state.raw_pcm_ms > PLAN.max_received_output_audio_ms) { controller.abort(); providerSession?.close(); return; }
          }
          value.onEvent(event);
        } });
        return { close() { providerSession.close(); }, sendAudio(bytes) {
          state.input_audio_ms += bytes.length / 32;
          assert.ok(state.input_audio_ms <= PLAN.max_input_audio_ms);
          return providerSession.sendAudio(bytes);
        } };
      } };
      moderator = createTencentTextModeratorFromEnvironment({ ...process.env, QIYU_TEXT_MODERATION_PROVIDER: 'tencent', TENCENT_MODERATION_TIMEOUT_MS: '3000' }, { fetchImpl: (url, init) => {
        assert.equal(url, 'https://tms.tencentcloudapi.com'); assert.ok(++state.tms_calls <= PLAN.max_tms_calls);
        return fetch(url, { ...init, signal: AbortSignal.any([controller.signal, init.signal]) });
      } });
    }
    server = createApp({ store, summaryEnabled: false, trialAuthEnabled: true,
      trialAuth: { resolveAccessToken: async value => value === token ? 'acct_dev_alice' : null },
      voiceCallEnabled: true, realtimeCallEnabled: true, realtimeProvider: provider, textModerator: moderator });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (route, body) => {
      const response = await fetch(base + '/api/v1' + route, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json(); assert.ok(response.ok, result.error?.code); return result;
    };
    for (const notice of (await request('/required-notices')).notices) await request(`/required-notices/${notice.notice_id}/displayed`, { notice_version: notice.notice_version });
    await request('/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
    const character = (await request('/characters', { name: '林语' })).character;
    const conversation = (await request('/conversations', { character_id: character.character_id })).conversation;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    page = await browser.newPage(); page.on('pageerror', () => state.page_errors.push('PAGE_ERROR'));
    await page.goto(base);
    wall = setTimeout(() => { controller.abort(); providerSession?.close(); }, PLAN.wall_clock_ms);
    await page.evaluate(async ({ token, conversationId, pcmBase64 }) => {
      const { RealtimeCallClient } = await import('/realtime-call-client.js');
      const pcm = Uint8Array.from(atob(pcmBase64), value => value.charCodeAt(0));
      const trace = window.__bargeProbe = { events: [], sources: [], inputs: [], target_completions: [], barge: null, first_reply: null, energy_barge_observed: false, done: false, error: null };
      const labels = new Map(); const label = value => { if (!value) return null; if (!labels.has(value)) labels.set(value, labels.size + 1); return labels.get(value); };
      let client; let mic; let completed = 0; let thirdStarted = false; let secondStarted = false;
      let firstQuestion; let secondQuestion; let thirdQuestion; const replyQuestions = new Map();
      const context = new AudioContext(); await context.resume();
      const original = context.createBufferSource.bind(context);
      context.createBufferSource = () => {
        const source = original(); const start = source.start.bind(source); const stop = source.stop.bind(source);
        const item = { ordinal: trace.sources.length + 1, reply: null, started: false, stopped: false, ended: false, activeAtBarge: false };
        trace.sources.push(item);
        source.start = when => { item.reply = label(client.replyId); item.started = true; item.start_ms = performance.now(); item.when = when; item.end_context_time = when + source.buffer.duration; return start(when); };
        source.stop = (...args) => { item.stopped = true; item.stop_ms = performance.now(); return stop(...args); };
        source.addEventListener('ended', () => { item.ended = true; item.ended_ms = performance.now(); });
        return source;
      };
      const reportError = error => { trace.error = error.code || 'BROWSER_PROBE_FAILED'; trace.done = true; };
      const runInput = () => mic.play().catch(reportError);
      client = new RealtimeCallClient({ apiBase: '/api/v1', conversationId,
        authHeaders: () => ({ authorization: `Bearer ${token}` }), contextFactory: () => context,
        micFactory: options => mic = {
          running: true, busy: false, async start() {}, setUploading() {}, stop() { this.running = false; },
          async play() {
            if (this.busy) throw new Error('INPUT_OVERLAP'); this.busy = true;
            const begin = performance.now();
            trace.inputs.push({ ordinal: trace.inputs.length + 1, at_ms: begin, active_source_ordinals: trace.sources.filter(item => item.started && !item.stopped && !item.ended && context.currentTime >= item.when && context.currentTime < item.end_context_time).map(item => item.ordinal) });
            for (let offset = 0; offset < pcm.length && this.running; offset += 640) {
              const delay = begin + offset / 32 - performance.now(); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
              const bytes = pcm.slice(offset, offset + 640); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
              let squared = 0; for (let i = 0; i < bytes.length; i += 2) squared += (view.getInt16(i, true) / 32768) ** 2;
              options.onEnergy(Math.sqrt(squared / (bytes.length / 2)), performance.now()); options.onChunk(bytes);
            }
            this.busy = false;
          }
        },
        onEvent(event) {
          const now = performance.now(); trace.events.push({ type: event.type, phase: event.phase, reply: label(event.replyId), at_ms: now });
          if (event.type === 'barge-in') {
            trace.energy_barge_observed = true;
            const active = trace.sources.filter(item => item.started && !item.ended && !item.stopped && item.end_context_time > context.currentTime);
            // stop() runs immediately before this event. Capture corresponding stopped-but-not-ended sources too.
            const justStopped = trace.sources.filter(item => item.stopped && !item.ended && now - item.stop_ms < 30 && item.end_context_time > context.currentTime);
            for (const item of [...active, ...justStopped]) item.activeAtBarge = true;
            trace.barge = { trigger: 'local_energy', at_ms: now, reply: label(client.replyId), active_sources: active.length + justStopped.length, scheduled_count: trace.sources.length };
          }
          if (event.type === 'audible' && event.audible && !secondStarted) {
            secondStarted = true;
            trace.first_reply = label(client.replyId);
            // Keep the complete first utterance and its tail. Start only during
            // actual old playback, never overlap microphone uploads or invent a barge.
            const deadline = now + 2500;
            const beginSecond = () => {
              const active = trace.sources.some(item => item.reply === trace.first_reply && item.started && !item.stopped && !item.ended && context.currentTime >= item.when && context.currentTime < item.end_context_time);
              if (!mic.busy && active) { runInput(); return; }
              if (performance.now() > deadline || client.closed) { reportError({ code: 'SECOND_INPUT_ACTIVE_PLAYBACK_WINDOW_MISSED' }); return; }
              setTimeout(beginSecond, 20);
            }; setTimeout(beginSecond, 20);
          }
          const matchesTarget = event.type === 'response-complete' && trace.barge &&
            ((completed === 0 && secondQuestion && replyQuestions.get(event.replyId) === secondQuestion) ||
             (completed === 1 && thirdQuestion && replyQuestions.get(event.replyId) === thirdQuestion));
          if (matchesTarget) {
            completed++;
            trace.target_completions.push({ input: completed + 1, reply: label(event.replyId), at_ms: now });
            if (completed === 1 && !thirdStarted) {
              thirdStarted = true;
              const wait = () => {
                if (mic.busy || client.phase === 'responding') { setTimeout(wait, 30); return; }
                runInput();
              }; setTimeout(wait, 30);
            }
            if (completed === 2) {
              const target = label(event.replyId);
              const waitPlayed = () => {
                if (trace.error) return;
                const sources = trace.sources.filter(item => item.reply === target);
                if (sources.length && sources.every(item => item.ended) && !mic.busy) { trace.done = true; return; }
                setTimeout(waitPlayed, 25);
              }; setTimeout(waitPlayed, 25);
            }
          }
          if (event.type === 'closed' && trace.intentional_hangup) { trace.cleanup_reason = event.reason; return; }
          if (event.type === 'error' || event.type === 'closed') { trace.error = event.code || 'CLIENT_CLOSED'; trace.done = true; }
        }
      });
      // Passive observation around the unchanged production event handler.
      const originalHandle = client.handleEvent.bind(client);
      client.handleEvent = (type, data) => {
        if (type === 'realtime.text') replyQuestions.set(data.reply_id, data.question_id);
        if ((type === 'realtime.interrupt' || type === 'realtime.speech-start') && data.question_id) {
          if (trace.inputs.length === 1) firstQuestion ||= data.question_id;
          if (trace.inputs.length === 2 && data.question_id !== firstQuestion) secondQuestion ||= data.question_id;
          if (trace.inputs.length === 3 && data.question_id !== firstQuestion && data.question_id !== secondQuestion) thirdQuestion ||= data.question_id;
        }
        const candidates = !trace.barge && trace.inputs.length === 2 && (type === 'realtime.interrupt' || type === 'realtime.speech-start') && data.question_id && data.question_id !== client.questionId
          ? trace.sources.filter(item => item.started && !item.stopped && !item.ended && context.currentTime >= item.when && context.currentTime < item.end_context_time) : [];
        const oldReply = label(client.replyId);
        const result = originalHandle(type, data);
        const stopped = candidates.filter(item => item.stopped);
        if (stopped.length) {
          for (const item of stopped) item.activeAtBarge = true;
          trace.barge = { trigger: 'provider_speech_start', at_ms: performance.now(), reply: oldReply, active_sources: stopped.length, scheduled_count: trace.sources.length };
        }
        return result;
      };
      window.__bargeClient = client;
      await client.start(); runInput();
    }, { token, conversationId: conversation.conversation_id, pcmBase64: source.pcm.toString('base64') });
    await page.waitForFunction(() => window.__bargeProbe.done, null, { timeout: PLAN.wall_clock_ms });
    const result = await page.evaluate(() => window.__bargeProbe);
    state.browser = result;
    assert.equal(result.error, null); assert.ok(result.barge?.active_sources > 0, 'barge must stop an active real audio source');
    assert.ok(result.inputs[1]?.active_source_ordinals.length > 0, 'second real PCM input must begin while old audio source is active');
    if (!execute) assert.equal(result.barge.trigger, providerFirst ? 'provider_speech_start' : 'local_energy');
    const oldSources = result.sources.filter(item => item.reply === result.barge.reply);
    assert.ok(oldSources.some(item => item.stopped && item.activeAtBarge));
    assert.ok(!oldSources.some(item => item.start_ms > result.barge.at_ms), 'old reply must not enqueue after barge');
    const completions = result.target_completions;
    assert.equal(completions.length, 2); assert.notEqual(completions[0].reply, result.barge.reply);
    assert.notEqual(completions[0].reply, completions[1].reply);
    for (const event of completions) assert.ok(result.sources.some(item => item.reply === event.reply && item.started && item.ended), 'each subsequent completed reply must actually play');
    assert.equal(state.page_errors.length, 0);
    assert.equal(await page.evaluate(() => window.__bargeClient.closed), false);
    // End the server session explicitly before tearing down WS/SSE, so teardown
    // cannot win the race and mislabel this successful acceptance as a disconnect.
    await page.evaluate(async () => {
      window.__bargeProbe.intentional_hangup = true;
      await window.__bargeClient.request(`/realtime-calls/${encodeURIComponent(window.__bargeClient.sessionId)}/end`, {});
    });
    await page.waitForFunction(() => window.__bargeClient.closed && window.__bargeClient.context.state === 'closed' && window.__bargeClient.audioSocket.readyState === 3);
    state.cleanup = await page.evaluate(() => ({ reason: window.__bargeProbe.cleanup_reason, context_closed: window.__bargeClient.context.state === 'closed', socket_closed: window.__bargeClient.audioSocket.readyState === 3 }));
    state.cleanup.reserved_tokens = [...store.dailyChatUsage.values()].reduce((sum, usage) => sum + usage.reserved_input_tokens, 0);
    assert.equal(state.cleanup.reason, 'USER_HANGUP'); assert.equal(state.cleanup.reserved_tokens, 0);
    state.status = execute ? 'SUCCEEDED_REAL_BROWSER_PLAYBACK_BARGE' : 'SUCCEEDED_MOCK_BROWSER_PLAYBACK_BARGE';
    await page.screenshot({ path: path.join(dir, 'after-barge.png') });
  } catch (error) {
    state.status = 'FAILED'; state.failure_code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'BROWSER_BARGE_ASSERTION_FAILED';
    state.failure_message = error.message;
    if (page) state.browser = await page.evaluate(() => window.__bargeProbe).catch(() => null);
  } finally {
    clearTimeout(wall);
    if (page) await page.evaluate(() => window.__bargeClient?.end()).catch(() => {});
    controller.abort(); providerSession?.close();
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(report, JSON.stringify(state, null, 2) + '\n');
    console.log(JSON.stringify({ output: report, status: state.status, failure_code: state.failure_code, failure_message: state.failure_message }));
    if (state.status === 'FAILED') process.exitCode = 1;
  }
}
if (require.main === module) main().catch(error => { console.error(error.code || 'BROWSER_BARGE_FATAL'); process.exitCode = 1; });
module.exports = { PLAN, sourcePcm };
