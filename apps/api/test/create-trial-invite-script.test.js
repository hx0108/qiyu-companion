'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { oneTimeCredentialOutput, parseOptions } = require('../scripts/create-trial-invite');

test('邀请码创建脚本要求受限标签和有效期', () => {
  assert.deepEqual(parseOptions(['--label', 'self-test-001', '--days', '14']), { label: 'self-test-001', days: 14 });
  assert.throws(() => parseOptions(['--days', '14']), /--label is required/);
  assert.throws(() => parseOptions(['--label', 'x', '--days', '91']), /1 to 90/);
});

test('邀请码创建脚本以可复制的 ASCII 键输出一次性凭据，不写入文件', () => {
  assert.equal(oneTimeCredentialOutput({ inviteCode: 'QYAAAA-BBBBBB-CCCCCC-DDDDDD', initialSecret: 'test-only-secret', days: 14 }), 'INVITE_CODE=QYAAAA-BBBBBB-CCCCCC-DDDDDD\nINITIAL_SECRET=test-only-secret\nEXPIRES_IN_DAYS=14\n');
});
