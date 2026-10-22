'use strict';
// Known synthetic audio only. Default is an offline preflight; no automatic retries.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { VolcengineRealtimeAdapter } = require('../src/providers/volcengine-realtime-adapter');
const { readSyntheticWav } = require('./verify-native-realtime-synthetic');
const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'output/voice-gender-2026-10-18');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function wav(pcm) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
async function main() {
  const gender = process.argv.includes('--male') ? 'MALE' : 'FEMALE';
  const execute = process.argv.includes('--execute-approved');
  const name = gender.toLowerCase(); const report = path.join(output, `${name}${execute ? '' : '-preflight'}.json`);
  const source = readSyntheticWav();
  const result = { status: 'PREFLIGHT_PASSED_NO_NETWORK', gender, plan: { reserve_cny: 0.25, sessions: 1, automatic_retries: 0, input_cap_ms: 2300, output_cap_ms: 6000, wall_cap_ms: 20000, strict_cloud_spend_cap_enforced: false }, speaker: null, input_ms: 0, output_ms: 0, transcripts: [], replies: [], usage: [], bill_verified: false, scope: 'real supplier adapter with known synthetic PCM; no browser, public proxy or human microphone' };
  assert.ok(source.inputDurationMs <= result.plan.input_cap_ms);
  fs.mkdirSync(output, { recursive: true });
  if (!execute) { fs.writeFileSync(report, JSON.stringify(result, null, 2)); console.log(result.status); return; }
  assert.equal(process.env.QIYU_APPROVED_GENDER_PROBE, `20261018-${name}`);
  assert.ok(process.env.VOLCENGINE_REALTIME_API_KEY);
  assert.ok(!fs.existsSync(report), 'a paid attempt already exists; no retry');
  fs.writeFileSync(report, JSON.stringify({ ...result, status: 'STARTED_NO_RETRY' }), { flag: 'wx' });
  const audio = []; let session, finished = false, timer;
  let finish; const done = new Promise(resolve => { finish = resolve; });
  const end = status => { if (finished) return; finished = true; result.status = status; finish(); };
  try {
    const adapter = new VolcengineRealtimeAdapter({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY, maxSessionMs: 20000, wsFactory: (url, options) => {
      const WebSocket = require('ws'); const socket = new WebSocket(url, options); const send = socket.send.bind(socket);
      socket.send = (bytes, ...args) => {
        if (bytes.readUInt32BE(4) === 100) { const n = bytes.readUInt32BE(8); result.speaker = JSON.parse(bytes.subarray(16 + n).toString()).tts.speaker; }
        return send(bytes, ...args);
      }; return socket;
    } });
    timer = setTimeout(() => end('WALL_CAP_REACHED'), 20000);
    session = await adapter.createSession({ botName: '小栖', voiceGender: gender,
      instructions: `你是虚构的${gender === 'MALE' ? '男性' : '女性'}陪伴角色小栖。用一句不超过15个字的中文自然回应，不自我介绍。`, onEvent: event => {
        if (event.type === 'transcript' && event.final) result.transcripts.push(event.text);
        if (event.type === 'sentence-start') result.replies.push(event.text);
        if (event.type === 'usage') result.usage.push(event.usage);
        if (event.type === 'audio') {
          if (result.output_ms + event.bytes.length / 48 > 6000) { end('OUTPUT_CAP_REACHED'); return; }
          audio.push(event.bytes); result.output_ms += event.bytes.length / 48;
        }
        if (event.type === 'response-complete') end('RESPONSE_COMPLETED');
        if (event.type === 'error') { result.error_code = event.code; end('FAILED'); }
      } });
    for (let i = 0; i < source.pcm.length && !finished; i += 640) { const chunk = source.pcm.subarray(i, i + 640); session.sendAudio(chunk); result.input_ms += chunk.length / 32; await sleep(20); }
    await done;
  } catch (error) { result.status = 'FAILED'; result.error_code = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PROBE_FAILED'; }
  finally {
    clearTimeout(timer); session?.close();
    if (audio.length) fs.writeFileSync(path.join(output, `${name}-sample.wav`), wav(Buffer.concat(audio)));
    fs.writeFileSync(report, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ status: result.status, gender, speaker: result.speaker, input_ms: result.input_ms, output_ms: result.output_ms }));
}
if (require.main === module) main().catch(() => { console.error('GENDER_PREFLIGHT_FAILED'); process.exitCode = 1; });
