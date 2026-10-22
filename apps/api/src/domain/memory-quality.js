'use strict';

// Only explicit first-person facts are candidates; questions, role-play and
// transient chat do not silently become durable facts.
function explicitFact(text) {
  const source = String(text ?? '').replace(/^你提到[：:]?[“"]?/, '').replace(/[”"]$/, '').trim();
  if (!source || source.length > 240 || /[?？]|假如|如果|假设|扮演|编个|故事里/.test(source)) return null;
  const value = source.replace(/^(?:其实|更正一下|纠正一下|现在)[，,：:]?/, '');
  let match = value.match(/^我(?:现在)?(?:住在|居住在)([^，。！；\n]{1,40})[。！]?$/);
  if (match) return { key: 'user.residence', value: match[1], text: source };
  match = value.match(/^我(?:叫|的名字是)([^，。！；\n]{1,30})[。！]?$/);
  if (match) return { key: 'user.name', value: match[1], text: source };
  match = value.match(/^我(?:最)?(不喜欢|讨厌|喜欢)([^，。！；\n]{1,60})[。！]?$/);
  if (match) return { key: `user.preference:${match[2]}`, value: match[1] === '喜欢' ? 'like' : 'dislike', text: source };
  match = value.match(/^我(?:是|的工作是)([^，。！；\n]{1,40})[。！]?$/);
  if (match && /工程师|教师|老师|医生|设计师|产品经理|学生|程序员|会计/.test(match[1])) return { key: 'user.occupation', value: match[1], text: source };
  return null;
}
function deriveFactCandidate(text, context) {
  const fact = explicitFact(text);
  if (!fact) return null;
  if ((context?.confirmed_assets ?? []).some((asset) => {
    const previous = explicitFact(asset.display_text);
    return previous?.key === fact.key && previous.value === fact.value;
  })) return null;
  return { type: 'development_note', normalized_value: { text: fact.text, fact_key: fact.key, fact_value: fact.value }, display_text: `你提到：“${fact.text}”`, confidence: 0.8 };
}
function unresolvedFactKeys(assets) {
  const values = new Map();
  for (const asset of assets) {
    const fact = explicitFact(asset.display_text);
    if (!fact) continue;
    if (!values.has(fact.key)) values.set(fact.key, new Set());
    values.get(fact.key).add(fact.value);
  }
  return new Set([...values].filter(([, entries]) => entries.size > 1).map(([key]) => key));
}
// Bridge the unsummarized 20/60 window without another model call. Excerpts are
// source-labelled, bounded, and never promoted to confirmed relationship facts.
function contextBridge(messages, recentLimit, query) {
  const older = messages.slice(0, -recentLimit);
  const queryGrams = new Set(String(query ?? '').match(/[\u3400-\u9fff]{2}|[a-z0-9]+/gi) ?? []);
  const score = (message) => [...queryGrams].filter((term) => message.text.includes(term)).length;
  const selected = older.length <= 40 ? older : older.map((message, index) => ({ message, index, score: score(message) }))
    .sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 40).sort((a, b) => a.index - b.index).map(({ message }) => message);
  return selected.map((message) => {
    const full = String(message.text ?? '');
    const positions = [...queryGrams].map((term) => full.indexOf(term)).filter((index) => index >= 0);
    const offset = positions.length ? Math.max(0, Math.min(...positions) - 30) : 0;
    const excerpt = full.length <= 100 ? full : positions.length ? full.slice(offset, offset + 100) : `${full.slice(0, 45)}…${full.slice(-54)}`;
    return { source_message_id: message.message_id, actor: message.actor, text: excerpt };
  });
}
// Qwen selects exact quotations, not paraphrased facts. Even a plausible model
// invention is rejected unless its quote belongs to the cited source message.
// A substring alone is not semantically grounded: it can omit negation,
// conditions or a reported speaker. Retain the entire bounded source message.
function groundedSummary(raw, messages, previousSummary) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new TypeError('summary must return source-grounded excerpts'); }
  if (!Array.isArray(parsed.excerpts) || !parsed.excerpts.length || parsed.excerpts.length > 12) throw new TypeError('invalid summary excerpts');
  const source = new Map(messages.map((message) => [message.message_id, message]));
  const latestFacts = new Map();
  for (const message of messages) {
    const fact = message.actor === 'USER' ? explicitFact(message.text) : null;
    if (fact) latestFacts.set(fact.key, { fact, message });
  }
  const excerpts = parsed.excerpts.map((item) => {
    const message = source.get(item.message_id);
    if (!message || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 180 || !message.text.includes(item.quote)) throw new TypeError('summary excerpt does not match source');
    if (message.text.length > 600) throw new TypeError('summary source is too long to retain complete context');
    // Keep one source per physical line so incremental summaries do not drop
    // a continuation containing negation or a reported speaker.
    return `[${message.message_id}/${message.actor === 'USER' ? '用户' : '助手'}] ${message.text.replace(/[\r\n]+/g, ' ')}`;
  });
  const priorLines = previousSummary ? String(previousSummary).split('\n').filter((line) => /^\[[^\]]+\/(?:用户|助手)\] /.test(line)).slice(-6) : [];
  // Old v1 summaries remain available as explicitly unverified historical
  // context; they are never relabelled as source-verified v2 quotations.
  const newerFacts = new Map([...latestFacts].map(([key, { fact }]) => [key, fact.value]));
  const currentExcerpts = excerpts.filter((line) => {
    const fact = explicitFact(line.replace(/^\[[^\]]+\/(?:用户|助手)\] /, ''));
    return !fact || !newerFacts.has(fact.key) || newerFacts.get(fact.key) === fact.value;
  });
  const corrections = [...latestFacts.values()].slice(-6).map(({ fact, message }) => `[${message.message_id}/用户] ${fact.text}`);
  const prior = priorLines.length ? priorLines.filter((line) => {
    const fact = explicitFact(line.replace(/^\[[^\]]+\/(?:用户|助手)\] /, ''));
    return !fact || !newerFacts.has(fact.key) || newerFacts.get(fact.key) === fact.value;
  }) : previousSummary ? [`[旧版摘要/语义未核对] ${String(previousSummary).slice(0, 450)}`] : [];
  // Never truncate a verified source line mid-sentence to meet the budget.
  // Prefer corrections and this batch before inherited excerpts.
  const lines = [];
  let length = 0;
  for (const line of new Set([...corrections, ...currentExcerpts, ...prior])) {
    const nextLength = length + (lines.length ? 1 : 0) + line.length;
    if (nextLength > 1200) continue;
    lines.push(line);
    length = nextLength;
  }
  if (!lines.length) throw new TypeError('summary has no complete source excerpt within budget');
  return lines.join('\n');
}
module.exports = { explicitFact, deriveFactCandidate, unresolvedFactKeys, contextBridge, groundedSummary };
