'use strict';
// Full production frontend + disposable local mock API. No user session, real
// provider, microphone, remote browser or public service is accessed.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {launchIsolatedBrowser}=require('./isolated-browser');
const {startPreview}=require('./start-apricot-preview');
const root=path.resolve(__dirname,'../../..');
const baseline=process.argv.includes('--baseline');
const output=path.join(root,'output/playwright/chat-menu',baseline?'baseline':'fixed');
const results=[];
const viewports=[{width:320,height:640},{width:375,height:812},{width:412,height:915},{width:820,height:960},{width:874,height:402},{width:375,height:480}];

async function main(){
 fs.mkdirSync(output,{recursive:true});
 const {server,origin}=await startPreview({port:0});
 const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 const {browser,close:closeBrowser}=await launchIsolatedBrowser({channel:'msedge',headless:true});
 async function contextPage(viewport,night=false,large=false){
  const context=await browser.newContext({viewport,serviceWorkers:'block',reducedMotion:'reduce'});
  const errors=[];
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  await page.goto(origin);
  await page.getByRole('button',{name:'陪伴',exact:true}).waitFor();
  if(night){await page.getByRole('button',{name:'我的',exact:true}).click();await page.getByRole('button',{name:'切换日夜主题',exact:true}).click();}
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.locator('.apricot-chat').waitFor();
  if(large){
   // Serve a test-only same-origin stylesheet; retain the application's CSP.
   const url=origin+'/__test/large-text.css';
   await page.route(url,route=>route.fulfill({contentType:'text/css',body:'.apricot-chat-menu :is(button,h2){font-size:24px!important;line-height:1.6!important}'}));
   await page.addStyleTag({url});
  }
  return {context,page,errors};
 }
 async function open(page){await page.getByRole('button',{name:'陪伴设置',exact:true}).click();await page.getByRole('dialog',{name:'陪伴选项',exact:true}).waitFor();}
 try{
  for(const night of [false,true])for(const viewport of baseline?[{width:375,height:812}]:viewports)for(const large of baseline?[false]:[false,true]){
   const id=`${night?'night':'day'}-${viewport.width}x${viewport.height}-${large?'large':'normal'}`;
   const {context,page,errors}=await contextPage(viewport,night,large);
   try{
    await page.locator('textarea[name="message"]').fill('尚未发送的中文草稿');
    await open(page);
    const metrics=await page.evaluate(()=>{
     const box=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
     const app=document.querySelector('#app'),layer=document.querySelector('#app > .sheet-layer'),dialog=document.querySelector('.apricot-chat-menu');
     const close=dialog.querySelector('[data-action="close-chat-menu"]'),list=dialog.querySelector('.apricot-chat-menu-items');
     // The desktop device frame clips its rounded corners. Probe inside the
     // actual visible scrim rather than the transparent top-left corner.
     const a=box(app),hit=document.elementFromPoint(a.left+a.width/2,a.top+10);
     return {app:a,layer:box(layer),dialog:box(dialog),close:box(close),position:getComputedStyle(layer).position,closeBorder:getComputedStyle(close).borderTopWidth,closeRadius:getComputedStyle(close).borderRadius,backgroundInert:app.querySelector('.screen').inert,hitIsOverlay:!!hit?.closest('.sheet-layer'),pageOverflow:document.documentElement.scrollWidth-innerWidth,list:list?{...box(list),scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,overflowY:getComputedStyle(list).overflowY}:null,actions:[...dialog.querySelectorAll('.apricot-setting')].map(el=>({action:el.dataset.action,...box(el)})),focused:document.activeElement?.dataset.action};
    });
    const violations=[];
    if(metrics.position!=='absolute')violations.push('root sheet is in normal document flow');
    for(const key of ['left','right','top','bottom'])if(Math.abs(metrics.layer[key]-metrics.app[key])>1)violations.push('scrim does not cover app '+key);
    if(metrics.dialog.top<metrics.app.top||metrics.dialog.bottom>metrics.app.bottom+1)violations.push('dialog outside app');
    if(metrics.close.width<44||metrics.close.height<44||metrics.close.top<metrics.app.top||metrics.close.bottom>metrics.app.bottom)violations.push('close target clipped or undersized');
    if(metrics.closeBorder!=='0px')violations.push('native close border remains');
    if(!metrics.backgroundInert||!metrics.hitIsOverlay)violations.push('background remains interactive');
    if(metrics.pageOverflow>1)violations.push('horizontal page overflow');
    if(!metrics.list||metrics.list.clientHeight<=0||!['auto','scroll'].includes(metrics.list.overflowY))violations.push('menu list lacks independent scrolling');
    if(metrics.actions.length!==6||metrics.actions.some(a=>a.width<=0||a.height<44||a.left<metrics.app.left||a.right>metrics.app.right+1))violations.push('action geometry broken');
    if(metrics.focused!=='close-chat-menu')violations.push('focus does not enter dialog');
    if(viewport.width===375||viewport.width===874)await page.screenshot({path:path.join(output,id+'.png')});
    if(!violations.length){
     await page.locator('.apricot-chat-menu [data-action="open-proactive"]').focus();
     await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').getAttribute('data-action'),'close-chat-menu');
     await page.keyboard.press('Shift+Tab');assert.equal(await page.locator(':focus').getAttribute('data-action'),'open-proactive');
     await page.keyboard.press('Escape');assert.equal(await page.locator('.apricot-chat-menu').count(),0);
     assert.equal(await page.locator(':focus').getAttribute('data-action'),'open-chat-menu');
     assert.equal(await page.locator('textarea[name="message"]').inputValue(),'尚未发送的中文草稿');
     await open(page);await page.getByRole('button',{name:'关闭面板',exact:true}).click();assert.equal(await page.locator('.apricot-chat-menu').count(),0);
     await open(page);await page.mouse.click(metrics.app.left+metrics.app.width/2,metrics.app.top+10);assert.equal(await page.locator('.apricot-chat-menu').count(),0);
    }
    if(errors.length)violations.push(...errors);
    results.push({id,passed:violations.length===0,violations,metrics});
    console.log(`${violations.length?'FAIL':'PASS'} ${id}`);
   }catch(e){results.push({id,passed:false,violations:[e.message]});console.log('FAIL '+id+' '+e.message.split('\n')[0]);}
   finally{await context.close();}
  }
  if(!baseline&&!results.some(r=>!r.passed)){
   for(const hasReply of [false,true]){
    if(hasReply){
     const headers={authorization:'Bearer dev-alice-token','content-type':'application/json','idempotency-key':'menu-seed-reply'};
     const conversations=await fetch(origin+'/api/v1/conversations',{headers}).then(r=>r.json());
     const r=await fetch(origin+'/api/v1/conversations/'+conversations.conversations[0].conversation_id+'/messages',{method:'POST',headers,body:JSON.stringify({content:{text:'合成菜单回归，不含个人数据。'}})});assert.equal(r.status,201);
    }
    for(const [action,destination] of [['open-character-profile','character-profile'],['latest-memory-refs',null],['praise-latest-assistant-message',null],['report-latest-assistant-message',null],['open-world-state','world-state'],['open-proactive','proactive']]){
     const id=`action-${hasReply?'reply':'empty'}-${action}`;
     const {context,page,errors}=await contextPage({width:375,height:812});
     try{
      const answers=['OOC','LOW','synthetic menu regression'];page.on('dialog',dialog=>dialog.accept(answers.shift()||''));
      await open(page);await page.locator('.apricot-chat-menu [data-action="'+action+'"]').click();
      await page.locator('.apricot-chat-menu').waitFor({state:'detached'});
      if(destination)await page.waitForFunction(route=>document.querySelector('#app').dataset.route===route,destination);
      if(action==='latest-memory-refs')await page.getByRole('status').filter({hasText:hasReply?'这一轮没有记忆引用记录。':'还没有可以查看的回复。'}).waitFor();
      if(action==='report-latest-assistant-message')await page.getByRole('status').filter({hasText:hasReply?'反馈已记录到该回复的版本快照':'还没有可以反馈的回复。'}).waitFor();
      assert.deepEqual(errors,[]);results.push({id,passed:true,violations:[]});console.log('PASS '+id);
     }catch(e){results.push({id,passed:false,violations:[e.message]});console.log('FAIL '+id+' '+e.message.split('\n')[0]);}
     finally{await context.close();}
    }
   }
   const {context,page}=await contextPage({width:375,height:812});
   try{page.on('dialog',d=>d.dismiss());await open(page);await page.locator('.apricot-chat-menu [data-action="report-latest-assistant-message"]').click();assert.equal(await page.locator('.apricot-chat-menu').count(),0);results.push({id:'cancel-feedback-closes-menu',passed:true,violations:[]});}
   finally{await context.close();}
   // Deliberately mocked reference payload, separate from the real local API's
   // truthful 404 above. This checks the secondary sheet's layout and close.
   const refs=await contextPage({width:375,height:812});
   try{
    await refs.page.route('**/api/v1/messages/*/memory-references',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({references:[{kind:'ASSET',id:'synthetic-reference',version:1,available:true,display_text:'合成来源，仅用于菜单布局验收'}]})}));
    await open(refs.page);await refs.page.locator('.apricot-chat-menu [data-action="latest-memory-refs"]').click();
    await refs.page.getByRole('dialog',{name:'本轮记忆引用',exact:true}).waitFor();
    const box=await refs.page.locator('#app > .sheet-layer').boundingBox();assert.ok(box.height<=812&&box.y>=0);
    await refs.page.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await refs.page.locator('#app > .sheet-layer').count(),0);
    assert.deepEqual(refs.errors,[]);results.push({id:'mock-reference-panel-layout-and-close',passed:true,violations:[]});
   }catch(e){results.push({id:'mock-reference-panel-layout-and-close',passed:false,violations:[e.message]});}
   finally{await refs.context.close();}
  }
 }finally{await closeBrowser();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));for(const socket of sockets)socket.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 const failed=results.filter(r=>!r.passed).length;
 console.log(JSON.stringify({cases:results.length,passed:results.length-failed,failed,scope:'isolated browser production-code/mock-API, not physical-device acceptance'}));
 if(failed)process.exitCode=1;
}
main().then(() => process.exit(process.exitCode || 0)).catch(e=>{console.error(e);process.exitCode=1;});
