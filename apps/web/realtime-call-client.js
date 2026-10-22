'use strict';

import { MicPipeline, RealtimePcmPlayer, CALL_VAD_SPEAK_THRESHOLD, CALL_BARGE_IN_THRESHOLD } from './call-client.js';

const id = () => globalThis.crypto.randomUUID();
function decode(value) {
  if (typeof value !== 'string' || value.length > 1_500_000) throw new Error('实时音频格式无效');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

// One server-bounded native session; transient upload backpressure never creates paid retries.
export class RealtimeCallClient {
  constructor({ apiBase = '', authHeaders, conversationId, prepareConversation, onEvent = () => {}, fetchImpl = (...args) => globalThis.fetch(...args),
    contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(),
    micFactory = (options) => new MicPipeline(options), playerFactory = (context) => new RealtimePcmPlayer(context),
    socketFactory = (url, protocols) => new WebSocket(url, protocols) }) {
    Object.assign(this, { apiBase, authHeaders, conversationId, prepareConversation, onEvent, fetchImpl, contextFactory, micFactory, playerFactory, socketFactory });
    this.phase = 'idle'; this.muted = false; this.sequence = 0;
    this.closed = false; this.epoch = 0; this.blockedReplies = new Set(); this.questionId = null;
    this.replyId = null; this.lastSpeechAt = null; this.firstScheduled = new Set(); this.highSince = null;
    this.lastTurnTiming = null; this.endPromise = null; this.segments = new Map(); this.ackSequence = 0;
    this.uploadQueue = []; this.uploadBytes = 0; this.inflight = new Map(); this.inflightBytes = 0;
  }
  emit(event) { this.onEvent(event); }
  setPhase(phase) { this.phase = phase; this.emit({ type: 'phase', phase }); }
  headers(json = false) { return { ...this.authHeaders(), ...(json ? { 'content-type': 'application/json', 'idempotency-key': id() } : {}) }; }
  async request(path, body, signal = this.abort?.signal) {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body), signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || '实时语音请求失败'), { code: payload?.error?.code, status: response.status });
    return payload;
  }
  async start() {
    if (this.phase !== 'idle') throw new Error('通话已经启动');
    this.setPhase('ringing'); this.abort = new AbortController(); const epoch = ++this.epoch;
    try {
      this.context = this.contextFactory(); await this.context.resume();
      this.player = this.playerFactory(this.context);
      // Unlock audio in the tap handler before asynchronous conversation creation.
      // Preparing an empty conversation never sends text or opens a provider session.
      if (this.prepareConversation) this.conversationId = await this.prepareConversation();
      if (this.closed || epoch !== this.epoch) return null;
      if (!this.conversationId) throw new Error('语音会话准备失败，请重试。');
      const result = await this.request(`/conversations/${encodeURIComponent(this.conversationId)}/realtime-calls`, {});
      this.sessionId = result.session_id;
      if (!this.sessionId || !result.stream_url) throw new Error('实时语音会话响应无效');
      this.call = { call_id: this.sessionId, session_id: this.sessionId, mode: 'native_realtime', started_at: new Date().toISOString(), max_duration_ms: result.max_duration_ms };
      if (this.closed || epoch !== this.epoch) { await this.endRemoteSession(); return this.call; }
      this.emit({ type: 'started', call: this.call, greetingText: '' });
      const ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
      this.readyTimer = setTimeout(() => this.fail(new Error('实时通话连接超时')), 15_000);
      // The server owns duration/budget termination; no competing client 60-second cap.
      this.maxDurationMs = result.max_duration_ms;
      this.streamTask = this.stream(result.stream_url, epoch).catch((error) => this.fail(error));
      await ready;
      if (this.closed || epoch !== this.epoch) return this.call;
      await this.openAudioSocket(result, epoch);
      if (this.closed || epoch !== this.epoch) return this.call;
      this.mic = this.micFactory({ context: this.context, chunkMs: 100, rawPcm: true,
        onChunk: (bytes) => this.uploadChunk(bytes), onEnergy: (rms, now) => this.handleEnergy(rms, now) });
      await this.mic.start();
      if (this.closed || epoch !== this.epoch) { this.mic.stop(); return this.call; }
      this.mic.bucket = []; this.mic.setUploading(true); this.setPhase('ready');
      return this.call;
    } catch (error) { this.fail(error); throw error; }
  }
  async openAudioSocket(result, epoch) {
    if (result.audio_socket_protocol !== 'qiyu-realtime-v1' || typeof result.audio_socket_ticket !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(result.audio_socket_ticket) || typeof result.audio_socket_url !== 'string' || !result.audio_socket_url.startsWith('/api/v1/realtime-calls/')) throw new Error('实时语音上传连接无效');
    const page = new URL(globalThis.location.href);
    const url = new URL(result.audio_socket_url, page);
    if (url.origin !== page.origin || url.search || url.hash) throw new Error('实时语音上传连接无效');
    url.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socketFactory(url.href, ['qiyu-realtime-v1', `ticket.${result.audio_socket_ticket}`]);
    this.audioSocket = socket;
    return new Promise((resolve, reject) => {
      this.audioReject = reject;
      this.socketTimer = setTimeout(() => this.fail(new Error('实时音频连接超时')), 5000);
      socket.onopen = () => {
        clearTimeout(this.socketTimer);
        if (this.closed || epoch !== this.epoch) { socket.close(); reject(new Error('通话已结束')); return; }
        this.audioReject = null; resolve();
      };
      socket.onmessage = (event) => {
        if (this.closed || epoch !== this.epoch) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type !== 'audio.ack' || !Number.isInteger(data.next_sequence) || data.next_sequence < this.ackSequence || data.next_sequence > this.sequence) throw new Error('实时音频确认无效');
          this.ackSequence = data.next_sequence;
          for (const [sequence, length] of this.inflight) {
            if (sequence < this.ackSequence) { this.inflightBytes -= length; this.inflight.delete(sequence); }
          }
          this.flushUploads();
        } catch { this.fail(new Error('实时音频确认无效')); }
      };
      socket.onerror = () => { if (!this.closed) this.fail(new Error('实时音频连接失败')); };
      socket.onclose = () => { if (!this.closed) this.fail(new Error('实时音频连接已断开')); };
    });
  }
  async stream(path, epoch) {
    // Only same-origin API URLs are accepted; never forward auth to a provider URL.
    if (!path.startsWith('/api/v1/realtime-calls/') && !path.startsWith('/realtime-calls/')) throw new Error('实时通话地址无效');
    const url = path.startsWith('/api/v1/') ? path : `${this.apiBase}${path}`;
    const response = await this.fetchImpl(url, { headers: this.headers(), signal: this.abort.signal });
    if (!response.ok || !response.body) throw new Error('实时通话连接失败');
    const reader = response.body.getReader(); this.reader = reader; const decoder = new TextDecoder(); let pending = '';
    try {
      while (!this.closed && epoch === this.epoch) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        if (pending.length > 2_000_000) throw new Error('实时通话数据超过限制');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (event && data && !this.closed && epoch === this.epoch) this.handleEvent(event, JSON.parse(data));
        }
      }
      if (!this.closed && epoch === this.epoch) throw new Error('实时通话连接已断开');
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock?.(); }
  }
  handleEvent(type, data) {
    if (this.closed) return;
    if (type === 'realtime.input-skipped') {
      if (data.code !== 'ASR_UNCONFIRMED' || typeof data.question_id !== 'string' || !data.question_id) throw new Error('实时识别状态无效');
      if (data.question_id !== this.questionId) return;
      if (this.replyId) this.blockedReplies.add(this.replyId);
      this.stopPlayback(); this.replyId = null; this.questionId = null; this.setPhase('ready');
      this.emit({ type: 'turn-failed', code: data.code, message: '刚才那句没听清，请再说一次。' });
      return;
    }
    if (type === 'realtime.response-rejected') {
      if (data.code !== 'OOC_RELATIONSHIP_CONFLICT' || typeof data.question_id !== 'string' || !data.question_id || typeof data.reply_id !== 'string' || !data.reply_id) throw new Error('实时回复状态无效');
      if (data.question_id !== this.questionId) return;
      this.blockedReplies.add(data.reply_id);
      this.stopPlayback(); this.replyId = null; this.setPhase('ready');
      this.emit({ type: 'turn-failed', code: data.code, message: '这句关系表达有误，已停止播放；你可以继续说。' });
      return;
    }
    if (type === 'realtime.ready') { clearTimeout(this.readyTimer); this.readyResolve?.(); this.readyResolve = null; this.readyReject = null; return; }
    if (type === 'realtime.speech-start' || type === 'realtime.interrupt') {
      if (data.question_id && this.questionId === data.question_id) return;
      if (this.replyId) this.blockedReplies.add(this.replyId);
      this.stopPlayback(); this.questionId = data.question_id; this.replyId = null;
      this.segments.clear();
      this.setPhase('recording'); return;
    }
    if (type === 'realtime.transcript') { this.emit({ type: 'text', role: data.role, text: data.text }); return; }
    if (type === 'realtime.text') {
      if (this.blockedReplies.has(data.reply_id)) return;
      if (!data.question_id || data.question_id !== this.questionId || !data.reply_id || !data.segment_id || typeof data.text !== 'string') throw new Error('实时字幕关联无效');
      this.segments.set(data.segment_id, { replyId: data.reply_id, questionId: data.question_id });
      this.replyId = data.reply_id; this.emit({ type: 'text', role: 'assistant', text: data.text }); return;
    }
    if (type === 'realtime.audio') {
      if (this.blockedReplies.has(data.reply_id) || (data.question_id && data.question_id !== this.questionId)) return;
      const segment = this.segments.get(data.segment_id);
      if (!data.ai_generated || data.format !== 'pcm_s16le' || data.sample_rate !== 24000 || !segment || segment.replyId !== data.reply_id || segment.questionId !== data.question_id) throw new Error('实时音频缺少已审核字幕关联');
      this.replyId = data.reply_id;
      const bytes = decode(data.audio_base64);
      const when = this.player.enqueue(bytes, data.sample_rate);
      clearTimeout(this.playbackTimer);
      this.playbackTimer = setTimeout(() => {
        if (!this.closed && this.phase === 'responding') { this.emit({ type: 'audible', audible: false }); this.setPhase('ready'); }
      }, Math.max(0, when - this.context.currentTime + bytes.length / 48000) * 1000);
      this.setPhase('responding'); this.emit({ type: 'audible', audible: true });
      if (!this.firstScheduled.has(data.reply_id)) {
        this.firstScheduled.add(data.reply_id);
        const now = performance.now(); const delay = Math.max(0, when - this.context.currentTime) * 1000;
        this.lastTurnTiming = { mode: 'native_realtime', replyId: data.reply_id,
          firstScheduledMs: this.lastSpeechAt === null ? null : Math.round(now - this.lastSpeechAt + delay),
          measurement: 'last_local_energy_to_audio_source_schedule', acousticOnsetVerified: false };
        this.emit({ type: 'turn-timing', timing: this.lastTurnTiming });
        if (typeof window !== 'undefined') window.__qiyuRealtimeTurnTiming = this.lastTurnTiming;
      }
      return;
    }
    if (type === 'realtime.response-complete' || type === 'realtime.response-completed') { this.emit({ type: 'response-complete', replyId: data.reply_id }); return; }
    if (type === 'realtime.closed') { if (this.call) this.call.end_reason = data.reason; this.emit({ type: 'closed', reason: data.reason }); this.end(); }
  }
  handleEnergy(rms, now) {
    if (this.closed || this.muted) return;
    if (rms >= CALL_VAD_SPEAK_THRESHOLD) this.lastSpeechAt = performance.now();
    if (this.phase === 'responding' && rms >= CALL_BARGE_IN_THRESHOLD) {
      this.highSince ??= now;
      if (now - this.highSince >= 150) {
        if (this.replyId) this.blockedReplies.add(this.replyId);
        this.stopPlayback(); this.highSince = null; this.setPhase('recording');
        this.emit({ type: 'barge-in' });
      }
    } else this.highSince = null;
  }
  stopPlayback() { clearTimeout(this.playbackTimer); this.player?.stop(); if (this.context && !this.closed) this.player = this.playerFactory(this.context); this.emit({ type: 'audible', audible: false }); }
  uploadChunk(value) {
    if (this.closed) return;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (!bytes.length || bytes.length % 2 || bytes.length > 6400) { this.fail(new Error('实时音频格式无效')); return; }
    if (!this.audioSocket || this.audioSocket.readyState !== 1) { this.fail(new Error('实时音频连接已断开，请重新拨打')); return; }
    // At 16kHz mono PCM, 96kB bounds all unacknowledged + waiting audio to 3s.
    // Never drop or replay ambiguous speech and never open an automatic paid reconnect.
    if (this.uploadBytes + this.inflightBytes + bytes.length > 96000) { this.fail(new Error('网络持续拥塞，通话已结束，请网络恢复后重新拨打')); return; }
    this.uploadQueue.push({ bytes: bytes.slice(), queuedAt: performance.now() }); this.uploadBytes += bytes.length;
    this.flushUploads();
  }
  flushUploads() {
    clearTimeout(this.uploadTimer);
    if (this.closed) return;
    try {
      while (this.uploadQueue.length && this.audioSocket?.readyState === 1 && this.audioSocket.bufferedAmount <= 32000 && this.inflightBytes < 64000) {
        const { bytes } = this.uploadQueue.shift(); this.uploadBytes -= bytes.length;
        const frame = new Uint8Array(4 + bytes.length); new DataView(frame.buffer).setUint32(0, this.sequence, false); frame.set(bytes, 4);
        this.inflight.set(this.sequence, bytes.length); this.inflightBytes += bytes.length;
        this.audioSocket.send(frame); this.sequence++;
      }
      if (this.uploadQueue.length) {
        if (performance.now() - this.uploadQueue[0].queuedAt > 3000) { this.fail(new Error('网络持续拥塞，通话已结束，请网络恢复后重新拨打')); return; }
        this.uploadTimer = setTimeout(() => this.flushUploads(), 25);
      }
    } catch (error) { this.fail(error); }
  }
  toggleMute() {
    this.muted = !this.muted;
    for (const track of this.mic?.stream?.getAudioTracks?.() || []) track.enabled = !this.muted;
    if (this.mic) this.mic.bucket = [];
    this.emit({ type: 'muted', muted: this.muted }); return this.muted;
  }
  setMuted(value) { if (this.muted !== Boolean(value)) this.toggleMute(); return this.muted; }
  hangup() { return this.end(); }
  fail(error) {
    if (this.closed) return;
    this.readyReject?.(error); this.readyReject = null;
    this.emit({ type: 'error', message: error.message || '实时通话已结束', code: error.code }); this.end();
  }
  async end() {
    if (this.endPromise) return this.endPromise;
    if (this.closed) return;
    this.closed = true; ++this.epoch; clearTimeout(this.readyTimer); clearTimeout(this.uploadTimer); clearTimeout(this.playbackTimer); clearTimeout(this.socketTimer);
    this.readyReject?.(new Error('实时通话已结束')); this.readyReject = null;
    this.audioReject?.(new Error('实时通话已结束')); this.audioReject = null; this.audioSocket?.close();
    this.mic?.stop(); this.player?.stop(); this.abort?.abort(); this.segments.clear();
    this.uploadQueue = []; this.uploadBytes = 0; this.inflight.clear(); this.inflightBytes = 0;
    this.setPhase('ended'); this.emit({ type: 'audible', audible: false }); this.emit({ type: 'ended', call: this.call });
    this.endPromise = (async () => {
      try { await this.context?.close(); } catch {}
      await this.endRemoteSession();
      return this.call;
    })();
    return this.endPromise;
  }
  async endRemoteSession() {
    if (!this.sessionId) return;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
    try { await this.request(`/realtime-calls/${encodeURIComponent(this.sessionId)}/end`, {}, controller.signal); }
    catch (error) { this.emit({ type: 'settlement-error', message: '通话已关闭，结束状态等待服务端确认', code: error.code }); }
    finally { clearTimeout(timer); }
  }
  destroy() { return this.end(); }
}
