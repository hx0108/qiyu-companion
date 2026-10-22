'use strict';

const { randomUUID } = require('node:crypto');
const { gunzipSync } = require('node:zlib');

const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const { CALL_MAX_DURATION_MS } = require('../domain/call-session');
const MAX_FRAME = 1024 * 1024;
const STANDARD_VOICES = new Set(['zh_female_vv_jupiter_bigtts', 'zh_female_xiaohe_jupiter_bigtts', 'zh_male_yunzhou_jupiter_bigtts', 'zh_male_xiaotian_jupiter_bigtts']);
const NORMAL_TTS_TYPES = new Set(['default', 'chat_tts_text', 'network', 'external_rag', 'sing']);
class RealtimeProviderError extends Error {
  constructor(code, status = 502) {
    super('实时语音服务暂不可用');
    this.name = 'RealtimeProviderError'; this.code = code; this.status = status; this.expose = true;
  }
}
function fail(code, status) { return new RealtimeProviderError(code, status); }
function nonblank(value) { return typeof value === 'string' && value.trim().length > 0; }
function uint(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }

// Official V3 event framing. IDs below 100 are connection scoped; session events carry ID.
function encodeRealtimeFrame(event, payload = {}, sessionId = '') {
  const audio = Buffer.isBuffer(payload);
  const bytes = audio ? payload : Buffer.from(JSON.stringify(payload));
  const id = Buffer.from(sessionId);
  if (bytes.length > MAX_FRAME || id.length > 128) throw fail('REALTIME_FRAME_TOO_LARGE', 400);
  return Buffer.concat([Buffer.from([0x11, audio ? 0x24 : 0x14, audio ? 0 : 0x10, 0]), uint(event),
    ...(event >= 100 ? [uint(id.length), id] : []), uint(bytes.length), bytes]);
}
function decodeRealtimeFrame(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < 8 || bytes.length > MAX_FRAME || bytes[0] !== 0x11 || bytes[3] !== 0) throw fail('REALTIME_PROTOCOL_INVALID');
  const type = bytes[1] >> 4; const flags = bytes[1] & 15;
  const serialization = bytes[2] >> 4; const compression = bytes[2] & 15;
  if (![9, 11, 15].includes(type) || ![0, 1].includes(serialization) || ![0, 1].includes(compression)) throw fail('REALTIME_PROTOCOL_INVALID');
  let offset = 4;
  function number() { if (offset + 4 > bytes.length) throw fail('REALTIME_PROTOCOL_INVALID'); const value = bytes.readUInt32BE(offset); offset += 4; return value; }
  function field() { const length = number(); if (length > MAX_FRAME || offset + length > bytes.length) throw fail('REALTIME_PROTOCOL_INVALID'); const value = bytes.subarray(offset, offset + length); offset += length; return value; }
  let event; let sessionId = ''; let errorCode;
  if (type === 15) errorCode = number();
  else {
    if (flags & 3) number();
    if (!(flags & 4)) throw fail('REALTIME_PROTOCOL_INVALID');
    event = number();
    // Server connection events contain connect ID; all other events contain session ID.
    sessionId = field().toString('utf8');
    if (Buffer.byteLength(sessionId) > 128) throw fail('REALTIME_PROTOCOL_INVALID');
  }
  let payload = field();
  if (offset !== bytes.length) throw fail('REALTIME_PROTOCOL_INVALID');
  if (compression) {
    try { payload = gunzipSync(payload, { maxOutputLength: MAX_FRAME }); } catch { throw fail('REALTIME_PROTOCOL_INVALID'); }
  }
  if (serialization === 1) {
    try { payload = JSON.parse(payload.toString('utf8')); } catch { throw fail('REALTIME_PROTOCOL_INVALID'); }
  }
  return { event, sessionId, payload, errorCode, type };
}

class VolcengineRealtimeAdapter {
  constructor({ apiKey, appId, accessKey, model = '1.2.1.1', speaker,
    wsFactory, timeoutMs = 10000, maxSessionMs = CALL_MAX_DURATION_MS, endSilenceMs = 500 } = {}) {
    if (!nonblank(apiKey) && !(nonblank(appId) && nonblank(accessKey))) throw fail('VOLCENGINE_REALTIME_CREDENTIAL_REQUIRED', 503);
    if (!['1.2.1.1', '2.2.0.0'].includes(model) || (speaker !== undefined && (!nonblank(speaker) || (model === '1.2.1.1' && !STANDARD_VOICES.has(speaker)))) || (model === '2.2.0.0' && !nonblank(speaker)) || !Number.isInteger(endSilenceMs) || endSilenceMs < 500 || endSilenceMs > 50000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxSessionMs) || maxSessionMs < 1) throw fail('VOLCENGINE_REALTIME_CONFIG_INVALID', 500);
    this.credentials = nonblank(apiKey) ? { 'X-Api-Key': apiKey } : { 'X-Api-App-ID': appId, 'X-Api-Access-Key': accessKey, 'X-Api-App-Key': 'PlgvMymc7f3tQnJ6' };
    this.wsFactory = wsFactory || ((url, options) => { const WebSocket = require('ws'); return new WebSocket(url, options); });
    Object.assign(this, { model, speaker, timeoutMs, maxSessionMs, endSilenceMs });
  }

  // Raw events are private to the server coordinator. They are NOT cleared for client playback.
  async createSession({ instructions, botName = '栖语', context = [], onEvent, signal, voiceGender, speakingStyle } = {}) {
    if (voiceGender !== undefined && !['MALE', 'FEMALE'].includes(voiceGender)) throw fail('REALTIME_VOICE_GENDER_INVALID', 400);
    // A global standard voice may tune a matching character, but must not
    // override the saved gender. Clone voices have no trustworthy gender tag.
    const genderPrefix = voiceGender === 'MALE' ? 'zh_male_' : 'zh_female_';
    const defaultSpeaker = voiceGender === 'MALE' ? 'zh_male_yunzhou_jupiter_bigtts' : 'zh_female_vv_jupiter_bigtts';
    const speaker = this.model === '1.2.1.1' && voiceGender
      ? (this.speaker?.startsWith(genderPrefix) ? this.speaker : defaultSpeaker)
      : this.speaker || defaultSpeaker;
    if (!nonblank(instructions) || instructions.length > 4000 || !nonblank(botName) || botName.length > 20 || typeof onEvent !== 'function' || !Array.isArray(context) || context.length > 40 || context.length % 2 || context.some((item, index) => item?.role !== (index % 2 ? 'assistant' : 'user') || !nonblank(item.text) || item.text.length > 2000)) throw fail('REALTIME_SESSION_CONFIG_INVALID', 400);
    if (speakingStyle !== undefined && (!nonblank(speakingStyle) || speakingStyle.length > 1000)) throw fail('REALTIME_SESSION_CONFIG_INVALID', 400);
    if (this.model === '1.2.1.1' && instructions.length + (speakingStyle?.length || 0) > 4000) throw fail('REALTIME_SESSION_CONFIG_INVALID', 400);
    if (signal?.aborted) throw fail('REALTIME_ABORTED', 499);
    const sessionId = randomUUID(); const connectId = randomUUID();
    let ws;
    try { ws = this.wsFactory(ENDPOINT, { headers: { ...this.credentials, 'X-Api-Resource-Id': 'volc.speech.dialog', 'X-Api-Connect-Id': connectId }, maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: this.timeoutMs }); }
    catch { throw fail('REALTIME_CONNECTION_FAILED'); }
    let ready = false; let closed = false; let terminalError = null; let inputEnded = false; let sentence = null; let sentenceCount = 0;
    let questionId = null; let sessionRequested = false; let activeReply = null;
    let finalTranscript = null; let interrupted = false; let replyText = null; let replySegment = null;
    let pendingTts = null; let pendingTtsTimer;
    const staleQuestions = new Set(); const completedReplies = new Set();
    let finishResolve; let finishReject; let sessionTimer; let pendingBytes = 0;
    let chain = Promise.resolve();
    const started = new Promise((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
    const handshakeTimer = setTimeout(() => stop(fail('REALTIME_START_TIMEOUT', 504)), this.timeoutMs);
    const emit = (event) => onEvent({ ...event, sessionId });
    const send = (event, payload = {}) => {
      if (closed || ws.readyState !== 1) throw terminalError || fail('REALTIME_SESSION_CLOSED', 409);
      if (ws.bufferedAmount > MAX_FRAME) throw fail('REALTIME_BACKPRESSURE', 503);
      ws.send(encodeRealtimeFrame(event, payload, sessionId));
    };
    const stop = (error) => {
      if (closed) return;
      terminalError = error || null;
      closed = true; sentence = null; pendingTts = null;
      clearTimeout(handshakeTimer); clearTimeout(sessionTimer); clearTimeout(pendingTtsTimer); signal?.removeEventListener('abort', abort);
      // terminate closes immediately: queued native audio must never leak after an interrupt.
      if (typeof ws.terminate === 'function') ws.terminate(); else ws.close();
      if (!ready) finishReject(error || fail('REALTIME_SESSION_CLOSED'));
      else Promise.resolve(emit(error ? { type: 'error', code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } : { type: 'closed' })).catch(() => {});
    };
    const abort = () => stop(fail('REALTIME_ABORTED', 499));
    signal?.addEventListener('abort', abort, { once: true });
    const session = {
      sessionId, inputFormat: { format: 'pcm_s16le', sampleRate: 16000, channels: 1 },
      outputFormat: { format: 'pcm_s16le', sampleRate: 24000, channels: 1 },
      sendAudio: (audio) => {
        if (!ready || inputEnded || !Buffer.isBuffer(audio) || !audio.length || audio.length % 2 || audio.length > 32000) throw fail('REALTIME_AUDIO_INVALID', 400);
        send(200, audio);
      },
      // V3 server VAD owns endpointing. Do not send FinishSession as a turn commit.
      finishInput: () => { inputEnded = true; },
      interrupt: () => stop(), close: () => {
        if (!closed && ready) { try { send(102); send(2); } catch {} }
        stop();
      },
      get closed() { return closed; },
      get closedReason() { return terminalError?.code || null; }
    };
    ws.on('open', () => { try { send(1); } catch (error) { stop(error); } });
    ws.on('error', () => stop(fail('REALTIME_CONNECTION_FAILED')));
    ws.on('close', () => stop(fail('REALTIME_CONNECTION_CLOSED')));
    ws.on('message', (data, isBinary) => {
      if (closed) return;
      pendingBytes += data.length;
      if (!isBinary || pendingBytes > 2 * MAX_FRAME) { stop(fail('REALTIME_PROTOCOL_INVALID')); return; }
      chain = chain.then(async () => {
        pendingBytes -= data.length;
        if (closed) return;
        await processFrame(decodeRealtimeFrame(data));
      }).catch((error) => stop(error instanceof RealtimeProviderError ? error : fail('REALTIME_EVENT_HANDLER_FAILED')));
    });
    const processFrame = async (frame) => {
        if (closed) return;
        const payload = frame.payload;
        if (frame.errorCode || [51, 153, 599].includes(frame.event)) throw fail('REALTIME_PROVIDER_REJECTED');
        if (frame.event === 50) {
          if (sessionRequested || ready) throw fail('REALTIME_PROTOCOL_ORDER');
          sessionRequested = true;
          const dialog = { ...(this.model === '2.2.0.0' ? { character_manifest: instructions } : { bot_name: botName, system_role: instructions }),
            ...(this.model === '1.2.1.1' && speakingStyle !== undefined ? { speaking_style: speakingStyle } : {}),
            dialog_context: context.map(({ role, text }) => ({ role, text })), extra: { strict_audit: true, enable_volc_websearch: false, model: this.model } };
          send(100, { asr: { extra: { enable_custom_vad: true, end_smooth_window_ms: this.endSilenceMs } },
            tts: { speaker, audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 } }, dialog });
          return;
        }
        if (frame.sessionId !== sessionId) throw fail('REALTIME_SESSION_MISMATCH');
        if (frame.event === 150 && !ready) {
          ready = true; clearTimeout(handshakeTimer);
          sessionTimer = setTimeout(() => stop(fail('REALTIME_SESSION_LIMIT', 408)), this.maxSessionMs);
          finishResolve(session); return;
        }
        if (!ready) throw fail('REALTIME_PROTOCOL_ORDER');
        if (frame.event === 154) {
          const fields = ['input_text_tokens', 'input_audio_tokens', 'cached_text_tokens', 'cached_audio_tokens', 'output_text_tokens', 'output_audio_tokens'];
          const usage = {};
          for (const key of fields) {
            if (!Number.isSafeInteger(payload.usage?.[key]) || payload.usage[key] < 0) throw fail('REALTIME_USAGE_INVALID');
            usage[key] = payload.usage[key];
          }
          await emit({ type: 'usage', usage });
        }
        else if (frame.event === 450) {
          if (!nonblank(payload?.question_id)) throw asrFail('ASR_INFO');
          if (questionId && questionId !== payload.question_id) { staleQuestions.add(questionId); interrupted = true; }
          questionId = payload.question_id; sentence = null; activeReply = null;
          finalTranscript = null; replyText = null; replySegment = null; pendingTts = null;
          clearTimeout(pendingTtsTimer);
          await emit({ type: 'speech-start', questionId });
        }
        else if (frame.event === 451) {
          // ASRResponse/ASREnded do not carry IDs in the official wire schema.
          // They belong to the last ASRInfo question; never invent or guess across turns.
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw asrFail('ASR_SCHEMA');
          if (payload.question_id !== undefined && (!nonblank(payload.question_id) || questionId && payload.question_id !== questionId)) throw asrFail('ASR_QUESTION_MISMATCH');
          questionId ||= payload.question_id;
          if (!nonblank(questionId)) throw asrFail('ASR_INFO');
          if (!Array.isArray(payload.results) || payload.results.some((result) => !result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string' || result.is_interim !== undefined && typeof result.is_interim !== 'boolean')) throw asrFail('ASR_SCHEMA');
          const results = payload.results.filter((result) => nonblank(result.text));
          // Empty placeholders contain no revision. Preserve a previously explicit
          // final; a missing confirmation on nonempty text is preview-only.
          if (!results.length) return;
          const text = results.map((result) => result.text).join('');
          if (text.length > 4000) throw asrFail('ASR_LENGTH');
          finalTranscript = results.every((result) => result.is_interim === false) ? text : null;
          await emit({ type: 'transcript', role: 'user', text, final: false, questionId });
        }
        else if (frame.event === 459) {
          if (!nonblank(questionId)) throw asrFail('ASR_INFO');
          // No confirmed input means no user turn. Drop this question's output,
          // inform the coordinator, and allow another utterance on the same call.
          if (!nonblank(finalTranscript)) {
            staleQuestions.add(questionId); interrupted = true;
            sentence = null; activeReply = null; replyText = null; replySegment = null; pendingTts = null;
            clearTimeout(pendingTtsTimer);
            await emit({ type: 'speech-end', questionId, empty: true, reason: 'ASR_UNCONFIRMED' }); return;
          }
          await emit({ type: 'transcript', role: 'user', text: finalTranscript, final: true, questionId });
          finalTranscript = null;
          await emit({ type: 'speech-end', questionId });
        }
        else if (frame.event === 550 || frame.event === 559) {
          if (!nonblank(payload.question_id) || !nonblank(payload.reply_id)) throw fail('REALTIME_TEXT_UNBOUND');
          if (staleQuestions.has(payload.question_id)) return;
          if (completedReplies.has(payload.reply_id) || payload.question_id !== questionId ||
            (activeReply && (activeReply.replyId !== payload.reply_id || activeReply.questionId !== payload.question_id)) ||
            (replyText && (replyText.replyId !== payload.reply_id || replyText.questionId !== payload.question_id))) throw fail('REALTIME_TEXT_UNBOUND');
          replyText ||= { questionId: payload.question_id, replyId: payload.reply_id, text: '', complete: false };
          if (replyText.complete) throw fail('REALTIME_TEXT_UNBOUND');
          if (frame.event === 550) {
            if (typeof payload.content !== 'string' || replyText.text.length + payload.content.length > 4000) throw fail('REALTIME_TEXT_INVALID');
            replyText.text += payload.content;
          } else {
            if (!nonblank(replyText.text)) throw fail('REALTIME_TEXT_INVALID');
            replyText.complete = true;
            if (pendingTts) {
              if (pendingTts.questionId !== replyText.questionId || pendingTts.replyId !== replyText.replyId) throw sentenceFail('PENDING_REPLY_MISMATCH');
              const frames = pendingTts.frames; pendingTts = null;
              clearTimeout(pendingTtsTimer);
              for (const queued of frames) await processFrame(queued);
            }
          }
        }
        else if (frame.event === 350) {
          if (sentence || typeof payload.text !== 'string' || !nonblank(payload.reply_id) || !nonblank(payload.question_id)) throw sentenceFail(sentence ? 'OVERLAPPING_START' : 'START_SCHEMA');
          if (payload.tts_type !== undefined && !NORMAL_TTS_TYPES.has(payload.tts_type)) throw fail('REALTIME_TTS_TYPE_REJECTED');
          if (staleQuestions.has(payload.question_id)) {
            if (pendingTts) throw sentenceFail('OVERLAPPING_START');
            sentence = { replyId: payload.reply_id, questionId: payload.question_id, discarded: true }; return;
          }
          if (completedReplies.has(payload.reply_id)) throw sentenceFail('COMPLETED_REPLY');
          if ((questionId && payload.question_id !== questionId) || (activeReply && (activeReply.replyId !== payload.reply_id || activeReply.questionId !== payload.question_id))) throw sentenceFail('START_REPLY_MISMATCH');
          // Text and audio are independent streams. Hold early empty-text TTS until
          // its explicitly matching full text is sealed; nothing is emitted yet.
          if (!nonblank(payload.text) && payload.tts_type === 'default' && !replyText?.complete && questionId === payload.question_id && (!replyText || (replyText.replyId === payload.reply_id && replyText.questionId === payload.question_id))) {
            if (!pendingTts) {
              pendingTts = { questionId: payload.question_id, replyId: payload.reply_id, frames: [], bytes: 0 };
              pendingTtsTimer = setTimeout(() => stop(fail('REALTIME_PENDING_TTS_TIMEOUT', 504)), 5000);
            }
          }
          if (pendingTts) { queueTts(frame); return; }
          // Observed O2.0 emits empty 350.text after 550 deltas and 559. Only a
          // completed, explicitly matching reply can supply its reviewable text.
          if (!nonblank(payload.text) && (payload.tts_type !== 'default' || !replyText?.complete || replyText.replyId !== payload.reply_id || replyText.questionId !== payload.question_id || (activeReply && !replySegment))) throw sentenceFail('UNSEALED_EMPTY_TEXT');
          if (replySegment && nonblank(payload.text) && !replySegment.text.includes(payload.text)) throw sentenceFail('SUBCLAUSE_TEXT_MISMATCH');
          activeReply = { replyId: payload.reply_id, questionId: payload.question_id };
          interrupted = false;
          const existingReplySegment = Boolean(replySegment);
          if (!nonblank(payload.text) && !replySegment) replySegment = { text: replyText.text, ...activeReply, segmentId: `${payload.reply_id}:${++sentenceCount}` };
          sentence = replySegment || { text: payload.text, ...activeReply, segmentId: `${payload.reply_id}:${++sentenceCount}` };
          if (!existingReplySegment) await emit({ type: 'sentence-start', ...sentence, clearedForPlayback: false });
        }
        else if (frame.event === 352) {
          if (pendingTts) { queueTts(frame); return; }
          if (sentence?.discarded || (!sentence && interrupted)) return;
          if (!sentence || !Buffer.isBuffer(payload) || !payload.length || payload.length % 2) throw fail('REALTIME_AUDIO_UNBOUND');
          await emit({ type: 'audio', ...sentence, bytes: payload, format: 'pcm_s16le', sampleRate: 24000, channels: 1, clearedForPlayback: false });
        }
        else if (frame.event === 351) {
          // An interrupted reply may finish after the next reply has started.
          // Its explicit old question ID cannot end or invalidate the new sentence.
          if (staleQuestions.has(payload.question_id)) {
            if (sentence?.discarded && sentence.questionId === payload.question_id && sentence.replyId === payload.reply_id) sentence = null;
            return;
          }
          if (pendingTts) { queueTts(frame); return; }
          if (!sentence || payload.reply_id !== sentence.replyId || payload.question_id !== sentence.questionId) throw sentenceFail('END_REPLY_MISMATCH');
          if (sentence.discarded) { sentence = null; return; }
          if (!replySegment) await emit({ type: 'sentence-end', ...sentence });
          sentence = null;
        }
        else if (frame.event === 359) {
          if (staleQuestions.has(payload.question_id) || completedReplies.has(payload.reply_id)) return;
          if (pendingTts) { queueTts(frame); return; }
          if (sentence || !activeReply || payload.reply_id !== activeReply.replyId || payload.question_id !== activeReply.questionId) throw fail('REALTIME_PROTOCOL_ORDER');
          if (replySegment) await emit({ type: 'sentence-end', ...replySegment });
          await emit({ type: 'response-complete', replyId: payload.reply_id, questionId: payload.question_id });
          completedReplies.add(payload.reply_id);
          activeReply = null; replyText = null; replySegment = null;
        }
        else if (frame.event === 152) stop();
    };
    function sentenceFail(diagnostic) {
      const error = fail('REALTIME_SENTENCE_UNBOUND'); error.diagnostic = diagnostic; return error;
    }
    function asrFail(diagnostic) {
      const error = fail('REALTIME_TRANSCRIPT_INVALID'); error.diagnostic = diagnostic; return error;
    }
    function queueTts(frame) {
      const payload = frame.payload;
      if (frame.event !== 352 && (payload.question_id !== pendingTts.questionId || payload.reply_id !== pendingTts.replyId)) throw sentenceFail('PENDING_REPLY_MISMATCH');
      if (frame.event === 352 && (!Buffer.isBuffer(payload) || !payload.length || payload.length % 2)) throw fail('REALTIME_AUDIO_UNBOUND');
      pendingTts.bytes += frame.event === 352 ? payload.length : Buffer.byteLength(JSON.stringify(payload));
      if (pendingTts.bytes > MAX_FRAME || pendingTts.frames.length >= 512) throw fail('REALTIME_PENDING_TTS_LIMIT');
      pendingTts.frames.push(frame);
    }
    return started;
  }
}

function createVolcengineRealtimeAdapterFromEnvironment(environment = process.env, options = {}) {
  if (!nonblank(environment.VOLCENGINE_REALTIME_API_KEY) && !(nonblank(environment.VOLCENGINE_REALTIME_APP_ID) && nonblank(environment.VOLCENGINE_REALTIME_ACCESS_KEY))) return null;
  return new VolcengineRealtimeAdapter({ apiKey: environment.VOLCENGINE_REALTIME_API_KEY,
    appId: environment.VOLCENGINE_REALTIME_APP_ID, accessKey: environment.VOLCENGINE_REALTIME_ACCESS_KEY,
    ...(environment.VOLCENGINE_REALTIME_MODEL ? { model: environment.VOLCENGINE_REALTIME_MODEL } : {}),
    ...(environment.VOLCENGINE_REALTIME_SPEAKER ? { speaker: environment.VOLCENGINE_REALTIME_SPEAKER } : {}), ...options });
}
module.exports = { VolcengineRealtimeAdapter, RealtimeProviderError, createVolcengineRealtimeAdapterFromEnvironment, encodeRealtimeFrame, decodeRealtimeFrame };
