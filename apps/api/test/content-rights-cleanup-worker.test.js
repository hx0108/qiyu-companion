'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContentRightsCleanupWorker, safeErrorMessage } = require('../src/workers/content-rights-cleanup-worker');

test('content-rights cleanup worker deletes every claimed private object and then stores a receipt', async () => {
  const calls = [];
  const repository = {
    async claimNext() { return { event_id: '00000000-0000-7000-8000-000000000111', assets: [{ asset_id: 'asset-ref', object_key: 'qiyu/images/asset-ref.png' }, { asset_id: 'asset-scene', object_key: 'qiyu/images/asset-scene.png' }] }; },
    async complete(eventId, receipt) { calls.push({ type: 'complete', eventId, receipt }); },
    async fail() { throw new Error('unexpected failure path'); }
  };
  const imageStore = { async deleteAsset(objectKey) { calls.push({ type: 'delete', objectKey }); } };
  const worker = new ContentRightsCleanupWorker({ repository, imageStore, clock: () => '2026-09-04T12:00:00.000Z' });

  assert.deepEqual(await worker.runOnce(), { state: 'COMPLETED', event_id: '00000000-0000-7000-8000-000000000111', deleted_asset_count: 2 });
  assert.deepEqual(calls, [
    { type: 'delete', objectKey: 'qiyu/images/asset-ref.png' },
    { type: 'delete', objectKey: 'qiyu/images/asset-scene.png' },
    { type: 'complete', eventId: '00000000-0000-7000-8000-000000000111', receipt: { completed_at: '2026-09-04T12:00:00.000Z', deleted_asset_ids: ['asset-ref', 'asset-scene'], object_delete_count: 2 } }
  ]);
});

test('content-rights cleanup worker leaves an event retryable when private deletion fails', async () => {
  const failures = [];
  const repository = {
    async claimNext() { return { event_id: '00000000-0000-7000-8000-000000000112', assets: [{ asset_id: 'asset-ref', object_key: 'qiyu/images/asset-ref.png' }] }; },
    async complete() { throw new Error('must not complete'); },
    async fail(eventId, error) { failures.push({ eventId, error }); }
  };
  const worker = new ContentRightsCleanupWorker({ repository, imageStore: { async deleteAsset() { throw new Error('COS timeout\ncredential detail must not be logged'); } } });

  assert.deepEqual(await worker.runOnce(), { state: 'RETRY_SCHEDULED', event_id: '00000000-0000-7000-8000-000000000112', error: 'COS timeout credential detail must not be logged' });
  assert.deepEqual(failures, [{ eventId: '00000000-0000-7000-8000-000000000112', error: 'COS timeout credential detail must not be logged' }]);
});

test('content-rights cleanup worker returns idle without contacting COS when no job is ready', async () => {
  const worker = new ContentRightsCleanupWorker({
    repository: { async claimNext() { return null; }, async complete() {}, async fail() {} },
    imageStore: { async deleteAsset() { throw new Error('must not delete'); } }
  });
  assert.deepEqual(await worker.runOnce(), { state: 'IDLE' });
  assert.equal(safeErrorMessage({ message: 'x\r\ny' }), 'x y');
});
