'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { LocalPrivateMediaStore } = require('../src/media/local-private-media-store');

test('私有媒体库在生成前写任务清单，音频不使用公开 URL，并可删除', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'qiyu-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalPrivateMediaStore({ root });
  assert.equal(store.storageKind, 'LOCAL_PRIVATE');
  await store.createPendingJob({ job_id: 'tts_job_1', state: 'PENDING', type: 'TTS', created_at: '2026-09-03T00:00:00.000Z', source_message_id: 'msg_1' });
  const initial = JSON.parse(await readFile(path.join(root, 'jobs', 'tts_job_1.json'), 'utf8'));
  assert.equal(initial.state, 'PENDING');
  const asset = await store.putAudio({ assetId: 'med_1', jobId: 'tts_job_1', bytes: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' });
  assert.equal(asset.objectKey, 'tts/med_1.mp3');
  assert.match(asset.checksum, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(path.join(root, asset.objectKey))).toString(), 'mp3-bytes');
  assert.equal((await store.readTtsAudio(asset.objectKey)).toString(), 'mp3-bytes');
  await assert.rejects(() => store.readTtsAudio('asr-input/med_2.wav'));
  await store.deleteAsset(asset.objectKey);
  await assert.rejects(() => readFile(path.join(root, asset.objectKey)));

  const asrInput = await store.putAsrInput({ assetId: 'med_2', jobId: 'asr_job_1', bytes: Buffer.from('wav-bytes'), mimeType: 'audio/wav' });
  assert.equal(asrInput.objectKey, 'asr-input/med_2.wav');
  assert.equal((await readFile(path.join(root, asrInput.objectKey))).toString(), 'wav-bytes');
  await store.deleteAsset(asrInput.objectKey);
  await assert.rejects(() => readFile(path.join(root, asrInput.objectKey)));
});
