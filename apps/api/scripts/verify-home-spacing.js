'use strict';
// Offline production-markup/CSS regression; no user browser or API access.
const fs=require('node:fs');
const path=require('node:path');
const {launchIsolatedBrowser}=require('./isolated-browser');
const root=path.resolve(__dirname,'../../..');
const web=path.join(root,'apps/web');
const output=path.join(root,'output/playwright/home-spacing',process.argv.includes('--baseline')?'baseline':'fixed');
async function main(){
  const {apricotHome}=await import(`data:text/javascript;base64,${fs.readFileSync(path.join(web,'apricot-ui.js')).toString('base64')}`);
  const css=[path.join(web,'tokens.css'),...['styles.css','prototype-restoration.css','apricot.css'].map(file=>path.join(web,file))].map(file=>fs.readFileSync(file,'utf8').replace(/@import\s+url\([^;]+;/g,'')).join('\n');
  const {browser,close:closeBrowser}=await launchIsolatedBrowser({channel:'msedge',headless:true});
  const results=[];
  fs.mkdirSync(output,{recursive:true});
  try{
    for(const night of [false,true])for(const viewport of [{width:820,height:960},{width:375,height:812},{width:320,height:640},{width:874,height:402}]){
      const id=`${night?'night':'day'}-${viewport.width}x${viewport.height}`;
      const page=await browser.newPage({viewport,reducedMotion:'reduce'});
      await page.route('**/*',route=>route.abort());
      await page.setContent(`<!doctype html><html lang="zh-CN" data-qy-theme="${night?'night':'day'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="device-shell"><div class="app">${apricotHome({name:'林默',portrait:'/assets/qiyu-character.png',night,canCall:true})}</div></main></body></html>`);
      const metrics=await page.evaluate(()=>{
        const title=document.querySelector('.apricot-intro h1'),grid=document.querySelector('.apricot-tiles');
        const t=title.getBoundingClientRect(),g=grid.getBoundingClientRect();
        return {gap:g.top-t.bottom,horizontalOverflow:document.querySelector('.home-scroll').scrollWidth-document.querySelector('.home-scroll').clientWidth,tiles:[...grid.children].map(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,left:r.left,action:el.dataset.action};})};
      });
      const violations=[];
      if(Math.abs(metrics.gap-20)>.5)violations.push(`gap is ${metrics.gap}px, expected 20px`);
      if(metrics.horizontalOverflow>1)violations.push('horizontal overflow');
      if(metrics.tiles.length!==4||metrics.tiles.some(tile=>Math.abs(tile.height-117)>.5))violations.push('card dimensions changed');
      if(metrics.tiles[0].top!==metrics.tiles[1].top||metrics.tiles[2].top!==metrics.tiles[3].top||metrics.tiles[2].top-metrics.tiles[0].top!==128)violations.push('two-column 11px grid changed');
      if(viewport.width===820)await page.locator('.device-shell').screenshot({path:path.join(output,id+'.png')});
      results.push({id,passed:violations.length===0,violations,metrics});
      console.log(`${violations.length?'FAIL':'PASS'} ${id}${violations.length?': '+violations.join('; '):''}`);
      await page.close();
    }
  }finally{await closeBrowser();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));}
  const failed=results.filter(result=>!result.passed).length;
  console.log(JSON.stringify({cases:results.length,passed:results.length-failed,failed}));
  if(failed)process.exitCode=1;
}
main().then(() => process.exit(process.exitCode || 0)).catch(error=>{console.error(error);process.exit(1);});
