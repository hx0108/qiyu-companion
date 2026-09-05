param(
  [string]$ComposeFile = (Join-Path $PSScriptRoot '..\docker-compose.yml')
)

$ErrorActionPreference = 'Stop'
$composeDir = Split-Path -Parent $ComposeFile
Get-ChildItem (Join-Path $composeDir 'migrations') -Filter '*.sql' | Sort-Object Name | ForEach-Object {
  $name = $_.Name
  $escapedName = $name.Replace("'", "''")
  $check = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT to_regclass(''public.schema_migrations'') IS NOT NULL AND EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id = ''' + $escapedName + ''')"'
  $alreadyApplied = (docker compose -f $ComposeFile exec -T postgres sh -c $check).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect migration ledger for: $name" }
  if ($alreadyApplied -eq 't') {
    Write-Host "Skipping already applied $name"
    return
  }
  Write-Host "Applying $name"
  $apply = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f "/migrations/' + $name + '"'
  docker compose -f $ComposeFile exec -T postgres sh -c $apply
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($_.Name)" }
}
