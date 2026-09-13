'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectContextImage } = require('../src/domain/context-image-policy');

function png({ metadata = false, animated = false } = {}) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 4, 'ascii'); data.copy(out, 8); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([signature, chunk('IHDR', ihdr), ...(metadata ? [chunk('eXIf', Buffer.from('GPS'))] : []), ...(animated ? [chunk('acTL', Buffer.alloc(8))] : []), chunk('IEND', Buffer.alloc(0))]);
}

test('context image inspection verifies signature, dimensions and static metadata-free input', () => {
  const result = inspectContextImage(png(), 'image/png');
  assert.deepEqual({ mime: result.mimeType, width: result.width, height: result.height, stripped: result.metadataStripped }, { mime: 'image/png', width: 2, height: 3, stripped: true });
  assert.throws(() => inspectContextImage(png(), 'image/jpeg'), (error) => error.code === 'CONTEXT_IMAGE_SIGNATURE_MISMATCH');
  assert.throws(() => inspectContextImage(Buffer.from('not-image'), 'image/png'), (error) => error.code === 'CONTEXT_IMAGE_SIGNATURE_MISMATCH');
  assert.throws(() => inspectContextImage(png({ animated: true }), 'image/png'), (error) => error.code === 'CONTEXT_IMAGE_ANIMATION_NOT_ALLOWED');
  assert.throws(() => inspectContextImage(png({ metadata: true }), 'image/png'), (error) => error.code === 'CONTEXT_IMAGE_METADATA_NOT_ALLOWED');
});
