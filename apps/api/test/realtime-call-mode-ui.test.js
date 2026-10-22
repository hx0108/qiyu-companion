'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/app.js'), 'utf8');
function functions(state) {
  const code = source.slice(source.indexOf('function realtimeCallAvailable()'), source.indexOf('function updateCallHud()'));
  return vm.runInNewContext(`${code}\n({realtimeCallAvailable})`, { state, screen: value => value, isClosedTrial: () => state.trialAccess?.enabled === true });
}
test('native calling is available only when capability and invited authenticated trial session are present', () => {
  for (const [capability, trial, token, expected] of [[true,true,'token',true], [false,true,'token',false], [true,false,'token',false], [true,true,null,false]]) {
    const state = { trialAccess: { enabled: trial, realtime_call: { enabled: capability } }, trialSession: { access_token: token }, voiceCallEnabled: true };
    assert.equal(functions(state).realtimeCallAvailable(), expected);
  }
});
test('telephone starts the native model directly without a mode choice or verification gate', () => {
  assert.match(source, /if \(action === "start-call"\) startVoiceCall\(\);/);
  assert.doesNotMatch(source, /renderCallMode|start-realtime-call|start-standard-call|低延迟验证|选择语音通话/);
  const start = source.slice(source.indexOf('function startVoiceCall('), source.indexOf('function toggleCallMute('));
  assert.match(start, /new RealtimeCallClient\(/);
  assert.match(start, /if \(!realtimeCallAvailable\(\)\).*语音通话暂不可用/);
  assert.doesNotMatch(start, /CallSessionClient/);
});
test('updated shell cache refreshes native call behavior', () => {
  const sw = fs.readFileSync(path.resolve(__dirname, '../../web/service-worker.js'), 'utf8');
  assert.match(sw, /qiyu-shell-v32-apricot/); assert.match(sw, /'\/realtime-call-client.js'/);
});

test('settling an old hangup cannot reset a newly dialled call', async () => {
  let resolveOld; let renders = 0;
  const newer = { phase: 'ringing' };
  const context = vm.createContext({ state: { call: { mode: 'native-realtime' }, route: 'call' },
    callClient: { hangup: () => new Promise(resolve => { resolveOld = resolve; }) },
    window: { clearInterval() {}, __qiyuCall: null }, callTimerTimer: null,
    render: () => renders++, conversationId: () => 'synthetic', api: async () => ({ messages: [] }), unwrap: value => value.messages,
    setToast() {}, CALL_END_REASON_LABELS: {} });
  const code = source.slice(source.indexOf('async function hangupCall()'), source.indexOf('function renderSubscription()'));
  vm.runInContext(code, context);
  const pending = context.hangupCall();
  context.callClient = newer; context.state.call = newer; context.state.route = 'call';
  resolveOld({ end_reason: 'USER_HANGUP' }); await pending;
  assert.equal(context.state.call, newer); assert.equal(context.state.route, 'call'); assert.equal(renders, 0);
});
