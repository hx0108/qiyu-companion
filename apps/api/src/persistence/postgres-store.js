'use strict';

const { randomUUID } = require('node:crypto');
const { DevelopmentStore } = require('../domain/store');
const { PostgresRepository } = require('./postgres-repository');
const { PostgresTrialInviteAuthRepository } = require('./postgres-trial-invite-auth-repository');
const { MediaEntitlementService } = require('../domain/media-entitlement-service');
const { usageDate, usageKey } = require('../domain/daily-chat-usage');

const DEVELOPMENT_DATABASE_ACCOUNT_IDS = Object.freeze({
  acct_dev_alice: '00000000-0000-7000-8000-0000000000a1',
  acct_dev_bob: '00000000-0000-7000-8000-0000000000b2'
});

class PostgresStore {
  constructor({ pool }) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('PostgresStore requires a pg-compatible pool');
    this.pool = pool;
    this.trialAuth = new PostgresTrialInviteAuthRepository({ pool });
  }

  resolveAccountId(developmentAccountId) { return DEVELOPMENT_DATABASE_ACCOUNT_IDS[developmentAccountId]; }
  account() { return undefined; }
  createTrialSession(input) { return this.trialAuth.createSession(input); }
  resolveTrialAccessToken(token) { return this.trialAuth.resolveAccessToken(token); }
  refreshTrialSession(input) { return this.trialAuth.refreshSession(input); }

  async withAccountTransaction(accountId, operation, { lockDailyUsage = false } = {}) {
    const client = await this.pool.connect();
    const repository = new PostgresRepository(client);
    try {
      await repository.beginAccountScope(accountId);
      if (Object.values(DEVELOPMENT_DATABASE_ACCOUNT_IDS).includes(accountId)) {
        await repository.seedDevelopmentAccount(accountId, noticeIdFor(accountId));
      }
      const scopedStore = await PostgresRequestStore.load(client, accountId, { lockDailyUsage });
      // 媒体权益按请求作用域绑定：账本与订阅都在本请求加载的 store 内。
      scopedStore.mediaEntitlementService = new MediaEntitlementService({ store: scopedStore });
      const result = await operation(scopedStore);
      await scopedStore.flush();
      await repository.commit();
      return result;
    } catch (error) {
      try { await repository.rollback(); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresRequestStore extends DevelopmentStore {
  constructor(client, accountId) {
    super({ accountIds: [] });
    this.client = client;
    this.accountId = accountId;
    this.baseline = null;
    this.recallSource = 'postgres-structured-development-store';
    this.assetEmbeddingWritesDeferred = true;
  }

  resolveAccountId(developmentAccountId) { return DEVELOPMENT_DATABASE_ACCOUNT_IDS[developmentAccountId]; }

  static async load(client, accountId, { lockDailyUsage = false } = {}) {
    const store = new PostgresRequestStore(client, accountId);
    const today = usageDate(new Date());
    // Only message creation needs a row lock.  It makes quota reservation and
    // commit serial for one account/day without blocking ordinary reads.
    if (lockDailyUsage) {
      await client.query(`INSERT INTO daily_chat_usage (account_id, usage_date, chat_rounds, billed_input_tokens, reserved_input_tokens)
        VALUES ($1, $2::date, 0, 0, 0)
        ON CONFLICT (account_id, usage_date) DO NOTHING`, [accountId, today]);
    }
    // A pg Client supports one active query at a time. Keep this sequential so the
    // request's transaction stays scoped and does not rely on driver queueing.
    const queries = [
      [`SELECT a.account_id, a.account_status, a.age_status, a.retention_policy_id, a.revocation_epoch, a.proactive_preferences_json,
        c.user_pause_state, c.safety_mode, c.service_mode
        FROM accounts a JOIN account_interaction_controls c USING (account_id)
        WHERE a.account_id = $1 AND a.deleted_at IS NULL`, [accountId]],
      [`SELECT notice_id, account_id, type, notice_version, state, displayed_at
        FROM required_notices WHERE account_id = $1 AND deleted_at IS NULL ORDER BY due_at ASC LIMIT 1`, [accountId]],
      [`SELECT character_id, account_id, display_name, status, version, active_persona_version, persona_json
        FROM characters WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT character_id, version, persona_json, changed_fields, note, state, parent_version, evaluation_json, canary_json, rollback_json, created_at, updated_at
        FROM persona_versions WHERE account_id = $1 ORDER BY version ASC`, [accountId]],
      [`SELECT world_state_id, account_id, character_id, mood_code, location_code, wardrobe_asset_id, active_event_refs,
        source, state_version, expires_at, reset_at, updated_at FROM character_world_states WHERE account_id = $1`, [accountId]],
      [`SELECT event_id, world_state_id, account_id, character_id, patch_json, source_type, previous_version, new_version, occurred_at
        FROM world_state_events WHERE account_id = $1 ORDER BY occurred_at ASC, new_version ASC`, [accountId]],
      [`SELECT conversation_id, account_id, character_id, status, created_at
        FROM conversations WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT m.message_id, m.conversation_id, m.actor, convert_from(m.content_ciphertext, 'UTF8') AS text,
        m.provider, m.model_version, m.ai_generated, m.world_state_id, m.world_state_version, m.created_at, m.retention_expires_at FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
        WHERE c.account_id = $1 AND m.deleted_at IS NULL`, [accountId]],
      [`SELECT summary_id, account_id, conversation_id, source_from_id, source_to_id, convert_from(summary_ciphertext, 'UTF8') AS text,
        model_route_id, prompt_version, source_checksum, revocation_epoch, state, created_at, invalidated_at, retention_expires_at
        FROM conversation_summaries WHERE account_id = $1`, [accountId]],
      [`SELECT job_id, account_id, conversation_id, source_to_id, captured_revocation_epoch, state, attempt_count,
        next_attempt_at, last_error, created_at, completed_at FROM conversation_summary_jobs WHERE account_id = $1`, [accountId]],
      [`SELECT event_id, account_id, character_id, aggregate_type, aggregate_id, event_type, payload_json, occurred_at
        FROM outbox_events WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT candidate_id, account_id, character_id, state, version, type, normalized_value, display_text,
        provider, expires_at, source_message_id FROM memory_candidates WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT asset_id, account_id, character_id, type, value_json, display_text, state, index_state, version,
        source_candidate_id, superseded_by, created_at, deleted_at FROM relationship_assets WHERE account_id = $1`, [accountId]],
      [`SELECT job_id, account_id, character_id, conversation_id, source_message_id, input_asset_id, reference_asset_id, entitlement_id, type, state, attempts,
        provider, provider_request_id, provider_job_id, moderation_policy_version, result_asset_id, transcript_text, transcript_state, failure_code, provider_error_code, world_state_id, world_state_version, scene_contract, voice_id, voice_version, authorization_record_id, rights_review_id, rights_review_state, created_at
        FROM media_jobs WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT asset_id, account_id, character_id, job_id, type, state, media_type, mime_type, byte_length,
        checksum, object_key, provider, provider_request_id, ai_generated, aigc_mark_version, confirmation_state, moderation_policy_version, failure_code, created_at, deleted_at, rights_review_id
        FROM media_assets WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT entitlement_ledger_id, account_id, entitlement_id, capability, action, job_id, quantity, reserved_quantity,
        idempotency_key, source, source_event_id, created_at
        FROM entitlement_ledgers WHERE account_id = $1 ORDER BY created_at ASC, entitlement_ledger_id ASC`, [accountId]],
      [`SELECT subscription_id, account_id, sku, channel, state, auto_renew, disclosure_version, period_start, period_end,
        grace_period_end, refund_status, transaction_ref_hash, created_at, updated_at
        FROM subscriptions WHERE account_id = $1 ORDER BY created_at ASC`, [accountId]],
      [`SELECT order_id, account_id, subscription_id, sku, amount_fen, currency, state, channel, auto_renew, disclosure_version, created_at
        FROM subscription_orders WHERE account_id = $1 ORDER BY created_at ASC`, [accountId]],
      [`SELECT provider_event_id, account_id, subscription_id, event_type, transaction_ref_hash, event_hash, outcome, quarantine_reason, effective_at
        FROM payment_events WHERE account_id = $1 ORDER BY created_at ASC`, [accountId]],
      [`SELECT q.provider_event_id, q.reason, q.received_at, q.resolved_at, q.resolution_note
        FROM payment_event_quarantines q JOIN payment_events e USING (provider_event_id)
        WHERE e.account_id = $1 ORDER BY q.received_at ASC`, [accountId]],
      [`SELECT deletion_job_id, account_id, asset_id, scope, state, revocation_epoch,
        physical_cleanup_state, backup_deadline, receipt_version, created_at, note FROM deletion_jobs WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT deletion_target_id, deletion_job_id, account_id, target_type, target_ref, state, attempts,
        provider_receipt, last_error_code, created_at, updated_at FROM deletion_targets WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT account_id, contact_name, relationship, phone, consent_version, updated_at
        FROM emergency_contacts WHERE account_id = $1`, [accountId]],
      [`SELECT complaint_id, account_id, kind, target_resource_id, description, state, resolution_note, created_at, updated_at
        FROM complaints WHERE account_id = $1 ORDER BY created_at ASC`, [accountId]],
      [`SELECT event_id, account_id, character_id, type, title, due_at, time_of_day_local, state, created_at
        FROM proactive_events WHERE account_id = $1`, [accountId]],
      [`SELECT message_id, account_id, character_id, event_id, kind, template_slot, text, sent_at
        FROM proactive_messages WHERE account_id = $1 ORDER BY sent_at ASC`, [accountId]],
      [`SELECT account_id, usage_date, chat_rounds, billed_input_tokens, reserved_input_tokens, updated_at
        FROM daily_chat_usage WHERE account_id = $1 AND usage_date = $2::date${lockDailyUsage ? ' FOR UPDATE' : ''}`, [accountId, today]],
      [`SELECT metric_id, account_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome, created_at
        FROM operation_metrics WHERE account_id = $1 ORDER BY created_at ASC, metric_id ASC`, [accountId]],
      [`SELECT request_method, request_path, idempotency_key, encode(request_hash, 'hex') AS body_hash,
        response_status, response_body FROM idempotency_keys WHERE account_id = $1 AND deleted_at IS NULL`, [accountId]],
      [`SELECT feedback_id, account_id, message_id, conversation_id, type, severity, note, provider, model_version,
        world_state_id, world_state_version, created_at FROM message_feedback WHERE account_id = $1 ORDER BY created_at ASC`, [accountId]]
      , [`SELECT import_id, account_id, convert_from(source_bytes, 'UTF8') AS source_text, declaration_version, state, proposed_persona, created_at, retention_expires_at
        FROM oc_imports WHERE account_id = $1 AND retention_expires_at > CURRENT_TIMESTAMP`, [accountId]]
      , [`SELECT review_id, account_id, subject_type, subject_ref, declaration_version, risk_codes, state, reviewer_id, decision_reason, created_at, updated_at
        FROM content_rights_reviews WHERE account_id = $1`, [accountId]]
      , [`SELECT appeal_id, account_id, review_id, statement, state, created_at FROM content_rights_appeals WHERE account_id = $1`, [accountId]]
      , [`SELECT decision_id, review_id, account_id, reviewer_id, decision, reason, decided_at
        FROM content_rights_review_decisions WHERE account_id = $1 ORDER BY decided_at ASC`, [accountId]]
      , [`SELECT decision_id, account_id, reviewer_id, decision, reason, created_at
        FROM age_review_decisions WHERE account_id = $1 ORDER BY created_at ASC`, [accountId]]
      , [`SELECT job_id, account_id, character_id, asset_id, asset_version, state, attempt_count,
        next_attempt_at, exhausted_at, last_error, created_at, completed_at FROM asset_embedding_jobs WHERE account_id = $1`, [accountId]]
      , [`SELECT dead_letter_id, job_id, account_id, asset_id, attempt_count, error_code, state, replay_count,
        occurred_at, last_replayed_at, last_replayed_by, last_replay_reason_sha256 FROM asset_embedding_dead_letters WHERE account_id = $1`, [accountId]]
      , [`SELECT asset_id, account_id, character_id, embedding::text AS embedding_text, embedding_model_version, created_at, updated_at, version
        FROM relationship_asset_embeddings WHERE account_id = $1`, [accountId]]
      , [`SELECT feedback_id, account_id, category, rating, note, created_at FROM trial_feedback
        WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]]
    ];
    const results = [];
    for (const [sql, values] of queries) results.push(await client.query(sql, values));
    const [accountRows, noticeRows, characterRows, personaVersionRows, worldStateRows, worldStateEventRows, conversationRows, messageRows, conversationSummaryRows, conversationSummaryJobRows, outboxEventRows, candidateRows, assetRows, mediaJobRows, mediaAssetRows, entitlementLedgerRows, subscriptionRows, subscriptionOrderRows, paymentEventRows, paymentQuarantineRows, deletionRows, deletionTargetRows, contactRows, complaintRows, proactiveEventRows, proactiveMessageRows, dailyUsageRows, operationMetricRows, idempotencyRows, messageFeedbackRows, ocImportRows, contentRightsReviewRows, contentRightsAppealRows, contentRightsDecisionRows, ageReviewDecisionRows, assetEmbeddingJobRows, assetEmbeddingDeadLetterRows, assetEmbeddingRows, trialFeedbackRows] = results.map((result) => result.rows);
    const account = accountRows[0];
    if (!account) throw new Error('Scoped development account was not available after seed');
    store.accounts.set(account.account_id, {
      account_id: account.account_id, account_status: account.account_status, age_status: account.age_status,
      raw_interaction_retention_days: account.retention_policy_id === 'RETENTION_90D' ? 90 : 30,
      user_pause_state: account.user_pause_state, safety_mode: account.safety_mode, service_mode: account.service_mode,
      revocation_epoch: Number(account.revocation_epoch), required_notice: mapNotice(noticeRows[0]),
      emergency_contact: contactRows[0] ? { contact_name: contactRows[0].contact_name, relationship: contactRows[0].relationship, phone: contactRows[0].phone, consent_version: contactRows[0].consent_version, updated_at: contactRows[0].updated_at } : null,
      interaction_activity: { first_heartbeat_at: null, last_heartbeat_at: null, last_reminder_at: null },
      proactive_preferences: parseJson(account.proactive_preferences_json) ?? { enabled: true, quiet_start_hour: 23, quiet_end_hour: 8, timezone_offset_minutes: 0 }
    });
    for (const row of complaintRows) store.complaints.set(row.complaint_id, { complaint_id: row.complaint_id, account_id: row.account_id, kind: row.kind, target_resource_id: row.target_resource_id, description: row.description, state: row.state, resolution_note: row.resolution_note, created_at: row.created_at, updated_at: row.updated_at });
    for (const row of proactiveEventRows) store.proactiveEvents.set(row.event_id, { event_id: row.event_id, account_id: row.account_id, character_id: row.character_id, type: row.type, title: row.title, due_at: row.due_at ? row.due_at.toISOString() : null, time_of_day_local: row.time_of_day_local === null ? null : Number(row.time_of_day_local), state: row.state, created_at: row.created_at });
    for (const row of proactiveMessageRows) store.proactiveMessages.set(row.message_id, { message_id: row.message_id, account_id: row.account_id, character_id: row.character_id, event_id: row.event_id, kind: row.kind, template_slot: row.template_slot, text: row.text, sent_at: row.sent_at });
    for (const row of dailyUsageRows) {
      const day = databaseDate(row.usage_date);
      store.dailyChatUsage.set(usageKey(row.account_id, `${day}T00:00:00+08:00`), {
        account_id: row.account_id, usage_date: day, chat_rounds: Number(row.chat_rounds),
        billed_input_tokens: Number(row.billed_input_tokens), reserved_input_tokens: Number(row.reserved_input_tokens),
        updated_at: dateTimeValue(row.updated_at)
      });
    }
    for (const row of operationMetricRows) store.operationMetrics.set(row.metric_id, {
      metric_id: row.metric_id, account_id: row.account_id, capability: row.capability, provider: row.provider,
      model_version: row.model_version, input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens),
      latency_ms: Number(row.latency_ms), outcome: row.outcome, created_at: dateTimeValue(row.created_at)
    });
    for (const row of characterRows) store.characters.set(row.character_id, { character_id: row.character_id, account_id: row.account_id, name: row.display_name, status: row.status, version: Number(row.version), active_persona_version: Number(row.active_persona_version ?? row.version), persona: parseJson(row.persona_json) ?? {}, persona_history: [] });
    for (const row of personaVersionRows) {
      const character = store.characters.get(row.character_id);
      if (character) character.persona_history.push({ version: Number(row.version), persona: parseJson(row.persona_json) ?? {}, changed_fields: row.changed_fields ?? [], note: row.note ?? '', state: row.state || 'STABLE', parent_version: row.parent_version === null || row.parent_version === undefined ? null : Number(row.parent_version), evaluation: parseJson(row.evaluation_json), canary: parseJson(row.canary_json), rollback: parseJson(row.rollback_json), created_at: dateTimeValue(row.created_at), updated_at: dateTimeValue(row.updated_at ?? row.created_at) });
    }
    for (const character of store.characters.values()) character.persona_history.sort((a, b) => a.version - b.version);
    for (const row of worldStateRows) store.worldStates.set(row.character_id, { world_state_id: row.world_state_id, account_id: row.account_id, character_id: row.character_id, mood_code: row.mood_code, location_code: row.location_code, wardrobe_asset_id: row.wardrobe_asset_id, active_event_refs: parseJson(row.active_event_refs) ?? [], source: row.source, state_version: Number(row.state_version), expires_at: row.expires_at ? dateTimeValue(row.expires_at) : null, reset_at: dateTimeValue(row.reset_at), updated_at: dateTimeValue(row.updated_at) });
    for (const row of worldStateEventRows) store.worldStateEvents.set(row.event_id, { event_id: row.event_id, world_state_id: row.world_state_id, account_id: row.account_id, character_id: row.character_id, patch: parseJson(row.patch_json) ?? {}, source_type: row.source_type, previous_version: Number(row.previous_version), new_version: Number(row.new_version), occurred_at: dateTimeValue(row.occurred_at) });
    for (const row of conversationRows) store.conversations.set(row.conversation_id, { conversation_id: row.conversation_id, account_id: row.account_id, character_id: row.character_id, status: mapConversationState(row.status), created_at: row.created_at });
    for (const row of messageRows) store.messages.set(row.message_id, { message_id: row.message_id, conversation_id: row.conversation_id, actor: row.actor, text: row.text, provider: row.provider, model_version: row.model_version, ai_generated: row.ai_generated, world_state_id: row.world_state_id, world_state_version: row.world_state_version === null ? null : Number(row.world_state_version), created_at: row.created_at, retention_expires_at: row.retention_expires_at ? dateTimeValue(row.retention_expires_at) : null });
    for (const row of conversationSummaryRows) store.conversationSummaries.set(row.summary_id, { summary_id: row.summary_id, account_id: row.account_id, conversation_id: row.conversation_id, source_from_id: row.source_from_id, source_to_id: row.source_to_id, text: row.text, model_route_id: row.model_route_id, prompt_version: row.prompt_version, source_checksum: row.source_checksum, revocation_epoch: Number(row.revocation_epoch), state: row.state, created_at: dateTimeValue(row.created_at), invalidated_at: row.invalidated_at ? dateTimeValue(row.invalidated_at) : null, retention_expires_at: dateTimeValue(row.retention_expires_at) });
    for (const row of conversationSummaryJobRows) store.conversationSummaryJobs.set(row.job_id, { job_id: row.job_id, account_id: row.account_id, conversation_id: row.conversation_id, source_to_id: row.source_to_id, captured_revocation_epoch: Number(row.captured_revocation_epoch), state: row.state, attempt_count: Number(row.attempt_count), next_attempt_at: dateTimeValue(row.next_attempt_at), last_error: row.last_error, created_at: dateTimeValue(row.created_at), completed_at: row.completed_at ? dateTimeValue(row.completed_at) : null });
    for (const row of outboxEventRows) store.outboxEvents.set(row.event_id, { event_id: row.event_id, account_id: row.account_id, character_id: row.character_id, aggregate_type: row.aggregate_type, aggregate_id: row.aggregate_id, event_type: row.event_type, payload: parseJson(row.payload_json) ?? {}, occurred_at: dateTimeValue(row.occurred_at) });
    for (const row of candidateRows) store.candidates.set(row.candidate_id, { candidate_id: row.candidate_id, account_id: row.account_id, character_id: row.character_id, state: row.state, version: Number(row.version), type: row.type, normalized_value: parseJson(row.normalized_value), display_text: row.display_text, provider: row.provider, expires_at: row.expires_at, source_message_id: row.source_message_id });
    for (const row of assetRows) {
      const asset = { asset_id: row.asset_id, account_id: row.account_id, character_id: row.character_id, type: row.type, value: row.value_json, display_text: row.display_text, state: row.state, index_state: row.index_state || 'PENDING', version: Number(row.version), source_candidate_id: row.source_candidate_id, created_at: row.created_at, deleted_at: row.deleted_at };
      if (row.superseded_by) asset.superseded_by = row.superseded_by;
      store.assets.set(row.asset_id, asset);
    }
    for (const row of mediaJobRows) store.mediaJobs.set(row.job_id, { job_id: row.job_id, account_id: row.account_id, character_id: row.character_id, conversation_id: row.conversation_id, source_message_id: row.source_message_id, input_asset_id: row.input_asset_id, reference_asset_id: row.reference_asset_id, entitlement_id: row.entitlement_id, type: row.type, state: row.state, attempts: Number(row.attempts), provider: row.provider, provider_request_id: row.provider_request_id, provider_job_id: row.provider_job_id, moderation_policy_version: row.moderation_policy_version, result_asset_id: row.result_asset_id, transcript_text: row.transcript_text, transcript_state: row.transcript_state, failure_code: row.failure_code, provider_error_code: row.provider_error_code, world_state_id: row.world_state_id, world_state_version: row.world_state_version === null ? null : Number(row.world_state_version), scene_contract: row.scene_contract, voice_id: row.voice_id, voice_version: row.voice_version, authorization_record_id: row.authorization_record_id, rights_review_id: row.rights_review_id, rights_review_state: row.rights_review_state, created_at: row.created_at });
    for (const row of mediaAssetRows) store.mediaAssets.set(row.asset_id, { asset_id: row.asset_id, account_id: row.account_id, character_id: row.character_id, job_id: row.job_id, type: row.type, state: row.state, media_type: row.media_type, mime_type: row.mime_type, byte_length: Number(row.byte_length), checksum: row.checksum, object_key: row.object_key, provider: row.provider, provider_request_id: row.provider_request_id, ai_generated: row.ai_generated, aigc_mark_version: row.aigc_mark_version, confirmation_state: row.confirmation_state, moderation_policy_version: row.moderation_policy_version, failure_code: row.failure_code, created_at: row.created_at, deleted_at: row.deleted_at, rights_review_id: row.rights_review_id });
    for (const row of entitlementLedgerRows) store.entitlementLedgers.set(row.entitlement_ledger_id, { entitlement_ledger_id: row.entitlement_ledger_id, account_id: row.account_id, entitlement_id: row.entitlement_id, capability: row.capability, action: row.action, job_id: row.job_id, quantity: Number(row.quantity), reserved_quantity: row.reserved_quantity === null ? null : Number(row.reserved_quantity), idempotency_key: row.idempotency_key, source: row.source, source_event_id: row.source_event_id, created_at: row.created_at });
    // node-postgres returns timestamptz columns as Date objects by default.
    // Domain entitlement checks intentionally use ISO strings, so normalize at
    // the persistence boundary; otherwise a valid trial is treated as expired
    // on the request immediately after it was granted.
    for (const row of subscriptionRows) store.subscriptions.set(row.subscription_id, {
      subscription_id: row.subscription_id, account_id: row.account_id, sku: row.sku, channel: row.channel, state: row.state,
      auto_renew: row.auto_renew, disclosure_version: row.disclosure_version,
      period_start: dateTimeValue(row.period_start), period_end: dateTimeValue(row.period_end),
      grace_period_end: row.grace_period_end ? dateTimeValue(row.grace_period_end) : null,
      refund_status: row.refund_status, transaction_ref_hash: row.transaction_ref_hash,
      created_at: dateTimeValue(row.created_at), updated_at: dateTimeValue(row.updated_at)
    });
    for (const row of subscriptionOrderRows) store.subscriptionOrders.set(row.order_id, { order_id: row.order_id, account_id: row.account_id, subscription_id: row.subscription_id, sku: row.sku, amount_fen: Number(row.amount_fen), currency: row.currency, state: row.state, channel: row.channel, auto_renew: row.auto_renew, disclosure_version: row.disclosure_version, created_at: row.created_at });
    for (const row of paymentEventRows) {
      const result = Object.freeze({ outcome: row.outcome, reason: row.quarantine_reason || undefined, subscription: row.outcome === 'APPLIED' ? store.subscriptions.get(row.subscription_id) || null : null, entitlement_grant: null });
      store.paymentEvents.set(row.provider_event_id, { provider_event_id: row.provider_event_id, account_id: row.account_id, subscription_id: row.subscription_id, event_type: row.event_type, transaction_ref_hash: row.transaction_ref_hash, event_hash: row.event_hash, outcome: row.outcome, quarantine_reason: row.quarantine_reason, effective_at: row.effective_at, result });
      if (row.outcome === 'APPLIED') store.paymentTransactionOwners.set(row.transaction_ref_hash, row.account_id);
    }
    for (const row of paymentQuarantineRows) store.paymentEventQuarantines.set(row.provider_event_id, { provider_event_id: row.provider_event_id, reason: row.reason, received_at: row.received_at, resolved_at: row.resolved_at, resolution_note: row.resolution_note });
    for (const row of deletionRows) store.deletionJobs.set(row.deletion_job_id, { deletion_job_id: row.deletion_job_id, account_id: row.account_id, asset_id: row.asset_id, scope: row.scope, state: row.state, revocation_epoch: Number(row.revocation_epoch), physical_cleanup_state: row.physical_cleanup_state, backup_deadline: row.backup_deadline ? dateTimeValue(row.backup_deadline) : null, receipt_version: row.receipt_version, created_at: row.created_at, note: row.note });
    for (const row of deletionTargetRows) store.deletionTargets.set(row.deletion_target_id, { deletion_target_id: row.deletion_target_id, deletion_job_id: row.deletion_job_id, account_id: row.account_id, target_type: row.target_type, target_ref: row.target_ref, state: row.state, attempts: Number(row.attempts), provider_receipt: row.provider_receipt, last_error_code: row.last_error_code, created_at: row.created_at, updated_at: row.updated_at });
    for (const row of idempotencyRows) store.idempotency.set(store.idempotencyKey(accountId, row.request_method, row.request_path, row.idempotency_key), { bodyHash: row.body_hash, result: { status: row.response_status, body: row.response_body } });
    for (const row of messageFeedbackRows) store.messageFeedback.set(row.feedback_id, { feedback_id: row.feedback_id, account_id: row.account_id, message_id: row.message_id, conversation_id: row.conversation_id, type: row.type, severity: row.severity, note: row.note, provider: row.provider, model_version: row.model_version, world_state_id: row.world_state_id, world_state_version: row.world_state_version === null ? null : Number(row.world_state_version), created_at: dateTimeValue(row.created_at) });
    for (const row of trialFeedbackRows) store.trialFeedback.set(row.feedback_id, { feedback_id: row.feedback_id, account_id: row.account_id, category: row.category, rating: Number(row.rating), note: row.note, created_at: dateTimeValue(row.created_at) });
    for (const row of ocImportRows) store.ocImports.set(row.import_id, { import_id: row.import_id, account_id: row.account_id, source_text: row.source_text, declaration_version: row.declaration_version, state: row.state, proposed_persona: parseJson(row.proposed_persona) ?? {}, created_at: dateTimeValue(row.created_at), retention_expires_at: dateTimeValue(row.retention_expires_at) });
    for (const row of contentRightsReviewRows) store.contentRightsReviews.set(row.review_id, { review_id: row.review_id, account_id: row.account_id, subject_type: row.subject_type, subject_ref: row.subject_ref, declaration_version: row.declaration_version, risk_codes: row.risk_codes ?? [], state: row.state, reviewer_id: row.reviewer_id, decision_reason: row.decision_reason, created_at: dateTimeValue(row.created_at), updated_at: dateTimeValue(row.updated_at) });
    for (const row of contentRightsAppealRows) store.contentRightsAppeals.set(row.appeal_id, { appeal_id: row.appeal_id, account_id: row.account_id, review_id: row.review_id, statement: row.statement, state: row.state, created_at: dateTimeValue(row.created_at) });
    for (const row of contentRightsDecisionRows) store.contentRightsDecisions.set(row.decision_id, { decision_id: row.decision_id, review_id: row.review_id, account_id: row.account_id, reviewer_id: row.reviewer_id, decision: row.decision, reason: row.reason, decided_at: dateTimeValue(row.decided_at) });
    for (const row of ageReviewDecisionRows) store.ageReviewDecisions.set(row.decision_id, { decision_id: row.decision_id, account_id: row.account_id, reviewer_id: row.reviewer_id, decision: row.decision, reason: row.reason, created_at: dateTimeValue(row.created_at) });
    for (const row of assetEmbeddingJobRows) store.assetEmbeddingJobs.set(row.job_id, { job_id: row.job_id, account_id: row.account_id, character_id: row.character_id, asset_id: row.asset_id, asset_version: Number(row.asset_version), state: row.state, attempt_count: Number(row.attempt_count), next_attempt_at: dateTimeValue(row.next_attempt_at), exhausted_at: row.exhausted_at ? dateTimeValue(row.exhausted_at) : null, last_error: row.last_error, created_at: dateTimeValue(row.created_at), completed_at: row.completed_at ? dateTimeValue(row.completed_at) : null });
    for (const row of assetEmbeddingDeadLetterRows) store.assetEmbeddingDeadLetters.set(row.dead_letter_id, { dead_letter_id: row.dead_letter_id, job_id: row.job_id, account_id: row.account_id, asset_id: row.asset_id, attempt_count: Number(row.attempt_count), error_code: row.error_code, state: row.state, replay_count: Number(row.replay_count), occurred_at: dateTimeValue(row.occurred_at), last_replayed_at: row.last_replayed_at ? dateTimeValue(row.last_replayed_at) : null, last_replayed_by: row.last_replayed_by, last_replay_reason_sha256: row.last_replay_reason_sha256 });
    for (const row of assetEmbeddingRows) {
      let embedding = null;
      try {
        // pgvector 的 text 形如 "[0.1,0.2,...]"，本身是合法 JSON 数组。
        embedding = row.embedding_text ? JSON.parse(String(row.embedding_text).replace(/\s+/g, '')).map(Number) : null;
      } catch { embedding = null; }
      if (Array.isArray(embedding)) store.assetEmbeddings.set(row.asset_id, { asset_id: row.asset_id, account_id: row.account_id, character_id: row.character_id, embedding, embedding_model_version: row.embedding_model_version, created_at: dateTimeValue(row.created_at), updated_at: dateTimeValue(row.updated_at), version: Number(row.version) });
    }
    store.baseline = snapshot(store);
    return store;
  }

  next() { return randomUUID(); }

  // 语义向量召回（P1-4）：向量维度随 provider 声明（开发 256 / Qwen 1024 等），
  // 但查询向量与存储向量必须同 embedding_model_version——不同版本的向量空间
  // 不可比，版本不一致的资产由 WHERE 直接排除（回退词法召回由上层负责）。
  async rankActiveAssetsByVector({ accountId, characterId, queryVector, embeddingModelVersion, limit = 20 } = {}) {
    if (accountId !== this.accountId || !characterId || !Array.isArray(queryVector) || queryVector.length === 0 || queryVector.length > 2048 || queryVector.some((value) => !Number.isFinite(value))) return [];
    if (typeof embeddingModelVersion !== 'string' || !embeddingModelVersion.trim()) return [];
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : 20;
    const literal = '[' + queryVector.join(',') + ']';
    const result = await this.client.query(`SELECT embedding.asset_id,
      (embedding.embedding::vector <=> $3::vector)::double precision AS distance
      FROM relationship_asset_embeddings AS embedding
      JOIN relationship_assets AS asset
        ON asset.asset_id = embedding.asset_id
       AND asset.account_id = embedding.account_id
       AND asset.character_id = embedding.character_id
      WHERE embedding.account_id = $1
        AND embedding.character_id = $2
        AND embedding.deleted_at IS NULL
        AND embedding.embedding_model_version = $4
        AND asset.account_id = $1
        AND asset.character_id = $2
        AND asset.state = 'ACTIVE'
        AND asset.deleted_at IS NULL
        AND asset.index_state = 'READY'
        AND asset.version = embedding.version
      ORDER BY embedding.embedding::vector <=> $3::vector, embedding.asset_id
      LIMIT $5`, [this.accountId, characterId, literal, embeddingModelVersion, safeLimit]);
    return result.rows
      .map((row) => ({ asset_id: row.asset_id, score: 1 - Number(row.distance) }))
      .filter((row) => row.asset_id && Number.isFinite(row.score));
  }

  async flush() {
    const before = this.baseline;
    const account = this.account(this.accountId);
    if (changed(before.accounts.get(this.accountId), account)) {
      await this.client.query('UPDATE accounts SET age_status = $2, retention_policy_id = $3, revocation_epoch = $4, account_status = $5, proactive_preferences_json = $6::jsonb WHERE account_id = $1', [this.accountId, account.age_status, account.raw_interaction_retention_days === 90 ? 'RETENTION_90D' : 'RETENTION_30D', account.revocation_epoch, account.account_status, JSON.stringify(account.proactive_preferences ?? {})]);
      await this.client.query('UPDATE account_interaction_controls SET safety_mode = $2 WHERE account_id = $1', [this.accountId, account.safety_mode]);
      await this.client.query('UPDATE required_notices SET state = $2, displayed_at = $3 WHERE notice_id = $1 AND account_id = $4', [account.required_notice.notice_id, mapNoticeState(account.required_notice.state), account.required_notice.displayed_at, this.accountId]);
      await syncEmergencyContact(this.client, this.accountId, account);
    }
    await syncRows(this.client, this.complaints, before.complaints, persistComplaint);
    await syncRows(this.client, this.proactiveEvents, before.proactiveEvents, persistProactiveEvent);
    await syncRows(this.client, this.proactiveMessages, before.proactiveMessages, persistProactiveMessage);
    await syncRows(this.client, this.dailyChatUsage, before.dailyChatUsage, persistDailyChatUsage);
    assertAppendOnly(before.operationMetrics, this.operationMetrics);
    await syncRows(this.client, this.operationMetrics, before.operationMetrics, persistOperationMetric);
    const retentionDays = account.raw_interaction_retention_days === 90 ? 90 : 30;
    await syncRows(this.client, this.characters, before.characters, persistCharacter);
    await syncRows(this.client, this.worldStates, before.worldStates, persistWorldState);
    assertAppendOnly(before.worldStateEvents, this.worldStateEvents);
    await syncRows(this.client, this.worldStateEvents, before.worldStateEvents, persistWorldStateEvent);
    await syncRows(this.client, this.conversations, before.conversations, (client, item, exists) => persistConversation(client, item, exists, retentionDays));
    await syncRows(this.client, this.conversationSummaries, before.conversationSummaries, persistConversationSummary, deleteConversationSummary);
    await syncRows(this.client, this.conversationSummaryJobs, before.conversationSummaryJobs, persistConversationSummaryJob);
    assertAppendOnly(before.outboxEvents, this.outboxEvents);
    await syncRows(this.client, this.outboxEvents, before.outboxEvents, persistOutboxEvent);
    await syncRows(this.client, this.messages, before.messages, (client, item, exists) => persistMessage(client, item, exists, retentionDays), deleteMessage);
    await syncRows(this.client, this.candidates, before.candidates, persistCandidate);
    await syncRows(this.client, this.assets, before.assets, persistAsset);
    // OC reviews can reference an import or a reference-image id. Insert the
    // import first, then its review, so reference media can safely carry the
    // rights_review_id foreign key in the same transaction.
    await syncRows(this.client, this.ocImports, before.ocImports, persistOcImport, deleteOcImport);
    await syncRows(this.client, this.contentRightsReviews, before.contentRightsReviews, persistContentRightsReview);
    await syncRows(this.client, this.contentRightsAppeals, before.contentRightsAppeals, persistContentRightsAppeal);
    assertAppendOnly(before.contentRightsDecisions, this.contentRightsDecisions);
    await syncRows(this.client, this.contentRightsDecisions, before.contentRightsDecisions, persistContentRightsDecision);
    assertAppendOnly(before.ageReviewDecisions, this.ageReviewDecisions);
    await syncRows(this.client, this.ageReviewDecisions, before.ageReviewDecisions, persistAgeReviewDecision);
    await syncRows(this.client, this.assetEmbeddingJobs, before.assetEmbeddingJobs, persistAssetEmbeddingJob);
    await syncRows(this.client, this.assetEmbeddingDeadLetters, before.assetEmbeddingDeadLetters, persistAssetEmbeddingDeadLetter);
    for (const assetId of before.assetEmbeddings.keys()) if (!this.assetEmbeddings.has(assetId)) await this.client.query('DELETE FROM relationship_asset_embeddings WHERE asset_id = $1 AND account_id = $2', [assetId, this.accountId]);
    await syncRows(this.client, this.assetEmbeddings, before.assetEmbeddings, persistAssetEmbedding);
    await syncRows(this.client, this.mediaJobs, before.mediaJobs, persistMediaJob);
    await syncRows(this.client, this.mediaAssets, before.mediaAssets, persistMediaAsset);
    assertAppendOnly(before.entitlementLedgers, this.entitlementLedgers);
    await syncRows(this.client, this.entitlementLedgers, before.entitlementLedgers, persistEntitlementLedger);
    await syncRows(this.client, this.subscriptions, before.subscriptions, persistSubscription);
    await syncRows(this.client, this.subscriptionOrders, before.subscriptionOrders, persistSubscriptionOrder);
    assertAppendOnly(before.paymentEvents, this.paymentEvents);
    await syncRows(this.client, this.paymentEvents, before.paymentEvents, persistPaymentEvent);
    assertAppendOnly(before.paymentEventQuarantines, this.paymentEventQuarantines);
    await syncRows(this.client, this.paymentEventQuarantines, before.paymentEventQuarantines, persistPaymentQuarantine);
    await syncRows(this.client, this.deletionJobs, before.deletionJobs, persistDeletionJob);
    await syncRows(this.client, this.deletionTargets, before.deletionTargets, persistDeletionTarget);
    await syncRows(this.client, this.messageFeedback, before.messageFeedback, persistMessageFeedback);
    await syncRows(this.client, this.trialFeedback, before.trialFeedback, persistTrialFeedback);
    await syncIdempotency(this.client, this, before.idempotency);
  }
}

async function syncRows(client, current, previous, persist, remove) {
  for (const [id, item] of current) if (changed(previous.get(id), item)) await persist(client, item, previous.has(id));
  if (remove) for (const [id, item] of previous) if (!current.has(id)) await remove(client, item);
}
function assertAppendOnly(previous, current) {
  for (const [id, oldEntry] of previous) {
    const entry = current.get(id);
    if (!entry || changed(oldEntry, entry)) throw new Error('Entitlement ledger entries are append-only');
  }
}
async function persistCharacter(client, item, exists) {
  const personaJson = JSON.stringify(item.persona ?? {});
  const result = exists
    ? await client.query('UPDATE characters SET display_name = $3, status = $4, persona_json = $5::jsonb, active_persona_version = $6 WHERE character_id = $1 AND account_id = $2', [item.character_id, item.account_id, item.name, item.status, personaJson, item.active_persona_version ?? item.version])
    : await client.query("INSERT INTO characters (character_id, account_id, display_name, status, persona_json, active_persona_version) VALUES ($1, $2, $3, 'ACTIVE', $4::jsonb, $5)", [item.character_id, item.account_id, item.name, personaJson, item.active_persona_version ?? item.version]);
  for (const entry of item.persona_history ?? []) {
    await client.query(`INSERT INTO persona_versions (character_id, account_id, version, persona_json, changed_fields, note, state, parent_version, evaluation_json, canary_json, rollback_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, COALESCE($12::timestamptz, CURRENT_TIMESTAMP), COALESCE($13::timestamptz, CURRENT_TIMESTAMP))
      ON CONFLICT (character_id, version) DO NOTHING`,
      [item.character_id, item.account_id, entry.version, JSON.stringify(entry.persona ?? {}), entry.changed_fields ?? [], entry.note ?? '', entry.state || 'STABLE', entry.parent_version ?? null, entry.evaluation ? JSON.stringify(entry.evaluation) : null, entry.canary ? JSON.stringify(entry.canary) : null, entry.rollback ? JSON.stringify(entry.rollback) : null, entry.created_at || null, entry.updated_at || null]);
  }
  return result;
}
async function persistWorldState(client, item, exists) {
  const values = [item.world_state_id, item.account_id, item.character_id, item.mood_code, item.location_code, item.wardrobe_asset_id || null, JSON.stringify(item.active_event_refs ?? []), item.source, item.state_version, item.expires_at || null, item.reset_at, item.updated_at];
  if (exists) return client.query(`UPDATE character_world_states SET mood_code = $4, location_code = $5, wardrobe_asset_id = $6, active_event_refs = $7::jsonb,
    source = $8, state_version = $9, expires_at = $10::timestamptz, reset_at = $11::timestamptz, updated_at = $12::timestamptz
    WHERE world_state_id = $1 AND account_id = $2 AND character_id = $3`, values);
  return client.query(`INSERT INTO character_world_states (world_state_id, account_id, character_id, mood_code, location_code, wardrobe_asset_id, active_event_refs, source, state_version, expires_at, reset_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz, $11::timestamptz, $12::timestamptz)`, values);
}
async function persistWorldStateEvent(client, item, exists) {
  if (exists) return;
  return client.query(`INSERT INTO world_state_events (event_id, world_state_id, account_id, character_id, patch_json, source_type, previous_version, new_version, occurred_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz)`,
  [item.event_id, item.world_state_id, item.account_id, item.character_id, JSON.stringify(item.patch ?? {}), item.source_type, item.previous_version, item.new_version, item.occurred_at]);
}
async function persistConversation(client, item, exists, retentionDays) {
  if (exists) return client.query('UPDATE conversations SET status = $2, deleted_at = $3 WHERE conversation_id = $1 AND account_id = $4', [item.conversation_id, mapConversationStatus(item.status), item.deleted_at || null, item.account_id]);
  return client.query("INSERT INTO conversations (conversation_id, account_id, character_id, status, created_at, retention_expires_at) VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, CURRENT_TIMESTAMP), COALESCE($5::timestamptz, CURRENT_TIMESTAMP) + make_interval(days => $6))", [item.conversation_id, item.account_id, item.character_id, mapConversationStatus(item.status), item.created_at || null, retentionDays]);
}
async function persistMessage(client, item, exists, retentionDays) {
  if (exists) return;
  return client.query("INSERT INTO messages (message_id, conversation_id, actor, content_ciphertext, created_at, retention_expires_at, provider, model_version, ai_generated, world_state_id, world_state_version) VALUES ($1, $2, $3, convert_to($4, 'UTF8'), COALESCE($5::timestamptz, CURRENT_TIMESTAMP), COALESCE($5::timestamptz, CURRENT_TIMESTAMP) + make_interval(days => $6), $7, $8, $9, $10, $11)", [item.message_id, item.conversation_id, item.actor, item.text, item.created_at || null, retentionDays, item.provider || null, item.model_version || null, Boolean(item.ai_generated), item.world_state_id || null, item.world_state_version || null]);
}
async function persistMessageFeedback(client, item, exists) {
  if (exists) throw new Error('Message feedback is append-only');
  return client.query('INSERT INTO message_feedback (feedback_id, account_id, message_id, conversation_id, type, severity, note, provider, model_version, world_state_id, world_state_version, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, CURRENT_TIMESTAMP))', [item.feedback_id, item.account_id, item.message_id, item.conversation_id, item.type, item.severity, item.note || null, item.provider || null, item.model_version || null, item.world_state_id || null, item.world_state_version || null, item.created_at || null]);
}
async function persistTrialFeedback(client, item, exists) {
  if (exists) throw new Error('Trial feedback is append-only');
  return client.query(`INSERT INTO trial_feedback (feedback_id, account_id, category, rating, note, created_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP))`,
  [item.feedback_id, item.account_id, item.category, item.rating, item.note, item.created_at || null]);
}
async function persistOcImport(client, item, exists) {
  if (exists) throw new Error('OC imports are immutable');
  // `source_bytes` is deliberately not called ciphertext: local development
  // uses bytea for isolation and must not be mistaken for encryption at rest.
  return client.query("INSERT INTO oc_imports (import_id, account_id, source_bytes, declaration_version, state, proposed_persona, created_at, retention_expires_at) VALUES ($1, $2, convert_to($3, 'UTF8'), $4, $5, $6::jsonb, COALESCE($7::timestamptz, CURRENT_TIMESTAMP), $8::timestamptz)", [item.import_id, item.account_id, item.source_text, item.declaration_version, item.state, JSON.stringify(item.proposed_persona), item.created_at || null, item.retention_expires_at]);
}
async function persistContentRightsReview(client, item, exists) {
  if (exists) throw new Error('Content-rights reviews are immutable from the application role');
  return client.query('INSERT INTO content_rights_reviews (review_id, account_id, subject_type, subject_ref, declaration_version, risk_codes, state, decision_reason, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP), COALESCE($10::timestamptz, CURRENT_TIMESTAMP))', [item.review_id, item.account_id, item.subject_type, item.subject_ref, item.declaration_version, item.risk_codes, item.state, item.decision_reason, item.created_at || null, item.updated_at || null]);
}
async function persistContentRightsAppeal(client, item, exists) {
  if (exists) throw new Error('Content-rights appeals are append-only');
  return client.query('INSERT INTO content_rights_appeals (appeal_id, account_id, review_id, statement, state, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP))', [item.appeal_id, item.account_id, item.review_id, item.statement, item.state, item.created_at || null]);
}
async function persistContentRightsDecision(client, item, exists) {
  if (exists) throw new Error('Content-rights decisions are append-only');
  return client.query('INSERT INTO content_rights_review_decisions (decision_id, review_id, account_id, reviewer_id, decision, reason, decided_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, CURRENT_TIMESTAMP))', [item.decision_id, item.review_id, item.account_id, item.reviewer_id, item.decision, item.reason, item.decided_at || null]);
}
async function persistAgeReviewDecision(client, item, exists) {
  if (exists) throw new Error('Age-review decisions are append-only');
  return client.query('INSERT INTO age_review_decisions (decision_id, account_id, reviewer_id, decision, reason, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP))', [item.decision_id, item.account_id, item.reviewer_id, item.decision, item.reason, item.created_at || null]);
}
async function persistAssetEmbeddingJob(client, item, exists) {
  const values = [item.job_id, item.account_id, item.character_id || null, item.asset_id, item.asset_version, item.state, item.attempt_count, item.next_attempt_at, item.exhausted_at || null, item.last_error || null, item.created_at || null, item.completed_at || null];
  // UPDATE 分支必须只传被引用的参数：未引用的 null 参数（character_id 等）会让
  // PostgreSQL 报 42P18（could not determine data type）。
  if (exists) return client.query('UPDATE asset_embedding_jobs SET state = $3, attempt_count = $4, next_attempt_at = $5::timestamptz, exhausted_at = $6::timestamptz, last_error = $7, completed_at = $8::timestamptz WHERE job_id = $1 AND account_id = $2', [item.job_id, item.account_id, item.state, item.attempt_count, item.next_attempt_at, item.exhausted_at || null, item.last_error || null, item.completed_at || null]);
  return client.query('INSERT INTO asset_embedding_jobs (job_id, account_id, character_id, asset_id, asset_version, state, attempt_count, next_attempt_at, exhausted_at, last_error, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, COALESCE($11::timestamptz, CURRENT_TIMESTAMP), $12::timestamptz)', values);
}
async function persistAssetEmbeddingDeadLetter(client, item, exists) {
  if (exists) return client.query('UPDATE asset_embedding_dead_letters SET state = $2, replay_count = $3, last_replayed_at = $4::timestamptz, last_replayed_by = $5, last_replay_reason_sha256 = $6 WHERE dead_letter_id = $1', [item.dead_letter_id, item.state, item.replay_count, item.last_replayed_at || null, item.last_replayed_by || null, item.last_replay_reason_sha256 || null]);
  return client.query('INSERT INTO asset_embedding_dead_letters (dead_letter_id, job_id, account_id, asset_id, attempt_count, error_code, state, replay_count, occurred_at, last_replayed_at, last_replayed_by, last_replay_reason_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP), $10::timestamptz, $11, $12)', [item.dead_letter_id, item.job_id, item.account_id, item.asset_id, item.attempt_count, item.error_code, item.state, item.replay_count, item.occurred_at || null, item.last_replayed_at || null, item.last_replayed_by || null, item.last_replay_reason_sha256 || null]);
}
async function persistAssetEmbedding(client, item, exists) {
  const vectorLiteral = '[' + (item.embedding ?? []).join(',') + ']';
  if (exists) return client.query('UPDATE relationship_asset_embeddings SET embedding = $3::vector, embedding_model_version = $4, updated_at = $5::timestamptz, version = $6 WHERE asset_id = $1 AND account_id = $2', [item.asset_id, item.account_id, vectorLiteral, item.embedding_model_version, item.updated_at || null, item.version]);
  return client.query('INSERT INTO relationship_asset_embeddings (asset_id, account_id, character_id, embedding, embedding_model_version, created_at, updated_at, version) VALUES ($1, $2, $3, $4::vector, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP), $7::timestamptz, $8)', [item.asset_id, item.account_id, item.character_id || null, vectorLiteral, item.embedding_model_version, item.created_at || null, item.updated_at || null, item.version]);
}
async function deleteMessage(client, item) { return client.query('DELETE FROM messages WHERE message_id = $1 AND conversation_id = $2', [item.message_id, item.conversation_id]); }
async function deleteConversationSummary(client, item) { return client.query('DELETE FROM conversation_summaries WHERE summary_id = $1 AND account_id = $2', [item.summary_id, item.account_id]); }
async function deleteOcImport(client, item) { return client.query('DELETE FROM oc_imports WHERE import_id = $1 AND account_id = $2', [item.import_id, item.account_id]); }
async function persistCandidate(client, item, exists) { if (exists) return client.query('UPDATE memory_candidates SET state = $2, normalized_value = $3, display_text = $4, last_transition_actor = $5 WHERE candidate_id = $1 AND account_id = $6', [item.candidate_id, item.state, JSON.stringify(item.normalized_value), item.display_text, item.state === 'CANDIDATE' ? 'SYSTEM' : 'USER', item.account_id]); return client.query(`INSERT INTO memory_candidates (candidate_id, account_id, character_id, state, type, normalized_value, display_text, provider, expires_at, source_message_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [item.candidate_id, item.account_id, item.character_id, item.state, item.type, JSON.stringify(item.normalized_value), item.display_text, item.provider, item.expires_at, item.source_message_id]); }
async function persistAsset(client, item, exists) { if (exists) return client.query('UPDATE relationship_assets SET state = $2, deleted_at = $3, superseded_by = $5, index_state = $6 WHERE asset_id = $1 AND account_id = $4', [item.asset_id, item.state, item.deleted_at || null, item.account_id, item.superseded_by || null, item.index_state || 'PENDING']); return client.query(`INSERT INTO relationship_assets (asset_id, account_id, character_id, type, value_json, display_text, state, index_state, source_candidate_id, activation_actor) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'USER')`, [item.asset_id, item.account_id, item.character_id, item.type, JSON.stringify(item.value), item.display_text, item.state, item.index_state || 'PENDING', item.source_candidate_id]); }
async function persistMediaJob(client, item, exists) {
  const values = [item.job_id, item.account_id, item.character_id, item.conversation_id || null, item.source_message_id || null, item.input_asset_id || null, item.reference_asset_id || null, item.entitlement_id || null, item.type, item.state, item.attempts, item.provider || null, item.provider_request_id || null, item.provider_job_id || null, item.moderation_policy_version || null, item.result_asset_id || null, item.transcript_text || null, item.transcript_state || null, item.failure_code || null, item.provider_error_code || null, item.world_state_id || null, item.world_state_version || null, item.scene_contract ? JSON.stringify(item.scene_contract) : null, item.voice_id || null, item.voice_version || null, item.authorization_record_id || null, item.rights_review_id || null, item.rights_review_state || null, item.created_at || null];
  if (exists) {
    // UPDATE must bind only referenced, consecutively numbered parameters.
    // PostgreSQL otherwise raises 42P18 for unused null parameters such as the
    // insert-only character_id/type/created_at values.
    const updateValues = [
      item.job_id, item.account_id, item.conversation_id || null, item.source_message_id || null,
      item.input_asset_id || null, item.reference_asset_id || null, item.entitlement_id || null,
      item.state, item.attempts, item.provider || null, item.provider_request_id || null,
      item.provider_job_id || null, item.moderation_policy_version || null, item.result_asset_id || null,
      item.transcript_text || null, item.transcript_state || null, item.failure_code || null,
      item.provider_error_code || null, item.world_state_id || null, item.world_state_version || null,
      item.scene_contract ? JSON.stringify(item.scene_contract) : null, item.voice_id || null,
      item.voice_version || null, item.authorization_record_id || null, item.rights_review_id || null,
      item.rights_review_state || null
    ];
    return client.query('UPDATE media_jobs SET conversation_id = $3, source_message_id = $4, input_asset_id = $5, reference_asset_id = $6, entitlement_id = $7, state = $8, attempts = $9, provider = $10, provider_request_id = $11, provider_job_id = $12, moderation_policy_version = $13, result_asset_id = $14, transcript_text = $15, transcript_state = $16, failure_code = $17, provider_error_code = $18, world_state_id = $19, world_state_version = $20, scene_contract = $21::jsonb, voice_id = $22, voice_version = $23, authorization_record_id = $24, rights_review_id = $25, rights_review_state = $26 WHERE job_id = $1 AND account_id = $2', updateValues);
  }
  return client.query('INSERT INTO media_jobs (job_id, account_id, character_id, conversation_id, source_message_id, input_asset_id, reference_asset_id, entitlement_id, type, state, attempts, provider, provider_request_id, provider_job_id, moderation_policy_version, result_asset_id, transcript_text, transcript_state, failure_code, provider_error_code, world_state_id, world_state_version, scene_contract, voice_id, voice_version, authorization_record_id, rights_review_id, rights_review_state, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::jsonb, $24, $25, $26, $27, $28, COALESCE($29::timestamptz, CURRENT_TIMESTAMP))', values);
}
async function persistMediaAsset(client, item, exists) {
  if (exists) {
    const updateValues = [
      item.asset_id, item.account_id, item.state, item.byte_length, item.checksum, item.object_key,
      item.provider_request_id || null, item.confirmation_state || null, item.moderation_policy_version || null,
      item.failure_code || null, item.deleted_at || null, item.rights_review_id || null
    ];
    return client.query('UPDATE media_assets SET state = $3, byte_length = $4, checksum = $5, object_key = $6, provider_request_id = $7, confirmation_state = $8, moderation_policy_version = $9, failure_code = $10, deleted_at = $11::timestamptz, rights_review_id = $12 WHERE asset_id = $1 AND account_id = $2', updateValues);
  }
  const insertValues = [
    item.asset_id, item.account_id, item.character_id, item.job_id || null, item.type, item.state,
    item.media_type, item.mime_type, item.byte_length, item.checksum, item.object_key, item.provider,
    item.provider_request_id || null, Boolean(item.ai_generated), item.aigc_mark_version,
    item.confirmation_state || null, item.moderation_policy_version || null, item.failure_code || null,
    item.created_at || null, item.rights_review_id || null
  ];
  return client.query('INSERT INTO media_assets (asset_id, account_id, character_id, job_id, type, state, media_type, mime_type, byte_length, checksum, object_key, provider, provider_request_id, ai_generated, aigc_mark_version, confirmation_state, moderation_policy_version, failure_code, created_at, rights_review_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, COALESCE($19::timestamptz, CURRENT_TIMESTAMP), $20)', insertValues);
}
async function persistEntitlementLedger(client, item, exists) {
  if (exists) return;
  return client.query('INSERT INTO entitlement_ledgers (entitlement_ledger_id, account_id, entitlement_id, capability, action, job_id, quantity, reserved_quantity, idempotency_key, source, source_event_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, CURRENT_TIMESTAMP))', [item.entitlement_ledger_id, item.account_id, item.entitlement_id, item.capability, item.action, item.job_id || null, item.quantity, item.reserved_quantity ?? null, item.idempotency_key, item.source || null, item.source_event_id || null, item.created_at || null]);
}
async function persistSubscription(client, item, exists) {
  const values = [item.subscription_id, item.account_id, item.sku, item.channel, item.state, Boolean(item.auto_renew), item.disclosure_version, item.period_start || null, item.period_end || null, item.grace_period_end || null, item.refund_status, item.transaction_ref_hash || null, item.created_at || null, item.updated_at || null];
  if (exists) return client.query('UPDATE subscriptions SET state = $5, auto_renew = $6, period_start = $8, period_end = $9, grace_period_end = $10, refund_status = $11, transaction_ref_hash = $12, updated_at = COALESCE($14::timestamptz, CURRENT_TIMESTAMP) WHERE subscription_id = $1 AND account_id = $2', values);
  return client.query('INSERT INTO subscriptions (subscription_id, account_id, sku, channel, state, auto_renew, disclosure_version, period_start, period_end, grace_period_end, refund_status, transaction_ref_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11, $12, COALESCE($13::timestamptz, CURRENT_TIMESTAMP), COALESCE($14::timestamptz, CURRENT_TIMESTAMP))', values);
}
async function persistSubscriptionOrder(client, item, exists) {
  const values = [item.order_id, item.account_id, item.subscription_id, item.sku, item.amount_fen, item.currency, item.state, item.channel, Boolean(item.auto_renew), item.disclosure_version, item.created_at || null];
  if (exists) return client.query('UPDATE subscription_orders SET state = $7 WHERE order_id = $1 AND account_id = $2', values);
  return client.query('INSERT INTO subscription_orders (order_id, account_id, subscription_id, sku, amount_fen, currency, state, channel, auto_renew, disclosure_version, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, CURRENT_TIMESTAMP))', values);
}
async function persistPaymentEvent(client, item, exists) {
  if (exists) return;
  return client.query('INSERT INTO payment_events (provider_event_id, account_id, subscription_id, event_type, transaction_ref_hash, event_hash, outcome, quarantine_reason, effective_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)', [item.provider_event_id, item.account_id || null, item.subscription_id || null, item.event_type, item.transaction_ref_hash, item.event_hash, item.outcome, item.quarantine_reason || null, item.effective_at]);
}
async function persistPaymentQuarantine(client, item, exists) {
  if (exists) return;
  return client.query('INSERT INTO payment_event_quarantines (provider_event_id, reason, received_at) VALUES ($1, $2, $3::timestamptz)', [item.provider_event_id, item.reason, item.received_at]);
}
async function persistDeletionJob(client, item, exists) {
  if (!exists) return client.query(`INSERT INTO deletion_jobs (deletion_job_id, account_id, asset_id, scope, state, online_disabled_at, revocation_epoch, physical_cleanup_state, note) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8)`, [item.deletion_job_id, item.account_id, item.asset_id, item.scope, item.state, item.revocation_epoch, item.physical_cleanup_state, item.note]);
  // 清理 Worker 的状态流转（ONLINE_DISABLED → COMPLETED）与回执字段。
  return client.query(`UPDATE deletion_jobs SET state = $2, physical_cleanup_state = $3, note = $4, backup_deadline = COALESCE($5::timestamptz, backup_deadline), receipt_version = COALESCE($6, receipt_version), updated_at = CURRENT_TIMESTAMP WHERE deletion_job_id = $1`, [item.deletion_job_id, item.state, item.physical_cleanup_state, item.note, item.backup_deadline || null, item.receipt_version || null]);
}
async function persistDeletionTarget(client, item, exists) {
  if (!exists) return client.query(`INSERT INTO deletion_targets (deletion_target_id, deletion_job_id, account_id, target_type, target_ref, state, attempts, provider_receipt, last_error_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [item.deletion_target_id, item.deletion_job_id, item.account_id, item.target_type, item.target_ref, item.state, item.attempts, item.provider_receipt, item.last_error_code]);
  return client.query(`UPDATE deletion_targets SET state = $2, attempts = $3, provider_receipt = $4, last_error_code = $5, updated_at = CURRENT_TIMESTAMP WHERE deletion_target_id = $1`, [item.deletion_target_id, item.state, item.attempts, item.provider_receipt, item.last_error_code]);
}
async function syncEmergencyContact(client, accountId, account) {
  const contact = account.emergency_contact;
  if (!contact) return client.query('DELETE FROM emergency_contacts WHERE account_id = $1', [accountId]);
  return client.query(`INSERT INTO emergency_contacts (account_id, contact_name, relationship, phone, consent_version, updated_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP))
    ON CONFLICT (account_id) DO UPDATE SET contact_name = $2, relationship = $3, phone = $4, consent_version = $5, updated_at = CURRENT_TIMESTAMP`,
    [accountId, contact.contact_name, contact.relationship, contact.phone, contact.consent_version, contact.updated_at || null]);
}
async function persistComplaint(client, item, exists) {
  if (exists) return client.query('UPDATE complaints SET state = $2, resolution_note = $3, updated_at = CURRENT_TIMESTAMP WHERE complaint_id = $1', [item.complaint_id, item.state, item.resolution_note]);
  return client.query(`INSERT INTO complaints (complaint_id, account_id, kind, target_resource_id, description, state, resolution_note, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))`,
    [item.complaint_id, item.account_id, item.kind, item.target_resource_id, item.description, item.state, item.resolution_note, item.created_at || null]);
}
async function persistProactiveEvent(client, item, exists) {
  if (exists) return client.query('UPDATE proactive_events SET state = $2 WHERE event_id = $1', [item.event_id, item.state]);
  return client.query(`INSERT INTO proactive_events (event_id, account_id, character_id, type, title, due_at, time_of_day_local, state, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, COALESCE($9::timestamptz, CURRENT_TIMESTAMP))`,
    [item.event_id, item.account_id, item.character_id, item.type, item.title, item.due_at || null, item.time_of_day_local, item.state, item.created_at || null]);
}
async function persistProactiveMessage(client, item) {
  return client.query(`INSERT INTO proactive_messages (message_id, account_id, character_id, event_id, kind, template_slot, text, sent_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, CURRENT_TIMESTAMP))
    ON CONFLICT (message_id) DO NOTHING`,
    [item.message_id, item.account_id, item.character_id, item.event_id, item.kind, item.template_slot, item.text, item.sent_at || null]);
}
async function persistDailyChatUsage(client, item, exists) {
  if (!exists) {
    return client.query(`INSERT INTO daily_chat_usage (account_id, usage_date, chat_rounds, billed_input_tokens, reserved_input_tokens, updated_at)
      VALUES ($1, $2::date, $3, $4, $5, $6::timestamptz)`,
    [item.account_id, item.usage_date, item.chat_rounds, item.billed_input_tokens, item.reserved_input_tokens, item.updated_at]);
  }
  return client.query(`UPDATE daily_chat_usage
    SET chat_rounds = $3, billed_input_tokens = $4, reserved_input_tokens = $5, updated_at = $6::timestamptz
    WHERE account_id = $1 AND usage_date = $2::date`,
  [item.account_id, item.usage_date, item.chat_rounds, item.billed_input_tokens, item.reserved_input_tokens, item.updated_at]);
}
async function persistConversationSummary(client, item, exists) {
  if (exists) return client.query('UPDATE conversation_summaries SET state = $2, invalidated_at = $3::timestamptz WHERE summary_id = $1 AND account_id = $4', [item.summary_id, item.state, item.invalidated_at || null, item.account_id]);
  return client.query(`INSERT INTO conversation_summaries (summary_id, account_id, conversation_id, source_from_id, source_to_id, summary_ciphertext, model_route_id, prompt_version, source_checksum, revocation_epoch, state, created_at, invalidated_at, retention_expires_at)
    VALUES ($1, $2, $3, $4, $5, convert_to($6, 'UTF8'), $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz, $14::timestamptz)`,
  [item.summary_id, item.account_id, item.conversation_id, item.source_from_id, item.source_to_id, item.text, item.model_route_id, item.prompt_version, item.source_checksum, item.revocation_epoch, item.state, item.created_at, item.invalidated_at, item.retention_expires_at]);
}
async function persistConversationSummaryJob(client, item, exists) {
  if (exists) return client.query('UPDATE conversation_summary_jobs SET state = $2, completed_at = $3::timestamptz, last_error = $4 WHERE job_id = $1 AND account_id = $5', [item.job_id, item.state, item.completed_at || null, item.last_error || null, item.account_id]);
  return client.query(`INSERT INTO conversation_summary_jobs (job_id, account_id, conversation_id, source_to_id, captured_revocation_epoch, state, attempt_count, next_attempt_at, last_error, created_at, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz, $11::timestamptz)`,
  [item.job_id, item.account_id, item.conversation_id, item.source_to_id, item.captured_revocation_epoch, item.state, item.attempt_count, item.next_attempt_at, item.last_error, item.created_at, item.completed_at]);
}
async function persistOutboxEvent(client, item, exists) {
  if (exists) throw new Error('Outbox events are append-only in application scope');
  return client.query(`INSERT INTO outbox_events (event_id, account_id, character_id, aggregate_type, aggregate_id, event_type, payload_json, occurred_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)`, [item.event_id, item.account_id, item.character_id, item.aggregate_type, item.aggregate_id, item.event_type, JSON.stringify(item.payload), item.occurred_at]);
}
async function persistOperationMetric(client, item, exists) {
  if (exists) throw new Error('Operation metrics are append-only');
  return client.query(`INSERT INTO operation_metrics (metric_id, account_id, capability, provider, model_version, input_tokens, output_tokens, latency_ms, outcome, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, CURRENT_TIMESTAMP))`,
  [item.metric_id, item.account_id, item.capability, item.provider, item.model_version || null, item.input_tokens, item.output_tokens, item.latency_ms, item.outcome, item.created_at || null]);
}
async function syncIdempotency(client, store, previous) { for (const [storageKey, item] of store.idempotency) { if (previous.has(storageKey)) continue; const segments = storageKey.split(':'); const method = segments[1]; const requestPath = segments[2]; const key = segments.slice(3).join(':'); await client.query(`INSERT INTO idempotency_keys (account_id, request_method, request_path, idempotency_key, request_hash, response_status, response_body) VALUES ($1, $2, $3, $4, decode($5, 'hex'), $6, $7::jsonb)`, [store.accountId, method, requestPath, key, item.bodyHash, item.result.status, JSON.stringify(item.result.body)]); } }

function snapshot(store) { return Object.freeze({ accounts: cloneMap(store.accounts), characters: cloneMap(store.characters), worldStates: cloneMap(store.worldStates), worldStateEvents: cloneMap(store.worldStateEvents), conversations: cloneMap(store.conversations), messages: cloneMap(store.messages), conversationSummaries: cloneMap(store.conversationSummaries), conversationSummaryJobs: cloneMap(store.conversationSummaryJobs), outboxEvents: cloneMap(store.outboxEvents), candidates: cloneMap(store.candidates), assets: cloneMap(store.assets), mediaJobs: cloneMap(store.mediaJobs), mediaAssets: cloneMap(store.mediaAssets), entitlementLedgers: cloneMap(store.entitlementLedgers), subscriptions: cloneMap(store.subscriptions), subscriptionOrders: cloneMap(store.subscriptionOrders), paymentEvents: cloneMap(store.paymentEvents), paymentEventQuarantines: cloneMap(store.paymentEventQuarantines), deletionJobs: cloneMap(store.deletionJobs), deletionTargets: cloneMap(store.deletionTargets), complaints: cloneMap(store.complaints), proactiveEvents: cloneMap(store.proactiveEvents), proactiveMessages: cloneMap(store.proactiveMessages), dailyChatUsage: cloneMap(store.dailyChatUsage), operationMetrics: cloneMap(store.operationMetrics), messageFeedback: cloneMap(store.messageFeedback), trialFeedback: cloneMap(store.trialFeedback), ocImports: cloneMap(store.ocImports), contentRightsReviews: cloneMap(store.contentRightsReviews), contentRightsAppeals: cloneMap(store.contentRightsAppeals), contentRightsDecisions: cloneMap(store.contentRightsDecisions), ageReviewDecisions: cloneMap(store.ageReviewDecisions), assetEmbeddingJobs: cloneMap(store.assetEmbeddingJobs), assetEmbeddings: cloneMap(store.assetEmbeddings), assetEmbeddingDeadLetters: cloneMap(store.assetEmbeddingDeadLetters), idempotency: cloneMap(store.idempotency) }); }
function cloneMap(map) { return new Map([...map].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))])); }
function changed(previous, current) { return JSON.stringify(previous) !== JSON.stringify(current); }
function noticeIdFor(accountId) { return accountId === DEVELOPMENT_DATABASE_ACCOUNT_IDS.acct_dev_alice ? '00000000-0000-7000-8000-0000000000a3' : '00000000-0000-7000-8000-0000000000b3'; }
function mapNotice(row) { return { notice_id: row.notice_id, type: 'AI_IDENTITY_FIRST_SESSION', notice_version: row.notice_version, state: row.state === 'PENDING' ? 'DUE' : row.state, displayed_at: row.displayed_at }; }
function mapNoticeState(state) { return state === 'DUE' ? 'PENDING' : state; }
function mapConversationState(state) { return state === 'ACTIVE' ? 'OPEN' : state; }
function mapConversationStatus(state) { return state === 'OPEN' ? 'ACTIVE' : state; }
function parseJson(value) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return { text: value }; } }
// pg 将 DATE 构造为会话时区的本地午夜 Date；取本地分量还原日期字符串，
// 用 UTC 切片会在东八区机器上把日期倒退一天（曾导致 daily_chat_usage 主键错位）。
function databaseDate(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return String(value).slice(0, 10);
}
function dateTimeValue(value) { return value instanceof Date ? value.toISOString() : String(value); }

module.exports = { DEVELOPMENT_DATABASE_ACCOUNT_IDS, PostgresStore, PostgresRequestStore };
