// Explicitly approved <= CNY 1 acceptance; this probe reserves <= CNY 0.34.
// Run only after release, in the existing API container. Never uses production DB/COS.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const r = (name) => require(path.join(process.cwd(), 'src', name));
const ROOT = process.env.QIYU_VOICE_PROBE_ROOT || '/tmp/qiyu-voice-probe-20261015';
const STAGE = process.env.QIYU_VOICE_PROBE_STAGE;
const LIMITS = { ttsChars: 400, ttsCalls: 12, tmsCalls: 20, asrCalls: 2, qwenCalls: 2, qwenInputBytes: 24000, qwenMaxOutputTokens: 256 };
const plan = { limits: LIMITS, upperBoundCny: 0.336292, reservedCny: 0.34,
  prices: { ttsCnyPer10000CharsConservative: 6.5, asrCnyPer1000Requests: 3.2, tmsCnyPer10000Requests: 25, qwenInputCnyPerMillion: 0.8, qwenOutputCnyPerMillion: 2.7 },
  sources: ['https://cloud.tencent.com/document/product/1073/34112', 'https://cloud.tencent.com/document/product/1093/35686', 'https://cloud.tencent.com/document/product/1124/37118', 'https://help.aliyun.com/zh/model-studio/model-pricing'] };
if (!['points', 'calls', 'calls-supplement'].includes(STAGE)) { console.log(JSON.stringify({ dryRun: true, ...plan })); process.exit(0); }
fs.mkdirSync(ROOT, { recursive: true });
const ledgerFile = path.join(ROOT, 'ledger.json');
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile)) : Object.fromEntries(Object.keys(LIMITS).map((key) => [key, 0]));
if (STAGE === 'calls-supplement') {
  assert.equal(ledger.asrCalls, 2, 'supplement allowed only once after original two attempts');
  Object.assign(LIMITS, { ttsChars: ledger.ttsChars + 300, ttsCalls: ledger.ttsCalls + 12, tmsCalls: ledger.tmsCalls + 20, asrCalls: ledger.asrCalls + 1, qwenCalls: ledger.qwenCalls + 1, qwenInputBytes: ledger.qwenInputBytes + 12000, qwenMaxOutputTokens: ledger.qwenMaxOutputTokens + 128 });
  plan.upperBoundCny = 0.3730; plan.reservedCny = 0.4;
}
function costFor(value) { return value.ttsChars * 6.5 / 10000 + value.asrCalls * 3.2 / 1000 + value.tmsCalls * 25 / 10000 + value.qwenInputBytes * 0.8 / 1000000 + value.qwenMaxOutputTokens * 2.7 / 1000000; }
function saveLedger() { fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2)); }
function reserve(delta) {
  for (const [key, amount] of Object.entries(delta)) assert.ok(ledger[key] + amount <= LIMITS[key], `BUDGET_LIMIT_${key}`);
  const proposed = { ...ledger };
  for (const [key, amount] of Object.entries(delta)) proposed[key] += amount;
  assert.ok(costFor(proposed) <= 0.4, 'CUMULATIVE_CNY_0_4_LIMIT');
  Object.assign(ledger, proposed);
  saveLedger(); // Count attempted calls even on upstream failure; no automatic reset/retry.
}
const realFetch = globalThis.fetch;
async function meteredFetch(url, options) {
  const host = new URL(url).hostname;
  if (host === 'tms.tencentcloudapi.com') reserve({ tmsCalls: 1 });
  else if (host === 'asr.tencentcloudapi.com') reserve({ asrCalls: 1 });
  else if (host === 'dashscope.aliyuncs.com') {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'qwen3.8-flash');
    body.max_tokens = 128;
    reserve({ qwenCalls: 1, qwenInputBytes: Buffer.byteLength(JSON.stringify(body.messages), 'utf8'), qwenMaxOutputTokens: 128 });
    options = { ...options, body: JSON.stringify(body) };
  } else throw new Error('UNAPPROVED_UPSTREAM_HOST');
  return realFetch(url, options);
}
async function main() {
  const { DevelopmentStore } = r('domain/store');
  const { createApp } = r('app');
  const { MediaEntitlementService } = r('domain/media-entitlement-service');
  const { createTencentTtsGeneratorFromEnvironment } = r('providers/tencent-tts-adapter');
  const { createTencentAsrTranscriberFromEnvironment } = r('providers/tencent-asr-adapter');
  const { createTencentTextModeratorFromEnvironment } = r('providers/tencent-moderation-adapter');
  const { createQwenStreamingReplyGenerator, DEFAULT_MODEL } = r('providers/qwen-adapter');
  assert.equal(DEFAULT_MODEL, 'qwen3.8-flash');
  assert.equal(process.env.TENCENT_TTS_API_MODE, 'stream');
  assert.equal(process.env.TENCENT_TTS_VOICE_TYPE, '601009');
  const store = new DevelopmentStore();
  const media = new Map();
  const mediaStore = { async createPendingJob() {}, async updateJob() {},
    async putAudio({ assetId, bytes, mimeType }) { media.set(assetId, Buffer.from(bytes)); return { objectKey: assetId, checksum: '0'.repeat(64), byteLength: bytes.length, mimeType }; },
    async getAudio(objectKey) { return { bytes: media.get(objectKey), mimeType: 'audio/mpeg' }; } };
  const providers = [];
  const rawTts = createTencentTtsGeneratorFromEnvironment(process.env);
  assert.equal(typeof rawTts.synthesizeStream, 'function');
  async function synthesize(input) {
    reserve({ ttsChars: input.text.length, ttsCalls: 1 });
    const entry = { type: 'tts', chars: input.text.length, startedAt: Date.now(), firstSegmentMs: null, completedMs: null };
    providers.push(entry);
    try { const output = await rawTts.synthesizeStream({ ...input, onAudioSegment: (bytes) => { entry.firstSegmentMs ??= Date.now() - entry.startedAt; input.onAudioSegment?.(bytes); } }); entry.completedMs = Date.now() - entry.startedAt; return output; }
    catch (error) { entry.error = error.code || error.name; throw error; }
  }
  Object.assign(synthesize, rawTts); synthesize.synthesizeStream = synthesize;
  function measured(type, fn) {
    const wrapped = async (input) => { const entry = { type, startedAt: Date.now(), direction: input.direction }; providers.push(entry); try { return await fn(input); } finally { entry.completedMs = Date.now() - entry.startedAt; } };
    return Object.assign(wrapped, fn);
  }
  const asr = measured('asr', createTencentAsrTranscriberFromEnvironment(process.env, { fetchImpl: meteredFetch }));
  const moderator = measured('tms', createTencentTextModeratorFromEnvironment(process.env, { fetchImpl: meteredFetch }));
  const stream = createQwenStreamingReplyGenerator(process.env, { fetchImpl: meteredFetch });
  assert.equal(typeof asr, 'function'); assert.equal(typeof moderator, 'function'); assert.ok(stream);
  const originalStream = stream.generateStream.bind(stream);
  stream.generateStream = async (...args) => {
    const entry = { type: 'llm', startedAt: Date.now(), firstFragmentMs: null }; providers.push(entry);
    const callback = args[2];
    args[2] = (...fragments) => { entry.firstFragmentMs ??= Date.now() - entry.startedAt; return callback(...fragments); };
    const result = await originalStream(...args); entry.completedMs = Date.now() - entry.startedAt; entry.usage = result.usage; return result;
  };
  const service = new MediaEntitlementService({ store });
  store.mediaEntitlementService = service;
  const subscription = { subscription_id: 'probe-sub', account_id: 'acct_dev_alice', state: 'TRIAL', period_end: new Date(Date.now() + 3600000).toISOString() };
  store.subscriptions.set(subscription.subscription_id, subscription);
  service.grantSubscriptionCycle({ subscription, product: { image_quota: 0, tts_minutes: 3, asr_minutes: 3 }, sourceEventId: 'isolated-probe' });
  const server = createApp({ store, voiceCallEnabled: true, mediaStore, imageEntitlementService: service, ttsGenerator: synthesize, asrTranscriber: asr, textModerator: moderator, streamingReplyGenerator: stream,
    replyGenerator: async (text) => ({ reply_text: text, provider: 'synthetic-fixture', ai_generated: true }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await realFetch(base + '/api/v1' + endpoint, { method, headers: { authorization: 'Bearer dev-alice-token', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, `${endpoint}:${result?.error?.code || response.status}`); return result;
  }
  async function events(url, method = 'GET') {
    const startedAt = Date.now(), timeline = []; let pending = '', final = null, error = null;
    const response = await realFetch(base + url, { method, headers: { authorization: 'Bearer dev-alice-token', 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.ok(response.ok);
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const blocks = pending.split('\n\n'); pending = blocks.pop();
      for (const block of blocks) {
        const name = block.match(/^event: (.+)$/m)?.[1], value = block.match(/^data: (.+)$/m)?.[1];
        if (!name || !value) continue;
        const data = JSON.parse(value);
        timeline.push({ event: name, ms: Date.now() - startedAt });
        if (/failed|error/.test(name)) error = `STREAM_FAILED:${data.code || name}`;
        if (name === 'tts.completed') final = data.tts_job;
        if (name === 'call.turn.completed') final = { timings_ms: data.timings_ms, tts_degraded: data.tts_degraded ?? false };
      }
    }
    return { timeline, final, error, completedMs: Date.now() - startedAt };
  }
  const results = { stage: STAGE, checkedAt: new Date().toISOString(), model: DEFAULT_MODEL, voice: { id: 601009, name: '爱小芊', category: '大模型音色', officialCategoryUrl: 'https://cloud.tencent.com/document/product/1073/92668' }, ...plan, scope: 'Real providers in deployed container; isolated DevelopmentStore, localhost HTTP; not public PG/COS, client network, device acoustics or product SLA', samples: [], providers };
  try {
    const notices = await request('/required-notices');
    await request(`/required-notices/${notices.notices[0].notice_id}/displayed`, { notice_version: notices.notices[0].notice_version });
    await request('/age/declarations', { date_of_birth: '1990-01-01', confirmed_18_plus: true });
    const { character } = await request('/characters', { name: '合成语音验收角色' });
    const { conversation } = await request('/conversations', { character_id: character.character_id });
    if (STAGE === 'points') {
      for (const text of ['今天心情怎么样？', '我想出去散步。', '明天见，晚安。']) {
        const msg = await request(`/conversations/${conversation.conversation_id}/messages`, { content: { text } });
        const id = msg.assistant_message.message_id;
        const cold = await events(`/api/v1/messages/${id}/tts-stream`, 'POST');
        assert.equal(cold.final?.state, 'COMPLETED');
        const replay = await events(`/api/v1/messages/${id}/tts-stream`, 'POST');
        assert.equal(replay.final?.state, 'COMPLETED');
        results.samples.push({ cold, replay });
        if (results.samples.length === 1) fs.writeFileSync(path.join(ROOT, 'synthetic-input.mp3'), media.get(cold.final.result_asset_id));
      }
    } else {
      const wav = fs.readFileSync(path.join(ROOT, 'synthetic-input.wav'));
      assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.ok(wav.length < 256000);
      const call = await request(`/conversations/${conversation.conversation_id}/calls`, {});
      for (let index = 0; index < (STAGE === 'calls-supplement' ? 1 : 2); index += 1) {
        const { turn } = await request(`/calls/${call.call.call_id}/turns`, {});
        await request(`/calls/${call.call.call_id}/turns/${turn.turn_id}/audio-chunks`, { chunk_index: 0, audio_base64: wav.toString('base64') });
        const startedAt = Date.now();
        const finalized = await request(`/calls/${call.call.call_id}/turns/${turn.turn_id}/finalize`, {});
        const finalizeMs = Date.now() - startedAt;
        const sample = await events(finalized.stream.stream_url);
        sample.finalizeMs = finalizeMs;
        sample.finalizeToFirstAudioMs = sample.timeline.find((item) => item.event === 'call.turn.audio')?.ms + finalizeMs;
        sample.finalizeToStreamCompletedMs = Date.now() - startedAt;
        results.samples.push(sample);
        assert.equal(sample.error, null, sample.error);
        assert.ok(sample.timeline.some((item) => item.event === 'call.turn.audio'), 'real call must return audio');
        assert.equal(sample.final?.tts_degraded, false);
      }
      await request(`/calls/${call.call.call_id}/end`, {});
    }
    results.passed = true;
  } catch (error) { results.passed = false; results.error = error.code || error.message; process.exitCode = 1; }
  finally {
    results.ledger = ledger;
    results.costUpperBoundAttemptedCny = costFor(ledger);
    fs.writeFileSync(path.join(ROOT, `${STAGE}-results.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(JSON.stringify({ stage: STAGE, code: error.code || error.message, ledger })); process.exitCode = 1; });
