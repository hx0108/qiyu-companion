'use strict';

// 受控物理清理验收：只创建本脚本随机 ID 对应的一张固定 PNG，写入一条
// APPROVED 参考图审核，再以正式 revoke 函数撤销。Worker 必须从 outbox 队列
// 删除该精确 COS 对象、写入完成回执；绝不枚举或删除任何既有用户对象。
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createTencentCosPrivateImageStoreFromEnvironment } = require('../src/media/tencent-cos-private-image-store');
const { createControlledPng } = require('./controlled-probe-png');

const REVIEWER_ROLE = 'qiyu_cleanup_e2e_reviewer';
const WAIT_MS = 1000;
const TIMEOUT_MS = 30000;

async function main(environment = process.env) {
  required(environment.DATABASE_URL, 'DATABASE_URL');
  required(environment.QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL, 'QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL');
  const imageStore = createTencentCosPrivateImageStoreFromEnvironment(environment);
  if (!imageStore) throw new Error('Tencent private image store is required.');
  const adminPool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 });
  const cleanupPool = new Pool({ connectionString: environment.QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL, max: 1 });
  const assetId = randomUUID();
  const reviewId = randomUUID();
  const reviewerId = randomUUID();
  let objectKey = null;
  let seeded = false;
  let completed = false;
  try {
    const target = await findControlledTarget(adminPool);
    await provisionReviewer(adminPool, reviewerId);
    const png = createControlledPng();
    const stored = await imageStore.putImage({ assetId, bytes: png, mimeType: 'image/png' });
    objectKey = stored.objectKey;
    await seedApprovedReference(adminPool, { assetId, reviewId, target, stored });
    seeded = true;
    await revokeReference(adminPool, reviewId);
    const receipt = await waitForReceipt(adminPool, reviewId);
    await assertDeleted(imageStore, objectKey);
    const result = Object.freeze({
      acceptance: 'passed', review_id: reviewId, asset_id: assetId,
      cleanup_state: receipt.state, object_delete_count: receipt.receipt_json?.object_delete_count,
      deleted_asset_ids: receipt.receipt_json?.deleted_asset_ids,
      storage_verification: 'COS getObject returned not-found for the controlled key only'
    });
    completed = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    // In a worker outage the test object must not survive. Once the worker has
    // completed, this is an idempotent second delete of the same random key.
    if (objectKey) await imageStore.deleteAsset(objectKey).catch(() => undefined);
    // Failed setup/revocation is not an audit event and must not leave a
    // visible AVAILABLE reference asset with a now-missing test object.
    if (seeded && !completed) await removeFailedProbeMetadata(adminPool, assetId, reviewId).catch(() => undefined);
    await cleanupPool.end();
    await adminPool.end();
  }
}

async function removeFailedProbeMetadata(pool, assetId, reviewId) {
  await pool.query('BEGIN');
  try {
    await pool.query(`DELETE FROM media_assets WHERE asset_id = $1 AND provider = 'controlled-cleanup-e2e'`, [assetId]);
    await pool.query(`DELETE FROM content_rights_reviews WHERE review_id = $1 AND decision_reason = 'Controlled cleanup probe approved for immediate revocation.'`, [reviewId]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function findControlledTarget(pool) {
  const result = await pool.query(`SELECT character_id, account_id FROM characters
    WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`);
  if (result.rows.length !== 1) throw new Error('A development character is required for the controlled cleanup probe.');
  return result.rows[0];
}

async function provisionReviewer(pool, reviewerId) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${REVIEWER_ROLE}') THEN
      CREATE ROLE ${REVIEWER_ROLE} NOLOGIN NOINHERIT;
    END IF;
  END $$;`);
  await pool.query(`GRANT qiyu_reviewer TO ${REVIEWER_ROLE}`);
  await pool.query(`INSERT INTO content_rights_reviewer_identities (database_role, reviewer_id, state)
    VALUES ($1::name, $2::uuid, 'ACTIVE')
    ON CONFLICT (database_role) DO UPDATE SET reviewer_id = EXCLUDED.reviewer_id, state = 'ACTIVE'`, [REVIEWER_ROLE, reviewerId]);
}

async function seedApprovedReference(pool, { assetId, reviewId, target, stored }) {
  await pool.query('BEGIN');
  try {
    await pool.query(`INSERT INTO content_rights_reviews
      (review_id, account_id, subject_type, subject_ref, declaration_version, risk_codes, state, reviewer_id, decision_reason)
      VALUES ($1, $2, 'REFERENCE_IMAGE', $3, 'cleanup-e2e-v1', ARRAY['CONTROLLED_E2E'], 'APPROVED', NULL, 'Controlled cleanup probe approved for immediate revocation.')`, [reviewId, target.account_id, assetId]);
    await pool.query(`INSERT INTO media_assets
      (asset_id, account_id, character_id, job_id, type, state, media_type, mime_type, byte_length, checksum, object_key, provider, provider_request_id, ai_generated, aigc_mark_version, confirmation_state, moderation_policy_version, created_at, rights_review_id)
      VALUES ($1, $2, $3, NULL, 'REFERENCE_IMAGE', 'AVAILABLE', 'IMAGE', 'image/png', $4, $5, $6, 'controlled-cleanup-e2e', 'controlled-cleanup-e2e', false, 'not-applicable-controlled-e2e', 'USER_CONFIRMED', 'controlled-cleanup-e2e', CURRENT_TIMESTAMP, $7)`,
    [assetId, target.account_id, target.character_id, stored.byteLength, stored.checksum, stored.objectKey, reviewId]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function revokeReference(pool, reviewId) {
  const client = await pool.connect();
  try {
    await client.query(`SET SESSION AUTHORIZATION ${REVIEWER_ROLE}`);
    // The probe identity intentionally has NOINHERIT. A real reviewer login
    // normally inherits its reviewer membership; this explicit switch proves
    // the same narrowly granted execution path without widening the probe.
    await client.query('SET ROLE qiyu_reviewer');
    await client.query(`SELECT app.revoke_content_rights_review($1::uuid, 'Controlled COS physical-cleanup acceptance probe.')`, [reviewId]);
    await client.query('RESET ROLE');
    await client.query('RESET SESSION AUTHORIZATION');
  } finally { client.release(); }
}

async function waitForReceipt(pool, reviewId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT job.state, job.receipt_json
      FROM content_rights_cleanup_jobs AS job
      JOIN outbox_events AS event ON event.event_id = job.event_id
      WHERE event.payload_json->>'review_id' = $1
      ORDER BY job.created_at DESC LIMIT 1`, [reviewId]);
    const row = result.rows[0];
    if (row?.state === 'COMPLETED') return row;
    await sleep(WAIT_MS);
  }
  throw new Error('Controlled cleanup job did not complete within 30 seconds.');
}

async function assertDeleted(imageStore, objectKey) {
  try {
    await imageStore.readImage(objectKey);
  } catch {
    return;
  }
  throw new Error('Controlled COS object was still readable after cleanup receipt.');
}
function required(value, name) { if (!value) throw new Error(`${name} is required.`); return value; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

if (require.main === module) main().catch((error) => { process.stderr.write(`content-rights cleanup acceptance failed: ${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
