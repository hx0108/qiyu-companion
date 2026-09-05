'use strict';

// The worker owns only the physical-object side effect.  Online access is
// already fail-closed in the reviewer transaction; a failed deletion stays
// retryable and must never be reported as completed.
class ContentRightsCleanupWorker {
  constructor({ repository, imageStore, clock = () => new Date().toISOString() }) {
    if (!repository || typeof repository.claimNext !== 'function' || typeof repository.complete !== 'function' || typeof repository.fail !== 'function') throw new TypeError('A content-rights cleanup repository is required');
    if (!imageStore || typeof imageStore.deleteAsset !== 'function') throw new TypeError('A private image store with deleteAsset is required');
    this.repository = repository;
    this.imageStore = imageStore;
    this.clock = clock;
  }

  async runOnce() {
    const job = await this.repository.claimNext();
    if (!job) return { state: 'IDLE' };
    try {
      for (const asset of job.assets) {
        if (!asset || typeof asset.asset_id !== 'string' || typeof asset.object_key !== 'string') throw new TypeError('Cleanup job contains an invalid media asset');
        await this.imageStore.deleteAsset(asset.object_key);
      }
      const receipt = {
        completed_at: this.clock(),
        deleted_asset_ids: job.assets.map((asset) => asset.asset_id),
        object_delete_count: job.assets.length
      };
      await this.repository.complete(job.event_id, receipt);
      return { state: 'COMPLETED', event_id: job.event_id, deleted_asset_count: job.assets.length };
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.repository.fail(job.event_id, message);
      return { state: 'RETRY_SCHEDULED', event_id: job.event_id, error: message };
    }
  }
}

function safeErrorMessage(error) {
  const value = error && typeof error.message === 'string' ? error.message : 'private object cleanup failed';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
}

module.exports = { ContentRightsCleanupWorker, safeErrorMessage };
