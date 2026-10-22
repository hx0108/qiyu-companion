'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../../web');
const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const ui = () => import(`data:text/javascript;base64,${fs.readFileSync(path.join(web, 'apricot-ui.js')).toString('base64')}`);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function render(overrides = {}) {
  const state = {theme:'day',busy:false,notifications:[],...overrides};
  return vm.runInNewContext(source.slice(source.indexOf('function renderNotifications()'), source.indexOf('function renderSafety()'))+'\nrenderNotifications()', {
    state, escapeHtml, ...await ui(), screen:content=>`<section class="screen">${content}</section>`,
  });
}

test('notifications reuse the profile/settings hierarchy in both themes, retaining icon-only origin-aware back', async () => {
  for (const theme of ['day','night']) {
    const html = await render({theme});
    assert.match(html, /class="screen qiyu-prototype .*apricot-settings/);
    assert.ok(html.includes(theme==='night'?' night ':' paper '));
    assert.equal((html.match(/<h1\b/g)||[]).length,1);
    assert.match(html, /<h1 id="app-title">站内通知<\/h1><div class="settings-content">/);
    assert.match(html, /class="editor-header">[\s\S]*?data-action="back-notifications"[^>]*aria-label="返回上一页"[^>]*><svg/);
    assert.ok(!html.includes('返回数据中心') && !html.includes('back-data'));
    assert.ok(!/>返回[^<]*</.test(html));
    assert.ok(html.indexOf('暂时没有通知。') < html.indexOf('这里只显示账户状态'));
    assert.ok(!html.includes('class="lead"'));
  }
});

test('notifications retain read/unread state, escaped content, timestamps, identifiers and busy guard', async () => {
  const notifications = [
    {notification_id:'fixture-unread',title:'<未读标题>',body:'<正文>',created_at:'2026-10-21T00:00:00Z',read:false},
    {notification_id:'fixture-read',title:'已读标题',body:'已读正文',created_at:'2026-10-20T00:00:00Z',read:true},
  ];
  for (const busy of [false,true]) {
    const html = await render({notifications,busy});
    assert.equal((html.match(/<article class="card">/g)||[]).length,2);
    assert.equal((html.match(/data-action="read-notification"/g)||[]).length,1);
    assert.match(html, /data-notification-id="fixture-unread"/);
    assert.ok(!html.includes('data-notification-id="fixture-read"'));
    assert.ok(html.includes('&lt;未读标题&gt;') && html.includes('&lt;正文&gt;'));
    assert.ok(html.includes(' · 未读') && html.includes(' · 已读'));
    assert.equal(/data-action="read-notification"[^>]*disabled/.test(html),busy);
    assert.ok(!html.includes('暂时没有通知。'));
  }
});

test('shared settings back options preserve defaults and escape caller-supplied labels/actions', async () => {
  const {apricotSettingsPage} = await ui();
  const standard = apricotSettingsPage('标题','<div>正文</div>');
  assert.match(standard, /data-action="back-chat" aria-label="返回"/);
  const custom = apricotSettingsPage('<标题>','<div>正文</div>',{backAction:'back-"test',backLabel:'返回<入口>'});
  assert.match(custom, /data-action="back-&quot;test" aria-label="返回&lt;入口&gt;"/);
  assert.match(custom, /&lt;标题&gt;/);
});
