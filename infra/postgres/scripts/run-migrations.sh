#!/usr/bin/env sh
# Apply only migrations absent from schema_migrations. This script runs inside
# the Compose migrate service; it intentionally prints filenames only.
set -eu

echo "Waiting for PostgreSQL migration ledger"
until pg_isready -q; do
  sleep 1
done

ledger_ready="$(psql -v ON_ERROR_STOP=1 -Atqc "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")"
if [ "$ledger_ready" != "t" ]; then
  echo "schema_migrations is missing; PostgreSQL initialization did not complete" >&2
  exit 1
fi

for migration_path in /migrations/*.sql; do
  migration_id="$(basename "$migration_path")"
  case "$migration_id" in
    *.sql) ;;
    *)
      echo "Unexpected migration filename: $migration_id" >&2
      exit 1
      ;;
  esac

  # psql does not substitute variables in -c reliably across client versions.
  # Migration filenames are repository-controlled; still quote a single quote
  # defensively before embedding the value in this tiny ledger lookup.
  escaped_migration_id="$(printf '%s' "$migration_id" | sed "s/'/''/g")"
  applied="$(psql -v ON_ERROR_STOP=1 -Atqc "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id = '$escaped_migration_id');")"
  if [ "$applied" = "t" ]; then
    echo "Skipping already applied $migration_id"
    continue
  fi

  echo "Applying $migration_id"
  psql -v ON_ERROR_STOP=1 -f "$migration_path"
done

echo "Database migrations are current"
