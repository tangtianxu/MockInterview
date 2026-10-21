import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink,readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('automatic questions never prompt, stale matches cannot overwrite answers and file selection stays inside the app',{timeout:70000},async()=>{
 const fixture='outputs/in-app-actions-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><meta charset="UTF-8"><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import App from '/src/App.tsx';import {open,save} from '/src/inAppActions.ts';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();localStorage.setItem('interviewCue.settings',JSON.stringify({answer:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'fixture'},sharedModelConnection:true,theme:'light'}));
 window.calls=[];window.parents=new Set();window.hold=true;window.release=null;window.orphans=[];window.plans={};window.chosen=null;window.holdLookup=false;window.releaseLookup=null;window.lookupError=false;window.answerError=false;
 window.pick=()=>{open({multiple:true,filters:[{name:'文本',extensions:['txt']},{name:'PDF',extensions:['pdf']}]}).then(value=>window.chosen=value)};
 window.save=()=>{save({defaultPath:'fixture.txt',filters:[{name:'文本',extensions:['txt']}]}).then(value=>window.chosen=value)};
 mockIPC(async(command,args)=>{window.calls.push({command,args});
  if(command.startsWith('plugin:dialog')||command.startsWith('plugin:notification'))throw Error('OS prompt is forbidden');
  if(command==='history_begin'){if(window.hold)await new Promise(resolve=>window.release=resolve);window.parents.add(args.session.id);return;}
  if(command==='history_record'||command==='knowledge_lookup'){
   const id=args.sessionId||args.historySessionId;if(!window.parents.has(id)){window.orphans.push(command);throw Error('FOREIGN KEY constraint failed');}
   if(command==='history_record')return;
   if(window.holdLookup)await new Promise(resolve=>window.releaseLookup=resolve);
   if(window.lookupError)throw Error('资料索引损坏');
   return {enabled:true,exact:null,questions:[{id:'a',project:'A',status:'confirmed',question:'A职责',answer:'A的已核实工作'},{id:'b',project:'B',status:'confirmed',question:'B职责',answer:'B的已核实工作'}],passages:[],projects:['A','B'],ambiguous:true};
  }
  if(command==='knowledge_snapshot')return {library:{enabled:true,sources:[],folders:[]},questions:[],errors:[],inbox:{items:[]}};
  if(command==='knowledge_prepare'){const token=crypto.randomUUID();window.plans[token]=args.input.question.question;return {token,model:'fixture',destination:'https://api.deepseek.com',characters:100};}
  if(command==='knowledge_run')throw Error('Runtime must not depend on semantic matching');
  if(command==='mvp_answer'&&window.answerError)throw Error('HTTP 503 fixture unavailable');
  if(command==='mvp_answer'&&args.question.startsWith('标准代码题')){await emit('mvp_answer_token',{requestId:args.requestId,token:'### Python 3 代码\\n\u0060\u0060\u0060python\\nclass Solution:\\n    def twoSum(self, nums, target):\\n        seen = {}\\n        for i, value in enumerate(nums):\\n            if target - value in seen:\\n                return [seen[target - value], i]\\n            seen[value] = i\\n        return []\\n\u0060\u0060\u0060'});await emit('mvp_answer_done',{requestId:args.requestId});return;}
  if(command==='mvp_answer'){await emit('mvp_answer_token',{requestId:args.requestId,token:'回答：'+args.question});await emit('mvp_answer_done',{requestId:args.requestId});return;}
  if(command==='action_browse_files')return {path:args.path||'C:/fixture',parent:'C:/',places:[{name:'文档',path:'C:/fixture'}],entries:[{name:'notes.txt',path:'C:/fixture/notes.txt',directory:false},{name:'report.pdf',path:'C:/fixture/report.pdf',directory:false}],truncated:false};
  if(command==='action_resolve_paths')return args.paths;
  if(command==='plugin:app|version')return 'fixture';if(command==='load_interview_profile')return null;
  if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';
  if(command==='ollama_runtime_status')return {executable:null,connected:false};if(command==='mvp_list_models')return ['fixture'];
  if(command==='has_api_key')return true;if(command.includes('is_registered'))return false;
  if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
  return null;
 },{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5232','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);let browser;
 try{
  const url='http://127.0.0.1:5232/'+fixture;for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1200,height:850}});page.setDefaultTimeout(8000);const errors=[];const dialogs=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.type());void d.dismiss();});await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
  async function question(text){await page.locator('.question-box').click();const editor=page.getByRole('textbox',{name:'修正模型理解的问题'});await editor.fill(text);await editor.press('Enter');}
  await question('Kmeans是什么');await page.waitForFunction(()=>!!window.release);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_lookup').length),0);
  await page.evaluate(()=>{window.hold=false;window.release();});const strip=page.getByRole('region',{name:'窗口内待确认操作'});await page.locator('.answer-text').filter({hasText:'回答：Kmeans是什么'}).waitFor();assert.equal(await strip.count(),0);
  await page.evaluate(()=>window.holdLookup=true);await question('旧的待回答问题');await page.waitForFunction(()=>!!window.releaseLookup);assert.match(await page.locator('.question-box').innerText(),/旧的待回答问题/);assert.match(await page.locator('.answer-text').innerText(),/回答思路/);await page.evaluate(()=>window.holdLookup=false);await question('更新的问题');await page.locator('.answer-text').filter({hasText:'回答：更新的问题'}).waitFor();await page.evaluate(()=>window.releaseLookup());await page.waitForTimeout(100);assert.match(await page.locator('.answer-text').innerText(),/回答：更新的问题/);assert.equal(await strip.count(),0);
  for(const text of ['介绍一下你在实习期间做过的项目','π0.5的架构是什么','怎么处理工作中的冲突','请进行自我介绍']){await question(text);await page.locator('.answer-text').filter({hasText:'回答：'+text}).waitFor();assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_answer').at(-1).args.knowledgeContext.questions.map(q=>q.project)),['A','B']);}
  await page.evaluate(()=>window.lookupError=true);await question('索引损坏时也要解释注意力');await page.locator('.answer-text').filter({hasText:'回答：索引损坏时也要解释注意力'}).waitFor();await page.evaluate(()=>window.lookupError=false);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_answer').at(-1).args.knowledgeContext),undefined);assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='knowledge_run')),false);
  await page.evaluate(()=>window.holdLookup=true);await question('读取超时也要继续解释');await page.locator('.answer-text').filter({hasText:'回答：读取超时也要继续解释'}).waitFor();await page.evaluate(()=>{window.holdLookup=false;window.releaseLookup();});
  await page.evaluate(()=>window.answerError=true);await question('模型断网时当前问题仍有思路');await page.getByText(/HTTP 503 fixture unavailable/).first().waitFor();assert.match(await page.locator('.answer-text').innerText(),/回答思路/);assert.match(await page.locator('.question-box').innerText(),/模型断网时当前问题/);await page.evaluate(()=>window.answerError=false);
  await question('标准代码题：给出 Python 3 的 Solution.twoSum。'+ '题干背景。'.repeat(130)+'末尾约束：不能复用同一下标。');await page.locator('.answer-text pre code').waitFor();assert.match(await page.locator('.answer-text pre code').innerText(),/    def twoSum/);assert.equal(await strip.count(),0);assert.ok(await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_answer').at(-1).args.question.endsWith('末尾约束：不能复用同一下标。')));assert.equal(await page.evaluate(()=>window.calls.some(c=>c.command==='mvp_decide')),false);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied=value}}));await page.locator('.answer-text').getByRole('button',{name:'复制这段代码'}).click();await page.waitForFunction(()=>!!window.copied);assert.match(await page.evaluate(()=>window.copied),/        seen = \{\}/);
  await page.evaluate(()=>window.pick());await strip.waitFor();await page.locator('.app-shell').evaluate(e=>e.style.visibility='hidden');assert.equal(await strip.isVisible(),false);assert.equal(page.context().pages().length,1);await page.locator('.app-shell').evaluate(e=>e.style.visibility='');await page.getByRole('checkbox',{name:'notes.txt'}).check();await page.getByRole('button',{name:'使用所选文件'}).click();await page.waitForFunction(()=>Array.isArray(window.chosen));assert.deepEqual(await page.evaluate(()=>window.chosen),['C:/fixture/notes.txt']);
  await page.evaluate(()=>window.save());await page.getByRole('textbox',{name:'保存文件名'}).fill('new.txt');await page.getByRole('button',{name:'保存到此位置'}).click();await page.waitForFunction(()=>typeof window.chosen==='string');assert.equal(await page.evaluate(()=>window.chosen),'C:/fixture/new.txt');
  await page.evaluate(()=>window.pick());await page.getByRole('region',{name:'窗口内待确认操作'}).getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>window.chosen===null);
  assert.deepEqual(await page.evaluate(()=>window.orphans),[]);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command.startsWith('plugin:dialog')||c.command.startsWith('plugin:notification')).length),0);assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:'outputs/in-app-actions-ui.png'});
  assert.doesNotMatch(await readFile('src-tauri/capabilities/default.json','utf8'),/dialog:|notification:/);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
