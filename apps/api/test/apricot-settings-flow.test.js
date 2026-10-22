'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../web');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'apricot.css'), 'utf8');
const ui = () => import(`data:text/javascript;base64,${fs.readFileSync(path.join(root, 'apricot-ui.js')).toString('base64')}`);
const character = { character_id:'fixture-character', name:'林默', version:2, active_persona_version:2, persona:{ gender:'male', personality:'安静' }, persona_history:[
  { version:1, state:'RETIRED', note:'创建角色', changed_fields:['personality'], created_at:'2026-10-20T00:00:00Z' },
  { version:2, state:'STABLE', note:'修改性格', changed_fields:['personality'], created_at:'2026-10-21T00:00:00Z' }
] };
function load(start, end, state, extra = {}) {
  const context = vm.createContext({ state, characterId:()=>state.character?.character_id, setBusy(){}, setToast(){}, serverMessage:error=>error.message, uuid:()=> 'fixture-key', refreshWorldState:async()=>{}, ...extra });
  vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  return context;
}

test('notifications return to their entry page, without entering the data center', async () => {
  for (const origin of ['home','profile','data']) {
    const state = { route:origin };
    const context = load('async function openNotifications()', 'async function markNotificationRead(', state, { refreshNotifications:async()=>{} });
    await context.openNotifications();
    assert.equal(state.route, 'notifications');
    assert.equal(state.notificationsOrigin, origin);
    vm.runInContext("const action='back-notifications';" + source.match(/  if \(action === 'back-notifications'\)[^\n]+/)[0], vm.createContext({ state, render(){} }));
    assert.equal(state.route, origin);
  }
  const notifications = source.slice(source.indexOf('function renderNotifications()'), source.indexOf('function renderSafety()'));
  assert.ok(notifications.includes('back-notifications'));
  assert.ok(!notifications.includes('back-data'));
  const data = source.slice(source.indexOf('function renderDataCenter()'), source.indexOf('// ---- 生活事件'));
  assert.ok(!data.includes('data-action="open-notifications"'));
  const { apricotProfile } = await ui();
  const html = apricotProfile({ name:'林默', portrait:'/fixture.png' });
  assert.match(html, /数据与隐私/);
  assert.match(html, /data-action="open-data"/);
  assert.match(html, /data-action="open-persona-versions"/);
});

test('secondary back preserves nested parents, while chat tab still navigates directly to chat', () => {
  const back = source.match(/  if \(action === "back-chat"\)[^\n]+/)[0];
  const state = { route:'safety', secondaryParents:{ safety:'data', data:'profile' }, secondaryOrigin:'home' };
  const context = vm.createContext({ state, action:'back-chat', button:{ closest:()=>null }, render(){} });
  vm.runInContext(back, context); assert.equal(state.route, 'data');
  vm.runInContext(back, context); assert.equal(state.route, 'profile');
  context.button.closest = () => ({}); vm.runInContext(back, context); assert.equal(state.route, 'chat');
});

test('profile has four compact steps, retains every field and draft, and styles both save buttons consistently', async () => {
  const { apricotPersonaEditor } = await ui();
  for (let step=0;step<4;step++) {
    const html = apricotPersonaEditor({ character, portrait:'/fixture.png', step, draft:{ persona_worldview:{value:'<保留草稿>'},pref_emoji:{checked:false},pref_character_to_user:{value:'小映'} } });
    for (const label of ['基本资料','陪伴方式','相处边界','我的偏好']) assert.ok(html.includes(label));
    for (const field of ['character_name','persona_gender','persona_worldview','persona_age_setting','persona_relationship','persona_personality','persona_expression','persona_boundaries','persona_examples','pref_character_to_user','pref_taboos','pref_sleep_at','pref_wake_at','pref_reply_length','pref_emoji']) assert.ok(html.includes(`name="${field}"`), field);
    assert.equal((html.match(/class="btn btn-primary editor-save"/g)||[]).length, 2);
    assert.ok(html.includes('&lt;保留草稿&gt;'));
    assert.ok(!html.includes('变更记录'));
    assert.ok(!/name="pref_emoji"[^>]*checked/.test(html));
    assert.ok(html.includes(`aria-current="step"`));
  }
  const busy = apricotPersonaEditor({ character, portrait:'/fixture.png', busy:true });
  assert.equal((busy.match(/class="btn btn-primary editor-save" disabled/g)||[]).length, 2);
  assert.match(css,/\.profile-editor\{[^}]*overflow:hidden/);
  assert.match(css,/\.editor-panels\{[^}]*overflow:auto/);
});

test('profile draft capture retains hidden fields and checkbox state across rerenders and portrait selection', () => {
  const state = {};
  const fields = [{name:'character_name',value:'新名字',checked:false},{name:'persona_worldview',value:'保留世界观',checked:false},{name:'pref_emoji',value:'on',checked:false}];
  const context = load('function captureProfileDraft()', 'async function openPersonaVersions()', state, { app:{dataset:{route:'character-profile'},querySelectorAll:()=>fields} });
  context.captureProfileDraft();
  assert.equal(state.profileDraft.persona_worldview.value,'保留世界观');
  assert.equal(state.profileDraft.pref_emoji.checked,false);
  assert.ok(source.indexOf('captureProfileDraft();', source.indexOf('function render()')) < source.indexOf('app.innerHTML = view', source.indexOf('function render()')));
});

test('portrait confirmation is right-aligned, without the former header label or Done text', () => {
  const context = load('function renderPortraitPicker()', 'function renderCharacterProfile()', {}, { selectedPortrait:()=>({id:'original',src:'/fixture.png',label:'经典'}),CHARACTER_PORTRAITS:[] });
  const header = context.renderPortraitPicker().match(/<header[^>]*>([\s\S]*?)<\/header>/)[1];
  assert.match(header, /portrait-confirm/);
  assert.match(header, />确认<\/button>/);
  assert.ok(!header.includes('角色形象'));
  assert.ok(!header.includes('完成'));
  assert.match(css,/\.portrait-picker \.portrait-confirm\{[^}]*margin-left:auto/);
});

test('back buttons expose accessible names and icons without visible Return text', async () => {
  const { apricotBackButton } = await ui();
  const html = apricotBackButton('back-notifications','返回此刻');
  assert.match(html,/aria-label="返回此刻"/); assert.match(html,/<svg/);
  assert.ok(!/>返回[^<]*</.test(html));
  assert.ok(!/<button\b[^>]*>返回[^<]*<\/button>/.test(source));
});

test('persona history is separate, and restore is gated on actual server support', async () => {
  const { apricotPersonaVersions, personaFeedbackPrefix } = await ui();
  const feedback = [{category:'PERSONA',rating:4,note:personaFeedbackPrefix(character.character_id,1)+'保留温柔',created_at:'2026-10-21T00:00:00Z'}, {category:'PERSONA',rating:1,note:'[角色 other · 人格 v1] 不应出现',created_at:'2026-10-21T00:00:00Z'}];
  const old = apricotPersonaVersions({ character, feedback });
  assert.match(old,/人格版本/); assert.match(old,/回退到此版本<\/button>/);
  assert.match(old,/data-action="prepare-persona-restore"[^>]*disabled/);
  assert.ok(!old.includes('不应出现'));
  const ready = apricotPersonaVersions({ character:{...character,persona_restore_supported:true},feedback,restore:{version:1,reason:'恢复原先设定'} });
  assert.ok(!/data-action="prepare-persona-restore"[^>]*disabled/.test(ready));
  assert.match(ready,/id="persona-restore-form"/);
  assert.match(ready,/>确认回退<\/button>/);
  assert.match(ready,/保留温柔/);
});

test('unsupported restore never mutates, and version feedback is associated through the existing feedback API', async () => {
  let calls=0;
  const state = { character, personaRestore:{version:1,expectedVersion:2}, trialFeedback:[],personaFeedbackDraft:{} };
  const context = load('async function restorePersonaVersion(', 'async function submitPersonaVersionFeedback(', state, { api:async()=>{calls++;} });
  await context.restorePersonaVersion({}); assert.equal(calls,0);
  const { personaFeedbackPrefix } = await ui();
  const feedbackContext = load('async function submitPersonaVersionFeedback(', 'async function ensureConversation()', state, { personaFeedbackPrefix,api:async(route,options)=>{
    assert.equal(route,'/trial-feedback'); assert.equal(options.body.category,'PERSONA');
    assert.equal(options.body.note,personaFeedbackPrefix(character.character_id,1)+'喜欢原来的表达');
    return {feedback:{feedback_id:'fixture',...options.body}};
  }});
  await feedbackContext.submitPersonaVersionFeedback({elements:{feedback_version:{value:'1'},feedback_rating:{value:'5'},feedback_note:{value:'喜欢原来的表达'}}});
  assert.equal(state.trialFeedback.length,1);
});
