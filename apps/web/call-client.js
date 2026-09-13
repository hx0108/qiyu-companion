'use strict';

// 1:1 通话常驻引擎（豆包式免提交互，独立于 app.js 的 render 全量重建）：
// - 接通即常开麦克风：能量监测全程运行，用户随时开口即自动开回合（250ms 持续
//   起说能量），静默 700ms 自动断句——全程免按键；AI 播报中开口 = 打断（更高
//   阈值 + 300ms 持续能量 + 800ms 冷却防 AEC 残留自打断循环）。
// - 静音键：免提的唯一切换（静音 = 结束当前回合并暂停聆听）；挂断键独立。
// - 无缝播放：段落在任意 MP3 帧边界时与下一段拼接重试解码；按 AudioContext
//   时钟精确排程（nextStart 链），消除 onended 链式起播的句间空拍。
// - 断线恢复：回合 SSE 10 秒无事件自动 GET /calls/{id} 对账，服务端事实优先。
// - 骨架只渲染一次，状态由 onEvent 定点更新；音频走 AudioContext 不进 DOM。

import { encodePcm16Wav } from './media-input.js';

export const CALL_SAMPLE_RATE = 16_000;
export const CALL_CHUNK_MS = 2_000;
export const CALL_CHUNK_SAMPLES = CALL_SAMPLE_RATE * (CALL_CHUNK_MS / 1000);
export const CALL_MAX_PRE_ROLL_MS = 12_000; // 未开回合时的预录缓冲上限（打断后语音开头不丢）
export const CALL_VAD_SPEAK_THRESHOLD = 0.045; // 起说能量（RMS）
export const CALL_VAD_SILENCE_MS = 700; // 静默断句
export const CALL_AUTO_START_MS = 250; // 持续起说多久自动开回合
export const CALL_BARGE_IN_THRESHOLD = 0.12; // 播放期更高阈值（防 AEC 残留）
export const CALL_BARGE_IN_HOLD_MS = 300; // 持续高能量才判打断
export const CALL_BARGE_IN_COOLDOWN_MS = 800; // 打断后冷却，抑制回声尾
export const CALL_MAX_UTTERANCE_MS = 50_000; // 单次发言强制断句（服务端 2MB 触顶更早）
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

// 播放管线：逐段 decodeAudioData（帧不完整时与下一段拼接重试）→ 按
// AudioContext 时钟精确排程的零间隙队列。
export class AudioOutPipeline {
  constructor({ onAudibleChange = () => {} } = {}) {
    this.context = null;
    this.pending = [];
    this.pendingBytes = [];
    this.sources = [];
    this.nextStart = 0;
    this.stopped = false;
    this.decoding = false;
    this.onAudibleChange = onAudibleChange;
  }

  ensureContext() {
    if (!this.context) this.context = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return this.context;
  }

  get audible() { return this.pending.length > 0 || this.sources.length > 0 || this.decoding; }

  async enqueueMp3(bytes) {
    if (this.stopped) return;
    this.pendingBytes.push(bytes);
    this.decoding = true;
    try {
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
    } finally { this.decoding = false; }
  }

  // 零间隙排程：新段从上一段的精确结束时刻起播（硬件时钟），而不是等
  // onended 事件再起播（事件调度天然带毫秒级空拍，累积成句间卡顿）。
  pump() {
    if (this.stopped || this.pending.length === 0) return;
    if (this.sources.length === 0) this.nextStart = this.context.currentTime + 0.06;
    while (this.pending.length) {
      const source = this.context.createBufferSource();
      source.buffer = this.pending.shift();
      source.connect(this.context.destination);
      source.start(Math.max(this.nextStart, this.context.currentTime + 0.02));
      this.nextStart = Math.max(this.nextStart, this.context.currentTime + 0.02) + source.buffer.duration;
      this.sources.push(source);
      source.onended = () => {
        this.sources = this.sources.filter((item) => item !== source);
        if (!this.sources.length && !this.pending.length && !this.decoding) this.onAudibleChange(false);
      };
    }
    this.onAudibleChange(true);
  }

  stopAll() {
    this.stopped = true;
    this.pending = [];
    this.pendingBytes = [];
    this.nextStart = 0;
    for (const source of this.sources) { try { source.stop(); } catch { /* 已停止 */ } }
    this.sources = [];
    this.onAudibleChange(false);
  }
}

// 采集管线：AEC 约束取流 → ScriptProcessor(4096) 实时 PCM（Safari 全兼容）
// → 线性降采样 16k → 能量/VAD 判定交给 onEnergy 回调（返回指令）。
// 缓冲桶始终累积（封顶 12 秒预录，丢最旧）：免提模式下打断后的语音开头
// 不会因回合尚未建立而丢失；uploading 开启后按 2 秒自封 WAV 顺序上传。
export class MicPipeline {
  constructor({ context, onChunk, onEnergy }) {
    this.context = context;
    this.onChunk = onChunk;
    this.onEnergy = onEnergy;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.bucket = [];
    this.uploading = false;
    this.speaking = false;
    this.silenceMs = 0;
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
    this.lastRms = rms; // 诊断暴露：免提触发失败时可直接读实时能量
    const now = performance.now();
    // 静默计时（供断句）：桶内样本数即本块时长。
    const loud = rms >= CALL_VAD_SPEAK_THRESHOLD;
    if (loud) { this.speaking = true; this.silenceMs = 0; }
    else if (this.speaking) this.silenceMs += (samples.length / CALL_SAMPLE_RATE) * 1000;
    this.onEnergy(rms, now);
    // 常开缓冲：无论是否在回合内都累积（预录），封顶丢最旧。
    this.bucket.push(samples);
    let bucketLength = this.bucket.reduce((sum, item) => sum + item.length, 0);
    const maxSamples = CALL_SAMPLE_RATE * (CALL_MAX_PRE_ROLL_MS / 1000);
    while (bucketLength > maxSamples && this.bucket.length > 1) {
      bucketLength -= this.bucket[0].length;
      this.bucket.shift();
    }
    if (!this.uploading) return;
    while (bucketLength >= CALL_CHUNK_SAMPLES) {
      const [chunk, rest] = this.takeBucket(CALL_CHUNK_SAMPLES);
      this.onChunk(encodePcm16Wav(chunk, CALL_SAMPLE_RATE));
      this.bucket = rest;
      bucketLength -= chunk.length;
    }
  }

  takeBucket(samplesWanted) {
    const merged = new Float32Array(samplesWanted);
    let offset = 0;
    let rest = [];
    let remaining = samplesWanted;
    for (const item of this.bucket) {
      if (remaining <= 0) { rest.push(item); continue; }
      if (item.length <= remaining) {
        merged.set(item, offset); offset += item.length; remaining -= item.length;
      } else {
        merged.set(item.subarray(0, remaining), offset);
        rest.push(item.subarray(remaining));
        remaining = 0;
      }
    }
    return [merged, rest];
  }

  // 断句收尾：把不满 2 秒的余量作为最后一块上传（服务端按块校验）。
  flushRemainder() {
    if (!this.bucket.length) return;
    const length = this.bucket.reduce((sum, item) => sum + item.length, 0);
    const [chunk] = this.takeBucket(length);
    this.onChunk(encodePcm16Wav(chunk, CALL_SAMPLE_RATE));
    this.bucket = [];
  }

  stop() {
    try { this.processor?.disconnect(); this.source?.disconnect(); } catch { /* 已断开 */ }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.processor = null; this.source = null; this.stream = null;
  }

  setUploading(value) { this.uploading = value; }
}

// 通话会话客户端：接通即免提。UI 通过 onEvent 拿状态，本类不触碰 DOM。
export class CallSessionClient {
  constructor({ apiBase = '', authHeaders, conversationId, onEvent = () => {} }) {
    this.apiBase = apiBase;
    this.authHeaders = authHeaders;
    this.conversationId = conversationId;
    this.onEvent = onEvent;
    this.call = null;
    this.phase = 'idle';
    this.muted = false;
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
    this.speakSince = 0;
    this.startingTurn = false;
    this.finishingTurn = false;
    this.reconciling = false;
    this.micStartTime = null;
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
    const payload = await this.request(`/conversations/${encodeURIComponent(this.conversationId)}/calls`, { method: 'POST', body: JSON.stringify({}) });
    this.call = payload.call;
    this.emit({ type: 'started', call: this.call, greetingText: payload.greeting?.text ?? '' });
    this.startWatchdog();
    // 常开麦：接通即聆听（免提核心）。问候也允许直接打断。
    this.mic = new MicPipeline({
      context: this.context,
      onChunk: (wavBuffer) => this.uploadChunk(wavBuffer),
      onEnergy: (rms, now) => this.handleEnergy(rms, now)
    });
    await this.mic.start();
    this.setPhase('greeting');
    // 问候语音失败（额度/供应商/网络）不阻塞通话：流结束（含失败）即进入聆听态。
    this.playTurnStream(payload.greeting?.stream?.stream_url, { greeting: true })
      .catch(() => {})
      .then(() => { if (this.phase === 'greeting') this.markReady(); });
    return this.call;
  }

  // ---- 能量判定（免提状态机核心，MicPipeline 每个处理块回调一次）----

  handleEnergy(rms, now) {
    if (this.muted || this.phase === 'ended') return;
    const audible = this.audioOut?.audible;

    // AI 播报中：持续高能量 = 打断（冷却期内忽略，防 AEC 残留循环）。
    if ((this.phase === 'responding' || this.phase === 'greeting') && audible) {
      if (rms >= CALL_BARGE_IN_THRESHOLD && now >= this.barrierUntil) {
        if (!this.highEnergySince) this.highEnergySince = now;
        if (now - this.highEnergySince >= CALL_BARGE_IN_HOLD_MS) {
          this.highEnergySince = 0;
          this.speakSince = now; // 打断的话音立刻进入起说计时
          this.bargeIn();
        }
      } else {
        this.highEnergySince = 0;
      }
      return;
    }
    this.highEnergySince = 0;

    // 聆听态：持续起说能量自动开回合（打断后由冷却期稍作延迟，语音开头在预录里）。
    if (this.phase === 'ready' && !this.startingTurn) {
      if (rms >= CALL_VAD_SPEAK_THRESHOLD) {
        if (!this.speakSince) this.speakSince = now;
        if (now - this.speakSince >= CALL_AUTO_START_MS && now >= this.barrierUntil) {
          this.speakSince = 0;
          this.startTurn().catch((error) => { this.lastTurnError = error?.message ?? String(error); /* 起说失败静默重试：下一口说话再触发 */ });
        }
      } else {
        this.speakSince = 0;
      }
      return;
    }

    // 说话中：静默自动断句；50 秒强制断句。
    if (this.phase === 'recording' && !this.finishingTurn && this.mic) {
      if (this.mic.silenceMs >= CALL_VAD_SILENCE_MS && this.mic.speaking) { this.finishTurn().catch(() => {}); return; }
      if (this.micStartTime && now - this.micStartTime >= CALL_MAX_UTTERANCE_MS) { this.finishTurn().catch(() => {}); }
    }
  }

  // ---- 说话回合 ----

  async startTurn() {
    if (this.phase !== 'ready' || this.startingTurn || performance.now() < this.barrierUntil) return;
    this.startingTurn = true;
    try {
      const payload = await this.request(`/calls/${encodeURIComponent(this.call.call_id)}/turns`, { method: 'POST', body: JSON.stringify({}) });
      this.turn = payload.turn;
      if (!this.turn) throw Object.assign(new Error('回合创建响应缺少 turn'), { code: 'CALL_TURN_RESPONSE_INVALID' });
      this.chunkIndex = 0;
      this.micStartTime = performance.now();
      this.speaking = false;
      this.setPhase('recording');
      this.emit({ type: 'turn', turn: this.turn });
      this.mic.setUploading(true); // 预录里的语音开头随首块上传
    } finally {
      this.startingTurn = false;
    }
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

  async finishTurn() {
    if (this.phase !== 'recording' || !this.turn || this.finishingTurn) return;
    this.finishingTurn = true;
    try {
      const turnId = this.turn.turn_id;
      this.mic?.setUploading(false);
      this.mic?.flushRemainder();
      await this.uploadChain.catch(() => {});
      if (!this.turn || this.turn.turn_id !== turnId) return;
      this.micStartTime = null;
      this.speaking = false;
      this.setPhase('responding');
      const payload = await this.request(`/calls/${encodeURIComponent(this.call.call_id)}/turns/${encodeURIComponent(turnId)}/finalize`, { method: 'POST', body: JSON.stringify({}) });
      this.emit({ type: 'turn-finalized', turn: payload.turn });
      this.lastEventAt = Date.now();
      await this.playTurnStream(payload.stream?.stream_url, {});
    } finally {
      this.finishingTurn = false;
    }
  }

  // ---- 静音 ----

  setMuted(value) {
    if (this.muted === value) return;
    this.muted = value;
    this.emit({ type: 'muted', muted: value });
    if (value) {
      // 静音 = 说完了：结束进行中的回合并停止聆听（不再自动开回合/打断）。
      this.speakSince = 0;
      if (this.phase === 'recording') this.finishTurn().catch((error) => { this.lastTurnError = error?.message ?? String(error); });
    } else {
      this.barrierUntil = performance.now() + 300; // 取消静音后短暂冷却，防麦克风声学冲击误触发
    }
  }

  // ---- 回合 SSE（音频只进播放管线；服务端仍发字幕事件，客户端不展示）----

  async playTurnStream(streamUrl, { greeting = false }) {
    if (this.audioOut) this.audioOut.stopped = false; // 打断后新回合恢复可播
    this.turnAbort = new AbortController();
    // 服务端返回的 stream_url 以根路径开头（/api/v1/...）：不要重复拼 apiBase。
    const streamPath = String(streamUrl || '').startsWith(`${this.apiBase}/`) || /^https?:\/\//.test(streamUrl)
      ? streamUrl
      : `${this.apiBase}${streamUrl}`;
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

  // 停播 + 中止 SSE（服务端断开即中止 LLM/TTS，已播出部分按 INTERRUPTED 结算）。
  // 打断后处于聆听态：正在说的话由免提状态机自动开新回合（预录不丢开头）。
  bargeIn() {
    if (performance.now() < this.barrierUntil) return;
    this.barrierUntil = performance.now() + CALL_BARGE_IN_COOLDOWN_MS;
    this.mic?.setUploading(false);
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
