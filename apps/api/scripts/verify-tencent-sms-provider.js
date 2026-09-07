'use strict';

// 腾讯云短信供应商真实验收（P2-10）：向指定手机发送一条验证码并核对
// 供应商回执 Code=Ok。不输出密钥、不回显验证码。
// 用法：QIYU_SMS_PROVIDER=tencent QIYU_SMS_SDK_APP_ID=... QIYU_SMS_SIGN_NAME=...
//       QIYU_SMS_TEMPLATE_ID=... TENCENT_SECRET_ID=... TENCENT_SECRET_KEY=... \
//       QIYU_SMS_VERIFY_PHONE=138... node scripts/verify-tencent-sms-provider.js
// 只有输出 {"acceptance":"passed",...} 才可把“真实短信通道已验证”写入记录。

const { createTencentSmsSenderFromEnvironment } = require('../src/providers/tencent-sms-adapter');
const { randomInt } = require('node:crypto');

async function main() {
  const sender = createTencentSmsSenderFromEnvironment(process.env);
  if (!sender) {
    console.log(JSON.stringify({ acceptance: 'skipped', reason: 'QIYU_SMS_PROVIDER 未配置为 tencent（保持开发固定验证码回退）' }));
    return;
  }
  const phone = process.env.QIYU_SMS_VERIFY_PHONE;
  if (!/^1[3-9][0-9]{9}$/.test(String(phone ?? ''))) {
    console.error('需要 QIYU_SMS_VERIFY_PHONE=有效手机号（验收短信发送对象，请使用你本人的号码）');
    process.exit(1);
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    const result = await sender.send({ phone, code });
    console.log(JSON.stringify({ acceptance: 'passed', provider: sender.provider, phone_masked: `${phone.slice(0, 3)}****${phone.slice(-4)}`, request_id: result.providerRequestId, note: '验证码已真实发送（此处不回显）；请在手机上确认收到。' }));
  } catch (error) {
    console.log(JSON.stringify({ acceptance: 'failed', code: error.code || 'UNKNOWN', message: error.expose ? error.message : '供应商错误（详情见服务端日志）' }));
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
