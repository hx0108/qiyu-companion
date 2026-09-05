'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TencentCosPrivateMediaStore,
  createTencentCosPrivateMediaStoreFromEnvironment
} = require('../src/media/tencent-cos-private-media-store');

const bucket = 'qiyu-1250000000';

test('私有 COS 媒体存储将 TTS、ASR 和无正文任务清单隔离到固定前缀', async () => {
  const calls = [];
  const store = new TencentCosPrivateMediaStore({ client: callbackClient(calls), bucket });
  await store.createPendingJob({ job_id: 'tts_job_1', state: 'PENDING', type: 'TTS', created_at: '2026-09-05T00:00:00Z', source_message_id: 'msg_1' });
  const tts = await store.putAudio({ assetId: 'med_1', jobId: 'tts_job_1', bytes: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' });
  const asr = await store.putAsrInput({ assetId: 'med_2', jobId: 'asr_job_1', bytes: Buffer.from('wav-bytes'), mimeType: 'audio/wav' });
  await store.updateJob({ job_id: 'tts_job_1', state: 'COMPLETED', type: 'TTS', provider: 'tencent-tts', provider_request_id: 'request_1', result_asset_id: 'med_1' });

  assert.equal(store.storageKind, 'COS_PRIVATE');
  assert.deepEqual(tts, { objectKey: 'qiyu/media/tts/med_1.mp3', checksum: 'ff1ab79265993c9674c3e4998978ec8f9eccfee1f53c9749c4f0c23b9e7d9a5a', byteLength: 9, mimeType: 'audio/mpeg' });
  assert.equal(asr.objectKey, 'qiyu/media/asr-input/med_2.wav');
  assert.deepEqual(calls.slice(0, 4).map(({ method, params }) => ({ method, key: params.Key, headers: params.Headers })), [
    { method: 'putObject', key: 'qiyu/media/jobs/tts_job_1.json', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    { method: 'putObject', key: 'qiyu/media/tts/med_1.mp3', headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } },
    { method: 'putObject', key: 'qiyu/media/asr-input/med_2.wav', headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' } },
    { method: 'putObject', key: 'qiyu/media/jobs/tts_job_1.json', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  ]);
  assert.equal(calls[0].params.Body.toString().includes('transcript_text'), false);
  assert.equal((await store.readTtsAudio(tts.objectKey)).toString(), 'stored-mp3');
  await store.deleteAsset(tts.objectKey);
  assert.equal(calls.at(-1).params.Key, tts.objectKey);
});

test('私有 COS 媒体存储拒绝路径逃逸、非音频和超大负载', async () => {
  const store = new TencentCosPrivateMediaStore({ client: callbackClient([]), bucket });
  await assert.rejects(() => store.putAudio({ assetId: '../bad', jobId: 'job_1', bytes: Buffer.from('x'), mimeType: 'audio/mpeg' }), /media id/);
  await assert.rejects(() => store.putAudio({ assetId: 'med_1', jobId: 'job_1', bytes: Buffer.from('x'), mimeType: 'audio/wav' }), /MP3/);
  await assert.rejects(() => store.readTtsAudio('qiyu/media/asr-input/med_1.wav'), /TTS/);
  await assert.rejects(() => store.deleteAsset('qiyu/images/med_1.png'), /object key/);
});

test('媒体 COS 工厂只在显式选择后启用并校验私有广州桶', () => {
  const environment = {
    QIYU_PRIVATE_MEDIA_STORE: 'tencent-cos', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key',
    TENCENT_COS_BUCKET: bucket, TENCENT_COS_REGION: 'ap-guangzhou', TENCENT_COS_ENDPOINT: `https://${bucket}.cos.ap-guangzhou.myqcloud.com`
  };
  const store = createTencentCosPrivateMediaStoreFromEnvironment(environment, { client: callbackClient([]) });
  assert.ok(store instanceof TencentCosPrivateMediaStore);
  assert.equal(createTencentCosPrivateMediaStoreFromEnvironment({ TENCENT_COS_BUCKET: bucket }), null);
  assert.throws(() => createTencentCosPrivateMediaStoreFromEnvironment({ ...environment, TENCENT_COS_REGION: 'ap-shanghai' }), (error) => error.code === 'PRIVATE_MEDIA_STORE_CONFIGURATION_INVALID');
  assert.throws(() => createTencentCosPrivateMediaStoreFromEnvironment({ ...environment, TENCENT_COS_ENDPOINT: 'https://public.example.com' }), (error) => error.code === 'PRIVATE_MEDIA_STORE_CONFIGURATION_INVALID');
});

function callbackClient(calls) {
  return {
    putObject(params, callback) { calls.push({ method: 'putObject', params }); callback(null, { ETag: 'etag' }); },
    getObject(params, callback) { calls.push({ method: 'getObject', params }); callback(null, { Body: Buffer.from('stored-mp3') }); },
    deleteObject(params, callback) { calls.push({ method: 'deleteObject', params }); callback(null, {}); }
  };
}
