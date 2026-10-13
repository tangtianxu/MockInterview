import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('unloaded and stale empty views never overwrite saved drafts; refresh and reopening display all drafts',{timeout:80000},async()=>{
 const fixture='outputs/knowledge-loading-fixture.html';await mkdir('outputs',{recursive:true});
 let payload;
 if(process.env.KNOWLEDGE_REAL_FIXTURE)payload=JSON.parse(await readFile(process.env.KNOWLEDGE_REAL_FIXTURE,'utf8'));
 else payload={root:'C:/SYNTHETIC/library',library:{enabled:false,activeProject:'',buildModel:'pro',folders:[],sources:[{id:'source-1',project:'A',status:'ready',relativePath:'A/report.md'}]},questions:[],errors:[],inbox:{items:Array.from({length:97},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,question:`合成问题 ${i+1}`,project:'A',category:'项目问题',task:'机制',aliases:[],tags:[],answer:'合成回答',explanation:'',followUps:[],status:'draft',answerSource:'synthetic',priority:1,priorityReason:'合成检查',missing:['合成内容待核对'],references:[],origins:[],updatedAt:''})),matches:[],drafts:[],editor:null,cursor:null}};
 const snapshotPath='outputs/knowledge-loading-input.json';await writeFile(snapshotPath,JSON.stringify(payload));
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body class="theme-light"><div id="root"></div><script type="module">
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {mockIPC} from '@tauri-apps/api/mocks';import {KnowledgeView} from '/src/KnowledgeView.tsx';import '/src/index.css';
 window.payload=await (await fetch('/${snapshotPath}')).json();window.saved=structuredClone(window.payload);window.calls=[];window.delay=true;window.pending=[];
 window.release=()=>{window.delay=false;window.pending.splice(0).forEach(resolve=>resolve(structuredClone(window.saved)));};
 mockIPC(async(command,args)=>{window.calls.push({command,args});if(command==='knowledge_snapshot')return window.delay?new Promise(resolve=>window.pending.push(resolve)):structuredClone(window.saved);if(command==='knowledge_save_inbox'){window.saved.inbox=structuredClone(args.inbox);return;}return null;},{shouldMockEvents:true});
 function Root(){const [show,setShow]=useState(true);return show?React.createElement(KnowledgeView,{model:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},onClose:()=>setShow(false),onChange:()=>{},onBusyChange:()=>{}}):React.createElement('button',{onClick:()=>setShow(true)},'打开题库');}createRoot(document.getElementById('root')).render(React.createElement(Root));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5213','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',v=>output+=v);server.stderr.on('data',v=>output+=v);let browser;
 try{
  const url='http://127.0.0.1:5213/'+fixture;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:850}});page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  await page.getByText('正在读取资料和问答…',{exact:true}).waitFor();assert.equal(await page.locator('.knowledge-review-card').count(),0);
  await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();await page.getByRole('button',{name:'打开题库',exact:true}).waitFor();await page.evaluate(()=>window.release());await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_save_inbox').length),0);assert.equal(await page.evaluate(()=>window.saved.inbox.items.length),payload.inbox.items.length);
  await page.evaluate(()=>{window.saved={...structuredClone(window.payload),library:{...window.payload.library,buildModel:'current',sources:[]},inbox:{items:[],matches:[],drafts:[],editor:null,cursor:null}};});
  await page.getByRole('button',{name:'打开题库',exact:true}).click();await page.getByRole('heading',{name:'把项目资料放进来'}).waitFor();await page.getByRole('button',{name:'待检查',exact:true}).click();
  await page.evaluate(()=>window.saved=structuredClone(window.payload));await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.waitForFunction(count=>document.querySelectorAll('.knowledge-review-card').length===count,payload.inbox.items.length);
  assert.equal(await page.locator('.knowledge-review-card').count(),payload.inbox.items.length);assert.equal(await page.evaluate(()=>window.saved.inbox.items.length),payload.inbox.items.length);
  assert.equal(await page.getByLabel('准备问答的模型').inputValue(),'pro');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_save_inbox').length),0);
  await page.screenshot({path:'outputs/knowledge-loading-real-data.png'});
  await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();await page.getByRole('button',{name:'打开题库',exact:true}).click();await page.getByRole('heading',{name:'检查答案，再采用'}).waitFor();assert.equal(await page.locator('.knowledge-review-card').count(),payload.inbox.items.length);
  await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();await page.evaluate(()=>window.saved.errors=['待整理草稿读取失败，原文件已保留：access denied']);
  await page.getByRole('button',{name:'打开题库',exact:true}).click();await page.getByText('待整理草稿读取失败，原文件已保留：access denied',{exact:true}).waitFor();
  assert.equal(await page.locator('.knowledge-review-card').count(),0);await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_save_inbox').length),0);assert.equal(await page.evaluate(()=>window.saved.inbox.items.length),payload.inbox.items.length);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});await unlink(snapshotPath).catch(()=>{});}
});
