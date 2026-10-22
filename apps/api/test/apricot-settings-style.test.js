'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../../web');
const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(web, 'apricot.css'), 'utf8');
const moduleFrom = file => import(`data:text/javascript;base64,${fs.readFileSync(path.join(web, file)).toString('base64')}`);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const destinations = {
  renderProactive: '主动消息与静默时间', renderSubscription: '试用与可用能力',
  renderDataCenter: '数据与隐私', renderSafety: '帮助与反馈', renderPlans: '陪伴计划',
};
async function render(name, overrides = {}, closed = true) {
  const ui = await moduleFrom('apricot-ui.js');
  const cards = await moduleFrom('companion-cards.js');
  const state = {theme:'day', busy:false, assets:[], trialFeedback:[], entitlements:[], trial:{state:'CLOSED_TRIAL'}, ...overrides};
  const context = vm.createContext({
    state, escapeHtml, screen: content => `<section class="screen">${content}</section>`,
    isClosedTrial: () => closed, PROACTIVE_EVENT_TYPE_LABELS:{}, FEEDBACK_CATEGORY_LABELS:{}, DELETION_STATE_LABELS:{},
    prototypeIcon: () => '<svg aria-hidden="true"></svg>', prototypeNav: ui.apricotNav, ...ui, ...cards,
  });
  for (const fn of ['trialFeedbackMarkup', 'deletionMarkup', name]) {
    const start = source.indexOf(`function ${fn}(`);
    const end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, fn);
    vm.runInContext(source.slice(start, end), context);
  }
  return context[name]();
}

test('all five settings destinations use the reference page frame and icon-only return in both themes', async () => {
  for (const theme of ['day', 'night']) for (const [name, title] of Object.entries(destinations)) {
    const html = await render(name, {theme});
    assert.match(html, /class="screen qiyu-prototype .*apricot-settings/);
    assert.ok(html.includes(theme === 'night' ? ' night ' : ' paper '));
    assert.ok(html.includes(`<h1 id="app-title">${title}</h1>`), name);
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert.match(html, /<header class="editor-header">[\s\S]*?class="icon-btn app-back"[^>]*aria-label="返回"[^>]*><svg[\s\S]*?<\/svg><\/button><\/header>/);
    assert.match(html, /<div class="settings-content">/);
    assert.ok(!/<h1[^>]*>[^<]*<\/h1>\s*<p/.test(html), 'no title subtitle is reintroduced');
  }
});

test('proactive forms, real event/message states, and busy guards survive the presentation change', async () => {
  const html = await render('renderProactive', {
    busy:true, proactivePreferences:{enabled:false,quiet_start_hour:22,quiet_end_hour:7},
    proactiveEvents:[{event_id:'event-1',type:'CONFIRMED_BIRTHDAY',title:'<生日>'}],
    proactiveMessages:[{kind:'SYSTEM',text:'<通知>',sent_at:'2026-10-21T00:00:00Z'}],
  });
  for (const id of ['proactive-preferences-form','proactive-event-form']) assert.ok(html.includes(`id="${id}"`));
  for (const field of ['proactive_enabled','quiet_start','quiet_end','event_type','event_title','event_due_at']) assert.ok(html.includes(`name="${field}"`));
  assert.ok(!/name="proactive_enabled"[^>]*checked/.test(html));
  assert.match(html, /value="22" selected/); assert.match(html, /value="7" selected/);
  assert.match(html, /data-action="trigger-proactive"[^>]*disabled/);
  assert.match(html, /data-action="delete-proactive"[^>]*disabled/);
  assert.ok(html.includes('&lt;生日&gt;') && html.includes('&lt;通知&gt;'));
  assert.match(html, /<h2>偏好<\/h2>/);
});

test('capabilities keep closed-trial and subscription truth, actions, and unavailable states', async () => {
  const closed = await render('renderSubscription', {entitlements:[{capability:'SYNTHESIZE_TTS'}]});
  assert.ok(closed.includes('已自动开通') && closed.includes('角色语音'));
  assert.ok(!closed.includes('data-action="purchase-plan"'));
  const expired = await render('renderSubscription', {trial:{state:'EXPIRED'}}, false);
  assert.ok(expired.includes('7 天完整体验已结束'));
  assert.ok(expired.includes('服务端未返回订阅目录'));
  const paid = await render('renderSubscription', {busy:true, trial:null,
    currentSubscription:{state:'ACTIVE',sku:'fixture',auto_renew:false},
    subscriptionCatalog:{plans:[{sku:'fixture',label:'测试方案',price_fen:2000,billing_cycle:'MONTH',image_quota:3,tts_minutes:10,asr_minutes:10}],auto_renew_default:false},
  }, false);
  assert.match(paid, /data-action="cancel-renewal"[^>]*disabled/);
  assert.match(paid, /data-autorenew="false"[^>]*disabled/);
  assert.match(paid, /data-autorenew="true"[^>]*disabled/);
});

test('data controls retain retention selection, feedback, receipts and destructive disabled states', async () => {
  for (const days of [30,90]) {
    const html = await render('renderDataCenter', {busy:true,rawInteractionRetentionDays:days,
      deletionJob:{state:'PENDING',id:'receipt-1'},trialFeedback:[{category:'PERSONA',rating:4,note:'<保留>'}],
    });
    assert.match(html, new RegExp(`class="on"[^>]*data-action="set-retention-${days}"[^>]*disabled`));
    for (const action of ['download-relationship-profile','open-assets','open-safety','refresh-deletion','trial-logout']) assert.ok(html.includes(`data-action="${action}"`));
    assert.match(html, /data-action="delete-account"[^>]*disabled/);
    for (const field of ['category','rating','note']) assert.ok(html.includes(`name="${field}"`));
    assert.ok(html.includes('receipt-1') && html.includes('COMPLETED') && html.includes('&lt;保留&gt;'));
    assert.ok(!html.includes('data-hero'), 'old dark promotional panel is replaced by a reference-style card');
  }
});

test('help preserves contact consent, complaints, saved state and irreversible-deletion warning', async () => {
  const html = await render('renderSafety', {busy:true,lastComplaintId:'complaint-1',emergencyContact:{contact_name:'<联系人>',relationship:'朋友',phone_masked:'138****0000'}});
  for (const field of ['contact_name','contact_relationship','contact_phone','contact_consent','complaint_kind','complaint_target','complaint_description']) assert.ok(html.includes(`name="${field}"`));
  assert.match(html, /name="contact_consent"[^>]*required/);
  assert.match(html, /data-action="remove-emergency-contact"[^>]*disabled/);
  assert.ok(html.includes('&lt;联系人&gt;') && html.includes('complaint-1'));
  assert.ok(html.includes('此操作不可撤销') && html.includes('不会用于其他用途'));
});

test('plans retain draft editing, versioned actions, empty state and existing bottom navigation', async () => {
  const empty = await render('renderPlans');
  assert.ok(empty.includes('还没有计划'));
  assert.match(empty, /settings-with-nav/); assert.match(empty, /aria-label="主导航"/);
  const draft = await render('renderPlans', {plans:[{plan_id:'plan-1',title:'<计划>',state:'DRAFT',version:3,support_mode:'PLAN',steps:[{step_id:'step-1',state:'TODO',title:'<步骤>',estimated_minutes:15}]}]});
  assert.match(draft, /class="step-title-input"[^>]*data-expected-version="3"/);
  assert.match(draft, /data-action="plan-accept"[^>]*data-plan-id="plan-1"/);
  assert.ok(draft.includes('plan-followup-checkbox') && draft.includes('&lt;计划&gt;') && draft.includes('&lt;步骤&gt;'));
});

test('settings styles share reference type, card and field scales and protect scrolling/focus', () => {
  assert.match(css, /\.qiyu-prototype\.apricot-settings\s*\{[^}]*padding:24px 23px[^}]*overflow:hidden/s);
  assert.match(css, /\.apricot-settings>h1\s*\{[^}]*font-size:25px[^}]*font-weight:500/s);
  assert.match(css, /\.apricot-settings h2\s*\{[^}]*font-size:18px[^}]*font-weight:500/s);
  assert.match(css, /\.apricot-settings \.settings-content\s*\{[^}]*min-height:0[^}]*overflow:auto/s);
  assert.match(css, /\.apricot-settings \.settings-panel[^}]*padding:16px[^}]*border-radius:20px/s);
  assert.match(css, /\.apricot-settings \.field>span\s*\{[^}]*font-size:14px/s);
  assert.match(css, /\.apricot-settings \.field :is\(input,select,textarea\)\s*\{[^}]*min-width:0[^}]*font-size:15px/s);
  assert.match(css, /\.apricot-settings :is\(input,select,textarea\):focus\s*\{[^}]*outline-offset:-2px/s);
  assert.match(css, /\.apricot-settings\.settings-with-nav\s*\{[^}]*padding-bottom:calc\(110px/s);
});

test('settings forms cannot inherit shrinking onboarding flex layout or undersized checkbox copy', () => {
  const rule = css.match(/\.qiyu-prototype\.apricot-settings \.settings-content form\{([^}]+)\}/)?.[1];
  assert.ok(rule, 'settings-specific selector must outrank the legacy onboarding form selector');
  assert.match(rule, /display:grid/);
  assert.match(rule, /flex:0 0 auto/);
  assert.match(rule, /min-height:auto/);
  assert.match(rule, /height:auto/);
  const label = css.match(/\.apricot-settings \.check-row span\{([^}]+)\}/)?.[1];
  assert.ok(label);
  assert.match(label, /font-size:14px/);
  assert.match(label, /color:var\(--ap-ink\)/);
  assert.match(label, /min-width:0/);
});

test('versioned app imports and cached settings assets advance together', () => {
  const version = '20261021-chat-menu-v32';
  const index = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  const worker = fs.readFileSync(path.join(web, 'service-worker.js'), 'utf8');
  assert.ok(index.includes(`app.js?v=${version}`) && index.includes(`apricot.css?v=${version}`));
  assert.ok(source.includes(`apricot-ui.js?v=${version}`));
  assert.ok(worker.includes(`/apricot-ui.js?v=${version}`) && worker.includes(`/apricot.css?v=${version}`));
  assert.ok(worker.includes('qiyu-shell-v32-apricot'));
});
