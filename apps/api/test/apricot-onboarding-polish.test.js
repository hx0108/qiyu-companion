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

test('notice checkbox keeps receipt identity but does not expose the English version identifier', () => {
  const code = source.slice(source.indexOf('function renderNotices()'), source.indexOf('function renderAge()'));
  const html = vm.runInNewContext(code + '\nrenderNotices()', { state:{noticeChecks:new Set(),busy:false}, pendingNotices:()=>[{notice_id:'required-1',notice_version:'ai_identity_m1.0'}],escapeHtml:String,prototypeIcon:()=>'',prototypeShell:html=>html });
  assert.match(html,/data-notice-check="required-1"/);
  assert.ok(!html.includes('ai_identity_m1.0'));
  assert.ok(html.includes('我已阅读并理解系统告知。'));
});

test('template buttons start unselected and selecting one replaces the prior selection and all persona fields', () => {
  const state = {personaTemplateId:null,busy:false};
  const context = vm.createContext({ state, escapeHtml:String, prototypeShell:html=>html,prototypeIcon:()=>'',selectedPortrait:()=>({src:'/fixture.png'}),personaFields:()=>'', });
  vm.runInContext(source.slice(source.indexOf('const PERSONA_TEMPLATES ='), source.indexOf('function personaFromForm(')),context);
  vm.runInContext(source.slice(source.indexOf('function renderCharacter()'),source.indexOf('function renderOcImport()')),context);
  assert.equal((context.renderCharacter().match(/aria-pressed="true"/g)||[]).length,0);
  const nodes = ['illustrator','writer','barista'].map(id=>({dataset:{template:id},on:false,classList:{toggle(_name,value){nodes.find(n=>n.classList===this).on=value;}},setAttribute(name,value){this[name]=value;}}));
  const fields = Object.fromEntries(['character_name','persona_worldview','persona_gender','persona_age_setting','persona_relationship','persona_personality','persona_expression','persona_boundaries','persona_examples'].map(name=>[name,{value:''}]));
  const form={elements:fields,querySelectorAll:()=>nodes};
  context.selectPersonaTemplate(form,'writer');
  assert.equal(state.personaTemplateId,'writer'); assert.equal(nodes.filter(n=>n.on).length,1);
  assert.equal(nodes[1]['aria-pressed'],'true'); assert.equal(fields.persona_gender.value,'male');
  fields.character_name.value='自定义名字';
  context.selectPersonaTemplate(form,'barista');
  assert.equal(state.personaTemplateId,'barista'); assert.equal(nodes.filter(n=>n.on).length,1);
  assert.equal(nodes[1]['aria-pressed'],'false'); assert.equal(nodes[2]['aria-pressed'],'true');
  assert.equal(fields.character_name.value,'自定义名字'); assert.equal(fields.persona_gender.value,'female');
  assert.equal((context.renderCharacter().match(/aria-pressed="true"/g)||[]).length,1);
  state.busy=true; context.selectPersonaTemplate(form,'writer');
  assert.equal(state.personaTemplateId,'barista','busy form cannot switch templates');
});

test('home voice does not require a prior message or conversation and has no invitation subtitle', async () => {
  let props;
  const code=source.slice(source.indexOf('function renderHome()'),source.indexOf('function renderProfile()'));
  vm.runInNewContext(code+'\nrenderHome()', {state:{character:{character_id:'character-1'},theme:'day',assets:[],candidates:[]},characterId:()=> 'character-1',selectedPortrait:()=>({src:'/fixture.png'}),realtimeCallAvailable:()=>true,apricotHome:value=>{props=value;},prototypeIcon:()=>''});
  assert.equal(props.canCall,true);
  const {apricotHome}=await ui();
  for(const createdAt of [undefined,'2026-10-20T00:00:00Z']){
    const html=apricotHome({name:'林默',canCall:true,createdAt});
    assert.ok(!html.includes('把日常，慢慢说给他听。'));
    assert.ok(!html.includes('一起走过的第'));
    assert.ok(!/<div class="apricot-intro">[\s\S]*?<p>/.test(html.slice(0,html.indexOf('apricot-tiles'))));
    assert.ok(!/data-action="start-call"[^>]*disabled/.test(html));
  }
});

test('profile fields have an unclipped orange focus indicator without suppressing focus', () => {
  const rule=css.match(/\.profile-editor \.field :is\(input,textarea,select\):focus\{([^}]+)\}/)?.[1];
  assert.ok(rule); assert.match(rule,/outline:2px solid var\(--ap-brand\)/); assert.match(rule,/outline-offset:-2px/);
});

test('home call action prepares the current character conversation without requiring a first text message', async () => {
  const state={character:{character_id:'character-1'},route:'home'};
  let options; let prepared=0;
  const context=vm.createContext({state,callClient:null,characterId:()=> 'character-1',conversationId:()=>null,
    realtimeCallAvailable:()=>true,setToast(){},render(){},API_BASE:'/api/v1',window:{},handleCallEvent(){},
    authenticatedHeaders:()=>new Map(),ensureConversation:async()=>{prepared++;return {conversation_id:'conversation-1',character_id:'character-1'};},
    RealtimeCallClient:class{constructor(value){options=value;}async start(){await this.prepare();}async prepare(){return options.prepareConversation();}}});
  vm.runInContext(source.slice(source.indexOf('function startVoiceCall()'),source.indexOf('function toggleCallMute()')),context);
  context.startVoiceCall(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prepared,1); assert.equal(state.route,'call');
  assert.equal(await options.prepareConversation(),'conversation-1');
  assert.equal(state.messages,undefined,'call startup does not manufacture a first message');
});

test('profile destinations remove title subtitles but retain functional forms and safety content', async () => {
  const {apricotPersonaEditor,apricotPersonaVersions}=await ui();
  const character={name:'林默',version:1,persona:{},persona_history:[],persona_restore_supported:true};
  for(const html of [apricotPersonaEditor({character,portrait:'/fixture.png'}),apricotPersonaVersions({character})]) assert.ok(!/<h1\b[^>]*>[\s\S]*?<\/h1>\s*<p/.test(html));
  for(const [start,end] of [['renderProactive','startHeartbeat'],['renderSubscription','renderImageReference'],['renderDataCenter','openMemoryReferences'],['renderSafety','renderContinuousReminder']]){
    const code=source.slice(source.indexOf(`function ${start}(`),source.indexOf(`function ${end}(`));
    assert.ok(!/<h1\b[^>]*>[^<]*<\/h1><p class="(?:lead|page-sub)"/.test(code),start);
  }
  const plans=source.slice(source.indexOf('function renderPlans()'),source.indexOf('async function saveProactivePreferences('));
  assert.match(plans,/apricotSettingsPage\("陪伴计划"/);
  assert.ok(!plans.includes('角色提议只是草案'));
  assert.ok(source.includes('name="contact_consent"'));
});
