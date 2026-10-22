'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function pipeline() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../web/call-client.js'), 'utf8').replace(/^import .*;$/m, '').replace(/export /g, '');
  return vm.runInNewContext(`${source}\nAudioOutPipeline`, { Uint8Array, performance, AbortController, TextDecoder, setTimeout, clearTimeout });
}
function frame() { const bytes = new Uint8Array(417); bytes.set([0xff, 0xfb, 0x90, 0]); return bytes; }
function context(decode) {
  const starts = [];
  return { starts, state: 'running', currentTime: 1, destination: {}, decodeAudioData: decode,
    createBufferSource() { return { connect() {}, start(time) { starts.push(time); }, stop() {} }; } };
}
test('audio starts after prebuffer threshold before endTurn, and next turn resets its buffer duration', async () => {
  const Player = pipeline(), player = new Player();
  player.context = context(async () => ({ duration: 0.5 }));
  player.beginTurn();
  await player.enqueueMp3(frame());
  assert.equal(player.context.starts.length, 1);
  assert.equal(player.prebuffering, false);
  player.endTurn();
  player.beginTurn();
  assert.equal(player.holdDuration, 0);
});
test('under-threshold audio is released at stream end', async () => {
  const Player = pipeline(), player = new Player();
  player.context = context(async () => ({ duration: 0.1 }));
  player.beginTurn(); await player.enqueueMp3(frame());
  assert.equal(player.context.starts.length, 0);
  player.endTurn(); assert.equal(player.context.starts.length, 1);
});

test('paused message output is not resumed automatically by incoming decoded chunks', async () => {
  const Player = pipeline(), player = new Player();
  let resumes = 0;
  player.context = context(async () => ({ duration: 0.5 }));
  player.context.state = 'suspended';
  player.context.resume = async () => { resumes += 1; };
  player.outputPaused = true;
  player.beginTurn(); await player.enqueueMp3(frame());
  assert.equal(resumes, 0);
  player.outputPaused = false;
  player.ensureContext();
  assert.equal(resumes, 1);
});
test('pending decodes from an interrupted turn never play in a new turn; decoding stays ordered', async () => {
  const Player = pipeline(), player = new Player();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  player.context = context(async () => { calls += 1; if (calls === 1) await wait; return { duration: 0.5 }; });
  player.beginTurn(); const old = player.enqueueMp3(frame());
  await new Promise((resolve) => setImmediate(resolve));
  player.stopAll(); player.beginTurn(); const fresh = player.enqueueMp3(frame());
  release(); await Promise.all([old, fresh]);
  assert.equal(player.context.starts.length, 1);
});


test('call diagnostics retain server stages and measure first audio from end of speech', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../web/call-client.js'), 'utf8').replace(/^import .*;$/m, '').replace(/export /g, '');
  const clock = { now: () => 1700 };
  const window = {};
  const Client = vm.runInNewContext(`${source}\nCallSessionClient`, { Uint8Array, performance: clock, window, atob, AbortController, TextDecoder, setTimeout, clearTimeout });
  const events = [];
  const client = new Client({ authHeaders: () => ({}), onEvent: (event) => events.push(event) });
  client.lastTurnTiming = { turnId: 'turn-1', speechEndedAt: 1000, firstAudioMs: null, firstScheduledMs: null };
  let queued = 0;
  client.audioOut = { enqueueMp3: async () => { queued += 1; } };
  client.handleTurnEvent('call.turn.audio', { audio_base64: 'AA==' }, { greeting: false });
  assert.equal(queued, 1);
  assert.equal(window.__qiyuCallTurnTiming.firstAudioMs, 700);
  clock.now = () => 2500;
  client.handleTurnEvent('call.turn.completed', { timings_ms: { asr: 140, total: 800 } }, { greeting: false });
  assert.equal(window.__qiyuCallTurnTiming.completedMs, 1500);
  assert.equal(window.__qiyuCallTurnTiming.serverTimingsMs.asr, 140);
  assert.equal(events.find((event) => event.type === 'turn-done').timings_ms.total, 800);
  assert.equal(window.__qiyuCallTurnTiming.firstScheduledMs, null, '未排程不能将收到音频伪称首声');
});
