'use strict';

const { DevelopmentStore } = require('../domain/store');
const { PostgresStore } = require('./postgres-store');

function createPersistenceFromEnvironment(environment = process.env, dependencies = {}) {
  const persistence = environment.QIYU_PERSISTENCE || 'memory';
  if (persistence === 'memory') return new DevelopmentStore();
  if (persistence !== 'postgres') throw configurationError('PERSISTENCE_MODE_INVALID', 'QIYU_PERSISTENCE must be memory or postgres');
  if (environment.NODE_ENV === 'production') throw configurationError('PRODUCTION_RUNTIME_NOT_WIRED', 'The development PostgreSQL composition cannot run in production');
  if (!environment.DATABASE_URL) throw configurationError('DATABASE_URL_REQUIRED', 'DATABASE_URL is required when QIYU_PERSISTENCE=postgres');
  const pool = dependencies.pool || createPgPool(environment.DATABASE_URL);
  return new PostgresStore({ pool });
}

function createPgPool(connectionString) {
  // pg is loaded only for the explicit PostgreSQL development path. Unit tests
  // inject a fake pool and never need a database server or credentials.
  const { Pool } = require('pg');
  return new Pool({ connectionString });
}

function configurationError(code, message) { const error = new Error(message); error.code = code; return error; }

module.exports = { createPersistenceFromEnvironment };
