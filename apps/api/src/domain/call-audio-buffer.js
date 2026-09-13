'use strict';

// 通话上行音频的进程内缓冲（边录边传的接收端）。
// 合规口径：通话用户音频只进进程内存、永不落对象存储；ASR 转写完成
// （consume）或超时（sweep）即彻底丢弃——比异步语音「落桶后删」更严格，
// 因此通话链路不创建 ASR_INPUT_AUDIO 资产，retention-worker 无需感知。
// 单实例部署假设：进程级注册表（与 streamTokens 同口径），不跨实例共享。

const CALL_AUDIO_MAX_TURN_BYTES = 2_000_000; // 对齐腾讯一句话识别 2MB 上限（16k PCM16 ≈ 62s 触顶）
const CALL_AUDIO_MAX_TURN_CHUNKS = 60;
const CALL_AUDIO_MAX_CHUNK_BYTES = 256 * 1024; // 客户端按 ~64KB 分块，此为硬上限
const CALL_AUDIO_PROCESS_MAX_BYTES = 32 * 1024 * 1024; // 进程总缓冲兜底
const CALL_AUDIO_TTL_MS = 5 * 60 * 1000; // 未 finalize 的回合缓冲丢弃时限

class CallAudioBufferError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    // 上限类错误直接对应 413，路由层不再翻译。
    this.status = code === 'CALL_AUDIO_TURN_LIMIT' || code === 'CALL_AUDIO_PROCESS_LIMIT' ? 413 : 409;
  }
}

class CallAudioBufferRegistry {
  constructor({ maxTurnBytes = CALL_AUDIO_MAX_TURN_BYTES, maxTurnChunks = CALL_AUDIO_MAX_TURN_CHUNKS, maxChunkBytes = CALL_AUDIO_MAX_CHUNK_BYTES, processMaxBytes = CALL_AUDIO_PROCESS_MAX_BYTES, ttlMs = CALL_AUDIO_TTL_MS, now = () => Date.now() } = {}) {
    this.maxTurnBytes = maxTurnBytes;
    this.maxTurnChunks = maxTurnChunks;
    this.maxChunkBytes = maxChunkBytes;
    this.processMaxBytes = processMaxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.buffers = new Map(); // turnId → { chunks: Buffer[], totalBytes, closed, createdAt, closedAt }
    this.processBytes = 0;
  }

  processBytesUsed() { return this.processBytes; }

  // finalize 之前创建缓冲；重复创建视为协议错（回合创建与缓冲一一对应）。
  createBuffer(turnId) {
    requireTurnId(turnId);
    if (this.buffers.has(turnId)) throw new CallAudioBufferError('CALL_AUDIO_BUFFER_EXISTS', '回合音频缓冲已存在');
    this.buffers.set(turnId, { chunks: [], totalBytes: 0, closed: false, createdAt: this.now(), closedAt: null });
    return { turn_id: turnId, received_bytes: 0, chunks: 0 };
  }

  // 块序号从 0 连续递增（HTTP 逐块上传，乱序/缺块即拒绝，不做重排）。
  appendChunk(turnId, { chunkIndex, bytes }) {
    const buffer = this.bufferFor(turnId);
    if (buffer.closed) throw new CallAudioBufferError('CALL_AUDIO_BUFFER_CLOSED', '回合音频已封账，不能再上传');
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new CallAudioBufferError('CALL_AUDIO_CHUNK_INVALID', '音频块序号无效');
    }
    if (chunkIndex !== buffer.chunks.length) {
      throw new CallAudioBufferError('CALL_AUDIO_CHUNK_OUT_OF_ORDER', `音频块序号不连续，期望 ${buffer.chunks.length}`, { expected_index: buffer.chunks.length });
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new CallAudioBufferError('CALL_AUDIO_CHUNK_INVALID', '音频块内容无效');
    }
    if (bytes.length > this.maxChunkBytes) {
      throw new CallAudioBufferError('CALL_AUDIO_CHUNK_INVALID', '单个音频块超过大小上限', { max_chunk_bytes: this.maxChunkBytes });
    }
    if (buffer.chunks.length + 1 > this.maxTurnChunks) {
      throw new CallAudioBufferError('CALL_AUDIO_TURN_LIMIT', '回合音频块数已达上限', { max_chunks: this.maxTurnChunks });
    }
    if (buffer.totalBytes + bytes.length > this.maxTurnBytes) {
      throw new CallAudioBufferError('CALL_AUDIO_TURN_LIMIT', '回合音频总大小已达上限，请缩短单次发言', { max_total_bytes: this.maxTurnBytes });
    }
    if (this.processBytes + bytes.length > this.processMaxBytes) {
      throw new CallAudioBufferError('CALL_AUDIO_PROCESS_LIMIT', '服务通话音频缓冲已达总量上限，请稍后再试');
    }
    buffer.chunks.push(bytes);
    buffer.totalBytes += bytes.length;
    this.processBytes += bytes.length;
    return { turn_id: turnId, received_bytes: buffer.totalBytes, chunks: buffer.chunks.length };
  }

  // finalize：封账并返回完整音频（ASR 仍整段送审/识别）。缓冲保留到
  // consume/discard，供 SSE produce 消费。
  seal(turnId) {
    const buffer = this.bufferFor(turnId);
    if (buffer.closed) throw new CallAudioBufferError('CALL_AUDIO_BUFFER_CLOSED', '回合音频已封账');
    buffer.closed = true;
    buffer.closedAt = this.now();
    return { turn_id: turnId, audio: Buffer.concat(buffer.chunks), total_bytes: buffer.totalBytes, chunk_count: buffer.chunks.length };
  }

  // SSE produce 取走音频（转写完成后调用方负责立即 consume 丢弃）。
  consume(turnId) {
    const sealed = this.sealed(turnId);
    this.discard(turnId);
    return sealed;
  }

  discard(turnId) {
    const buffer = this.buffers.get(turnId);
    if (!buffer) return false;
    this.processBytes -= buffer.totalBytes;
    this.buffers.delete(turnId);
    return true;
  }

  // 超时清扫：创建后 TTL 内未 finalize 即整段丢弃（客户端崩溃兜底）。
  sweepExpired() {
    const discarded = [];
    const nowMs = this.now();
    for (const [turnId, buffer] of [...this.buffers.entries()]) {
      const referenceMs = buffer.closedAt ?? buffer.createdAt;
      if (nowMs - referenceMs > this.ttlMs) {
        this.discard(turnId);
        discarded.push({ turn_id: turnId, total_bytes: buffer.totalBytes });
      }
    }
    return discarded;
  }

  sealed(turnId) {
    const buffer = this.bufferFor(turnId);
    if (!buffer.closed) throw new CallAudioBufferError('CALL_AUDIO_BUFFER_OPEN', '回合音频尚未封账');
    return { turn_id: turnId, audio: Buffer.concat(buffer.chunks), total_bytes: buffer.totalBytes, chunk_count: buffer.chunks.length };
  }

  bufferFor(turnId) {
    requireTurnId(turnId);
    const buffer = this.buffers.get(turnId);
    if (!buffer) throw new CallAudioBufferError('CALL_AUDIO_BUFFER_NOT_FOUND', '回合音频缓冲不存在或已丢弃');
    return buffer;
  }
}

function requireTurnId(turnId) {
  if (typeof turnId !== 'string' || !turnId.trim()) throw new CallAudioBufferError('VALIDATION_ERROR', 'turnId 不能为空');
}

module.exports = {
  CALL_AUDIO_MAX_TURN_BYTES,
  CALL_AUDIO_MAX_TURN_CHUNKS,
  CALL_AUDIO_MAX_CHUNK_BYTES,
  CALL_AUDIO_PROCESS_MAX_BYTES,
  CALL_AUDIO_TTL_MS,
  CallAudioBufferError,
  CallAudioBufferRegistry
};
