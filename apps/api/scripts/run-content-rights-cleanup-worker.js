'use strict';

const { Pool } = require('pg');
const { ContentRightsCleanupWorker } = require('../src/workers/content-rights-cleanup-worker');
const { PostgresContentRightsCleanupRepository } = require('../src/persistence/postgres-content-rights-cleanup-repository');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');

async function main(environment = process.env) {
  const databaseUrl = required(environment.QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL, 'QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL');
  if (environment.QIYU_IMAGE_PROVIDER !== 'tencent-hunyuan') throw new Error('QIYU_IMAGE_PROVIDER=tencent-hunyuan is required for the cleanup worker');
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const worker = new ContentRightsCleanupWorker({
      repository: new PostgresContentRightsCleanupRepository({ pool }),
      imageStore: createTencentCosPrivateImageStoreFromEnvironment(environment)
    });
    const result = await worker.runOnce();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await pool.end();
  }
}

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`content-rights cleanup worker failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
