'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CALL_AUDIO_MAX_TURN_BYTES,
  CallAudioBufferError,
  CallAudioBufferRegistry
} = require('../src/domain/call-audio-buffer');

function chunk(size, fill = 0x61) { return Buffer.alloc(size, fill); }

test('边录边传接收：块序号必须从 0 连续递增，乱序即拒绝', () => {
  const registry = new CallAudioBufferRegistry();
  registry.createBuffer('callturn_000001');
  assert.deepEqual(registry.appendChunk('callturn_000001', { chunkIndex: 0, bytes: chunk(10) }), { turn_id: 'callturn_000001', received_bytes: 10, chunks: 1 });
  assert.throws(() => registry.appendChunk('callturn_000001', { chunkIndex: 2, bytes: chunk(10) }),
    (error) => error instanceof CallAudioBufferError && error.code === 'CALL_AUDIO_CHUNK_OUT_OF_ORDER' && error.details.expected_index === 1);
  assert.throws(() => registry.appendChunk('callturn_000001', { chunkIndex: -1, bytes: chunk(10) }),
    (error) => error.code === 'CALL_AUDIO_CHUNK_INVALID');
  assert.throws(() => registry.appendChunk('callturn_000001', { chunkIndex: 1, bytes: Buffer.alloc(0) }),
    (error) => error.code === 'CALL_AUDIO_CHUNK_INVALID');
});

test('封账后不可再传；consume 返回完整音频并立即释放缓冲', () => {
  const registry = new CallAudioBufferRegistry();
  registry.createBuffer('callturn_000001');
  registry.appendChunk('callturn_000001', { chunkIndex: 0, bytes: chunk(4, 1) });
  registry.appendChunk('callturn_000001', { chunkIndex: 1, bytes: chunk(6, 2) });
  registry.seal('callturn_000001');
  const sealed = registry.consume('callturn_000001');
  assert.equal(sealed.total_bytes, 10);
  assert.equal(sealed.chunk_count, 2);
  assert.deepEqual(sealed.audio, Buffer.concat([chunk(4, 1), chunk(6, 2)]));
  assert.equal(registry.processBytesUsed(), 0);
  assert.throws(() => registry.bufferFor('callturn_000001'), (error) => error.code === 'CALL_AUDIO_BUFFER_NOT_FOUND');
  // consume 之后重复取：缓冲已丢弃（转写后即弃的合规语义）。
  assert.throws(() => registry.sealed('callturn_000001'), (error) => error.code === 'CALL_AUDIO_BUFFER_NOT_FOUND');
});

test('seal 后继续上传被拒；seal 不消费缓冲，SSE produce 仍可 consume', () => {
  const registry = new CallAudioBufferRegistry();
  registry.createBuffer('callturn_000001');
  registry.appendChunk('callturn_000001', { chunkIndex: 0, bytes: chunk(10) });
  const sealed = registry.seal('callturn_000001');
  assert.equal(sealed.total_bytes, 10);
  assert.throws(() => registry.appendChunk('callturn_000001', { chunkIndex: 1, bytes: chunk(10) }),
    (error) => error.code === 'CALL_AUDIO_BUFFER_CLOSED');
  const consumed = registry.consume('callturn_000001');
  assert.equal(consumed.total_bytes, 10);
  assert.equal(registry.processBytesUsed(), 0);
});

test('三层上限：单回合字节、单回合块数、进程总量各自硬拒（413）', () => {
  const small = new CallAudioBufferRegistry({ maxTurnBytes: 100, maxTurnChunks: 2, processMaxBytes: 150 });
  small.createBuffer('callturn_000001');
  small.appendChunk('callturn_000001', { chunkIndex: 0, bytes: chunk(60) });
  // 单回合总字节：60+50 > 100
  assert.throws(() => small.appendChunk('callturn_000001', { chunkIndex: 1, bytes: chunk(50) }),
    (error) => error.code === 'CALL_AUDIO_TURN_LIMIT' && error.status === 413);
  // 单回合块数：已达 2 上限（第一块之后本块是第 2 块，允许；第 3 块拒）
  assert.equal(small.appendChunk('callturn_000001', { chunkIndex: 1, bytes: chunk(30) }).chunks, 2);
  // 进程总量：另一回合 100+60+30 已用 90，再收 70 > 150
  small.createBuffer('callturn_000002');
  assert.throws(() => small.appendChunk('callturn_000002', { chunkIndex: 0, bytes: chunk(70) }),
    (error) => error.code === 'CALL_AUDIO_PROCESS_LIMIT' && error.status === 413);
  // 单块硬上限
  const chunkLimited = new CallAudioBufferRegistry({ maxChunkBytes: 16 });
  chunkLimited.createBuffer('callturn_000003');
  assert.throws(() => chunkLimited.appendChunk('callturn_000003', { chunkIndex: 0, bytes: chunk(17) }),
    (error) => error.code === 'CALL_AUDIO_CHUNK_INVALID');
});

test('默认单回合上限对齐腾讯 ASR 2MB：触顶即拒', () => {
  const registry = new CallAudioBufferRegistry();
  registry.createBuffer('callturn_000001');
  // 单块先受 256KB 块上限约束，回合总上限用多块触顶（7×256KB 允许，第 8 块越线）。
  assert.throws(() => registry.appendChunk('callturn_000001', { chunkIndex: 0, bytes: chunk(CALL_AUDIO_MAX_TURN_BYTES + 1) }),
    (error) => error.code === 'CALL_AUDIO_CHUNK_INVALID');
  const maxChunk = 256 * 1024;
  for (let index = 0; index < 7; index += 1) registry.appendChunk('callturn_000001', { chunkIndex: index, bytes: chunk(maxChunk) });
  assert.throws(() => registry.appendChunk('callturn_000001', { chunkIndex: 7, bytes: chunk(maxChunk) }),
    (error) => error.code === 'CALL_AUDIO_TURN_LIMIT');
});

test('TTL 清扫：封账或创建超过时限未消费即整段丢弃，字节账同步回收', () => {
  let clock = 1_000_000;
  const registry = new CallAudioBufferRegistry({ ttlMs: 1000, now: () => clock });
  registry.createBuffer('callturn_000001');
  registry.appendChunk('callturn_000001', { chunkIndex: 0, bytes: chunk(10) });
  clock += 1001;
  const discarded = registry.sweepExpired();
  assert.deepEqual(discarded, [{ turn_id: 'callturn_000001', total_bytes: 10 }]);
  assert.equal(registry.processBytesUsed(), 0);
  // TTL 内的缓冲不受影响：封账后重新计时的 closedAt 同样受清扫约束。
  registry.createBuffer('callturn_000002');
  registry.appendChunk('callturn_000002', { chunkIndex: 0, bytes: chunk(5) });
  registry.seal('callturn_000002');
  clock += 500;
  assert.deepEqual(registry.sweepExpired(), []);
  clock += 501;
  assert.equal(registry.sweepExpired().length, 1);
});

test('重复创建缓冲与不存在回合的访问都被拒绝', () => {
  const registry = new CallAudioBufferRegistry();
  registry.createBuffer('callturn_000001');
  assert.throws(() => registry.createBuffer('callturn_000001'), (error) => error.code === 'CALL_AUDIO_BUFFER_EXISTS');
  assert.throws(() => registry.appendChunk('callturn_000404', { chunkIndex: 0, bytes: chunk(1) }),
    (error) => error.code === 'CALL_AUDIO_BUFFER_NOT_FOUND');
  assert.throws(() => registry.seal('callturn_000404'), (error) => error.code === 'CALL_AUDIO_BUFFER_NOT_FOUND');
});
