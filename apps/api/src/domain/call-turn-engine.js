'use strict';

// 1:1 通话回合执行体（每回合 SSE 的 produce 体，域层实现）。
// 形态对齐 app.js liveConversationStream：路由层负责 sseLive 包装与账户事务，
// 这里完成 ASR→门禁→LLM 流式→逐句审核→逐段 TTS→终局结算。
// 相对 live 流的通话特有口径：
// - 用户音频只进进程内存（call-audio-buffer），不建 ASR_INPUT_AUDIO 资产、
//   永不落对象存储；转写完成即 consume 丢弃；
// - INPUT 审核在转写后于本执行体内完成（live 在 POST 受理时完成）；
// - 情绪直接用世界状态基线，不做判断器竞速（省 0-1.5s）；
// - 逐句 OUTPUT 审核通过即合成，同文本不重复 TTS_OUTPUT 复审（同回合原子）；
// - 回合 TTS job 以 source_message_id=assistant 消息落库，通话后点播直接
//   命中现有同源复用逻辑，不重复合成不重复扣费；
// - 打断（客户端断开 SSE→signal abort）已过审已播出的片段拼接为终稿落库，
//   三本账按实际用量 commit（账本 commit≤reserve、终态后余量自动释放）。

const { assessSafety, responseForExistingSafetyMode } = require('./safety-policy');
const { assessModelOutputAuthority } = require('./model-output-policy');
const { commitDailyChatUsage, estimateInputTokens, inputTokensFromProviderUsage, releaseDailyChatUsage, reserveDailyChatUsage } = require('./daily-chat-usage');
const { resolveEmotion, sanitizeTtsText, truncateForTts } = require('./tts-delivery');
const { moderateTextWithMetric, providerModelVersion, providerName, recordOperationMetric } = require('./operation-metrics');
const { CALL_TURN_MAX_ASR_SECONDS, CALL_TURN_MAX_TTS_SECONDS, pickGreeting, settleTurn, transitionTurn } = require('./call-session');
const { tagWithAigcMetadata, AIGC_MARK_VERSION_AUDIO } = require('../media/aigc-metadata');

// 客户端边录边传的自封 WAV（16k PCM16），ASR 按此口径送审识别。
const CALL_AUDIO_MIME_TYPE = 'audio/wav';

const MODERATION_REPLY_TEXT = '这条内容暂时无法继续处理。你可以调整表达后再试。';
const OUTPUT_GUARD_REPLY_TEXT = '这条回复的部分内容未通过安全审核，已停止生成。你可以换一个话题继续。';

const CALL_TURN_FAILURE_MESSAGES = {
  CALL_AUDIO_MISSING: '回合音频已失效，请重新说一次',
  ASR_TRANSCRIPTION_FAILED: '没有听清，请再说一次',
  DAILY_CHAT_LIMIT_REACHED: '今日对话额度已用完',
  ENTITLEMENT_QUOTA_EXCEEDED: '语音额度不足，可在订阅方案中了解详情',
  CALL_TURN_ABORTED: '本回合已打断'
};

// ---- 开场问候（模板+世界情绪，不调 LLM；走与回合相同的音频事件管线）----

async function executeGreeting(deps, { store, account, call, emit, signal }) {
  requireDeps(deps, ['ownConversation', 'mediaStore']);
  emit('call.turn.accepted', { turn_id: null, call_id: call.call_id, kind: 'greeting' });
  const conversation = deps.ownConversation(store, account.account_id, call.conversation_id);
  const moodRecord = store.worldStates.get(call.character_id);
  const greeting = pickGreeting({ moodCode: moodRecord?.mood_code, seed: seedFromCallId(call.call_id) });
  const assistantMessageId = store.next('msg');
  const speech = createSpeechChannel(deps, { store, account, call, emit, signal, assistantMessageId, turnId: null, moodRecord });
  emit('call.turn.text', { turn_id: null, sequence: 1, text: greeting.text });
  try {
    await speech.speakSentence(truncateForTts(sanitizeTtsText(greeting.text)));
  } catch {
    // 问候语音失败（额度/供应商）不阻断通话：字幕已在客户端，用户可直接说话。
  }
  const assistantMessage = buildAssistantMessage(deps, store, account, conversation, {
    message_id: assistantMessageId, text: greeting.text, provider: 'call-greeting', model_version: 'call-greeting-v1', ai_generated: false
  }, call);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  const settled = await speech.settle();
  emit('call.turn.completed', {
    turn_id: null, greeting: true, assistant_message_id: assistantMessage.message_id,
    tts_job_id: settled.job?.job_id ?? null, usage: null
  });
}

// ---- 回合执行体（每回合一条 SSE 的 produce）----

async function executeCallTurn(deps, { store, account, call, turn, emit, signal }) {
  requireDeps(deps, ['audioRegistry', 'asrTranscriber', 'mediaStore', 'buildContextPack', 'ownConversation', 'requireOpenConversation', 'authorize']);
  emit('call.turn.accepted', { turn_id: turn.turn_id, turn_index: turn.turn_index, call_id: call.call_id });
  // 贯穿回合的可结算状态：任何退出路径（完成/打断/失败）都必须把已开的
  // job、预留与部分回复结清，否则预留悬挂在账本上永久占用余额。
  const ctx = {
    conversation: null, asrJob: null, asrReservedSeconds: 0, asrSeconds: 0,
    speech: null, emittedTexts: [], assistantMessageId: null, partialPersisted: false,
    usageReservation: null, usageSettled: false
  };
  const usageRelease = () => { if (ctx.usageReservation && !ctx.usageSettled) { ctx.usageSettled = true; try { releaseDailyChatUsage(store, ctx.usageReservation); } catch { /* 事务已回滚则忽略 */ } } };
  const usageCommit = (modelReply) => {
    if (ctx.usageReservation && !ctx.usageSettled) {
      ctx.usageSettled = true;
      return commitDailyChatUsage(store, ctx.usageReservation, { billedInputTokens: inputTokensFromProviderUsage(modelReply?.usage, ctx.usageReservation.reservation_tokens) });
    }
    return null;
  };

  try {
    await runCallTurn(deps, { store, account, call, turn, emit, signal }, ctx, { usageRelease, usageCommit });
  } catch (error) {
    const aborted = signal?.aborted || error?.code === 'TENCENT_TTS_STREAM_ABORTED';
    usageRelease();
    await closeAsrJob(deps, store, ctx, aborted ? 'CALL_TURN_ABORTED' : (error?.code || 'ASR_TRANSCRIPTION_FAILED'));
    // 打断语义只在 THINKING/SPEAKING 成立（状态机约束）；更早阶段的中止按
    // 失败结算，failure_code 如实标注 CALL_TURN_ABORTED。
    const interruptible = turn.state === 'THINKING' || turn.state === 'SPEAKING';
    if (aborted && interruptible) {
      persistPartialReply(deps, store, account, call, turn, ctx);
      const settled = ctx.speech ? await ctx.speech.settle() : { committedSeconds: 0 };
      settleTurn(store, call, turn, { state: 'INTERRUPTED', interrupted: true, asrSeconds: ctx.asrSeconds, ttsSeconds: settled.committedSeconds, now: new Date() });
      emit('call.turn.interrupted', { turn_id: turn.turn_id, assistant_message_id: turn.assistant_message_id });
      return;
    }
    const settled = ctx.speech ? await ctx.speech.settle() : { committedSeconds: 0 };
    settleTurn(store, call, turn, {
      state: 'FAILED', failureCode: aborted ? 'CALL_TURN_ABORTED' : (error?.code || 'CALL_TURN_FAILED'),
      asrSeconds: ctx.asrSeconds, ttsSeconds: settled.committedSeconds, now: new Date()
    });
    emit('call.turn.failed', {
      turn_id: turn.turn_id, code: aborted ? 'CALL_TURN_ABORTED' : (error?.code || 'CALL_TURN_FAILED'),
      message: CALL_TURN_FAILURE_MESSAGES[error?.code] || error?.message || '本回合处理失败，请再试一次。'
    });
  }
}

// 回合主体：正常路径内自行结算并返回；抛错交由 executeCallTurn 统一终态。
async function runCallTurn(deps, { store, account, call, turn, emit, signal }, ctx, { usageRelease, usageCommit }) {
  const now = () => new Date();
  const conversation = deps.ownConversation(store, account.account_id, call.conversation_id);
  deps.requireOpenConversation(conversation);
  ctx.conversation = conversation;

  // 1. 取走并丢弃进程内音频（合规：转写后即弃，不落任何存储）。
  if (signal?.aborted) throw abortError();
  let sealed;
  try {
    sealed = deps.audioRegistry.consume(turn.turn_id);
  } catch (error) {
    throw Object.assign(new Error(CALL_TURN_FAILURE_MESSAGES.CALL_AUDIO_MISSING), { code: 'CALL_AUDIO_MISSING', cause: error });
  }
  turn.audio_bytes = sealed.total_bytes;
  turn.chunk_count = sealed.chunk_count;

  // 2. ASR：authorize→job 行→额度预留 min(60s,估算,余额)→整段识别→同口径 commit。
  deps.authorize(account, 'TRANSCRIBE_ASR', store);
  transitionTurn(store, turn, 'TRANSCRIBING', {}, now());
  const asrJob = {
    job_id: store.next('asr'), account_id: account.account_id, character_id: call.character_id, conversation_id: call.conversation_id,
    // 合规口径：通话用户音频不建 input 资产（input_asset_id 恒 null），只在内存过一道 ASR。
    source_message_id: null, input_asset_id: null, entitlement_id: null, type: 'ASR', state: 'PENDING', attempts: 0, provider: 'tencent-asr', provider_request_id: null,
    moderation_policy_version: null, result_asset_id: null, transcript_text: null, transcript_state: null, failure_code: null, created_at: now().toISOString()
  };
  ctx.asrJob = asrJob;
  store.mediaJobs.set(asrJob.job_id, asrJob);
  await deps.mediaStore.createPendingJob(asrJob);
  ctx.asrReservedSeconds = reserveMediaSeconds(deps.mediaEntitlementService, {
    accountId: account.account_id, jobId: asrJob.job_id, capability: 'TRANSCRIBE_ASR',
    wantedSeconds: Math.min(CALL_TURN_MAX_ASR_SECONDS, deps.estimateAudioSeconds(sealed.total_bytes))
  }, (entitlementId) => { asrJob.entitlement_id = entitlementId; });
  ctx.asrSeconds = ctx.asrReservedSeconds;
  turn.asr_job_id = asrJob.job_id;
  asrJob.state = 'RUNNING'; asrJob.attempts = 1;
  await deps.mediaStore.updateJob(asrJob);
  let asrResult;
  const asrStartedAt = Date.now();
  try {
    asrResult = await deps.asrTranscriber({ bytes: sealed.audio, mimeType: CALL_AUDIO_MIME_TYPE, sessionId: asrJob.job_id });
    recordOperationMetric(store, { accountId: account.account_id, capability: 'ASR', provider: providerName(deps.asrTranscriber, asrJob.provider), modelVersion: providerModelVersion(deps.asrTranscriber), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - asrStartedAt, outcome: 'COMPLETED' });
  } catch (error) {
    recordOperationMetric(store, { accountId: account.account_id, capability: 'ASR', provider: providerName(deps.asrTranscriber, asrJob.provider), modelVersion: providerModelVersion(deps.asrTranscriber), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - asrStartedAt, outcome: 'FAILED' });
    throw Object.assign(new Error(CALL_TURN_FAILURE_MESSAGES.ASR_TRANSCRIPTION_FAILED), { code: 'ASR_TRANSCRIPTION_FAILED', cause: error });
  }
  if (typeof asrResult?.text !== 'string' || !asrResult.text.trim()) {
    throw Object.assign(new Error(CALL_TURN_FAILURE_MESSAGES.ASR_TRANSCRIPTION_FAILED), { code: 'ASR_TRANSCRIPTION_FAILED' });
  }
  asrJob.provider_request_id = asrResult.providerRequestId ?? null;
  asrJob.transcript_text = asrResult.text;
  // 通话没有“转写确认”步骤：识别即确认（说错靠下一轮自然纠正）。
  asrJob.transcript_state = 'CONFIRMED';
  asrJob.state = 'COMPLETED';
  commitMediaSeconds(deps.mediaEntitlementService, { accountId: account.account_id, jobId: asrJob.job_id, capability: 'TRANSCRIBE_ASR', actualSeconds: ctx.asrReservedSeconds, reservedSeconds: ctx.asrReservedSeconds });
  await deps.mediaStore.updateJob(asrJob);
  if (signal?.aborted) throw abortError();
  turn.transcript_text = asrResult.text;
  emit('call.turn.transcript', { turn_id: turn.turn_id, text: asrResult.text });
  const userMessage = {
    message_id: store.next('msg'), conversation_id: call.conversation_id, actor: 'USER', text: asrResult.text,
    provider: 'tencent-asr', ai_generated: false, call_session_id: call.call_id, created_at: now().toISOString()
  };
  store.messages.set(userMessage.message_id, userMessage);
  turn.user_message_id = userMessage.message_id;

  // 3. 安全态：固定文案朗读（账户状态副作用与 createSafetyResponse 同口径）。
  const activeSafety = responseForExistingSafetyMode(account.safety_mode) || assessSafety(asrResult.text);
  if (activeSafety) {
    if (activeSafety.safetyMode) account.safety_mode = activeSafety.safetyMode;
    if (activeSafety.ageReview) { account.age_status = 'AGE_REVIEW'; account.age_reason_codes = ['SELF_REPORTED_MINOR']; }
    if (activeSafety.pause) account.user_pause_state = 'PAUSED';
    await speakFixedReply(deps, { store, account, call, turn, emit, signal, ctx },
      { text: activeSafety.text, provider: 'safety-policy', model_version: 'deterministic-safety-v1' });
    return;
  }

  // 4. INPUT 审核（live 在 POST 受理时做；通话转写只在 produce 内可得）。
  //    与非流式同口径：仅 Block 拦截（固定审核回复 200），Review 放行留痕。
  deps.authorize(account, 'SEND_MESSAGE', store);
  if (typeof deps.textModerator === 'function') {
    const moderation = await moderateTextWithMetric(store, account, deps.textModerator, { text: asrResult.text, conversationId: call.conversation_id, direction: 'INPUT' });
    if (!moderation || !['PASS', 'REVIEW', 'BLOCK'].includes(moderation.decision)) {
      throw Object.assign(new Error('内容审核未返回有效决策'), { code: 'TEXT_MODERATION_RESPONSE_INVALID' });
    }
    if (moderation.decision === 'BLOCK') {
      await speakFixedReply(deps, { store, account, call, turn, emit, signal, ctx },
        { text: MODERATION_REPLY_TEXT, provider: 'content-moderation-policy', model_version: moderation.policyVersion });
      return;
    }
  }

  // 5. LLM 流式：额度→上下文→逐句（本地门禁+OUTPUT TMS→字幕+逐段 TTS）。
  try {
    ctx.usageReservation = reserveDailyChatUsage(store, { accountId: account.account_id, estimatedInputTokens: estimateInputTokens(asrResult.text) });
  } catch (error) {
    throw Object.assign(new Error(CALL_TURN_FAILURE_MESSAGES.DAILY_CHAT_LIMIT_REACHED), { code: 'DAILY_CHAT_LIMIT_REACHED', cause: error });
  }
  ctx.assistantMessageId = store.next('msg');
  transitionTurn(store, turn, 'THINKING', {}, now());
  const contextPack = await deps.buildContextPack(store, account, conversation, asrResult.text, deps.embeddingProvider);
  transitionTurn(store, turn, 'SPEAKING', { assistant_message_id: ctx.assistantMessageId }, now());
  const moodRecord = store.worldStates.get(call.character_id);
  ctx.speech = createSpeechChannel(deps, { store, account, call, emit, signal, assistantMessageId: ctx.assistantMessageId, turnId: turn.turn_id, moodRecord });
  let textSequence = 0;
  const onFragment = async (fragment) => {
    const visibleFragment = deps.normalizeUnpromptedSelfIntro({ reply_text: fragment }, asrResult.text, contextPack.character?.name, true).reply_text;
    if (!visibleFragment) return true;
    if (assessModelOutputAuthority(visibleFragment)) return false;
    if (typeof deps.textModerator === 'function') {
      const moderation = await moderateTextWithMetric(store, account, deps.textModerator, { text: visibleFragment, conversationId: call.conversation_id, direction: 'OUTPUT' });
      if (moderation?.policyVersion) ctx.speech.notePolicyVersion(moderation.policyVersion);
      // 与 live 同口径：仅 Block 拦截流式片段；Review 灰区放行。
      if (!moderation || moderation.decision === 'BLOCK') return false;
    }
    textSequence += 1;
    ctx.emittedTexts.push(visibleFragment);
    emit('call.turn.text', { turn_id: turn.turn_id, sequence: textSequence, text: visibleFragment });
    const ttsText = truncateForTts(sanitizeTtsText(visibleFragment));
    if (ttsText) await ctx.speech.speakSentence(ttsText);
    return true;
  };
  let modelReply;
  try {
    modelReply = deps.normalizeUnpromptedSelfIntro(
      await deps.streamingReplyGenerator.generateStream(asrResult.text, contextPack, onFragment, signal),
      asrResult.text,
      contextPack.character?.name
    );
  } catch (error) {
    if (signal?.aborted || error?.code === 'QWEN_STREAM_INTERCEPTED') throw error;
    // 流式协议/网络失败：同轮降级非流式请求（不重复落用户消息），逐句朗读。
    if (typeof deps.replyGenerator === 'function') {
      const fallbackReply = deps.normalizeUnpromptedSelfIntro(
        await deps.replyGenerator(asrResult.text, contextPack),
        asrResult.text,
        contextPack.character?.name
      );
      if (assessModelOutputAuthority(fallbackReply.reply_text)) {
        throw Object.assign(new Error('降级终稿未通过输出门禁'), { code: 'MODEL_CLAIMED_AUTHORITY' });
      }
      for (const sentence of splitSentences(fallbackReply.reply_text)) await onFragment(sentence);
      modelReply = fallbackReply;
    } else {
      throw error;
    }
  }
  // 终稿复核：片段全过不代表拼接终稿安全（跨片段可能拼出新表述）。
  const finalText = modelReply.reply_text;
  const replaced = assessModelOutputAuthority(finalText);
  const assistantMessage = buildAssistantMessage(deps, store, account, conversation, {
    message_id: ctx.assistantMessageId,
    text: replaced ? OUTPUT_GUARD_REPLY_TEXT : finalText,
    provider: replaced ? 'model-output-guard' : modelReply.provider,
    model_version: replaced ? 'stream-gate-v1' : modelReply.model_version,
    ai_generated: replaced ? false : modelReply.ai_generated !== false
  }, call);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  ctx.partialPersisted = true;
  if (replaced) {
    textSequence += 1;
    ctx.emittedTexts.push(OUTPUT_GUARD_REPLY_TEXT);
    emit('call.turn.text', { turn_id: turn.turn_id, sequence: textSequence, text: OUTPUT_GUARD_REPLY_TEXT });
    await ctx.speech.speakSentence(truncateForTts(sanitizeTtsText(OUTPUT_GUARD_REPLY_TEXT)));
  } else if (ctx.emittedTexts.length === 0) {
    // 流式片段全被门禁拦截但终稿复核通过（如全部只有动作描写）：终稿直接落库，
    // 可朗读部分照常合成，保证通话不“哑火”。
    textSequence += 1;
    ctx.emittedTexts.push(finalText);
    emit('call.turn.text', { turn_id: turn.turn_id, sequence: textSequence, text: finalText });
    const ttsText = truncateForTts(sanitizeTtsText(finalText));
    if (ttsText) await ctx.speech.speakSentence(ttsText);
  }
  const usage = usageCommit(modelReply);
  const settled = await ctx.speech.settle();
  settleTurn(store, call, turn, { state: 'COMPLETED', asrSeconds: ctx.asrSeconds, ttsSeconds: settled.committedSeconds, now: now() });
  emit('call.turn.completed', {
    turn_id: turn.turn_id, user_message_id: turn.user_message_id, assistant_message_id: assistantMessage.message_id,
    tts_job_id: settled.job?.job_id ?? null, usage: usage ?? null, tts_degraded: Boolean(settled.job?.failure_code)
  });
}

// 固定文案回合（安全态/INPUT BLOCK）：字幕+朗读+COMPLETED，不进 LLM 与日额度。
async function speakFixedReply(deps, { store, account, call, turn, emit, signal, ctx }, { text, provider, model_version }) {
  ctx.assistantMessageId = store.next('msg');
  transitionTurn(store, turn, 'THINKING', {}, new Date());
  transitionTurn(store, turn, 'SPEAKING', { assistant_message_id: ctx.assistantMessageId }, new Date());
  const moodRecord = store.worldStates.get(call.character_id);
  ctx.speech = createSpeechChannel(deps, { store, account, call, emit, signal, assistantMessageId: ctx.assistantMessageId, turnId: turn.turn_id, moodRecord });
  emit('call.turn.text', { turn_id: turn.turn_id, sequence: 1, text });
  const assistantMessage = buildAssistantMessage(deps, store, account, ctx.conversation, { message_id: ctx.assistantMessageId, text, provider, model_version, ai_generated: false }, call);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  ctx.partialPersisted = true;
  await ctx.speech.speakSentence(truncateForTts(sanitizeTtsText(text)));
  const settled = await ctx.speech.settle();
  settleTurn(store, call, turn, { state: 'COMPLETED', asrSeconds: ctx.asrSeconds, ttsSeconds: settled.committedSeconds, now: new Date() });
  emit('call.turn.completed', { turn_id: turn.turn_id, user_message_id: turn.user_message_id, assistant_message_id: assistantMessage.message_id, tts_job_id: settled.job?.job_id ?? null, usage: null, tts_degraded: Boolean(settled.job?.failure_code) });
}

// 打断时的部分回复落库：已过审已播出的片段拼接为终稿（裁决 3）。
function persistPartialReply(deps, store, account, call, turn, ctx) {
  if (ctx.partialPersisted) return;
  const text = ctx.emittedTexts.join('');
  if (!text) {
    turn.assistant_message_id = null; // 没有任何可保留内容：不落空气泡
    return;
  }
  const assistantMessage = buildAssistantMessage(deps, store, account, ctx.conversation, {
    message_id: ctx.assistantMessageId, text,
    provider: providerName(deps.streamingReplyGenerator, 'qwen-stream'),
    model_version: providerModelVersion(deps.streamingReplyGenerator),
    ai_generated: true
  }, call);
  store.messages.set(assistantMessage.message_id, assistantMessage);
  ctx.partialPersisted = true;
}

// ASR job 未完成即中止/失败：关闭 job 行并全额返还预留（终态释放，不悬挂）。
async function closeAsrJob(deps, store, ctx, failureCode) {
  const job = ctx.asrJob;
  if (!job || job.state === 'COMPLETED') return;
  job.state = 'FAILED';
  job.failure_code = failureCode;
  settleMediaSeconds(deps.mediaEntitlementService, { accountId: job.account_id, jobId: job.job_id, capability: 'TRANSCRIBE_ASR', actualSeconds: 0, reservedSeconds: ctx.asrReservedSeconds });
  try { await deps.mediaStore.updateJob(job); } catch { /* 存储失败不阻断终态。 */ }
}

// ---- 逐句 TTS 通道（回合与问候共用）----

// 懒创建 TTS job（首个可合成片段出现时）+ 懒额度预留 min(90s,余额)（不阻塞
// LLM 启动）。音频段到即 emit（回合首段打 AIGC 标识）；单句失败降级纯文字；
// signal abort 向上抛（打断传播到 WS，计费立即停止）。TTS 未配置时返回惰性
// 通道（纯文字通话）。settle 幂等：打断与失败路径可能重复触达。
function createSpeechChannel(deps, { store, account, call, emit, signal, assistantMessageId, turnId, moodRecord }) {
  if (typeof deps.ttsGenerator !== 'function') {
    return { notePolicyVersion() {}, async speakSentence() { return false; }, async settle() { return { job: null, committedSeconds: 0 }; } };
  }
  const voiceGender = deps.normalizePersonaGender(store.characters.get(call.character_id)?.persona?.gender);
  const voiceProfile = deps.resolvedTtsVoiceProfile(deps.ttsGenerator, voiceGender);
  const baseEmotion = resolveEmotion(moodRecord?.mood_code);
  const character = store.characters.get(call.character_id);
  const worldState = character ? deps.publicWorldState(deps.currentWorldState(store, account, character)) : null;
  const spokenTexts = [];
  const aggregateChunks = [];
  let job = null;
  let reservedSeconds = 0;
  let seconds = 0;
  let segmentCount = 0;
  let byteLength = 0;
  let failureCode = null;
  let providerRequestId = null;
  let policyVersion = null;
  let settledResult = null;
  const ensureJob = () => {
    if (job) return job;
    job = {
      job_id: store.next('tts'), account_id: account.account_id, character_id: call.character_id, conversation_id: call.conversation_id,
      // 通话后回放复用：job 挂在 assistant 消息上（同 source+音色+COMPLETED 即复用）。
      source_message_id: assistantMessageId, entitlement_id: null, type: 'TTS', state: 'PENDING', attempts: 0, provider: 'tencent-tts', provider_request_id: null,
      moderation_policy_version: policyVersion, result_asset_id: null, failure_code: null,
      voice_id: voiceProfile.voice_id, voice_version: voiceProfile.voice_version, voice_gender: voiceGender,
      authorization_record_id: voiceProfile.authorization_record_id, rights_review_id: voiceProfile.rights_review_id, rights_review_state: voiceProfile.rights_review_state,
      world_state_id: worldState?.world_state_id ?? null, world_state_version: worldState?.state_version ?? null,
      tts_text: '', emotion_category: baseEmotion.category, emotion_intensity: baseEmotion.intensity,
      emotion_source: moodRecord ? 'world_state_mood' : 'fallback_neutral', tts_speed: baseEmotion.speed,
      created_at: new Date().toISOString()
    };
    store.mediaJobs.set(job.job_id, job);
    reservedSeconds = reserveMediaSeconds(deps.mediaEntitlementService, {
      accountId: account.account_id, jobId: job.job_id, capability: 'SYNTHESIZE_TTS', wantedSeconds: CALL_TURN_MAX_TTS_SECONDS
    }, (entitlementId) => { job.entitlement_id = entitlementId; });
    job.state = 'RUNNING'; job.attempts = 1;
    return job;
  };
  return {
    notePolicyVersion(version) { policyVersion = version; if (job) job.moderation_policy_version = version; },
    async speakSentence(ttsText) {
      if (failureCode) return false; // 已降级纯文字：后续句子不再合成
      const currentJob = ensureJob();
      const sessionId = `${currentJob.job_id}_${spokenTexts.length + 1}`;
      const startedAt = Date.now();
      try {
        const aggregate = await synthesizeSpeech(deps, {
          text: ttsText, sessionId, gender: voiceGender,
          emotion: baseEmotion.category, intensity: baseEmotion.intensity, speed: baseEmotion.speed,
          onAudioSegment: (segment) => {
            segmentCount += 1;
            // AIGC 标识（ID3v2.3）只写回合首段；后续段是裸 MP3 帧，拼接可播。
            const payload = segmentCount === 1 ? tagWithAigcMetadata(segment) : segment;
            byteLength += payload.length;
            emit('call.turn.audio', {
              turn_id: turnId, sequence: segmentCount, segment_index: segmentCount - 1,
              format: 'mp3', audio_base64: payload.toString('base64'), last: false
            });
          },
          signal
        });
        recordOperationMetric(store, { accountId: account.account_id, capability: 'TTS', provider: providerName(deps.ttsGenerator, currentJob.provider), modelVersion: providerModelVersion(deps.ttsGenerator, voiceProfile.voice_version), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, outcome: 'COMPLETED' });
        spokenTexts.push(ttsText);
        aggregateChunks.push(aggregate.asset.bytes);
        seconds += deps.estimateTtsSeconds(ttsText);
        providerRequestId = aggregate.providerRequestId;
        return true;
      } catch (error) {
        recordOperationMetric(store, { accountId: account.account_id, capability: 'TTS', provider: providerName(deps.ttsGenerator, currentJob.provider), modelVersion: providerModelVersion(deps.ttsGenerator, voiceProfile.voice_version), inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, outcome: 'FAILED' });
        if (signal?.aborted || error?.code === 'TENCENT_TTS_STREAM_ABORTED') throw error;
        // 打断向上传播；其余失败（含额度不足）降级纯文字，回合继续。
        failureCode = error?.code || 'TTS_GENERATION_FAILED';
        return false;
      }
    },
    // 终局：实际合成字节的拼接资产落库（回放复用）+ 额度按实际量结算。
    async settle() {
      if (settledResult) return settledResult;
      if (!job) { settledResult = { job: null, committedSeconds: 0 }; return settledResult; }
      job.tts_text = spokenTexts.join('');
      job.provider_request_id = providerRequestId;
      try {
        if (byteLength > 0) {
          const assetId = store.next('med');
          const bytes = Buffer.concat(aggregateChunks);
          const persisted = await deps.mediaStore.putAudio({ assetId, jobId: job.job_id, bytes, mimeType: 'audio/mpeg' });
          const asset = {
            asset_id: assetId, account_id: account.account_id, character_id: call.character_id, job_id: job.job_id, type: 'TTS_AUDIO', state: 'AVAILABLE',
            media_type: 'AUDIO', mime_type: persisted.mimeType, byte_length: persisted.byteLength, checksum: persisted.checksum, object_key: persisted.objectKey,
            provider: 'tencent-tts', provider_request_id: providerRequestId, ai_generated: true, aigc_mark_version: AIGC_MARK_VERSION_AUDIO, created_at: new Date().toISOString(), deleted_at: null
          };
          store.mediaAssets.set(assetId, asset);
          job.result_asset_id = assetId;
          job.state = 'COMPLETED'; // 部分成功后降级也保留资产供回放；failure_code 如实留痕
          job.failure_code = failureCode;
        } else {
          job.state = 'FAILED';
          job.failure_code = failureCode || 'TTS_GENERATION_FAILED';
        }
      } catch (error) {
        job.state = 'FAILED';
        job.failure_code = error?.code || 'TTS_ASSET_PERSIST_FAILED';
      }
      settleMediaSeconds(deps.mediaEntitlementService, { accountId: account.account_id, jobId: job.job_id, capability: 'SYNTHESIZE_TTS', actualSeconds: seconds, reservedSeconds });
      try { await deps.mediaStore.updateJob(job); } catch { /* 存储失败不阻断终态。 */ }
      settledResult = { job, committedSeconds: Math.min(seconds, reservedSeconds) };
      return settledResult;
    }
  };
}

// TTS 分派：stream 适配器用逐段回调；basic 只有聚合合同（整句返回，无逐段）。
function synthesizeSpeech(deps, input) {
  const generator = deps.ttsGenerator;
  if (typeof generator?.synthesizeStream === 'function') return generator.synthesizeStream(input);
  return generator(input);
}

// ---- 额度（秒）三段式 ----

// 预留秒数 = min(期望, 账面可用)；不足 1 秒即额度不足。服务未配置则记账跳过。
function reserveMediaSeconds(service, { accountId, jobId, capability, wantedSeconds }, onReserved) {
  if (!service) return 0;
  const balance = service.entitlementBalances(accountId).find((item) => item.capability === capability);
  const seconds = Math.min(wantedSeconds, balance?.available_quantity ?? 0);
  if (seconds < 1) {
    throw Object.assign(new Error(CALL_TURN_FAILURE_MESSAGES.ENTITLEMENT_QUOTA_EXCEEDED), { code: 'ENTITLEMENT_QUOTA_EXCEEDED' });
  }
  const reservation = service.reserve({ accountId, jobId, capability, quantity: seconds });
  onReserved?.(reservation.entitlement_id);
  return seconds;
}

// 实际>0 → commit min(实际,预留)（终态后余量自动释放）；实际=0 → 全额返还。
function settleMediaSeconds(service, { accountId, jobId, capability, actualSeconds, reservedSeconds }) {
  if (!service || reservedSeconds < 1) return;
  try {
    if (actualSeconds >= 1) service.commit({ accountId, jobId, capability, quantity: Math.min(actualSeconds, reservedSeconds) });
    else service.release({ accountId, jobId, capability });
  } catch { /* 结算失败不再阻断终态；账本以 job 行可对账。 */ }
}

function commitMediaSeconds(service, { accountId, jobId, capability, actualSeconds, reservedSeconds }) {
  if (!service || reservedSeconds < 1 || actualSeconds < 1) return;
  try { service.commit({ accountId, jobId, capability, quantity: Math.min(actualSeconds, reservedSeconds) }); } catch { /* 同上 */ }
}

// ---- 杂项 ----

function buildAssistantMessage(deps, store, account, conversation, { message_id, text, provider, model_version, ai_generated }, call) {
  const contextCharacter = store.characters.get(conversation.character_id);
  const worldState = contextCharacter ? deps.publicWorldState(deps.currentWorldState(store, account, contextCharacter)) : null;
  return {
    message_id, conversation_id: conversation.conversation_id, actor: 'ASSISTANT', text,
    provider, model_version, ai_generated,
    world_state_id: worldState?.world_state_id ?? null, world_state_version: worldState?.state_version ?? null,
    call_session_id: call.call_id, created_at: new Date().toISOString()
  };
}

function splitSentences(text) {
  return String(text).split(/(?<=[。！？!?；;\n])/).map((part) => part.trim()).filter(Boolean);
}

function seedFromCallId(callId) {
  const digits = String(callId).replace(/\D/g, '').slice(-6);
  const parsed = Number.parseInt(digits, 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

function abortError() {
  return Object.assign(new Error(CALL_TURN_FAILURE_MESSAGES.CALL_TURN_ABORTED), { code: 'CALL_TURN_ABORTED' });
}

function requireDeps(deps, names) {
  for (const name of names) {
    if (!deps || !deps[name]) throw new TypeError(`call-turn-engine 依赖缺失：${name}`);
  }
}

module.exports = {
  CALL_AUDIO_MIME_TYPE,
  CALL_TURN_FAILURE_MESSAGES,
  executeCallTurn,
  executeGreeting
};
