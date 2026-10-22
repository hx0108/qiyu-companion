'use strict';
// Independent offline layout fixture; no app bootstrap, account or provider calls.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {launchIsolatedBrowser}=require('./isolated-browser');
const root=path.resolve(__dirname,'../../..'),web=path.join(root,'apps/web');
const output=path.join(root,'output/playwright/chat-header-layout');
async function main(){
  const ui=await import(`data:text/javascript;base64,${fs.readFileSync(path.join(web,'apricot-ui.js')).toString('base64')}`);
  const source=fs.readFileSync(path.join(web,'app.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('function renderChat()');
  const render=source.slice(start,source.indexOf('\n}',start)+2);
  const css=[path.join(web,'tokens.css'),...['styles.css','prototype-restoration.css','apricot.css'].map(file=>path.join(web,file))].map(file=>fs.readFileSync(file,'utf8').replace(/@import\s+url\([^;]+;/g,'')).join('\n');
  const portrait='data:image/png;base64,'+fs.readFileSync(path.join(web,'assets/portraits/male-02.png')).toString('base64');
  const icon=(name,size=24)=>(ui.APRICOT_ACTIONS[name]||'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>').replaceAll('width="24"',`width="${size}"`).replaceAll('height="24"',`height="${size}"`);
  const {browser,close:closeBrowser}=await launchIsolatedBrowser({channel:'msedge',headless:true});
  const results=[];
  fs.mkdirSync(output,{recursive:true});
  try{
    for(const night of [false,true])for(const viewport of [{width:820,height:960},{width:375,height:812},{width:320,height:640},{width:874,height:402}])for(const long of [false,true])for(const canCall of [false,true]){
      const id=`${night?'night':'day'}-${viewport.width}x${viewport.height}-${long?'long':'normal'}-${canCall?'call':'no-call'}`;
      const name=long?'这是一个较长的角色名字用于验证窄屏显示':'温柔的插画师';
      const state={theme:night?'night':'day',character:{name},candidates:[],messages:[],pendingTranscript:'',busy:false};
      const html=vm.runInNewContext(render+'\nrenderChat()',{state,...ui,apricotCandidate:()=>'',prototypeIcon:icon,prototypeNav:ui.apricotNav,selectedPortrait:()=>({src:portrait}),escapeHtml:ui.escapeUi,realtimeCallAvailable:()=>canCall,characterId:()=> 'fixture-character',messageId:()=>null});
      const page=await browser.newPage({viewport,reducedMotion:'reduce'});
      await page.route('**/*',route=>route.abort());
      await page.setContent(`<!doctype html><html lang="zh-CN" data-qy-theme="${night?'night':'day'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="device-shell"><div class="app">${html}</div></main></body></html>`);
      const metrics=await page.evaluate(()=>{
        const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,cy:r.top+r.height/2};};
        const header=document.querySelector('.app-header'),name=document.querySelector('.identity b');
        return {header:box(header),avatar:box(header.querySelector('.avatar-picker-trigger')),name:box(name),nameTitle:name.title,nameOverflow:getComputedStyle(name).textOverflow,buttons:[...header.querySelectorAll('.header-actions button')].map(el=>({...box(el),action:el.dataset.action})),back:!!header.querySelector('.chat-back,[data-action="open-home"]'),nav:document.querySelectorAll('.bottom-nav .nav-item').length};
      });
      const violations=[];
      if(metrics.back)violations.push('chat back control remains');
      if(Math.abs(metrics.avatar.left-metrics.header.left-23)>.5)violations.push('avatar is not aligned to 23px gutter');
      if(metrics.buttons.length!==(canCall?2:1))violations.push('call/menu capability mapping changed');
      if(metrics.name.width<=0||metrics.nameTitle!==name||metrics.nameOverflow!=='ellipsis')violations.push('name sizing/full-name disclosure broken');
      for(const button of metrics.buttons)if(button.width<44||button.height<44||Math.abs(button.cy-metrics.avatar.cy)>1||button.left<metrics.name.right+5||button.right>metrics.header.right-22)violations.push('action alignment, spacing or touch target broken');
      if(Math.abs(metrics.name.cy-metrics.avatar.cy)>1)violations.push('name is not vertically centered');
      if(metrics.nav!==4)violations.push('bottom navigation changed');
      if(viewport.width===820&&canCall&&!long)await page.locator('.app-header').screenshot({path:path.join(output,id+'.png')});
      results.push({id,passed:!violations.length,violations,metrics});
      console.log(`${violations.length?'FAIL':'PASS'} ${id}${violations.length?': '+violations.join('; '):''}`);
      await page.close();
    }
  }finally{await closeBrowser();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));}
  const failed=results.filter(r=>!r.passed).length;
  console.log(JSON.stringify({cases:results.length,passed:results.length-failed,failed}));
  if(failed)process.exitCode=1;
}
main().then(() => process.exit(process.exitCode || 0)).catch(error=>{console.error(error);process.exit(1);});
