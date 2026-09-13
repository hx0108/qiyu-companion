'use strict';

// 1:1 通话常驻引擎（独立于 app.js 的 render 全量重建）：
// - 骨架只渲染一次，HUD/字幕/计时由 onEvent 回调定点更新；音频走 AudioContext，
//   不进 DOM，全量重渲染不破坏通话。
// - 「点击说话」一级交互：点按开始说话，边录边传（每 2 秒自封带头 WAV 分块，
//   与语音消息共用 encodePcm16Wav 编码口径）；VAD 静默 700ms 自动断句，再次
//   点按可提前结束。
// - 打断（barge-in）：AI 播报中点按说话键 = 停播 + 中止当前回合 SSE fetch
//   （服务端断开即按 INTERRUPTED 结算）；播放期 VAD 检出 300ms 持续高能量也
//   会自动打断——阈值更高且打断后 800ms 冷却，防 AEC 残留自打断循环。
// - 断线恢复：回合 SSE 10 秒无事件自动 GET /calls/{id} 对账，服务端事实优先；
//   服务端已终局则就地恢复待说状态，通话已结束则如实呈现。

import { encodePcm16Wav } from './media-input.js';

export const CALL_SAMPLE_RATE = 16_000;
export const CALL_CHUNK_MS = 2_000;
export const CALL_CHUNK_SAMPLES = CALL_SAMPLE_RATE * (CALL_CHUNK_MS / 1000);
export const CALL_VAD_SPEAK_THRESHOLD = 0.045; // 静默监听期起说能量（RMS）
export const CALL_VAD_SILENCE_MS = 700; // 静默断句
export const CALL_BARGE_IN_THRESHOLD = 0.12; // 播放期更高阈值（防 AEC 残留）
export const CALL_BARGE_IN_HOLD_MS = 300; // 持续高能量才判打断
export const CALL_BARGE_IN_COOLDOWN_MS = 800; // 打断后冷却，抑制回声尾
export const CALL_MAX_UTTERANCE_MS = 50_000; // 客户端强制断句（服务端 2MB 触顶更早）
export const CALL_IDLE_RECONCILE_MS = 10_000; // SSE 无事件对账时限

function concatBytes(chunks) {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const item of chunks) { merged.set(item, offset); offset += item.length; }
  return merged;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// 分块上传的 base64 编码：64KB 一块的 ArrayBuffer 不能整块展开进
// String.fromCharCode（参数上限），按 32KB 段拼接。
function bytesToBase64(bytes) {
  let binary = '';
  const sliceSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += sliceSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + sliceSize));
  }
  return btoa(binary);
}

function uuid() { return globalThis.crypto?.randomUUID?.() ?? `call-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function downsampleTo16k(input, inputRate) {
  if (inputRate === CALL_SAMPLE_RATE) return input;
  const ratio = inputRate / CALL_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor];
    output[index] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

function rmsOf(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

// 播放管线：逐段 decodeAudioData → AudioBufferSourceNode 无缝排队；分段落在
// 任意 MP3 帧边界时单独解码可能失败——留在缓冲与下一段拼接重试（通话后回放
// 由服务端聚合资产兜底，不依赖本端拼接）。stopAll 即打断：立即静音并清队。
export class AudioOutPipeline {
  constructor({ onAudibleChange = () => {} } = {}) {
    this.context = null;
    this.pending = [];
    this.pendingBytes = [];
    this.playing = null;
    this.stopped = false;
    this.onAudibleChange = onAudibleChange;
  }

  ensureContext() {
    if (!this.context) this.context = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return this.context;
  }

  get audible() { return Boolean(this.playing) || this.pending.length > 0; }

  async enqueueMp3(bytes) {
    if (this.stopped) return;
    this.pendingBytes.push(bytes);
    while (this.pendingBytes.length) {
      const merged = concatBytes(this.pendingBytes);
      try {
        const buffer = await this.ensureContext().decodeAudioData(merged.slice().buffer);
        this.pendingBytes = [];
        this.pending.push(buffer);
        this.pump();
      } catch {
        break; // 帧不完整：等下一段拼接重试
      }
    }
  }

  pump() {
    if (this.playing || this.stopped || this.pending.length === 0) return;
    const source = this.context.createBufferSource();
    source.buffer = this.pending.shift();
    source.connect(this.context.destination);
    this.playing = source;
    this.onAudibleChange(true);
    source.onended = () => {
      this.playing = null;
      if (!this.pending.length) this.onAudibleChange(false);
      this.pump();
    };
    source.start();
  }

  stopAll() {
    this.stopped = true;
    this.pending = [];
    this.pendingBytes = [];
    const playing = this.playing;
    this.playing = null;
    try { playing?.stop(); } catch { /* 已停止 */ }
    this.onAudibleChange(false);
  }
}

// 采集管线：AEC 约束取流 → ScriptProcessor(4096) 实时 PCM（Safari 全兼容）
// → 线性降采样 16k → 2 秒自封 WAV 分块上传 + RMS 能量/VAD 回调。
export class MicPipeline {
  constructor({ context, onChunk, onEnergy }) {
    this.context = context;
    this.onChunk = onChunk;
    this.onEnergy = onEnergy;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.bucket = [];
    this.capturing = false; // 仅说话回合内累积/上传；AI 播报期只监测能量
    this.speaking = false;
    this.silenceMs = 0;
    this.highEnergyMs = 0;
  }

  async start() {
    this.stream = await globalThis.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => this.handleAudio(event);
    // ScriptProcessor 需要连接到 destination 才会驱动（增益 0 的静音节点避免回环）。
    const sink = this.context.createGain();
    sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.context.destination);
  }

  handleAudio(event) {
    const input = event.inputBuffer.getChannelData(0);
    const samples = downsampleTo16k(input, event.inputBuffer.sampleRate);
    const rms = rmsOf(samples);
    const now = performance.now();
    // 播放期用更高阈值+持续能量判打断（回调返回 true 表示已触发打断，VAD 状态复位）。
    if (this.onEnergy(rms, now) === 'barge-in') { this.speaking = false; this.silenceMs = 0; this.highEnergyMs = 0; return; }
    const loud = rms >= CALL_VAD_SPEAK_THRESHOLD;
    if (loud) { this.speaking = true; this.silenceMs = 0; }
    else if (this.speaking) { this.silenceMs += (samples.length / CALL_SAMPLE_RATE) * 1000; }
    if (!this.capturing) return;
    // 分块桶：满 2 秒自封一个带头 WAV 立即上传（边录边传）。
    this.bucket.push(samples);
    const bucketLength = this.bucket.reduce((sum, item) => sum + item.length, 0);
    if (bucketLength >= CALL_CHUNK_SAMPLES) {
      this.onChunk(encodePcm16Wav(this.bucketFlat(bucketLength), CALL_SAMPLE_RATE));
      this.bucket = [];
    }
  }

  setCapturing(value) {
    this.capturing = value;
    if (!value) { this.bucket = []; this.speaking = false; this.silenceMs = 0; }
  }

  bucketFlat(length) {
    const merged = new Float32Array(length);
    let offset = 0;
    for (const item of this.bucket) { merged.set(item, offset); offset += item.length; }
    return merged;
  }

  // 断句收尾：把不满 2 秒的余量作为最后一块上传（可能不足 64KB，服务端按块校验）。
  flushRemainder() {
    if (!this.bucket.length) return;
    this.onChunk(encodePcm16Wav(this.bucketFlat(this.bucket.reduce((sum, item) => sum + item.length, 0)), CALL_SAMPLE_RATE));
    this.bucket = [];
  }

  stop() {
    try { this.processor?.disconnect(); this.source?.disconnect(); } catch { /* 已断开 */ }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.processor = null; this.source = null; this.stream = null;
  }
}

// 通话会话客户端：发起/回合上传/回合 SSE/打断/挂断/断线对账。UI 通过 onEvent
// 拿到状态与字幕，本类不触碰 DOM。
export class CallSessionClient {
  constructor({ apiBase = '', authHeaders, conversationId, onEvent = () => {} }) {
    this.apiBase = apiBase;
    this.authHeaders = authHeaders;
    this.conversationId = conversationId;
    this.onEvent = onEvent;
    this.call = null;
    this.phase = 'idle';
    this.mic = null;
    this.audioOut = null;
    this.context = null;
    this.chunkIndex = 0;
    this.turn = null;
    this.turnAbort = null;
    this.lastEventAt = 0;
    this.watchdog = null;
    this.uploadChain = Promise.resolve();
    this.barrierUntil = 0; // 打断冷却
    this.highEnergySince = 0;
    this.reconciling = false;
  }

  emit(payload) { this.onEvent(payload); }

  setPhase(phase) { this.phase = phase; this.emit({ type: 'phase', phase }); }

  async request(path, options = {}) {
    // 写路由全部要求 Idempotency-Key；每次调用都是新的逻辑操作，逐请求生成
    //（音频分块路由在服务端不进幂等层，多余头会被忽略）。
    const headers = { ...this.authHeaders(), ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.method === 'POST') headers['idempotency-key'] = uuid();
    const response = await fetch(`${this.apiBase}${path}`, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`), { status: response.status, code: payload?.error?.code, payload });
    return payload;
  }

  async start() {
    this.setPhase('ringing');
    // AudioContext 必须在手势调用链内创建/恢复（iOS Safari 口径）。
    this.audioOut = new AudioOutPipeline({ onAudibleChange: (audible) => this.emit({ type: 'audible', audible }) });
    this.context = this.audioOut.ensureContext();
    const payload = await this.request(`/conversations/${encodeURIComponent(this.conversationId)}/calls`, { method: 'POST', headers: this.authHeaders(), body: JSON.stringify({}) });
    this.call = payload.call;
    this.emit({ type: 'started', call: this.call, greetingText: payload.greeting?.text ?? '' });
    this.startWatchdog();
    this.setPhase('greeting');
    // 问候语音失败（额度/供应商/网络）不阻塞通话：字幕已由受理响应给出，
    // 流结束（含失败）即进入待说状态。
    this.playTurnStream(payload.greeting?.stream?.stream_url, { greeting: true })
      .catch(() => {})
      .then(() => { if (this.phase === 'greeting') this.markReady(); });
    return this.call;
  }

  // ---- 说话回合 ----

  async startTurn() {
    if (this.phase !== 'ready' || performance.now() < this.barrierUntil) return;
    const payload = await this.request(`/calls/${encodeURIComponent(this.call.call_id)}/turns`, { method: 'POST', body: JSON.stringify({}) });
    this.turn = payload.turn;
    this.chunkIndex = 0;
    this.micStartTime = performance.now();
    this.setPhase('recording');
    this.emit({ type: 'turn', turn: this.turn });
    if (!this.mic) {
      this.mic = new MicPipeline({
        context: this.context,
        onChunk: (wavBuffer) => this.uploadChunk(wavBuffer),
        onEnergy: (rms, now) => this.handleEnergy(rms, now)
      });
      await this.mic.start();
    }
    this.mic.setCapturing(true);
  }

  uploadChunk(wavBuffer) {
    if (!this.turn) return;
    const index = this.chunkIndex;
    this.chunkIndex += 1;
    // 顺序链保证分块按序到达服务端（乱序会被 409 拒绝）。
    this.uploadChain = this.uploadChain.then(async () => {
      if (!this.turn) return;
      await this.request(`/calls/${encodeURIComponent(this.call.call_id)}/turns/${encodeURIComponent(this.turn.turn_id)}/audio-chunks`, {
        method: 'POST',
        body: JSON.stringify({ chunk_index: index, audio_base64: bytesToBase64(new Uint8Array(wavBuffer)) })
      }).catch(() => { /* 单块失败不致命：finalize 后 ASR 以已收块为准 */ });
    });
  }

  handleEnergy(rms, now) {
    // AI 播报中：高能量持续 300ms 即自动打断（冷却期内忽略，防 AEC 残留）。
    if (this.phase === 'responding' && this.audioOut?.audible) {
      if (rms >= CALL_BARGE_IN_THRESHOLD && now >= this.barrierUntil) {
        if (!this.highEnergySince) this.highEnergySince = now;
        if (now - this.highEnergySince >= CALL_BARGE_IN_HOLD_MS) { this.highEnergySince = 0; this.bargeIn(); return 'barge-in'; }
      } else {
        this.highEnergySince = 0;
      }
      return 'monitoring';
    }
    this.highEnergySince = 0;
    // 说话中静默 700ms 自动断句；单次发言 50 秒强制断句。
    if (this.phase === 'recording' && this.mic?.speaking && this.mic.silenceMs >= CALL_VAD_SILENCE_MS) {
      this.finishTurn().catch(() => {});
      return 'finalized';
    }
    if (this.phase === 'recording' && this.mic && this.micStartTime && now - this.micStartTime >= CALL_MAX_UTTERANCE_MS) {
      this.finishTurn().catch(() => {});
      return 'finalized';
    }
    return 'idle';
  }

  async finishTurn() {
    if (this.phase !== 'recording' || !this.turn) return;
    const turnId = this.turn.turn_id;
    this.mic?.setCapturing(false);
    this.mic?.flushRemainder();
    await this.uploadChain.catch(() => {});
    if (!this.turn || this.turn.turn_id !== turnId) return;
    this.micStartTime = null;
    this.setPhase('responding');
    const payload = await this.request(`/calls/${encodeURIComponent(this.call.call_id)}/turns/${encodeURIComponent(turnId)}/finalize`, { method: 'POST', body: JSON.stringify({}) });
    this.emit({ type: 'turn-finalized', turn: payload.turn });
    this.lastEventAt = Date.now();
    await this.playTurnStream(payload.stream?.stream_url, {});
  }

  // ---- 回合 SSE（字幕 + 逐段音频）----

  async playTurnStream(streamUrl, { greeting = false }) {
    if (this.audioOut) this.audioOut.stopped = false; // 打断后新回合恢复可播
    this.turnAbort = new AbortController();
    const streamPath = String(streamUrl || '').startsWith(`${this.apiBase}/`) ? streamUrl : `${this.apiBase}${streamUrl}`;
    const response = await fetch(streamPath, { headers: this.authHeaders('text/event-stream'), signal: this.turnAbort.signal });
    if (!response.ok || !response.body) throw Object.assign(new Error(`通话流不可用（HTTP ${response.status}）`), { status: response.status });
    this.lastEventAt = Date.now();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.lastEventAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (!eventLine || !dataLine) continue;
        this.handleTurnEvent(eventLine.replace('event: ', ''), JSON.parse(dataLine.replace('data: ', '')), { greeting });
      }
    }
    this.turnAbort = null;
    if (!greeting) this.markReady();
  }

  handleTurnEvent(event, data, { greeting }) {
    if (event === 'call.turn.transcript') this.emit({ type: 'transcript', text: data.text });
    if (event === 'call.turn.text') this.emit({ type: 'subtitle', text: data.text });
    if (event === 'call.turn.audio' && data.audio_base64) {
      this.audioOut?.enqueueMp3(base64ToBytes(data.audio_base64)).catch(() => {});
    }
    if (event === 'call.turn.completed') {
      this.emit({ type: 'turn-done', greeting, usage: data.usage ?? null });
      if (greeting) this.markReady();
    }
    if (event === 'call.turn.interrupted') this.emit({ type: 'interrupted' });
    if (event === 'call.turn.failed') this.emit({ type: 'turn-failed', code: data.code, message: data.message });
  }

  markReady() {
    this.turn = null;
    if (this.phase === 'ended') return;
    this.setPhase('ready');
  }

  // ---- 打断 ----

  // 用户点按打断或 VAD 自动打断：停播 + 中止 SSE（服务端断开即中止 LLM/TTS，
  // 已播出部分按 INTERRUPTED 结算）。说话键随后可直接开始新回合。
  bargeIn() {
    if (performance.now() < this.barrierUntil) return;
    this.barrierUntil = performance.now() + CALL_BARGE_IN_COOLDOWN_MS;
    this.mic?.setCapturing(false);
    this.audioOut?.stopAll();
    try { this.turnAbort?.abort(); } catch { /* 已中止 */ }
    this.turnAbort = null;
    this.emit({ type: 'barge-in' });
    this.markReady();
  }

  // ---- 断线对账 ----

  startWatchdog() {
    this.watchdog = window.setInterval(() => {
      if (this.phase !== 'responding' || this.reconciling || !this.turn) return;
      if (Date.now() - this.lastEventAt < CALL_IDLE_RECONCILE_MS) return;
      this.reconcile().catch(() => {});
    }, 1_000);
  }

  async reconcile() {
    this.reconciling = true;
    try {
      const payload = await this.request(`/calls/${encodeURIComponent(this.call.call_id)}`);
      const call = payload.call;
      if (call.state === 'ENDED') { this.emit({ type: 'ended', call, reason: call.end_reason }); this.setPhase('ended'); return; }
      const current = (payload.turns ?? []).find((turn) => turn.turn_id === this.turn?.turn_id);
      if (current && ['COMPLETED', 'INTERRUPTED', 'FAILED'].includes(current.state)) {
        this.emit({ type: 'reconciled', turn: current });
        this.markReady();
      }
    } finally { this.reconciling = false; }
  }

  // ---- 挂断 ----

  async hangup() {
    this.setPhase('ended');
    try { this.turnAbort?.abort(); } catch { /* 已中止 */ }
    this.audioOut?.stopAll();
    this.mic?.stop();
    this.mic = null;
    window.clearInterval(this.watchdog);
    this.watchdog = null;
    if (!this.call) return null;
    const payload = await this.request(`/calls/${encodeURIComponent(this.call.call_id)}/end`, { method: 'POST', body: JSON.stringify({}) }).catch(() => null);
    try { await this.context?.close(); } catch { /* 已关闭 */ }
    this.context = null;
    return payload?.call ?? null;
  }
}
