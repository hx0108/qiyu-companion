// Local synthetic trial + Mock native provider; real Edge mic/WS/SSE/PCM scheduling.
// No external provider requests and no claim about production/acoustic latency.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { createApp } = require('../src/app');
const { DevelopmentStore } = require('../src/domain/store');

const waitFor = async (predicate, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
function pcmTone(seconds = 0.3) {
  const bytes = Buffer.alloc(Math.round(seconds * 24000) * 2);
  for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 640 / 24000) * 2500), i * 2);
  return bytes;
}
async function main() {
  const output = path.resolve(__dirname, '../../../output/playwright', `native-call-${Date.now()}`);
  fs.mkdirSync(output, { recursive: true });
  const wav = path.join(output, 'synthetic-low-energy-mic.wav');
  const generated = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=640:duration=8:sample_rate=16000', '-filter:a', 'volume=0.01', '-ac', '1', '-c:a', 'pcm_s16le', wav], { windowsHide: true });
  assert.equal(generated.status, 0, 'synthetic microphone WAV must be generated');
  const store = new DevelopmentStore();
  const accountId = 'acct_dev_alice', token = 'local-native-browser-synthetic-token';
  const tokens = { access_token: token, refresh_token: 'local-native-browser-synthetic-refresh', expires_in: 3600 };
  const state = { providerSessions: 0, providerClosed: 0, uploadedFrames: 0, uploadedBytes: 0, audits: [], events: [], pageErrors: [], networkFailures: [], httpErrors: [] };
  let providerOptions;
  const provider = { model: 'local-mock-native', async createSession(options) {
    state.providerSessions++; providerOptions = options;
    return { close() { state.providerClosed++; }, sendAudio(bytes) { state.uploadedFrames++; state.uploadedBytes += bytes.length; } };
  } };
  const trialAuth = { resolveAccessToken: async value => value === token ? accountId : null,
    createSession: async ({ inviteCode }) => { assert.equal(inviteCode, 'LOCAL-SYNTHETIC-NATIVE'); return { account_id: accountId, tokens }; },
    refreshSession: async ({ refreshToken }) => { assert.equal(refreshToken, tokens.refresh_token); return { account_id: accountId, tokens }; } };
  const server = createApp({ store, trialAuthEnabled: true, trialAuth, voiceCallEnabled: true, realtimeCallEnabled: true,
    realtimeProvider: provider, summaryEnabled: false, textModerator: async input => { state.audits.push(input.direction); return { decision: 'PASS', policyVersion: 'local-mock-browser-p1' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let key = 0;
  async function api(route, method = 'GET', body) {
    const response = await fetch(base + '/api/v1' + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `local-browser-${++key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, `${route}: ${response.status} ${result.error?.code || ''}`); return result;
  }
  const notices = await api('/required-notices');
  for (const notice of notices.notices) await api(`/required-notices/${notice.notice_id}/displayed`, 'POST', { notice_version: notice.notice_version });
  await api('/age/declarations', 'POST', { date_of_birth: '1991-05-20', confirmed_18_plus: true });
  const character = (await api('/characters', 'POST', { name: '语音验证角色' })).character;
  store.characters.get(character.character_id).persona.relationship_to_user = '男女朋友';
  const conversation = (await api('/conversations', 'POST', { character_id: character.character_id })).conversation;
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
  const page = await browser.newPage();
  page.on('pageerror', error => state.pageErrors.push(error.message));
  page.on('response', async response => {
    if (response.status() >= 400) { const body = await response.json().catch(() => ({})); state.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status(), code: body.error?.code, message: body.error?.message }); }
  });
  page.on('requestfailed', request => { if (!request.failure()?.errorText?.includes('ERR_ABORTED')) state.networkFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  await page.addInitScript(() => {
    window.__nativeProbe = { schedules: [], events: [], serverEvents: [] };
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this), start = source.start.bind(source);
      source.start = (...args) => { window.__nativeProbe.schedules.push({ replyId: window.__qiyuCall?.replyId, at: performance.now(), when: args[0] }); return start(...args); };
      return source;
    };
  });
  function send(type, fields) { providerOptions.onEvent({ type, ...fields }); }
  function startQuestion(n) {
    send('speech-start', { questionId: `q${n}` });
    send('transcript', { role: 'user', final: true, text: `这是第${n}轮问候。`, questionId: `q${n}` });
  }
  function sentence(n, text = '你好呀，我在听。') {
    send('sentence-start', { text, questionId: `q${n}`, replyId: `r${n}`, segmentId: `s${n}` });
    send('audio', { bytes: pcmTone(), sampleRate: 24000, format: 'pcm_s16le', questionId: `q${n}`, replyId: `r${n}`, segmentId: `s${n}` });
  }
  try {
    await page.goto(base);
    await page.locator('[name="invite_code"]').fill('LOCAL-SYNTHETIC-NATIVE');
    await page.locator('#trial-login-form button[type="submit"], #trial-login-form .btn-primary').first().click();
    await page.locator('[data-action="start-call"]').waitFor(); await page.locator('[data-action="start-call"]').click();
    assert.equal(await page.locator('[data-action="start-realtime-call"]').count(), 0);
    assert.doesNotMatch(await page.locator('#app').innerText(), /低延迟验证|选择语音通话/);
    await page.screenshot({ path: path.join(output, 'direct-call.png') });
    await page.waitForFunction(() => window.__qiyuCall?.mic || document.querySelector('.toast'));
    const startupError = await page.locator('.toast').count() ? await page.locator('.toast').textContent() : null;
    if (startupError && !await page.evaluate(() => Boolean(window.__qiyuCall?.mic))) throw new Error(`Native browser startup failed: ${startupError}`);
    await page.waitForFunction(() => window.__qiyuCall?.mic?.stream && window.__qiyuCall.phase === 'ready' && window.__qiyuCall.audioSocket?.readyState === 1);
    await page.evaluate(() => {
      const client = window.__qiyuCall, old = client.onEvent;
      client.onEvent = event => { window.__nativeProbe.events.push({ type: event.type, replyId: event.replyId, code: event.code }); old(event); };
      const handle = client.handleEvent;
      client.handleEvent = (type, data) => {
        window.__nativeProbe.serverEvents.push({ type, questionId: data.question_id, replyId: data.reply_id, code: data.code });
        return handle.call(client, type, data);
      };
      window.__nativeMicTracks = client.mic.stream.getTracks(); window.__nativeSocket = client.audioSocket; window.__nativeContext = client.context;
    });
    await waitFor(() => state.uploadedFrames >= 3, 'real microphone PCM never reached Mock provider over WebSocket');
    // Hold acknowledgements for 1.4s: the old ten-frame window ended this call.
    await page.evaluate(() => {
      const socket = window.__qiyuCall.audioSocket, original = socket.onmessage;
      const pending = [];
      window.__nativeAckDelay = { socket, original, pending };
      socket.onmessage = event => {
        const entry = { event, timer: null }; pending.push(entry);
        entry.timer = setTimeout(() => { pending.splice(pending.indexOf(entry), 1); original(event); }, 1400);
      };
    });
    await new Promise(resolve => setTimeout(resolve, 2400));
    assert.equal(await page.evaluate(() => window.__qiyuCall?.closed), false);
    state.delayedAckRecovered = true;
    // Do not carry deliberately delayed real-network callbacks into the virtual
    // clock test: flush them in arrival order before restoring live delivery.
    await page.evaluate(() => {
      const { socket, original, pending } = window.__nativeAckDelay;
      socket.onmessage = original;
      for (const entry of pending) { clearTimeout(entry.timer); original(entry.event); }
      pending.length = 0; delete window.__nativeAckDelay;
    });
    // Advance browser timers beyond three minutes without spending real time.
    await page.clock.install(); await page.clock.fastForward(185000);
    assert.equal(await page.evaluate(() => window.__qiyuCall?.closed), false);
    await page.clock.resume(); state.beyondSixtySecondsVerified = true; state.beyondThreeMinutesVerified = true;
    assert.match(providerOptions.instructions, /男女朋友/, 'the current romantic relationship must reach the provider');
    const candidatesBeforeRejection = store.candidates.size;
    startQuestion(0); sentence(0, '我们只是好朋友。');
    send('sentence-end', { questionId: 'q0', replyId: 'r0', segmentId: 's0' });
    send('response-complete', { questionId: 'q0', replyId: 'r0' });
    await page.waitForFunction(() => window.__nativeProbe.serverEvents.some(event => event.type === 'realtime.response-rejected' && event.replyId === 'r0' && event.code === 'OOC_RELATIONSHIP_CONFLICT'));
    await page.waitForFunction(() => window.__nativeProbe.events.some(event => event.type === 'turn-failed' && event.code === 'OOC_RELATIONSHIP_CONFLICT'));
    await page.waitForFunction(() => window.__nativeProbe.serverEvents.some(event => event.type === 'realtime.response-skipped' && event.replyId === 'r0'));
    assert.equal(await page.evaluate(() => window.__nativeProbe.schedules.filter(entry => entry.replyId === 'r0').length), 0, 'wrong friend reply must never schedule audio');
    assert.equal(await page.evaluate(() => window.__qiyuCall?.closed), false, 'relationship rejection must keep the same call open');
    assert.equal(await page.evaluate(() => window.__qiyuCall?.phase), 'ready');
    assert.equal(state.providerSessions, 1);
    assert.equal([...store.messages.values()].filter(message => message.provider === 'volcengine-realtime').length, 0, 'rejected relationship reply must not become conversation history');
    assert.equal(store.candidates.size, candidatesBeforeRejection, 'rejected relationship reply must not create memory candidates');
    state.wrongRelationshipRejected = true;
    state.rejectedAudioNotScheduled = true;
    state.relationshipRejectionKeptCallOpen = true;
    send('speech-start', { questionId: 'q-empty' });
    send('speech-end', { questionId: 'q-empty', empty: true, reason: 'ASR_UNCONFIRMED' });
    await page.waitForFunction(() => window.__nativeProbe.serverEvents.some(event => event.type === 'realtime.input-skipped' && event.questionId === 'q-empty' && event.code === 'ASR_UNCONFIRMED'));
    await page.waitForFunction(() => window.__nativeProbe.events.some(event => event.type === 'turn-failed' && event.code === 'ASR_UNCONFIRMED'));
    assert.equal(await page.evaluate(() => window.__qiyuCall?.closed), false, 'unconfirmed ASR must keep the call open');
    assert.equal(await page.evaluate(() => window.__qiyuCall?.phase), 'ready');
    assert.equal(await page.evaluate(() => window.__qiyuCall?.questionId), null, 'unconfirmed ASR must release the active question');
    assert.equal([...store.messages.values()].filter(message => message.provider === 'volcengine-realtime').length, 0);
    state.unconfirmedAsrRecoverable = true;
    for (let round = 1; round <= 30; round++) {
      startQuestion(round); sentence(round, round === 1 ? '我们是恋人呀。' : undefined);
      send('sentence-end', { questionId: `q${round}`, replyId: `r${round}`, segmentId: `s${round}` });
      send('response-complete', { questionId: `q${round}`, replyId: `r${round}` });
      await page.waitForFunction(n => window.__nativeProbe.events.some(event => event.type === 'response-complete' && event.replyId === `r${n}`), round);
      await page.waitForFunction(n => window.__nativeProbe.schedules.some(entry => entry.replyId === `r${n}`), round);
      await page.waitForFunction(() => window.__qiyuCall?.phase === 'ready');
      if (round === 1) {
        assert.equal(state.providerSessions, 1, 'compliant romantic reply must play in the original call');
        state.compliantRomanticReplyPlayed = true;
        state.nextRoundAfterUnconfirmedAsrPlayed = true;
      }
    }
    startQuestion(31); sentence(31);
    await page.waitForFunction(() => window.__nativeProbe.schedules.some(entry => entry.replyId === 'r31'));
    const beforeInterrupt = await page.evaluate(() => window.__nativeProbe.schedules.filter(entry => entry.replyId === 'r31').length);
    startQuestion(32);
    await page.waitForFunction(() => window.__qiyuCall?.questionId === 'q32');
    send('audio', { bytes: pcmTone(), sampleRate: 24000, format: 'pcm_s16le', questionId: 'q31', replyId: 'r31', segmentId: 's31' });
    send('sentence-end', { questionId: 'q31', replyId: 'r31', segmentId: 's31' });
    send('response-complete', { questionId: 'q31', replyId: 'r31' });
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterInterrupt = await page.evaluate(() => window.__nativeProbe.schedules.filter(entry => entry.replyId === 'r31').length);
    assert.equal(afterInterrupt, beforeInterrupt, 'late interrupted reply must never schedule more audio');
    await page.locator('[data-action="call-hangup"]').click();
    await page.waitForFunction(() => window.__qiyuCall === null && window.__nativeMicTracks.every(track => track.readyState === 'ended') && window.__nativeSocket.readyState === 3 && window.__nativeContext.state === 'closed');
    await waitFor(() => [...store.dailyChatUsage.values()].every(usage => usage.reserved_input_tokens === 0), 'hangup left token reservation');
    const messages = [...store.messages.values()].filter(message => message.provider === 'volcengine-realtime');
    assert.equal(messages.length, 60, 'thirty completed rounds persist; interrupted fragments do not become complete replies');
    assert.ok(messages.some(message => message.actor === 'ASSISTANT' && message.text === '我们是恋人呀。'));
    assert.ok(messages.every(message => message.text !== '我们只是好朋友。'));
    assert.equal(state.providerSessions, 1); assert.ok(state.providerClosed >= 1); assert.equal(state.pageErrors.length, 0);
    state.browser = await page.evaluate(() => window.__nativeProbe);
    state.persistedNativeMessages = messages.length; state.reservedTokens = [...store.dailyChatUsage.values()].reduce((sum, usage) => sum + usage.reserved_input_tokens, 0);
    state.lateInterruptedAudioBlocked = afterInterrupt === beforeInterrupt; state.mediaReleased = true; state.directNativeCallVerified = true; state.twelveRoundsVerified = true; state.thirtyRoundsVerified = true;
    state.passed = true;
    await page.screenshot({ path: path.join(output, 'after-hangup.png') });
  } catch (error) {
    state.passed = false; state.error = error.stack;
    state.browser = await page.evaluate(() => ({ ...window.__nativeProbe, client: window.__qiyuCall ? { phase: window.__qiyuCall.phase, closed: window.__qiyuCall.closed, sequence: window.__qiyuCall.sequence, ack: window.__qiyuCall.ackSequence } : null })).catch(() => null);
    state.body = (await page.locator('body').innerText().catch(() => '')).slice(-1800);
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  } finally {
    await page.evaluate(() => window.__qiyuCall?.hangup()).catch(() => {});
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    state.scope = 'Isolated synthetic trial; Mock native provider; real Edge fake microphone PCM, localhost WebSocket, audited SSE, AudioContext PCM source.start; not real-provider or acoustic SLA';
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ output, ...state }));
  }
  assert.equal(state.passed, true, `Native browser verification failed; see ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
