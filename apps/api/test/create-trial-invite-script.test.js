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
  assert.equal(oneTimeCredentialOutput({ inviteCode: 'QYAAAA-BBBBBB-CCCCCC-DDDDDD', days: 14 }), 'INVITE_CODE=QYAAAA-BBBBBB-CCCCCC-DDDDDD\nEXPIRES_IN_DAYS=14\nNOTE=凭邀请码即可登录；初始口令已取消。\n');
});
