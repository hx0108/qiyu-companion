'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { enqueueAssetEmbedding, invalidateAssetEmbedding } = require('./asset-embedding-worker');
const { explicitMemoryExpiry, groundedPreferenceAnswer, normalizeMemoryFact } = require('./automatic-memory-normalization');

const categories = new Set(['preference', 'interest', 'communication', 'background', 'goal', 'recent', 'sensitive']);
const prohibited = /密码|验证码|密钥|助记词|身份证号|银行卡号|api[ _-]?key|bearer\s|不要记|别记|忘掉|忽略.{0,12}指令/i;
const uncertain = /假如|假设|如果|扮演|扮成|扮作|开玩笑|可能|也许|转述|他说|她说|朋友说|我(?:没(?:有)?|未)说过|(?:^|[，,；;。！!\n])\s*要是|才怪\s*(?:[。！!]|$)|[?？“”「」]/;
const sensitive = /诊断|病历|抑郁|失眠|病史|药物|怀孕|工资|收入|负债|贷款|存款|住址|门牌|(?:住在|家在|住处在)[^，,；;。！!\n]{0,28}[\d０-９〇零一二三四五六七八九十两]+(?:号|室|栋|单元|楼|层)/;
const standaloneDisclosure = /^我(?:最近|目前|现在|一直|每天|今年)?(?:在服用|服用|有|出现|患有|被诊断|怀孕|的?(?:(?:月|年)?(?:工资|收入)|负债|贷款|存款|住址|门牌)(?:是|为))/;
const day = 86400000;

function isIndependentPreference(quote, fact, clauses) {
  return !sensitive.test(quote) && ['like', 'dislike'].includes(fact?.value) &&
    !/(?:它|这[个种些里]|那[个种些里]|上述|前面|后面)/.test(quote) &&
    [...clauses].every((clause) => clause === quote || (sensitive.test(clause) && standaloneDisclosure.test(clause)));
}

function enqueueAutomaticMemory(store, account, message) {
  const mode = process.env.QIYU_AUTOMATIC_MEMORY_V2;
  if (!Array.isArray(store.automaticMemoryJobs) || !['shadow', 'active'].includes(mode)) return;
  if (!account.automatic_memory_enabled || !eligibleText(message.text) || message.attachments?.length) return;
  if (!automaticMemoryRolloutIncludes(account.account_id)) return;
  store.automaticMemoryJobs.push({
    messageId: message.message_id,
    preferenceVersion: account.automatic_memory_preference_version,
    revocationEpoch: account.revocation_epoch,
    mode
  });
  return mode;
}

function automaticMemoryRolloutIncludes(accountId) {
  const allowlist = process.env.QIYU_AUTOMATIC_MEMORY_V2_ACCOUNTS?.trim();
  if (allowlist) return allowlist.split(',').some((id) => id.trim() === accountId);
  const percent = Number(process.env.QIYU_AUTOMATIC_MEMORY_V2_PERCENT || 100);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) return false;
  if (percent === 100) return true;
  const bucket = createHash('sha256').update(accountId).digest().readUInt32BE(0) % 100;
  return bucket < percent;
}

function eligibleText(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 800 && !prohibited.test(text);
}

function evaluateCandidates(text, output, { previous, utcOffsetMinutes = 0 } = {}) {
  if (!eligibleText(text)) return [];
  if (!Array.isArray(output) || output.length > 5) throw new Error('INVALID_CANDIDATES');
  const clauses = new Set(text.split(/[，,；;。！!\n]/u).map((part) => part.trim()).filter(Boolean));
  const seen = new Set();
  const candidates = [];
  for (const entry of output) {
    if (!entry || !categories.has(entry.category) || entry.subject !== 'self' || entry.assertion !== 'explicit') continue;
    const { topic } = entry;
    if (typeof entry.quote !== 'string' || entry.quote.length > 120) continue;
    const quote = entry.quote.trim().replace(/[。！!]+$/u, '').trimEnd();
    if (!clauses.has(quote)) continue;
    if (typeof topic !== 'string' || !/^[\p{L}\p{N}]{1,24}$/u.test(topic) || !quote.includes(topic)) continue;
    if (uncertain.test(text) || /不是(?:真的|说我)|反话|假的|我(?:的)?(?:朋友|同事|家人|孩子|伴侣|妈妈|爸爸)/.test(text)) continue;
    const contextual = ['preference', 'interest'].includes(entry.category) ? groundedPreferenceAnswer(quote, previous) : null;
    if (quote.length < 4 && !contextual) continue;
    const standingCommunication = entry.category === 'communication' &&
      /^(?:(?:以后|今后|往后|此后)(?:和我聊天时)?(?:请|希望你|回答我|回复我|的(?:回答|回复|答复))|希望你|回答我时|回复我时)/.test(quote);
    if (entry.category === 'communication' && /^(?:我)?(?:这次|本次|这条|这段|这一|这道|当前)/.test(quote)) continue;
    if (!contextual && !/^(?:(?:其实|最近|目前|现在|以前|以后)\s*)?我(?!们)/.test(quote) &&
        !standingCommunication) continue;
    const fact = contextual || normalizeMemoryFact(entry.category, quote);
    const expiry = entry.category === 'recent' || /计划|打算|预约|定于|安排在/.test(quote)
      ? explicitMemoryExpiry(quote, utcOffsetMinutes) : { kind: 'none' };
    if (expiry.kind === 'invalid') continue;
    const recent = entry.category === 'recent' || expiry.kind === 'date';
    const needsConfirmation = expiry.kind === 'ambiguous' || entry.category === 'sensitive' ||
      (sensitive.test(text) && !isIndependentPreference(quote, fact, clauses));
    const category = recent && !needsConfirmation ? 'recent' : entry.category;
    const key = fact?.key || `v2:${category}:${topic.normalize('NFKC').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      key, value: fact?.value || quote, quote, displayText: contextual?.displayText || quote,
      relatedKeys: fact?.relatedKeys || [],
      recent, needsConfirmation,
      expiresAt: expiry.expiresAt,
      revisable: Boolean(fact?.revisable && /^(?:其实|现在|目前|以后|今后)/.test(quote)),
      contextId: contextual ? previous.message_id : null
    });
  }
  return candidates;
}

function sourceFor(store, job) {
  if (!store) return null;
  const account = store.account(job.account_id);
  const message = store.messages.get(job.message_id);
  const conversation = message && store.conversations.get(message.conversation_id);
  if (!account || account.account_status !== 'OPEN' || account.user_pause_state !== 'ACTIVE' ||
      !account.automatic_memory_enabled || Number(account.automatic_memory_preference_version) !== Number(job.preference_version) ||
      Number(account.revocation_epoch) !== Number(job.revocation_epoch) || message?.actor !== 'USER' ||
      message.deleted_at || message.attachments?.length || !eligibleText(message.text) ||
      (message.retention_expires_at && Date.parse(message.retention_expires_at) <= Date.now()) ||
      conversation?.account_id !== job.account_id || conversation.status === 'DELETED') return null;
  const recent = [...store.messages.values()]
    .filter((item) => item.conversation_id === message.conversation_id &&
      new Date(item.created_at).getTime() < new Date(message.created_at).getTime())
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
      Number(a.actor === 'ASSISTANT') - Number(b.actor === 'ASSISTANT') || a.message_id.localeCompare(b.message_id))
    .slice(-4);
  const context = recent.filter(eligibleContext);
  const previous = context.at(-1) === recent.at(-1) ? context.at(-1) : undefined;
  return { message, conversation, context, previous, utcOffsetMinutes: account.proactive_preferences?.timezone_offset_minutes ?? 0 };
}

function eligibleContext(item) {
  return Boolean(item && !item.deleted_at && !item.attachments?.length && eligibleText(item.text) && !sensitive.test(item.text) &&
    (!item.retention_expires_at || Date.parse(item.retention_expires_at) > Date.now()));
}

function persistSuggestions(store, job, source, candidates, modelVersion) {
  const { message, conversation } = source;
  const characterId = conversation.character_id;
  const scoped = (item) => item.account_id === job.account_id && item.character_id === characterId;
  for (const candidate of candidates) {
    const now = Date.now();
    const validUntil = candidate.expiresAt || (candidate.recent ? new Date(Date.parse(message.created_at) + 30 * day).toISOString() : null);
    if (validUntil && Date.parse(validUntil) <= now) continue;
    const keyMatches = (key) => key === candidate.key || candidate.relatedKeys.includes(key);
    const matches = (value, displayText) => keyMatches(value?.fact_key) ||
      value?.fact_value === candidate.quote || displayText === candidate.quote;
    const same = [...store.assets.values()].filter((asset) => scoped(asset) && matches(asset.value, asset.display_text));
    if (same.some((asset) => asset.state === 'DELETED')) continue;
    const active = same.filter((asset) => asset.state === 'ACTIVE');
    const current = active.length === 1 ? active[0] : null;
    const renewal = candidate.recent && current?.origin === 'AUTOMATIC' && current.automatic_policy_version === 'v2' &&
      current.value?.fact_key === candidate.key && current.valid_until && Date.parse(current.valid_until) <= now;
    if (!renewal && active.some((asset) =>
      (asset.display_text === candidate.quote || (keyMatches(asset.value?.fact_key) && asset.value?.fact_value === candidate.value)))) continue;
    if (!renewal && !candidate.revisable && same.some((asset) => asset.state === 'SUPERSEDED')) continue;
    if ([...store.candidates.values()].some((item) => scoped(item) &&
      (item.state === 'REJECTED' || (item.state === 'CANDIDATE' && Date.parse(item.expires_at) > Date.now())) &&
      matches(item.normalized_value, item.display_text))) continue;
    const value = { fact_key: candidate.key, fact_value: candidate.value, extraction_model: modelVersion };
    if (candidate.contextId) value.context_message_id = candidate.contextId;
    const explicitStyle = candidate.key === 'communication.response_style' &&
      store.userPreferences?.get(`${job.account_id}:${characterId}`)?.style?.reply_length;
    const currentKey = current?.value?.fact_key;
    const replace = (candidate.revisable || renewal) && current?.origin === 'AUTOMATIC' && !explicitStyle &&
      (currentKey === candidate.key || (current.automatic_policy_version === 'v2' && keyMatches(currentKey))) ? current : null;
    const confirm = candidate.needsConfirmation || explicitStyle || (active.length > 0 && !replace);
    if (confirm) {
      if (candidate.relatedKeys.length) value.related_fact_keys = candidate.relatedKeys;
      const id = store.next('memc');
      store.candidates.set(id, {
        candidate_id: id, account_id: job.account_id, character_id: characterId,
        state: 'CANDIDATE', version: 1, type: 'development_note', provider: 'qwen',
        normalized_value: value, display_text: candidate.displayText, source_message_id: message.message_id,
        expires_at: new Date(Date.now() + 7 * day).toISOString()
      });
      continue;
    }
    const asset = {
      asset_id: store.next('ras'), account_id: job.account_id, character_id: characterId,
      state: 'ACTIVE', version: 1, type: 'PREFERENCE', origin: 'AUTOMATIC', index_state: 'PENDING',
      automatic_policy_version: 'v2', automatic_source_message_id: message.message_id,
      value, display_text: candidate.displayText, created_at: new Date().toISOString(),
      valid_until: validUntil
    };
    if (replace) {
      replace.state = 'SUPERSEDED';
      replace.superseded_by = asset.asset_id;
      invalidateAssetEmbedding(store, replace.asset_id, 'automatic memory explicitly revised');
    }
    store.assets.set(asset.asset_id, asset);
    enqueueAssetEmbedding({ store, asset });
  }
}

async function runAutomaticMemoryJob({ store, accountId, extract, mode }) {
  return (await runAutomaticMemoryBatch({ store, accountId, extract, mode, limit: 1 }))[0] || 'IDLE';
}

async function runAutomaticMemoryBatch({ store, accountId, extract, mode, limit = 3 }) {
  if (!['shadow', 'active'].includes(mode)) return [];
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new RangeError('invalid automatic memory batch size');
  const leaseId = randomUUID();
  const transaction = (operation, write = false) => store.withAutomaticMemoryTransaction
    ? store.withAutomaticMemoryTransaction(accountId, operation, { write })
    : store.withAccountTransaction(accountId, operation, { lockMemory: true });
  const claims = await transaction(async (scoped) => {
    if (store.withAutomaticMemoryTransaction) {
      const { rows: [lock] } = await scoped.client.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('automatic-memory:' || $1::text, 0)) AS acquired", [accountId]);
      if (!lock.acquired) return [];
    }
    await scoped.client.query(`UPDATE automatic_memory_jobs SET state = 'FAILED', lease_id = NULL, result_code = 'LEASE_EXHAUSTED'
      WHERE account_id = $1 AND state = 'PROCESSING' AND attempts = 2 AND available_at <= NOW()`, [accountId]);
    const result = await scoped.client.query(`
        WITH head AS MATERIALIZED (
          SELECT j.message_id, m.created_at, j.available_at, j.attempts
          FROM automatic_memory_jobs j JOIN messages m USING (message_id)
          WHERE j.account_id = $1 AND j.state IN ('PENDING','PROCESSING')
          ORDER BY m.created_at, j.message_id LIMIT $3
        ), ready AS (
          SELECT message_id, created_at,
            bool_and(available_at <= NOW() AND attempts < 2)
              OVER (ORDER BY created_at, message_id ROWS UNBOUNDED PRECEDING) AS due
          FROM head
        ), claimed AS (
          UPDATE automatic_memory_jobs j SET state = 'PROCESSING', attempts = j.attempts + 1,
            lease_id = $2, available_at = NOW() + interval '30 seconds'
          FROM ready WHERE j.message_id = ready.message_id AND ready.due
            AND j.available_at <= NOW() AND j.attempts < 2 AND j.state IN ('PENDING','PROCESSING')
          RETURNING j.*, ready.created_at
        )
        SELECT * FROM claimed ORDER BY created_at, message_id`, [accountId, leaseId, limit]);
    const selected = [];
    const included = automaticMemoryRolloutIncludes(accountId);
    const sources = included && result.rows.length && scoped.loadSources
      ? await scoped.loadSources(result.rows.map(({ message_id }) => message_id)) : null;
    for (const job of result.rows) {
      if (!included) {
        await finish(scoped, job, leaseId, 'CANCELLED', 'ROLLOUT_DISABLED');
        continue;
      }
      const current = sources ? sources.get(job.message_id) : scoped.loadSource ? await scoped.loadSource(job.message_id) : scoped;
      const source = sourceFor(current, job);
      if (!source) {
        await finish(scoped, job, leaseId, 'CANCELLED', 'SOURCE_REVOKED');
        continue;
      }
      selected.push({
        job, text: source.message.text, previousId: source.previous?.message_id,
        context: source.context.map(({ message_id, actor, text }) => ({ message_id, actor, text }))
      });
    }
    return selected;
  });
  const results = await Promise.all(claims.map((claim) => extractAutomaticMemory(claim, extract)));
  const outcomes = [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    let result = results[index];
    if (!result && limit > 1 && claim.job.attempts < 2) {
      const canRetry = await transaction(async (scoped) => {
        const current = scoped.loadSource ? await scoped.loadSource(claim.job.message_id, claim.context.map((item) => item.message_id)) : scoped;
        const source = sourceFor(current, claim.job);
        if (!source || source.message.text !== claim.text || !automaticMemoryRolloutIncludes(accountId)) return false;
        if (claim.context.some((item) => !eligibleContext(current.messages.get(item.message_id)) ||
          current.messages.get(item.message_id)?.text !== item.text)) return false;
        const update = await scoped.client.query(`UPDATE automatic_memory_jobs SET attempts = 2
          WHERE message_id = $1 AND lease_id = $2 AND state = 'PROCESSING' AND available_at > clock_timestamp()`,
        [claim.job.message_id, leaseId]);
        return Boolean(update.rowCount);
      });
      if (canRetry) result = await extractAutomaticMemory(claim, extract);
    }
    const outcome = result
      ? await commitAutomaticMemory({ transaction, claim, leaseId, mode, accountId, ...result })
      : await transaction((scoped) => finish(scoped, claim.job, leaseId,
        limit === 1 && claim.job.attempts < 2 ? 'PENDING' : 'FAILED', 'EXTRACTION_FAILED'));
    outcomes.push(outcome);
    if (outcome === 'STALE') break;
  }
  return outcomes;
}

async function extractAutomaticMemory(claim, extract) {
  try {
    const result = await extract(claim.text, claim.context.map(({ actor, text }) => ({ actor, text })));
    if (!Array.isArray(result.candidates) || result.candidates.length > 5) throw new Error('INVALID_CANDIDATES');
    return { output: result.candidates, modelVersion: result.modelVersion };
  } catch {
    return null;
  }
}

async function commitAutomaticMemory({ transaction, claim, leaseId, mode, accountId, output, modelVersion }) {
  if (output.length === 0) {
    const kind = mode === 'active' && claim.job.mode === 'active' ? 'ACTIVE' : 'SHADOW';
    return transaction((scoped) => finish(scoped, claim.job, leaseId, 'COMPLETED', `${kind}_CANDIDATES_0`));
  }
  return transaction(async (scoped) => {
    const current = await scoped.client.query(`SELECT 1 FROM automatic_memory_jobs
      WHERE message_id = $1 AND lease_id = $2 AND state = 'PROCESSING' AND available_at > clock_timestamp()
      FOR UPDATE`, [claim.job.message_id, leaseId]);
    if (!current.rowCount) return 'STALE';
    const evidenceIds = claim.context.map((item) => item.message_id);
    const sourceStore = scoped.loadSource ? await scoped.loadSource(claim.job.message_id, evidenceIds) : scoped;
    const source = sourceFor(sourceStore, claim.job);
    if (!source || source.message.text !== claim.text) return finish(scoped, claim.job, leaseId, 'CANCELLED', 'SOURCE_REVOKED');
    for (const item of claim.context) {
      const currentMessage = sourceStore.messages.get(item.message_id);
      if (!eligibleContext(currentMessage) || currentMessage.conversation_id !== source.message.conversation_id ||
          currentMessage.actor !== item.actor || currentMessage.text !== item.text) {
        return finish(scoped, claim.job, leaseId, 'CANCELLED', 'CONTEXT_REVOKED');
      }
    }
    const previous = source.previous?.message_id === claim.previousId ? source.previous : undefined;
    const candidates = evaluateCandidates(claim.text, output, { ...source, previous });
    const publish = mode === 'active' && claim.job.mode === 'active' && automaticMemoryRolloutIncludes(accountId);
    if (publish && candidates.length) {
      const changes = scoped.loadMemoryChanges ? await scoped.loadMemoryChanges(source.conversation.character_id, candidates) : null;
      persistSuggestions(changes?.state || scoped, claim.job, source, candidates, modelVersion);
      if (changes) await changes.flush();
    }
    const completed = await finish(scoped, claim.job, leaseId, 'COMPLETED', `${publish ? 'ACTIVE' : 'SHADOW'}_CANDIDATES_${candidates.length}`);
    if (completed === 'STALE' && publish && candidates.length) throw new Error('AUTOMATIC_MEMORY_LEASE_EXPIRED');
    return completed;
  }, true);
}

async function finish(scoped, job, leaseId, state, reason) {
  const result = await scoped.client.query(`UPDATE automatic_memory_jobs SET state = $3, lease_id = NULL,
    result_code = $4, available_at = NOW() + interval '10 seconds'
    WHERE message_id = $1 AND lease_id = $2 AND state = 'PROCESSING' AND available_at > clock_timestamp()`, [job.message_id, leaseId, state, reason]);
  return result.rowCount ? state : 'STALE';
}

module.exports = { enqueueAutomaticMemory, evaluateCandidates, runAutomaticMemoryJob, runAutomaticMemoryBatch };
