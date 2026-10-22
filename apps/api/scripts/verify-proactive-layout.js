'use strict';

// Isolated rendering regression: actual page markup + all production styles.
// No app bootstrap, browser profile, API, account or provider requests are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { launchIsolatedBrowser } = require('./isolated-browser');
const root = path.resolve(__dirname, '../../..');
const web = path.join(root, 'apps/web');
const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const output = path.join(root, 'output/playwright/proactive-layout/fixed');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readCss = file => fs.readFileSync(file, 'utf8').replace(/@import\s+url\([^;]+;/g, '');

async function main() {
  const ui = await import(`data:text/javascript;base64,${fs.readFileSync(path.join(web, 'apricot-ui.js')).toString('base64')}`);
  const styles = [path.join(web, 'tokens.css'), ...['styles.css','prototype-restoration.css','apricot.css'].map(file => path.join(web, file))].map(readCss).join('\n');
  const start = source.indexOf('function renderProactive()');
  const render = source.slice(start, source.indexOf('\n}', start) + 2);
  const { browser, close: closeBrowser } = await launchIsolatedBrowser({channel:'msedge', headless:true});
  const results = [];
  fs.mkdirSync(output, {recursive:true});
  try {
    for (const theme of ['day','night']) for (const viewport of [{width:820,height:960},{width:375,height:812},{width:320,height:640},{width:874,height:402}]) for (const scenario of ['empty','populated','busy']) {
      const id = `${theme}-${viewport.width}x${viewport.height}-${scenario}`;
      const page = await browser.newPage({viewport, reducedMotion:'reduce'});
      await page.route('**/*', route => route.abort()); // The fixture must remain offline.
      const state = {theme, busy:scenario === 'busy', proactivePreferences:{enabled:true,quiet_start_hour:23,quiet_end_hour:8},
        proactiveEvents:scenario === 'populated' ? [{event_id:'fixture-event',type:'CONFIRMED_APPOINTMENT',title:'周末一起散步，也聊聊这一周开心和烦恼的小事'.repeat(3)}] : [],
        proactiveMessages:scenario === 'populated' ? [{kind:'SYSTEM',sent_at:'2026-10-21T00:00:00Z',text:'提醒已按你确认的时间发送。'.repeat(8)}] : [],
      };
      const html = vm.runInNewContext(`${render}\nrenderProactive()`, {state, escapeHtml, ...ui, PROACTIVE_EVENT_TYPE_LABELS:{CONFIRMED_APPOINTMENT:'约定'}});
      await page.setContent(`<!doctype html><html lang="zh-CN" data-qy-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><main class="device-shell"><div id="app" class="app">${html}</div></main></body></html>`);
      const metrics = await page.evaluate(() => {
        const box = el => {const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
        const scroller = document.querySelector('.settings-content');
        const forms = [...document.querySelectorAll('.settings-content form')].map(form => ({id:form.id,box:box(form),style:{display:getComputedStyle(form).display,flexGrow:getComputedStyle(form).flexGrow,flexShrink:getComputedStyle(form).flexShrink},children:[...form.children].map(el=>({tag:el.tagName,box:box(el)}))}));
        const groups = [...scroller.children].map(box);
        const check = document.querySelector('.check-row span');
        return {forms,groups,horizontalOverflow:scroller.scrollWidth-scroller.clientWidth,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,checkFont:getComputedStyle(check).fontSize};
      });
      const violations = [];
      for (const form of metrics.forms) {
        if (form.style.display !== 'grid' || form.style.flexGrow !== '0' || form.style.flexShrink !== '0') violations.push(`${form.id}: old flex sizing is active`);
        for (const child of form.children) if (child.box.top < form.box.top+14 || child.box.bottom > form.box.bottom-14 || child.box.left < form.box.left+14 || child.box.right > form.box.right-14) violations.push(`${form.id}: ${child.tag} escapes card padding`);
        for (let i=1;i<form.children.length;i++) if (form.children[i].box.top < form.children[i-1].box.bottom+10) violations.push(`${form.id}: children overlap or lose spacing`);
      }
      for (let i=1;i<metrics.groups.length;i++) if (metrics.groups[i].top < metrics.groups[i-1].bottom+10) violations.push('page groups overlap');
      if (metrics.horizontalOverflow > 1) violations.push('horizontal overflow');
      if (metrics.checkFont !== '14px') violations.push('checkbox text inherits old 12px style');
      await page.locator('.device-shell').screenshot({path:path.join(output, `${id}-top.png`)});
      await page.locator('#proactive-event-form button').scrollIntoViewIfNeeded();
      const createVisible = await page.locator('#proactive-event-form button').isVisible();
      const hit = await page.locator('#proactive-event-form button').evaluate(el => {const r=el.getBoundingClientRect();const target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return el===target||el.contains(target);});
      if (!createVisible || !hit) violations.push('create button is covered or unreachable');
      if (scenario === 'empty' && theme === 'day' && viewport.width === 820) await page.locator('.device-shell').screenshot({path:path.join(output, 'day-desktop-create-visible.png')});
      await page.locator('.settings-content').evaluate(el => {el.scrollTop=el.scrollHeight;});
      await page.locator('.device-shell').screenshot({path:path.join(output, `${id}-bottom.png`)});
      if (scenario !== 'busy') {
        await page.getByRole('checkbox').uncheck();
        if (await page.getByRole('checkbox').isChecked()) violations.push('checkbox cannot toggle');
        await page.locator('[name="quiet_start"]').selectOption('22');
        await page.locator('[name="event_title"]').fill('本地布局检查');
        await page.locator('[name="event_due_at"]').fill('2026-10-22');
        await page.locator('[name="event_title"]').focus();
        const focus = await page.locator('[name="event_title"]').evaluate(el => ({offset:getComputedStyle(el).outlineOffset,width:getComputedStyle(el).outlineWidth}));
        if (focus.offset !== '-2px' || focus.width !== '2px') violations.push('field focus ring is not inset');
      } else if (await page.locator('#proactive-event-form button').isEnabled()) violations.push('busy create action is enabled');
      results.push({id,passed:violations.length===0,violations,metrics});
      console.log(`${violations.length ? 'FAIL' : 'PASS'} ${id}${violations.length ? ': '+violations.join('; ') : ''}`);
      await page.close();
    }
  } finally {
    await closeBrowser();
    fs.writeFileSync(path.join(output,'results.json'), JSON.stringify(results,null,2));
  }
  const failed = results.filter(result=>!result.passed).length;
  console.log(JSON.stringify({cases:results.length,passed:results.length-failed,failed,output}));
  if (failed) process.exitCode=1;
}
main().then(() => process.exit(process.exitCode || 0)).catch(error=>{console.error(error);process.exit(1);});
