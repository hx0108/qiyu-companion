'use strict';

const { createHash } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');

// Development-only private media vault. It is deliberately outside STATIC_FILES
// and returns object keys, never browser-accessible paths or URLs.
class LocalPrivateMediaStore {
  constructor({ root = path.resolve(process.cwd(), '.qiyu-dev-media') } = {}) {
    this.root = path.resolve(root);
    this.storageKind = 'LOCAL_PRIVATE';
  }

  async createPendingJob(job) {
    await this.writeManifest(job.job_id, { job_id: job.job_id, state: job.state, type: job.type, created_at: job.created_at, source_message_id: job.source_message_id });
  }

  async updateJob(job) {
    await this.writeManifest(job.job_id, { job_id: job.job_id, state: job.state, type: job.type, provider: job.provider || null, provider_request_id: job.provider_request_id || null, result_asset_id: job.result_asset_id || null, failure_code: job.failure_code || null });
  }

  async putAudio({ assetId, jobId, bytes, mimeType }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError('Private media bytes must be a non-empty Buffer');
    if (mimeType !== 'audio/mpeg') throw new TypeError('Only MP3 audio is supported in the development media vault');
    await mkdir(this.root, { recursive: true });
    const objectKey = `tts/${assetId}.mp3`;
    const target = this.resolveObjectKey(objectKey);
    await atomicWrite(target, bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await this.writeManifest(jobId, { job_id: jobId, state: 'COMPLETED', result_asset_id: assetId, object_key: objectKey, checksum, byte_length: bytes.length, mime_type: mimeType });
    return { objectKey, checksum, byteLength: bytes.length, mimeType };
  }

  async putAsrInput({ assetId, jobId, bytes, mimeType }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new TypeError('Private media bytes must be a non-empty Buffer');
    const extension = asrExtensionFor(mimeType);
    if (!extension) throw new TypeError('Unsupported ASR input MIME type');
    await mkdir(this.root, { recursive: true });
    const objectKey = `asr-input/${assetId}.${extension}`;
    const target = this.resolveObjectKey(objectKey);
    await atomicWrite(target, bytes);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    await this.writeManifest(jobId, { job_id: jobId, state: 'PENDING', input_asset_id: assetId, input_object_key: objectKey, input_checksum: checksum, input_byte_length: bytes.length, input_mime_type: mimeType });
    return { objectKey, checksum, byteLength: bytes.length, mimeType };
  }

  async deleteAsset(objectKey) {
    await rm(this.resolveObjectKey(objectKey), { force: true });
  }

  async readTtsAudio(objectKey) {
    if (typeof objectKey !== 'string' || !/^tts\/[A-Za-z0-9_-]+\.mp3$/.test(objectKey)) throw new TypeError('Invalid private TTS media object key');
    return readFile(this.resolveObjectKey(objectKey));
  }

  async writeManifest(jobId, patch) {
    await mkdir(path.join(this.root, 'jobs'), { recursive: true });
    await atomicWrite(path.join(this.root, 'jobs', `${safeId(jobId)}.json`), Buffer.from(JSON.stringify(patch), 'utf8'));
  }

  resolveObjectKey(objectKey) {
    if (typeof objectKey !== 'string' || !/^(?:tts\/[A-Za-z0-9_-]+\.mp3|asr-input\/[A-Za-z0-9_-]+\.(?:mp3|wav|m4a|aac|ogg))$/.test(objectKey)) throw new TypeError('Invalid private media object key');
    const target = path.resolve(this.root, objectKey);
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new TypeError('Private media object escaped its vault');
    return target;
  }
}

async function atomicWrite(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'w' });
  await rename(temporary, target);
}
function safeId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid media job id'); return value; }
function asrExtensionFor(mimeType) { return ({ 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg' })[mimeType]; }

module.exports = { LocalPrivateMediaStore };
