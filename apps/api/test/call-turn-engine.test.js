'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevelopmentStore } = require('../src/domain/store');
const { MediaEntitlementService } = require('../src/domain/media-entitlement-service');
const { CallAudioBufferRegistry } = require('../src/domain/call-audio-buffer');
const { createCall, createTurn, transitionTurn } = require('../src/domain/call-session');
const { executeCallTurn, executeGreeting } = require('../src/domain/call-turn-engine');
const { balanceFor } = require('../src/domain/entitlement-ledger');

const NOW = new Date('2026-09-13T12:00:00.000Z');
const ACCOUNT_ID = 'acct_dev_alice';

// ---- 测试替身 ----

function fakeMediaStore() {
  return {
    createPendingJob: async () => {},
    updateJob: async () => {},
    putAudio: async ({ assetId, bytes, mimeType }) => ({ mimeType, byteLength: bytes.length, checksum: `chk_${assetId}`, objectKey: `dev/${assetId}.mp3` })
  };
}

function fakeTtsGenerator({ onSecondSentence } = {}) {
  let counter = 0;
  const generator = (input) => generator.synthesizeStream(input);
  generator.provider = 'tencent-tts';
  generator.modelVersion = 'TextToStreamAudioWS:emotion-v1';
  generator.voiceProfileFor = () => ({ voice_id: 'tencent-standard-101001', voice_version: 'provider-catalog-2026-09', authorization_record_id: 'rec-1', rights_review_id: 'rr-1', rights_review_state: 'APPROVED' });
  generator.synthesizeStream = async ({ text, onAudioSegment, signal }) => {
    counter += 1;
    if (signal?.aborted) throw Object.assign(new Error('已中止'), { code: 'TENCENT_TTS_STREAM_ABORTED' });
    if (onSecondSentence && counter === 2) return onSecondSentence({ onAudioSegment });
    onAudioSegment(Buffer.from(`mp3:${text}`));
    onAudioSegment(Buffer.from('!'));
    return { asset: { bytes: Buffer.from(`mp3:${text}!`), mimeType: 'audio/mpeg', byteLength: text.length + 5 }, providerRequestId: `tts_req_${counter}` };
  };
  return generator;
}

function buildDeps(overrides = {}) {
  const asrTranscriber = overrides.asrTranscriber || (async () => ({ text: '今天心情怎么样？', providerRequestId: 'asr_req_1' }));
  const moderatorDecisions = overrides.moderatorDecisions || {};
  const textModerator = async ({ direction }) => ({
    decision: moderatorDecisions[direction] || 'PASS', policyVersion: 'tms-v1', providerRequestId: `tms_${direction}`
  });
  const streamingReplyGenerator = {
    provider: 'qwen', modelVersion: 'qwen-max-v1',
    generateStream: overrides.generateStream || (async (text, contextPack, onFragment) => {
      await onFragment('我在呢。');
      await onFragment('想听点开心的吗？');
      return { reply_text: '我在呢。想听点开心的吗？', provider: 'qwen', model_version: 'qwen-max-v1', usage: { input_tokens: 12, output_tokens: 20 }, memory_candidate: null };
    })
  };
  const deps = {
    audioRegistry: new CallAudioBufferRegistry(),
    asrTranscriber,
    ttsGenerator: overrides.ttsGenerator === undefined ? fakeTtsGenerator() : overrides.ttsGenerator,
    streamingReplyGenerator,
    replyGenerator: overrides.replyGenerator || null,
    textModerator,
    embeddingProvider: null,
    mediaStore: fakeMediaStore(),
    mediaEntitlementService: overrides.mediaEntitlementService === undefined ? null : overrides.mediaEntitlementService,
    buildContextPack: async () => ({ character: { name: '小栖' } }),
    ownConversation: (store, accountId, conversationId) => {
      const conversation = store.conversations.get(conversationId);
      if (!conversation || conversation.account_id !== accountId) throw new Error('会话不存在');
      return conversation;
    },
    requireOpenConversation: () => {},
    authorize: () => {},
    normalizePersonaGender: (value) => (value === 'male' ? 'male' : 'female'),
    normalizeUnpromptedSelfIntro: (wrapped) => wrapped,
    currentWorldState: () => ({ world_state_id: 'ws_000001', state_version: 3 }),
    publicWorldState: (state) => state,
    estimateAudioSeconds: (byteLength) => Math.max(1, Math.ceil(byteLength * 8 / 32000)),
    estimateTtsSeconds: (text) => Math.max(1, Math.ceil(String(text).length / 4)),
    resolvedTtsVoiceProfile: (generator, gender) => generator.voiceProfileFor(gender)
  };
  return deps;
}

function fixtureStore() {
  const store = new DevelopmentStore();
  store.characters.set('chr_000001', { character_id: 'chr_000001', account_id: ACCOUNT_ID, persona: { gender: 'female' }, status: 'ACTIVE' });
  store.conversations.set('conv_000001', { conversation_id: 'conv_000001', account_id: ACCOUNT_ID, character_id: 'chr_000001', state: 'OPEN' });
  store.worldStates.set('chr_000001', { character_id: 'chr_000001', mood_code: 'HAPPY' });
  return store;
}

// 试用权益账本：tts 30 分钟、asr 15 分钟（与封测试用档同量级）。
function entitlementServiceFor(store, { asrMinutes = 15, ttsMinutes = 30 } = {}) {
  const subscription = { subscription_id: 'sub_000001', account_id: ACCOUNT_ID, state: 'TRIAL', period_end: new Date(NOW.getTime() + 7 * 86400000).toISOString() };
  store.subscriptions.set(subscription.subscription_id, subscription);
  const service = new MediaEntitlementService({ store, now: () => NOW });
  service.grantSubscriptionCycle({ subscription, product: { image_quota: 3, tts_minutes: ttsMinutes, asr_minutes: asrMinutes }, sourceEventId: 'evt_trial_grant_1' });
  return service;
}

// 走完客户端协议前半段：创建通话与回合、上传、finalize 端点的封账（seal）
// 与状态推进；SSE produce 随后 consume。
function finalizedTurn(store, deps) {
  const call = createCall(store, { accountId: ACCOUNT_ID, conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW });
  const turn = createTurn(store, call, { now: NOW });
  transitionTurn(store, turn, 'UPLOADING', {}, NOW);
  deps.audioRegistry.createBuffer(turn.turn_id);
  deps.audioRegistry.appendChunk(turn.turn_id, { chunkIndex: 0, bytes: Buffer.alloc(32000, 1) });
  deps.audioRegistry.seal(turn.turn_id);
  transitionTurn(store, turn, 'FINALIZED', {}, NOW);
  return { call, turn };
}

function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}

function eventNames(events) { return events.map((item) => item.event); }

// ---- 回合主链路 ----

test('回合主链路：转写字幕→逐句字幕+音频段（首段带 AIGC 标识）→完成；三本账落账；用户音频不落资产', async () => {
  const store = fixtureStore();
  const service = entitlementServiceFor(store);
  const deps = buildDeps({ mediaEntitlementService: service });
  const { call, turn } = finalizedTurn(store, deps);
  const { events, emit } = collect();

  await executeCallTurn(deps, { store, account: store.account(ACCOUNT_ID), call, turn, emit, signal: null });

  assert.deepEqual(eventNames(events), [
    'call.turn.accepted', 'call.turn.transcript',
    'call.turn.text', 'call.turn.audio',
    'call.turn.text', 'call.turn.audio',
    'call.turn.completed'
  ]);
  assert.equal(events.at(-1).data.assistant_message_id, turn.assistant_message_id);
  assert.equal(events.at(-1).data.tts_degraded, false);
  // 微批：每句的供应商小帧合成一个音频段下发（弱客户端友好）。
  // 首段音频带 ID3v2.3 AIGC 标识，后续段是裸 MP3 帧。
  const audioEvents = events.filter((item) => item.event === 'call.turn.audio');
  assert.equal(Buffer.from(audioEvents[0].data.audio_base64, 'base64').subarray(0, 3).toString(), 'ID3');
  assert.equal(audioEvents[0].data.segment_index, 0);
  assert.ok(Buffer.from(audioEvents[0].data.audio_base64, 'base64').includes(Buffer.from('mp3:我在呢。')), '批内应含整句合成字节');
  assert.notEqual(Buffer.from(audioEvents[1].data.audio_base64, 'base64').subarray(0, 3).toString(), 'ID3');

  assert.equal(turn.state, 'COMPLETED');
  assert.equal(call.asr_seconds_used, 8); // 32000B ≈ 8s
  assert.equal(call.tts_seconds_used, 3); // 两句各 1s+2s

  const messages = [...store.messages.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const userMessage = messages.find((item) => item.actor === 'USER');
  const assistantMessage = messages.find((item) => item.actor === 'ASSISTANT');
  assert.equal(userMessage.text, '今天心情怎么样？');
  assert.equal(userMessage.provider, 'tencent-asr');
  assert.equal(userMessage.call_session_id, call.call_id);
  assert.equal(assistantMessage.text, '我在呢。想听点开心的吗？');
  assert.equal(assistantMessage.call_session_id, call.call_id);

  const asrJob = store.mediaJobs.get(turn.asr_job_id);
  assert.equal(asrJob.state, 'COMPLETED');
  assert.equal(asrJob.input_asset_id, null); // 合规：通话用户音频永不落资产
  assert.equal([...store.mediaAssets.values()].filter((asset) => asset.type === 'ASR_INPUT_AUDIO').length, 0);

  const ttsJobs = [...store.mediaJobs.values()].filter((job) => job.type === 'TTS');
  assert.equal(ttsJobs.length, 1);
  assert.equal(ttsJobs[0].state, 'COMPLETED');
  assert.equal(ttsJobs[0].source_message_id, assistantMessage.message_id); // 回放复用锚点
  assert.equal(ttsJobs[0].voice_gender, 'female');
  assert.equal(ttsJobs[0].emotion_source, 'world_state_mood');
  assert.ok(ttsJobs[0].result_asset_id);
  assert.ok(store.mediaAssets.get(ttsJobs[0].result_asset_id).byte_length > 0);

  // 账本：ASR 预留 8 提交 8；TTS 预留 90 提交 3（余量终态自动释放）。
  const entries = [...store.entitlementLedgers.values()];
  const balanceOf = (capability) => balanceFor(entries, ACCOUNT_ID, 'sub_000001:' + new Date(NOW.getTime() + 7 * 86400000).toISOString(), capability);
  assert.equal(balanceOf('TRANSCRIBE_ASR').committed_quantity, 8);
  assert.equal(balanceOf('TRANSCRIBE_ASR').reserved_quantity, 0);
  assert.equal(balanceOf('SYNTHESIZE_TTS').committed_quantity, 3);
  assert.equal(balanceOf('SYNTHESIZE_TTS').reserved_quantity, 0);
});

test('打断：SSE abort 即中止合成，已播出片段拼为终稿落 INTERRUPTED，TTS 按实际量 commit', async () => {
  const store = fixtureStore();
  const service = entitlementServiceFor(store);
  const controller = new AbortController();
  let llmCalled = false;
  const generateStream = async (text, contextPack, onFragment) => {
    llmCalled = true;
    await onFragment('第一句。'); // 正常播出
    controller.abort(); // 用户在第二句起播前后打断
    await onFragment('第二句。'); // 字幕已发，音频合成收到 abort
  };
  const deps = buildDeps({
    mediaEntitlementService: service,
    generateStream,
    ttsGenerator: fakeTtsGenerator()
  });
  const { call, turn } = finalizedTurn(store, deps);
  const { events, emit } = collect();

  await executeCallTurn(deps, { store, account: store.account(ACCOUNT_ID), call, turn, emit, signal: controller.signal });

  assert.equal(llmCalled, true);
  assert.equal(eventNames(events).at(-1), 'call.turn.interrupted');
  assert.equal(turn.state, 'INTERRUPTED');
  assert.equal(turn.interrupted, true);
  assert.equal(call.interrupted_turn_count, 1);

  // 部分终稿：两句字幕都已过审下发，音频只完整播出第一句。
  const assistantMessage = store.messages.get(turn.assistant_message_id);
  assert.equal(assistantMessage.text, '第一句。第二句。');
  const ttsJobs = [...store.mediaJobs.values()].filter((job) => job.type === 'TTS');
  assert.equal(ttsJobs.length, 1);
  assert.equal(ttsJobs[0].state, 'COMPLETED'); // 已合成部分保留资产供通话后回放
  assert.equal(ttsJobs[0].tts_text, '第一句。');
  assert.equal(call.tts_seconds_used, 1); // 实际只合成第一句（1s），非预留全额

  const entries = [...store.entitlementLedgers.values()];
  const entitlementId = 'sub_000001:' + new Date(NOW.getTime() + 7 * 86400000).toISOString();
  const ttsBalance = balanceFor(entries, ACCOUNT_ID, entitlementId, 'SYNTHESIZE_TTS');
  assert.equal(ttsBalance.committed_quantity, 1);
  assert.equal(ttsBalance.reserved_quantity, 0); // 余量已随终态释放，不悬挂
});

test('INPUT BLOCK：转写被拦截时以固定审核回复朗读收尾，不调用模型、不占日额度', async () => {
  const store = fixtureStore();
  let llmCalled = false;
  const deps = buildDeps({
    moderatorDecisions: { INPUT: 'BLOCK' },
    generateStream: async () => { llmCalled = true; return { reply_text: '不应出现', provider: 'qwen', model_version: 'v1', usage: {} }; }
  });
  const { call, turn } = finalizedTurn(store, deps);
  const { events, emit } = collect();

  await executeCallTurn(deps, { store, account: store.account(ACCOUNT_ID), call, turn, emit, signal: null });

  assert.equal(llmCalled, false);
  assert.deepEqual(eventNames(events), ['call.turn.accepted', 'call.turn.transcript', 'call.turn.text', 'call.turn.audio', 'call.turn.completed']);
  assert.equal(events.find((item) => item.event === 'call.turn.text').data.text, '这条内容暂时无法继续处理。你可以调整表达后再试。');
  assert.equal(turn.state, 'COMPLETED');
  const assistantMessage = store.messages.get(turn.assistant_message_id);
  assert.equal(assistantMessage.provider, 'content-moderation-policy');
  assert.equal(store.dailyChatUsage.size, 0);
});

test('TTS 失败降级纯文字：字幕照发、无音频段，job FAILED、预留全额返还', async () => {
  const store = fixtureStore();
  const service = entitlementServiceFor(store);
  const brokenTts = () => {};
  brokenTts.provider = 'tencent-tts';
  brokenTts.modelVersion = 'TextToStreamAudioWS:emotion-v1';
  brokenTts.voiceProfileFor = () => ({ voice_id: 'tencent-standard-101001', voice_version: 'provider-catalog-2026-09', authorization_record_id: 'rec-1', rights_review_id: 'rr-1', rights_review_state: 'APPROVED' });
  brokenTts.synthesizeStream = async () => { throw Object.assign(new Error('上游失败'), { code: 'TTS_PROVIDER_FAILED' }); };
  const deps = buildDeps({ mediaEntitlementService: service, ttsGenerator: brokenTts });
  const { call, turn } = finalizedTurn(store, deps);
  const { events, emit } = collect();

  await executeCallTurn(deps, { store, account: store.account(ACCOUNT_ID), call, turn, emit, signal: null });

  assert.equal(events.filter((item) => item.event === 'call.turn.audio').length, 0);
  assert.equal(events.filter((item) => item.event === 'call.turn.text').length, 2);
  const completed = events.at(-1);
  assert.equal(completed.event, 'call.turn.completed');
  assert.equal(completed.data.tts_degraded, true);
  assert.equal(turn.state, 'COMPLETED');
  const ttsJobs = [...store.mediaJobs.values()].filter((job) => job.type === 'TTS');
  assert.equal(ttsJobs[0].state, 'FAILED');
  assert.equal(ttsJobs[0].failure_code, 'TTS_PROVIDER_FAILED');
  assert.equal(call.tts_seconds_used, 0);
  const entries = [...store.entitlementLedgers.values()];
  const entitlementId = 'sub_000001:' + new Date(NOW.getTime() + 7 * 86400000).toISOString();
  assert.equal(balanceFor(entries, ACCOUNT_ID, entitlementId, 'SYNTHESIZE_TTS').available_quantity, 1800); // 预留已全额返还
});

test('额度不足：ASR 预留即失败，回合 FAILED 并透出中文原因，不烧任何供应商调用', async () => {
  const store = fixtureStore();
  const service = entitlementServiceFor(store, { asrMinutes: 0 }); // 试用档未承诺 ASR
  let asrCalled = false;
  const deps = buildDeps({
    mediaEntitlementService: service,
    asrTranscriber: async () => { asrCalled = true; return { text: 'x', providerRequestId: 'r' }; }
  });
  const { call, turn } = finalizedTurn(store, deps);
  const { events, emit } = collect();

  await executeCallTurn(deps, { store, account: store.account(ACCOUNT_ID), call, turn, emit, signal: null });

  assert.equal(asrCalled, false);
  const failed = events.at(-1);
  assert.equal(failed.event, 'call.turn.failed');
  assert.equal(failed.data.code, 'ENTITLEMENT_QUOTA_EXCEEDED');
  assert.match(failed.data.message, /额度不足/);
  assert.equal(turn.state, 'FAILED');
  assert.equal(turn.failure_code, 'ENTITLEMENT_QUOTA_EXCEEDED');
  const asrJobs = [...store.mediaJobs.values()].filter((job) => job.type === 'ASR');
  assert.equal(asrJobs[0].state, 'FAILED');
  assert.equal(asrJobs[0].input_asset_id, null);
});

test('ASR 识别失败：预留全额返还，通话审计不虚增 asr_seconds_used（与账本口径一致）', async () => {
  const store = fixtureStore();
  const service = entitlementServiceFor(store);
  const deps = buildDeps({
    mediaEntitlementService: service,
    asrTranscriber: async () => ({ text: '', providerRequestId: 'asr_req_empty' }) // 供应商返回空文本
  });
  const { call, turn } = finalizedTurn(store, deps);
  const { events, emit } = collect();

  await executeCallTurn(deps, { store, account: store.account(ACCOUNT_ID), call, turn, emit, signal: null });

  const failed = events.at(-1);
  assert.equal(failed.event, 'call.turn.failed');
  assert.equal(failed.data.code, 'ASR_TRANSCRIPTION_FAILED');
  assert.match(failed.data.message, /没有听清/);
  assert.equal(turn.state, 'FAILED');
  assert.equal(turn.failure_code, 'ASR_TRANSCRIPTION_FAILED');
  // 预留已返还：账面余额回到满额。
  const asrBalance = service.entitlementBalances(ACCOUNT_ID).find((item) => item.capability === 'TRANSCRIBE_ASR');
  assert.equal(asrBalance.available_quantity, 15 * 60);
  // 审计不虚增：识别失败不产生用户可被计费的秒数。
  assert.equal(call.asr_seconds_used, 0);
});

// ---- 开场问候 ----

test('开场问候：世界情绪选模板、同一音频事件管线、TTS job 挂问候消息可回放', async () => {
  const store = fixtureStore();
  const service = entitlementServiceFor(store);
  const deps = buildDeps({ mediaEntitlementService: service });
  const call = createCall(store, { accountId: ACCOUNT_ID, conversationId: 'conv_000001', characterId: 'chr_000001', now: NOW });
  const { events, emit } = collect();

  await executeGreeting(deps, { store, account: store.account(ACCOUNT_ID), call, emit, signal: null });

  assert.deepEqual(eventNames(events), ['call.turn.accepted', 'call.turn.text', 'call.turn.audio', 'call.turn.completed']);
  const accepted = events[0].data;
  assert.equal(accepted.kind, 'greeting');
  assert.equal(accepted.turn_id, null);
  const completed = events.at(-1).data;
  assert.equal(completed.greeting, true);
  const greetingMessage = store.messages.get(completed.assistant_message_id);
  assert.equal(greetingMessage.provider, 'call-greeting');
  assert.equal(greetingMessage.call_session_id, call.call_id);
  assert.equal(greetingMessage.text, events[1].data.text); // 字幕即模板原文
  const ttsJobs = [...store.mediaJobs.values()].filter((job) => job.type === 'TTS');
  assert.equal(ttsJobs.length, 1);
  assert.equal(ttsJobs[0].source_message_id, greetingMessage.message_id);
  assert.equal(ttsJobs[0].state, 'COMPLETED');
});
