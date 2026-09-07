'use strict';

// 腾讯云短信适配器（P2-10 真实登录）：SendSms 单发验证码，TC3 签名复用
// ./tencent-tc3-client。环境变量（QIYU_SMS_PROVIDER=tencent 时启用）：
//   TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_REGION（默认 ap-guangzhou）
//   QIYU_SMS_SDK_APP_ID / QIYU_SMS_SIGN_NAME / QIYU_SMS_TEMPLATE_ID
// 模板须为已审核通过的正文模板，占位参数按 {1} 传验证码。
// 未配置时 AuthService 回退开发固定验证码（不外呼），响应如实标注。

const { TencentTc3Client, TencentProviderError } = require('./tencent-tc3-client');

function createTencentSmsSenderFromEnvironment(environment = process.env, dependencies = {}) {
  if (environment.QIYU_SMS_PROVIDER !== 'tencent') return null;
  const required = {
    sdkAppId: environment.QIYU_SMS_SDK_APP_ID,
    signName: environment.QIYU_SMS_SIGN_NAME,
    templateId: environment.QIYU_SMS_TEMPLATE_ID
  };
  for (const [field, value] of Object.entries(required)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TencentProviderError('TENCENT_SMS_CONFIG_REQUIRED', `QIYU_SMS_PROVIDER=tencent 需要配置 QIYU_SMS_${field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`, 500);
    }
  }
  const clientFactory = dependencies.clientFactory || ((options) => new TencentTc3Client(options));
  const client = clientFactory({
    secretId: environment.TENCENT_SECRET_ID,
    secretKey: environment.TENCENT_SECRET_KEY,
    region: environment.TENCENT_REGION || 'ap-guangzhou'
  });
  const sender = {
    provider: 'tencent-sms',
    async send({ phone, code }) {
      if (!/^1[3-9][0-9]{9}$/.test(String(phone ?? ''))) throw new TencentProviderError('TENCENT_SMS_PHONE_INVALID', '手机号格式不合法', 400);
      if (!/^[0-9]{6}$/.test(String(code ?? ''))) throw new TencentProviderError('TENCENT_SMS_CODE_INVALID', '验证码必须是 6 位数字', 500);
      const payload = await client.request({
        service: 'sms', action: 'SendSms', version: '2021-01-11',
        body: { PhoneNumberSet: [`+86${phone}`], SmsSdkAppId: required.sdkAppId, SignName: required.signName, TemplateId: required.templateId, TemplateParamSet: [String(code)] }
      });
      const status = payload?.SendStatusSet?.[0];
      if (!status || status.Code !== 'Ok') {
        // 供应商拒绝（签名/模板/频控等）：对外只给安全码，不透传供应商诊断。
        throw new TencentProviderError('TENCENT_SMS_SEND_REJECTED', '短信发送失败，请稍后重试', 502, { provider_code: status?.Code ?? 'NO_STATUS' }, true);
      }
      return { providerRequestId: payload.RequestId || 'tencent-sms-request-id-unavailable' };
    }
  };
  return sender;
}

module.exports = { createTencentSmsSenderFromEnvironment };
