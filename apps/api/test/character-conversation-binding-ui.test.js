'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/app.js'), 'utf8');
function load(start, end, state, extra = {}) {
  const context = vm.createContext({ state,
    characterId: () => state.character?.character_id ?? state.character?.id,
    conversationId: () => state.conversation?.conversation_id ?? state.conversation?.id,
    unwrap: (value, key) => value?.[key], uuid: () => 'synthetic-id',
    refreshWorldState: async () => {}, restoreReferenceImage: async () => {},
    hydrateContextImages: async () => {}, refreshMemoryAndAssets: async () => {}, refreshTrialFeedback: async () => {},
    ...extra });
  vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  return context;
}
test('restore selects the selected characters open conversation even when another characters conversation is last', async () => {
  const state = {};
  const requested = [];
  const context = load('async function restoreSession()', 'async function refreshTrialFeedback()', state, { api: async route => {
    requested.push(route);
    if (route === '/characters') return { characters: [{ character_id: 'selected', status: 'ACTIVE' }, { character_id: 'other', status: 'ACTIVE' }] };
    if (route === '/conversations') return { conversations: [
      { conversation_id: 'mine', character_id: 'selected', status: 'OPEN' },
      { conversation_id: 'theirs', character_id: 'other', status: 'OPEN' } ] };
    return { messages: [] };
  } });
  await context.restoreSession();
  assert.equal(state.conversation.conversation_id, 'mine');
  assert.ok(requested.includes('/conversations/mine/messages?limit=50'));
  assert.ok(!requested.some(route => route.includes('theirs')));
});
test('ensure reuses only the current characters existing conversation', async () => {
  const conversation = { conversation_id: 'mine', character_id: 'selected' };
  const state = { character: { character_id: 'selected' }, conversation };
  const context = load('async function ensureConversation()', 'async function consumeSseStream(', state, { api: () => { throw new Error('should not create'); } });
  assert.equal(await context.ensureConversation(), conversation);
});
test('ensure replaces a stale other-character conversation and clears its messages', async () => {
  const state = { character: { character_id: 'selected' }, conversation: { conversation_id: 'theirs', character_id: 'other' }, messages: [{ text: 'old fixture' }] };
  const context = load('async function ensureConversation()', 'async function consumeSseStream(', state, { api: async (route, options) => {
    assert.equal(route, '/conversations'); assert.equal(options.body.character_id, 'selected');
    assert.equal(state.conversation, null); assert.equal(state.messages.length, 0);
    return { conversation: { conversation_id: 'new', character_id: 'selected' } };
  } });
  assert.equal((await context.ensureConversation()).conversation_id, 'new');
});
test('ensure rejects a response bound to a different character', async () => {
  const state = { character: { character_id: 'selected' }, conversation: null, messages: [] };
  const context = load('async function ensureConversation()', 'async function consumeSseStream(', state, { api: async () => ({ conversation: { conversation_id: 'wrong', character_id: 'other' } }) });
  await assert.rejects(context.ensureConversation(), /角色会话不匹配/); assert.equal(state.conversation, null);
});
test('ensure does not install a pending conversation after selected character changes', async () => {
  const state = { character: { character_id: 'selected' }, conversation: null, messages: [] };
  const context = load('async function ensureConversation()', 'async function consumeSseStream(', state, { api: async () => {
    state.character = { character_id: 'changed' }; return { conversation: { conversation_id: 'old-result', character_id: 'selected' } };
  } });
  await assert.rejects(context.ensureConversation(), /角色会话不匹配/); assert.equal(state.conversation, null);
});
test('dial never starts the model for another characters conversation', () => {
  const state = { character: { character_id: 'selected' }, conversation: { conversation_id: 'theirs', character_id: 'other' } };
  let clientCreated = 0; let toast;
  const context = load('function startVoiceCall()', 'function toggleCallMute()', state, { callClient: null,
    realtimeCallAvailable: () => true, setToast: value => { toast = value; },
    RealtimeCallClient: class { constructor() { clientCreated++; } } });
  context.startVoiceCall(); assert.equal(clientCreated, 0); assert.match(toast, /当前角色/);
});
test('creating a new character clears the prior characters conversation and messages', async () => {
  const state = { character: { character_id: 'old' }, conversation: { conversation_id: 'old-call', character_id: 'old' }, messages: [{ text: 'old fixture' }], portraitDraft: 'original' };
  const context = load('async function createCharacter(form)', 'async function submitOcImport(form)', state, {
    setBusy() {}, setToast() {}, serverMessage: value => value.message,
    api: async () => ({ character: { character_id: 'new' } }), personaFromForm: () => ({})
  });
  await context.createCharacter({ elements: { character_name: { value: 'Synthetic' }, rights_confirmed: { checked: true } } });
  assert.equal(state.character.character_id, 'new'); assert.equal(state.conversation, null); assert.equal(state.messages.length, 0);
});

test('matching-character dial starts the native client synchronously with the current conversation', () => {
  const state = { character: { character_id: 'selected' }, conversation: { conversation_id: 'mine', character_id: 'selected' } };
  let received; let starts = 0;
  const context = load('function startVoiceCall()', 'function toggleCallMute()', state, { callClient: null,
    API_BASE: '/api/v1', window: {}, render() {}, handleCallEvent() {},
    realtimeCallAvailable: () => true, setToast() {},
    RealtimeCallClient: class { constructor(options) { received = options; } start() { starts++; return Promise.resolve(); } } });
  context.startVoiceCall();
  assert.equal(received.conversationId, 'mine'); assert.equal(starts, 1); assert.equal(state.route, 'call');
});
