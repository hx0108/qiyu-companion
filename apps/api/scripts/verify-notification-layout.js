'use strict';

// Offline rendering regression, following the existing proactive-layout runner.
// Uses production render markup/CSS only; never attaches to user tabs or APIs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { launchIsolatedBrowser } = require('./isolated-browser');
const root = path.resolve(__dirname, '../../..');
const web = path.join(root, 'apps/web');
const output = path.join(root, 'output/playwright/notification-layout');
const source = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
const renderSource = source.slice(source.indexOf('function renderNotifications()'), source.indexOf('function renderSafety()'));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function main() {
  const ui = await import(`data:text/javascript;base64,${fs.readFileSync(path.join(web, 'apricot-ui.js')).toString('base64')}`);
  const styles = [path.join(web, 'tokens.css'), ...['styles.css','prototype-restoration.css','apricot.css'].map(file=>path.join(web,file))].map(file=>fs.readFileSync(file,'utf8').replace(/@import\s+url\([^;]+;/g,'')).join('\n');
  const documentFor = (html,theme) => `<!doctype html><html lang="zh-CN" data-qy-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><main class="device-shell"><div id="app" class="app">${html}</div></main></body></html>`;
  const titleStyle = page => page.locator('h1').evaluate(el=>{const s=getComputedStyle(el);return {size:s.fontSize,weight:s.fontWeight,line:s.lineHeight,family:s.fontFamily};});
  const { browser, close: closeBrowser } = await launchIsolatedBrowser({channel:'msedge',headless:true});
  const results = [];
  fs.mkdirSync(output,{recursive:true});
  try {
    for (const theme of ['day','night']) {
      const reference = await browser.newPage();
      await reference.route('**/*',route=>route.abort());
      const character={name:'林默',version:1,persona:{},persona_history:[]};
      const referenceTitles=[];
      for (const html of [ui.apricotPersonaEditor({character,portrait:'/fixture.png'}),ui.apricotPersonaVersions({character})]) {
        await reference.setContent(documentFor(html,theme));
        referenceTitles.push(await titleStyle(reference));
      }
      await reference.close();
      for (const viewport of [{width:820,height:960},{width:375,height:812},{width:320,height:640},{width:874,height:402}]) for (const scenario of ['empty','unread','read','busy']) {
        const id=`${theme}-${viewport.width}x${viewport.height}-${scenario}`;
        const page=await browser.newPage({viewport,reducedMotion:'reduce'});
        await page.route('**/*',route=>route.abort());
        const state={theme,busy:scenario==='busy',notifications:scenario==='empty'?[]:Array.from({length:4},(_,i)=>({notification_id:`fixture-${i}`,title:'试用权益与账户状态通知'.repeat(2),body:'这是一条本地合成的通知正文，用于检查长内容换行、卡片高度和滚动。'.repeat(4),created_at:'2026-10-21T00:00:00Z',read:scenario==='read'}))};
        const html=vm.runInNewContext(renderSource+'\nrenderNotifications()',{state,escapeHtml,...ui});
        await page.setContent(documentFor(html,theme));
        const metrics=await page.evaluate(()=>{
          const box=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
          const scroll=document.querySelector('.settings-content');
          const cards=[...scroll.querySelectorAll('.card,.empty-state')].map(el=>({box:box(el),radius:getComputedStyle(el).borderRadius,padding:getComputedStyle(el).padding,children:[...el.children].map(child=>({box:box(child),font:getComputedStyle(child).fontSize}))}));
          const back=document.querySelector('.app-back'), r=back.getBoundingClientRect();
          return {cards,horizontalOverflow:scroll.scrollWidth-scroll.clientWidth,back:{width:r.width,height:r.height,action:back.dataset.action,text:back.textContent.trim()},noteFont:getComputedStyle(scroll.lastElementChild).fontSize};
        });
        const violations=[];
        const heading=await titleStyle(page);
        if(referenceTitles.some(ref=>JSON.stringify(ref)!==JSON.stringify(heading))) violations.push('title typography differs from profile/version reference');
        if(metrics.back.width<44||metrics.back.height<44||metrics.back.action!=='back-notifications'||metrics.back.text) violations.push('back icon is inconsistent');
        if(metrics.horizontalOverflow>1) violations.push('horizontal overflow');
        if(metrics.noteFont!=='14px') violations.push('notification scope note font differs');
        for (const card of metrics.cards) {
          if(card.radius!=='20px'||card.padding!=='16px') violations.push('card scale differs');
          for(const child of card.children) if(child.box.left<card.box.left+14||child.box.right>card.box.right-14||child.box.bottom>card.box.bottom-14) violations.push('card content overflows');
          if(scenario!=='empty') {
            const fonts=card.children.map(child=>child.font);
            if(fonts[0]!=='15px'||fonts[1]!=='14px'||fonts[2]!=='12px') violations.push('notification type scale differs');
          }
        }
        for(let i=1;i<metrics.cards.length;i++) if(metrics.cards[i].box.top<metrics.cards[i-1].box.bottom+10) violations.push('notification cards overlap');
        if(scenario==='busy' && await page.locator('[data-action="read-notification"]').evaluateAll(buttons=>buttons.length!==4||buttons.some(button=>!button.disabled))) violations.push('busy read actions missing or enabled');
        await page.locator('.device-shell').screenshot({path:path.join(output,id+'-top.png')});
        if(scenario==='unread') {
          const button=page.locator('[data-notification-id="fixture-3"]');
          await button.scrollIntoViewIfNeeded();
          const hit=await button.evaluate(el=>{const r=el.getBoundingClientRect();const point=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return point===el||el.contains(point);});
          if(!hit) violations.push('last unread action is covered');
          await button.focus();
          if(await button.evaluate(el=>getComputedStyle(el).outlineOffset)!=='-2px') violations.push('keyboard focus is not inset');
        }
        await page.locator('.settings-content').evaluate(el=>{el.scrollTop=el.scrollHeight;});
        await page.locator('.device-shell').screenshot({path:path.join(output,id+'-bottom.png')});
        results.push({id,passed:violations.length===0,violations,heading,metrics});
        console.log(`${violations.length?'FAIL':'PASS'} ${id}${violations.length?': '+violations.join('; '):''}`);
        await page.close();
      }
    }
  } finally {
    await closeBrowser();
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
  }
  const failed=results.filter(result=>!result.passed).length;
  console.log(JSON.stringify({cases:results.length,passed:results.length-failed,failed,output}));
  if(failed) process.exitCode=1;
}
main().then(() => process.exit(process.exitCode || 0)).catch(error=>{console.error(error);process.exit(1);});
