'use strict';

const { detectOoc } = require('./ooc-policy');
const OOC_FALLBACK_TEXT = '我刚才的表达不够贴合这个角色。我们换一种更自然的方式继续聊，好吗？';

function oocFallback(reply, code) {
  return { ...reply, provider: 'ooc-guard', model_version: 'ooc-guard-v1', ai_generated: false, memory_candidate: null, reply_text: OOC_FALLBACK_TEXT, ooc_guard: code };
}

async function guardPersonaReply(reply, { text, contextPack, replyGenerator, normalize = (value) => value, repairUsed = false, violationCode = null }) {
  let decision = violationCode ? { decision: 'REPAIR_REQUIRED', code: violationCode } : detectOoc(reply.reply_text, contextPack.character, { userText: text });
  if (decision.decision === 'PASS') return reply;
  if (!repairUsed && reply.ai_generated !== false && typeof replyGenerator === 'function') {
    try {
      reply = normalize(await replyGenerator(text, { ...contextPack, ooc_repair: { code: decision.code } }));
      decision = detectOoc(reply.reply_text, contextPack.character, { userText: text });
      if (decision.decision === 'PASS') return reply;
    } catch {
      // A failed repair must remain a deterministic fallback, never an unguarded retry.
    }
  }
  return oocFallback(reply, decision.code);
}

// Hold incomplete phrases so identity claims split across provider chunks cannot
// leak. Completed clauses still flow immediately; no whole-turn buffering.
function createPersonaStreamGuard(character, deliver, { userText } = {}) {
  let pending = '';
  let checked = '';
  function check(text) {
    const decision = detectOoc(text, character, { userText });
    if (decision.decision !== 'PASS') throw Object.assign(new Error('角色身份表达需要修复'), { code: 'OOC_STREAM_REPAIR_REQUIRED', oocCode: decision.code });
  }
  async function push(fragment) {
    pending += String(fragment || '');
    const parts = pending.match(/[^。！？!?；;，,\n]*[。！？!?；;，,\n]+/gu) || [];
    for (const part of parts) {
      check(checked + part);
      checked += part;
      pending = pending.slice(part.length);
      if (await deliver(part) === false) return false;
    }
    // Providers also flush long unpunctuated text. Keep a short suffix for
    // cross-chunk identity claims rather than holding that entire answer.
    while (pending.length > 48) {
      let length = pending.length - 32;
      const tailStart = Math.max(0, length - 32);
      const tail = pending.slice(tailStart, length);
      const identityStart = tail.search(/(?:我是|我叫|作为|我就是)/u);
      if (identityStart >= 0) length = tailStart + identityStart;
      if (length === 0) break; // An unfinished identity at the start needs its continuation.
      const part = pending.slice(0, length);
      check(checked + part);
      checked += part;
      pending = pending.slice(length);
      if (await deliver(part) === false) return false;
    }
    return true;
  }
  async function finish(finalText) {
    check(finalText);
    if (pending) {
      const tail = pending;
      pending = '';
      checked += tail;
      if (await deliver(tail) === false) throw Object.assign(new Error('终稿未通过输出门禁'), { code: 'QWEN_STREAM_INTERCEPTED' });
    }
  }
  return { push, finish };
}

module.exports = { OOC_FALLBACK_TEXT, oocFallback, guardPersonaReply, createPersonaStreamGuard };
