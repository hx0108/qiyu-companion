'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createControlledPng } = require('../scripts/controlled-probe-png');

test('图片供应商预检使用满足 IMS 最小尺寸的固定无内容 PNG', () => {
  const png = createControlledPng();
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  assert.ok(png.length > 512);
});
