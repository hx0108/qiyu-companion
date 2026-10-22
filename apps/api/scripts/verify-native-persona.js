'use strict';
// Controlled synthetic provider diagnostic. No user data; not a production or
// browser acceptance test. Default execution is an offline preflight.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { VolcengineRealtimeAdapter, decodeRealtimeFrame } = require('../src/providers/volcengine-realtime-adapter');
const { providerSessionContext } = require('../src/domain/realtime-call');
const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(ROOT, 'output/voice-persona-2026-10-18');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const persona = { gender: 'female', worldview: '现代都市', age_setting: '25岁', relationship_to_user: '用户的女朋友', personality: '温柔、有主见，不使用客服式套话', expression_style: '口语简洁，亲密自然，称呼用户阿辰', hard_boundaries: ['不替用户作决定'], example_behaviors: ['先回应感受，不连续追问'] };
function readWav(file) {
  const bytes = fs.readFileSync(file); let pcm, format;
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  for (let i = 12; i + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', i, i + 4), size = bytes.readUInt32LE(i + 4); i += 8;
    assert.ok(i + size <= bytes.length);
    if (name === 'fmt ') format = { codec: bytes.readUInt16LE(i), channels: bytes.readUInt16LE(i + 2), rate: bytes.readUInt32LE(i + 4), bits: bytes.readUInt16LE(i + 14) };
    if (name === 'data') pcm = bytes.subarray(i, i + size);
    i += size + size % 2;
  }
  assert.deepEqual(format, { codec: 1, channels: 1, rate: 16000, bits: 16 });
  assert.ok(pcm?.length && pcm.length <= 192000);
  return Buffer.concat([pcm, Buffer.alloc(16000)]);
}
async function main() {
  const execute = process.argv.includes('--execute-approved');
  const phase = process.argv.includes('--comfort') ? 'fixed-cool-comfort' : process.argv.includes('--baseline') ? 'baseline' : process.argv.includes('--cool') ? 'fixed-cool' : 'fixed';
  const output = path.join(OUT, `${phase}${execute ? '' : '-preflight'}.json`);
  const plan = { reserve_cny: 0.25, sessions: 1, automatic_retries: 0, max_wall_ms: 30000, max_input_ms: 6500, max_output_ms: 8000, max_prompt_bytes: 6000, provider_bill_verified: false, strict_provider_spend_cap_enforced: false };
  const activePersona = phase.startsWith('fixed-cool') ? { ...persona, personality: '冷静克制，嘴硬心软，有主见', expression_style: '只说一两句短句，略带傲娇，称呼阿辰；不说教，不用客服套话，不连续追问' } : persona;
  const mapped = providerSessionContext({ character: { name: '小栖', persona: activePersona }, user_preferences: { address_terms: { character_to_user: '阿辰' } } });
  const pcm = readWav(path.join(OUT, phase === 'fixed-cool-comfort' ? 'comfort-16k.wav' : 'question-16k.wav'));
  assert.ok(pcm.length / 32 <= plan.max_input_ms);
  assert.ok(Buffer.byteLength(mapped.instructions) <= plan.max_prompt_bytes);
  const result = { status: 'PREFLIGHT_PASSED_NO_NETWORK', phase, plan, synthetic_question: phase === 'fixed-cool-comfort' ? '我今天很累，你陪我说句话吧。' : '我们是什么关系？你平时怎么称呼我？', persona: activePersona, speaking_style: phase === 'baseline' ? null : mapped.speakingStyle, prompt_bytes: Buffer.byteLength(mapped.instructions + (phase === 'baseline' ? '' : mapped.speakingStyle || '')), input_ms: pcm.length / 32, output_ms: 0, input_sent_ms: 0, transcripts: [], replies: [], asr_schema: [], usage: [], events: [] };
  if (!execute) { fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(result.status); return; }
  assert.equal(process.env.QIYU_APPROVED_PERSONA_PROBE, `20261018-${phase}`);
  assert.ok(!fs.existsSync(output), 'No automatic repeat of a paid attempt');
  fs.writeFileSync(output, JSON.stringify({ ...result, status: 'STARTED_NO_RETRY' }), { flag: 'wx' });
  let session, timer, done = false; const audio = []; const controller = new AbortController();
  let resolve; const finished = new Promise(r => { resolve = r; });
  function end(status) { if (done) return; done = true; result.status = status; resolve(); }
  const key = process.env.VOLCENGINE_REALTIME_API_KEY;
  assert.ok(key, 'Dedicated speech credential required');
  try {
    const Base = phase === 'baseline'
      ? require(path.join(OUT, 'adapter-baseline.cjs')).VolcengineRealtimeAdapter : VolcengineRealtimeAdapter;
    const adapter = new Base({ apiKey: key, model: '1.2.1.1', maxSessionMs: plan.max_wall_ms, wsFactory: (url, options) => {
      const WebSocket = require('ws'); const ws = new WebSocket(url, options);
      ws.on('message', (bytes, binary) => {
        if (!binary) return;
        try {
          const frame = decodeRealtimeFrame(bytes), p = frame.payload;
          if (frame.event === 451) result.asr_schema.push({ results_type: Array.isArray(p.results) ? 'array' : typeof p.results, entries: Array.isArray(p.results) ? p.results.map(r => ({ text_type: typeof r?.text, text_length: r?.text?.length, interim_type: typeof r?.is_interim, interim: typeof r?.is_interim === 'boolean' ? r.is_interim : null })) : [] });
          if (frame.event === 154) result.usage.push(p);
        } catch {}
      }); return ws;
    } });
    session = await adapter.createSession({ instructions: mapped.instructions, context: mapped.context, botName: '小栖', voiceGender: 'FEMALE', ...(mapped.speakingStyle ? { speakingStyle: mapped.speakingStyle } : {}), signal: controller.signal, onEvent: event => {
      result.events.push(event.type);
      if (event.type === 'transcript' && event.final) result.transcripts.push(event.text);
      if (event.type === 'sentence-start') result.replies.push(event.text);
      if (event.type === 'audio') { audio.push(event.bytes); result.output_ms += event.bytes.length / 48; if (result.output_ms >= plan.max_output_ms) end('OUTPUT_CAP_REACHED'); }
      if (event.type === 'response-complete') end('RESPONSE_COMPLETED');
      if (event.type === 'error') { result.error_code = event.code; if (event.diagnostic) result.diagnostic = event.diagnostic; end('FAILED'); }
    } });
    timer = setTimeout(() => end('WALL_CAP_REACHED'), plan.max_wall_ms);
    for (let i = 0; i < pcm.length && !done; i += 640) { session.sendAudio(pcm.subarray(i, i + 640)); result.input_sent_ms += Math.min(640, pcm.length - i) / 32; await wait(20); }
    await finished;
  } catch (error) { result.status = 'FAILED'; result.error_code = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PROBE_FAILED'; }
  finally { clearTimeout(timer); session?.close(); controller.abort(); fs.writeFileSync(output, JSON.stringify(result, null, 2)); if (audio.length) fs.writeFileSync(path.join(OUT, `${phase}-synthetic-reply.pcm`), Buffer.concat(audio)); }
  const text = result.replies.join('');
  console.log(JSON.stringify({ status: result.status, relationship_mentioned: /男朋友|女朋友|恋人|情侣/.test(text), address_mentioned: text.includes('阿辰'), error_code: result.error_code || null, output_ms: result.output_ms }));
}
if (require.main === module) main().catch(() => { console.error('PERSONA_PREFLIGHT_FAILED'); process.exitCode = 1; });
