param(
  [string]$Source = (Join-Path $PSScriptRoot '..\..\AI Agent\.env'),
  [string]$Target = (Join-Path $PSScriptRoot '.env')
)

$ErrorActionPreference = 'Stop'

function Read-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Environment file not found: $Path" }
  $values = [ordered]@{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $name = $Matches[1]
      $value = $Matches[2]
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$name] = $value
    }
  }
  return $values
}

$sourceValues = Read-DotEnv $Source
$required = @(
  'TENCENT_SECRET_ID',
  'TENCENT_SECRET_KEY',
  'TENCENT_REGION',
  'TENCENT_TEXT_MODERATION_BIZ_TYPE',
  'TENCENT_TTS_VOICE_TYPE',
  'TENCENT_TTS_VOICE_VERSION',
  'TENCENT_TTS_AUTHORIZATION_RECORD_ID',
  'TENCENT_TTS_RIGHTS_REVIEW_ID',
  'TENCENT_COS_BUCKET',
  'TENCENT_COS_REGION',
  'TENCENT_COS_ENDPOINT'
)
$optional = @('TENCENT_TTS_MODEL_TYPE', 'TENCENT_TTS_SAMPLE_RATE')

foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace($sourceValues[$name])) { throw "$name is required in the source environment file." }
}

$updates = [ordered]@{
  QIYU_TEXT_MODERATION_PROVIDER = 'tencent'
  QIYU_TTS_PROVIDER = 'tencent'
  QIYU_PRIVATE_MEDIA_STORE = 'tencent-cos'
}
foreach ($name in $required + $optional) {
  if (-not [string]::IsNullOrWhiteSpace($sourceValues[$name])) { $updates[$name] = $sourceValues[$name] }
}

$targetLines = [Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $Target) { $targetLines.AddRange([string[]](Get-Content -LiteralPath $Target)) }
$written = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
for ($index = 0; $index -lt $targetLines.Count; $index += 1) {
  if ($targetLines[$index] -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
    $name = $Matches[1]
    if ($updates.Contains($name) -and -not $written.Contains($name)) {
      $targetLines[$index] = "$name=$($updates[$name])"
      [void]$written.Add($name)
    }
  }
}
foreach ($name in $updates.Keys) {
  if (-not $written.Contains($name)) {
    $targetLines.Add("$name=$($updates[$name])")
    [void]$written.Add($name)
  }
}

[IO.File]::WriteAllLines($Target, $targetLines, [Text.UTF8Encoding]::new($false))
Write-Host "Prepared deploy/.env with $($updates.Count) allowlisted provider settings. Secret values were not printed."
