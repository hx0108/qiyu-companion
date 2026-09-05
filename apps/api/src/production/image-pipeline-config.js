'use strict';

const IMAGE_CONFIGURATION_KEYS = Object.freeze([
  'QIYU_IMAGE_PROVIDER', 'QIYU_IMAGE_MODERATION_PROVIDER', 'TENCENT_REGION', 'TENCENT_HUNYUAN_REGION',
  'TENCENT_IMAGE_MODERATION_BIZ_TYPE', 'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION', 'TENCENT_COS_ENDPOINT'
]);

// Image generation is a chained safety workflow. It must not be enabled with
// only a generator: reference-media ownership, pre/post moderation and private
// object storage are all mandatory dependencies.
function assertImagePipelineConfiguration(environment = process.env) {
  // TENCENT_REGION is shared by TMS/ASR/TTS. It is required only after an
  // image-specific switch is present and must not make those independent
  // capabilities fail as an incomplete image pipeline.
  // COS is shared by private audio and image media. A media-store-only
  // deployment must not accidentally enable (or fail) the image workflow.
  const configured = [
    'QIYU_IMAGE_PROVIDER', 'QIYU_IMAGE_MODERATION_PROVIDER',
    'TENCENT_HUNYUAN_REGION', 'TENCENT_IMAGE_MODERATION_BIZ_TYPE'
  ].some((key) => nonBlank(environment[key]));
  if (!configured) return Object.freeze({ enabled: false });
  const required = [
    ['QIYU_IMAGE_PROVIDER', 'tencent-hunyuan'],
    ['QIYU_IMAGE_MODERATION_PROVIDER', 'tencent'],
    ['TENCENT_REGION', 'ap-guangzhou'],
    ['TENCENT_HUNYUAN_REGION', 'ap-guangzhou'],
    ['TENCENT_IMAGE_MODERATION_BIZ_TYPE'],
    ['TENCENT_COS_BUCKET'],
    ['TENCENT_COS_REGION', 'ap-guangzhou'],
    ['TENCENT_COS_ENDPOINT']
  ];
  for (const [key, expected] of required) {
    if (!nonBlank(environment[key])) throw configurationError('IMAGE_PIPELINE_CONFIGURATION_INCOMPLETE', `图片链路缺少 ${key}`);
    if (expected && environment[key] !== expected) throw configurationError('IMAGE_PIPELINE_CONFIGURATION_INVALID', `${key} 必须为 ${expected}`);
  }
  const endpoint = environment.TENCENT_COS_ENDPOINT;
  const bucket = environment.TENCENT_COS_BUCKET;
  if (!isPrivateGuangzhouCosEndpoint(endpoint, bucket)) throw configurationError('IMAGE_PIPELINE_CONFIGURATION_INVALID', 'COS 端点必须匹配广州地域的私有桶域名');
  return Object.freeze({ enabled: true, provider: 'tencent-hunyuan', moderationProvider: 'tencent', bucket, endpoint });
}

function isPrivateGuangzhouCosEndpoint(value, bucket) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && url.hostname === `${bucket}.cos.ap-guangzhou.myqcloud.com`;
  } catch { return false; }
}
function nonBlank(value) { return typeof value === 'string' && value.trim().length > 0; }
function configurationError(code, message) { const error = new Error(message); error.code = code; return error; }

module.exports = { IMAGE_CONFIGURATION_KEYS, assertImagePipelineConfiguration, isPrivateGuangzhouCosEndpoint };
