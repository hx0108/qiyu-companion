'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const web=path.resolve(__dirname,'../../web');
const source=fs.readFileSync(path.join(web,'app.js'),'utf8');
const css=fs.readFileSync(path.join(web,'apricot.css'),'utf8');
const ui=()=>import('data:text/javascript;base64,'+fs.readFileSync(path.join(web,'apricot-ui.js')).toString('base64'));
function rule(selector){const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const matches=[...css.matchAll(new RegExp(escaped+'\\s*\\{([^}]*)\\}','g'))];assert.ok(matches.length,'missing '+selector);return matches.at(-1)[1];}

test('chat menu is a labelled standalone dialog with all six existing actions and a separate scrolling list',async()=>{
 const html=(await ui()).apricotChatMenu();
 assert.match(html,/class="sheet-layer apricot-chat-menu-layer"/);
 assert.match(html,/id="chat-menu-dialog"[^>]*role="dialog"/);
 assert.match(html,/aria-modal="true" aria-labelledby="chat-menu-title"/);
 assert.match(html,/class="apricot-chat-menu-items"/);
 for(const action of ['open-character-profile','latest-memory-refs','praise-latest-assistant-message','report-latest-assistant-message','open-world-state','open-proactive'])assert.equal(html.split(`data-action="${action}"`).length-1,1);
 assert.match(html,/class="icon-btn apricot-menu-close"/);
});
test('root-level sheet layer overlays the app rather than flowing below its full-height screen',()=>{
 const layer=rule('.app > .sheet-layer');
 for(const value of ['position:absolute','inset:0','display:flex','align-items:flex-end','overflow:hidden'])assert.ok(layer.includes(value),value);
 assert.ok(Number(layer.match(/z-index:(\d+)/)?.[1])>=60);
});
test('menu header stays visible, list scrolls within the viewport, and standalone close does not inherit native button chrome',()=>{
 assert.match(rule('.apricot-chat-menu'),/display:flex/);
 assert.match(rule('.apricot-chat-menu-items'),/overflow-y:auto/);
 assert.match(rule('.apricot-chat-menu-items'),/min-height:0/);
 const close=rule('.apricot-chat-menu .apricot-menu-close');
 assert.match(close,/width:44px/);assert.match(close,/height:44px/);assert.match(close,/border:0/);assert.match(close,/border-radius:50%/);
 assert.ok(css.includes('env(safe-area-inset-bottom)'));
});
test('opening exposes dialog state and inerts only the background screen',()=>{
 assert.ok(source.includes('aria-haspopup="dialog" aria-controls="chat-menu-dialog" aria-expanded="${state.chatMenuOpen}"'));
 assert.ok(source.includes('backgroundScreen.inert = true'));
 assert.ok(source.includes('backgroundScreen.setAttribute("aria-hidden", "true")'));
});
test('explicit dismiss restores trigger focus; cancelled actions can close the menu before doing work',()=>{
 const start=source.indexOf('function closeChatMenu(');
 assert.ok(start>=0);
 const code=source.slice(start,source.indexOf('\n}',start)+2);
 for(const restoreFocus of [true,false]){
  let renders=0,focus=0;
  const state={chatMenuOpen:true};
  const context=vm.createContext({state,render:()=>renders++,app:{querySelector:()=>({focus:()=>focus++})}});
  vm.runInContext(code+`;closeChatMenu({restoreFocus:${restoreFocus}})`,context);
  assert.equal(state.chatMenuOpen,false);assert.equal(renders,1);assert.equal(focus,restoreFocus?1:0);
 }
 assert.ok(source.includes('closeChatMenu({ restoreFocus: false })'));
 assert.ok(source.includes('event.target.classList?.contains("apricot-chat-menu-layer")'));
});
test('feedback with no assistant reply displays an accurate empty-state notice rather than leaving a stale menu',()=>{
 const start=source.indexOf('async function reportLatestAssistantMessage()');
 const body=source.slice(start,source.indexOf('\n}',start)+2);
 assert.match(body,/if \(!message \|\| !messageId\(message\)\) \{ setToast\("还没有可以反馈的回复。"\); return; \}/);
});
