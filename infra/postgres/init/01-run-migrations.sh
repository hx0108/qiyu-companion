#!/usr/bin/env bash
set -Eeuo pipefail

# PostgreSQL's entrypoint only automatically executes files directly beneath
# /docker-entrypoint-initdb.d. Keep versioned SQL mounted separately so the
# same files can also be applied to an existing database by scripts/migrate.ps1.
for migration in /migrations/*.sql; do
  echo "Running migration: ${migration}"
  psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 --file "$migration"
done
