import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('ordinary folder flow freezes one scope, pauses on failure, resumes and requires answer review',{timeout:80000},async()=>{
 const fixture='outputs/knowledge-workflow-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body class="theme-light"><div id="root"></div><script type="module">
 import {mockActionResponses} from '/evaluation/helpers/in-app-actions.mjs';
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {mockIPC} from '@tauri-apps/api/mocks';import {KnowledgeView} from '/src/KnowledgeView.tsx';import {emptyQuestion} from '/src/knowledge.ts';import '/src/index.css';
 window.calls=[];window.pending={};window.failSecond=true;window.saved={root:'C:/SYNTHETIC/library',library:{enabled:false,activeProject:'',buildModel:'current',folders:[],sources:[]},questions:[],errors:[],inbox:{items:[],matches:[],drafts:[],editor:null,cursor:null}};
 const sources=['A','B'].map((p,i)=>({id:'source-'+i,path:'C:/SYNTHETIC/'+p+'/report.md',relativePath:p+'/report.md',project:p,hash:'synthetic-'+i,modified:1,characters:500,status:'ready',note:''}));
 mockActionResponses((kind,options,message)=>{window.calls.push({command:'in-app:'+kind,args:{options,message}});return kind==='confirm'?true:kind==='open'?'C:/SYNTHETIC/materials':null;});
 mockIPC(async(command,args)=>{window.calls.push({command,args});
  if(command==='knowledge_snapshot')return structuredClone(window.saved);

  if(command==='knowledge_import_folder'){window.saved.library.sources=sources;window.saved.library.folders=[args.path];return structuredClone(window.saved);}
  if(command==='knowledge_save_inbox'){window.saved.inbox=structuredClone(args.inbox);return;}
  if(command==='knowledge_configure'){Object.assign(window.saved.library,args);return structuredClone(window.saved);}
  if(command==='knowledge_prepare_build'){
   const start=args.input.batch||0;const plans=sources.slice(start).map((s,j)=>{const batch=start+j;const token=crypto.randomUUID();window.pending[token]=batch;return {token,action:'build',model:args.endpoint.model,destination:args.endpoint.baseUrl,characters:500,files:[s.relativePath],preview:'SYNTHETIC DATA ONLY '+s.project,batch,totalBatches:2};});
   return {plans,characters:500*plans.length,files:plans.flatMap(p=>p.files),preview:plans.map(p=>p.preview).join(' / '),model:args.endpoint.model,destination:args.endpoint.baseUrl};
  }
  if(command==='knowledge_run'){
   const batch=window.pending[args.token];if(batch===1&&window.failSecond)throw Error('第二项目连接失败');
   const s=sources[batch];const q={...emptyQuestion(s.project),id:'00000000-0000-4000-8000-00000000000'+(batch+1),question:s.project+' 的关键机制是什么？',answer:'资料记载的'+s.project+'机制。',task:'核心机制',references:[{sourceId:s.id,hash:s.hash,quote:'SYNTHETIC 原文证据'}],missing:[],answerSource:'synthetic-model',status:'draft'};
   window.saved.inbox.items.push(q);const match={questionId:q.id,duplicateId:'',relation:'new',reason:'任务明确'};window.saved.inbox.matches.push(match);
   return {items:[q],matches:[match],warnings:[],model:'synthetic-model',elapsedMs:100,usage:{}};
  }
  if(command==='knowledge_commit'){window.saved.questions.push(...args.questions);return structuredClone(window.saved);}
  return null;
 },{shouldMockEvents:true});
 function Root(){const [show,setShow]=useState(true);return show?React.createElement(KnowledgeView,{model:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},onClose:()=>setShow(false),onChange:()=>{},onBusyChange:()=>{}}):React.createElement('button',{onClick:()=>setShow(true)},'打开题库');}createRoot(document.getElementById('root')).render(React.createElement(Root));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5212','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',v=>output+=v);server.stderr.on('data',v=>output+=v);let browser;
 try{
  const url='http://127.0.0.1:5212/'+fixture;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  await page.getByRole('heading',{name:'把项目资料放进来'}).waitFor();assert.equal(await page.getByRole('button',{name:'准备问答',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'导入Agent整理目录',exact:true}).click();await page.getByText('已读取 2 份',{exact:true}).waitFor();
  await page.getByRole('button',{name:'准备问答',exact:true}).click();await page.getByRole('alertdialog').waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),0);await page.getByText(/2 次请求/).waitFor();
  await page.getByRole('button',{name:'取消发送',exact:true}).click();await page.waitForFunction(()=>window.calls.filter(c=>c.command==='knowledge_discard_plan').length===2);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),0);
  await page.getByRole('button',{name:'准备问答',exact:true}).click();await page.getByRole('button',{name:'同意本次发送',exact:true}).click();await page.getByRole('alert').filter({hasText:'第二项目连接失败'}).waitFor();
  assert.equal(await page.evaluate(()=>window.saved.inbox.items.length),1);assert.equal(await page.evaluate(()=>window.saved.inbox.cursor.next),1);assert.equal(await page.evaluate(()=>window.saved.questions.length),0);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),2);
  await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();await page.getByRole('button',{name:'打开题库',exact:true}).click();await page.getByRole('button',{name:'继续准备问答',exact:true}).waitFor();
  await page.setViewportSize({width:620,height:830});assert.ok(await page.locator('.knowledge-window').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:'outputs/knowledge-workflow-guide.png'});
  await page.evaluate(()=>window.failSecond=false);await page.getByRole('button',{name:'继续准备问答',exact:true}).click();await page.getByText(/1 次请求/).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),2);await page.getByRole('button',{name:'同意本次发送',exact:true}).click();
  await page.getByRole('heading',{name:'检查答案，再采用'}).waitFor();await page.getByText(/批量操作 \/ 导出/).click();assert.equal(await page.evaluate(()=>window.saved.inbox.items.length),2);assert.equal(await page.evaluate(()=>window.saved.questions.length),0);assert.equal(await page.getByRole('button',{name:'采用所选问答',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'选择无待补信息的问答',exact:true}).click();await page.getByRole('checkbox',{name:'我已核对所选答案、依据和本人实际贡献',exact:true}).check();await page.getByRole('button',{name:'采用所选问答',exact:true}).click();
  await page.waitForFunction(()=>window.saved.library.enabled&&window.saved.questions.length===2);assert.ok(await page.evaluate(()=>window.saved.questions.every(q=>q.status==='confirmed')));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_prepare_build').at(-1).args.input.batch),1);assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
