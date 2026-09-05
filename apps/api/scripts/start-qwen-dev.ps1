param(
  [int]$Port = 3000,
  [string]$CredentialFile = 'C:\Users\ASUS\Desktop\AI Agent\.env',
  [switch]$EnableTencentTextModeration,
  [switch]$EnableTencentAsr,
  [switch]$EnableTencentTts,
  [switch]$EnableTencentCosMediaStore,
  [switch]$EnableTencentImagePipeline
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CredentialFile)) { throw "Qwen credential file was not found: $CredentialFile" }

$values = @{}
foreach ($line in Get-Content -LiteralPath $CredentialFile) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $name = $Matches[1]
    $value = $Matches[2]
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$name] = $value
  }
}

$apiKey = if ($values['QWEN_API_KEY']) { $values['QWEN_API_KEY'] } else { $values['DASHSCOPE_API_KEY'] }
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'QWEN_API_KEY or DASHSCOPE_API_KEY is required in the credential file.' }

# Keep credentials in this process environment only. Do not write them into this repository.
$env:QWEN_API_KEY = $apiKey
if ($values['QWEN_BASE_URL']) { $env:QWEN_BASE_URL = $values['QWEN_BASE_URL'] }
elseif ($values['DASHSCOPE_BASE_URL']) { $env:QWEN_BASE_URL = $values['DASHSCOPE_BASE_URL'] }
$env:QIYU_LLM_PROVIDER = 'qwen'
$env:QWEN_MODEL = 'qwen3.8-flash'
$env:QIYU_TEXT_MODERATION_PROVIDER = ''
if ($EnableTencentTextModeration) {
  foreach ($name in @('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION', 'TENCENT_TEXT_MODERATION_BIZ_TYPE')) {
    if ([string]::IsNullOrWhiteSpace($values[$name])) { throw "$name is required when -EnableTencentTextModeration is specified." }
    Set-Item -Path "Env:$name" -Value $values[$name]
  }
  $env:QIYU_TEXT_MODERATION_PROVIDER = 'tencent'
}
$env:QIYU_TTS_PROVIDER = ''
$env:QIYU_ASR_PROVIDER = ''
if ($EnableTencentAsr) {
  foreach ($name in @('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION')) {
    if ([string]::IsNullOrWhiteSpace($values[$name])) { throw "$name is required when -EnableTencentAsr is specified." }
    Set-Item -Path "Env:$name" -Value $values[$name]
  }
  if ($values['TENCENT_ASR_ENGINE_MODEL_TYPE']) { $env:TENCENT_ASR_ENGINE_MODEL_TYPE = $values['TENCENT_ASR_ENGINE_MODEL_TYPE'] }
  $env:QIYU_ASR_PROVIDER = 'tencent'
}
if ($EnableTencentTts) {
  foreach ($name in @('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION', 'TENCENT_TTS_VOICE_TYPE', 'TENCENT_TTS_VOICE_VERSION', 'TENCENT_TTS_AUTHORIZATION_RECORD_ID', 'TENCENT_TTS_RIGHTS_REVIEW_ID')) {
    if ([string]::IsNullOrWhiteSpace($values[$name])) { throw "$name is required when -EnableTencentTts is specified." }
    Set-Item -Path "Env:$name" -Value $values[$name]
  }
  if ($values['TENCENT_TTS_MODEL_TYPE']) { $env:TENCENT_TTS_MODEL_TYPE = $values['TENCENT_TTS_MODEL_TYPE'] }
  if ($values['TENCENT_TTS_SAMPLE_RATE']) { $env:TENCENT_TTS_SAMPLE_RATE = $values['TENCENT_TTS_SAMPLE_RATE'] }
  $env:QIYU_TTS_PROVIDER = 'tencent'
}
if ($EnableTencentCosMediaStore) {
  foreach ($name in @('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION', 'TENCENT_COS_ENDPOINT')) {
    if ([string]::IsNullOrWhiteSpace($values[$name])) { throw "$name is required when -EnableTencentCosMediaStore is specified." }
    Set-Item -Path "Env:$name" -Value $values[$name]
  }
  if ($values['TENCENT_COS_REGION'] -ne 'ap-guangzhou') { throw 'TENCENT_COS_REGION must be ap-guangzhou when -EnableTencentCosMediaStore is specified.' }
  $env:QIYU_PRIVATE_MEDIA_STORE = 'tencent-cos'
}
if ($EnableTencentImagePipeline) {
  foreach ($name in @('TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION', 'TENCENT_COS_BUCKET', 'TENCENT_COS_REGION', 'TENCENT_COS_ENDPOINT', 'TENCENT_IMAGE_MODERATION_BIZ_TYPE')) {
    if ([string]::IsNullOrWhiteSpace($values[$name])) { throw "$name is required when -EnableTencentImagePipeline is specified." }
    Set-Item -Path "Env:$name" -Value $values[$name]
  }
  $imageProvider = if ($values['QIYU_IMAGE_PROVIDER']) { $values['QIYU_IMAGE_PROVIDER'] } else { 'tencent-hunyuan' }
  $imageRegion = if ($values['TENCENT_HUNYUAN_REGION']) { $values['TENCENT_HUNYUAN_REGION'] } else { 'ap-guangzhou' }
  $imageModerationProvider = if ($values['QIYU_IMAGE_MODERATION_PROVIDER']) { $values['QIYU_IMAGE_MODERATION_PROVIDER'] } else { 'tencent' }
  if ($imageProvider -ne 'tencent-hunyuan') { throw 'QIYU_IMAGE_PROVIDER must be tencent-hunyuan when -EnableTencentImagePipeline is specified.' }
  if ($imageRegion -ne 'ap-guangzhou') { throw 'TENCENT_HUNYUAN_REGION must be ap-guangzhou when -EnableTencentImagePipeline is specified.' }
  if ($imageModerationProvider -ne 'tencent') { throw 'QIYU_IMAGE_MODERATION_PROVIDER must be tencent when -EnableTencentImagePipeline is specified.' }
  $env:QIYU_IMAGE_PROVIDER = $imageProvider
  $env:TENCENT_HUNYUAN_REGION = $imageRegion
  $env:QIYU_IMAGE_MODERATION_PROVIDER = $imageModerationProvider
}
$env:PORT = "$Port"

node (Join-Path $PSScriptRoot '..\src\server.js')
