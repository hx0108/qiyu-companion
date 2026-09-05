'use strict';

// This worker owns the second model call and the derived-data commit. The API
// only enqueues a task; a worker failure must never turn a completed chat into
// a failed user request.
class ConversationSummaryWorker {
  constructor({ repository, summaryGenerator }) {
    if (!repository || typeof repository.claimNext !== 'function' || typeof repository.complete !== 'function' || typeof repository.fail !== 'function') throw new TypeError('A conversation summary repository is required');
    if (typeof summaryGenerator !== 'function') throw new TypeError('A conversation summary generator is required');
    this.repository = repository;
    this.summaryGenerator = summaryGenerator;
  }

  async runOnce() {
    const job = await this.repository.claimNext();
    if (!job) return { state: 'IDLE' };
    const modelStartedAt = Date.now();
    try {
      const generated = await this.summaryGenerator({ conversationId: job.conversation_id, previousSummary: job.previous_summary?.text || null, messages: job.pending_messages });
      if (!generated || typeof generated.text !== 'string' || !generated.text.trim() || !generated.provider || !generated.modelVersion) throw new TypeError('conversation summary generator returned invalid result');
      const result = await this.repository.complete(job, generated, Date.now() - modelStartedAt);
      return { state: result.state, job_id: job.job_id, summary_id: result.summary_id || null };
    } catch (error) {
      await this.repository.fail(job.job_id, safeErrorMessage(error), Date.now() - modelStartedAt);
      return { state: 'RETRY_SCHEDULED', job_id: job.job_id };
    }
  }
}

function safeErrorMessage(error) { return String(error?.message || 'conversation summary worker failed').replace(/[\r\n\t]+/g, ' ').slice(0, 1000); }
module.exports = { ConversationSummaryWorker, safeErrorMessage };
