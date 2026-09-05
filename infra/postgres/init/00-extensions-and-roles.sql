-- Runs only when the Docker volume is initialized. Schema migrations live in ../migrations.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS app;

-- App traffic must use this non-owner role so FORCE ROW LEVEL SECURITY is effective.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qiyu_app') THEN
    CREATE ROLE qiyu_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO qiyu_app;
ALTER ROLE qiyu_app SET timezone TO 'UTC';

-- The Docker bootstrap owner is the only login used for local development.
-- It must explicitly assume the non-owner application role for every API
-- transaction; otherwise a table owner would bypass FORCE RLS.
-- 幂等：bootstrap 用户恰为 qiyu_app 本身（如显式以应用角色初始化）时跳过
-- 自我成员授权；该场景下 qiyu_app 需为可登录角色且具备建库建角色权限。
DO $$
BEGIN
  IF current_user <> 'qiyu_app' THEN
    EXECUTE format('GRANT qiyu_app TO %I', current_user);
  END IF;
END
$$;

-- UUIDv7-compatible layout: UTC Unix milliseconds, RFC 9562 version/variant bits,
-- then cryptographically secure randomness. PostgreSQL 16 does not ship uuidv7().
CREATE OR REPLACE FUNCTION app.uuid_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  unix_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  time_hex text := lpad(to_hex(unix_ms), 12, '0');
  random_hex text := encode(gen_random_bytes(9), 'hex');
  variant text := substr('89ab', (get_byte(gen_random_bytes(1), 0) % 4) + 1, 1);
BEGIN
  RETURN (
    substr(time_hex, 1, 8) || '-' || substr(time_hex, 9, 4) || '-' ||
    '7' || substr(random_hex, 1, 3) || '-' ||
    variant || substr(random_hex, 4, 3) || '-' || substr(random_hex, 7, 12)
  )::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.account_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_character_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.character_id', true), '')::uuid
$$;
