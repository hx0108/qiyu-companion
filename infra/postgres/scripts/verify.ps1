param(
  [string]$ComposeFile = (Join-Path $PSScriptRoot '..\docker-compose.yml')
)

$ErrorActionPreference = 'Stop'
$command = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f /verify/verify_schema.sql'
docker compose -f $ComposeFile exec -T postgres sh -c $command
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL schema verification failed' }
