import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink,readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('confirmation, cancellation and file selection stay inside the owning app; native history is initialized first',{timeout:70000},async()=>{
 const fixture='outputs/in-app-actions-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><meta charset="UTF-8"><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import App from '/src/App.tsx';import {open,save} from '/src/inAppActions.ts';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();localStorage.setItem('interviewCue.settings',JSON.stringify({answer:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'fixture'},sharedModelConnection:true,theme:'light'}));
 window.calls=[];window.parents=new Set();window.hold=true;window.release=null;window.orphans=[];window.plans={};window.chosen=null;
 window.pick=()=>{open({multiple:true,filters:[{name:'文本',extensions:['txt']},{name:'PDF',extensions:['pdf']}]}).then(value=>window.chosen=value)};
 window.save=()=>{save({defaultPath:'fixture.txt',filters:[{name:'文本',extensions:['txt']}]}).then(value=>window.chosen=value)};
 mockIPC(async(command,args)=>{window.calls.push({command,args});
  if(command.startsWith('plugin:dialog')||command.startsWith('plugin:notification'))throw Error('OS prompt is forbidden');
  if(command==='history_begin'){if(window.hold)await new Promise(resolve=>window.release=resolve);window.parents.add(args.session.id);return;}
  if(command==='history_record'||command==='knowledge_lookup'){
   const id=args.sessionId||args.historySessionId;if(!window.parents.has(id)){window.orphans.push(command);throw Error('FOREIGN KEY constraint failed');}
   if(command==='history_record')return;
   return {enabled:true,exact:null,questions:[{id:'a'}],passages:[],projects:['A']};
  }
  if(command==='knowledge_snapshot')return {library:{enabled:true,sources:[],folders:[]},questions:[],errors:[],inbox:{items:[]}};
  if(command==='knowledge_prepare'){const token=crypto.randomUUID();window.plans[token]=args.input.question.question;return {token,model:'fixture',destination:'https://api.deepseek.com',characters:100};}
  if(command==='knowledge_run')return {matches:[{relation:'new',needsPersonalEvidence:false}],items:[]};
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
  await page.evaluate(()=>{window.hold=false;window.release();});const strip=page.getByRole('region',{name:'窗口内待确认操作'});await strip.waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),0);
  await page.locator('.app-shell').evaluate(e=>e.style.visibility='hidden');assert.equal(await strip.isVisible(),false);assert.equal(page.context().pages().length,1);await page.locator('.app-shell').evaluate(e=>e.style.visibility='');
  await strip.getByRole('button',{name:'跳过本次'}).click();await page.getByRole('status').filter({hasText:'已跳过本次题库匹配'}).waitFor();assert.equal(await page.locator('.error-box').filter({hasText:/取消|FOREIGN KEY/}).count(),0);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),0);
  await question('解释一下Kmeans');await strip.waitFor();await strip.getByRole('button',{name:'发送本次内容'}).click();await page.locator('.answer-text').filter({hasText:'回答：解释一下Kmeans'}).waitFor();
  await question('旧的待确认问题');await strip.waitFor();await question('更新的问题');await page.waitForFunction(()=>Object.values(window.plans).includes('更新的问题'));await page.waitForFunction(()=>window.calls.some(c=>c.command==='knowledge_discard_plan'&&window.plans[c.args.token]==='旧的待确认问题'));
  await strip.getByRole('button',{name:'发送本次内容'}).click();await page.locator('.answer-text').filter({hasText:'回答：更新的问题'}).waitFor();
  await page.evaluate(()=>window.pick());await page.getByRole('checkbox',{name:'notes.txt'}).check();await page.getByRole('button',{name:'使用所选文件'}).click();await page.waitForFunction(()=>Array.isArray(window.chosen));assert.deepEqual(await page.evaluate(()=>window.chosen),['C:/fixture/notes.txt']);
  await page.evaluate(()=>window.save());await page.getByRole('textbox',{name:'保存文件名'}).fill('new.txt');await page.getByRole('button',{name:'保存到此位置'}).click();await page.waitForFunction(()=>typeof window.chosen==='string');assert.equal(await page.evaluate(()=>window.chosen),'C:/fixture/new.txt');
  await page.evaluate(()=>window.pick());await page.getByRole('region',{name:'窗口内待确认操作'}).getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>window.chosen===null);
  assert.deepEqual(await page.evaluate(()=>window.orphans),[]);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command.startsWith('plugin:dialog')||c.command.startsWith('plugin:notification')).length),0);assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:'outputs/in-app-actions-ui.png'});
  assert.doesNotMatch(await readFile('src-tauri/capabilities/default.json','utf8'),/dialog:|notification:/);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
