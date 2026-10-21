import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('manual questions require send approval and adoption; drafts survive reload; history exports merge aliases',{timeout:70000},async()=>{
 const fixture='outputs/knowledge-ui-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body class="theme-light"><div id="root"></div><script type="module">
 import {mockActionResponses} from '/evaluation/helpers/in-app-actions.mjs';
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {mockIPC} from '@tauri-apps/api/mocks';import {KnowledgeView} from '/src/KnowledgeView.tsx';import {emptyQuestion,knowledgeForQuestion} from '/src/knowledge.ts';import '/src/index.css';
 const initial={...emptyQuestion('A'),id:'11111111-1111-4111-8111-111111111111',category:'技术基础',question:'PPO 是什么？',answer:'本人核实的原回答',status:'confirmed',origins:[{sessionId:'old',entryId:'one',at:'',original:'PPO 是什么？'}]};
 window.saved=JSON.parse(localStorage.getItem('knowledge.fixture')||'null')||{root:'C:/fixture/library',library:{enabled:true,activeProject:'',buildModel:'current',folders:[],sources:[]},questions:[initial],errors:[],inbox:{items:[],matches:[],drafts:[],editor:null,cursor:null}};
 const persist=()=>localStorage.setItem('knowledge.fixture',JSON.stringify(window.saved));window.calls=[];window.plans={};window.lookup=(query)=>knowledgeForQuestion(query,{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},()=>true);
 mockActionResponses((kind,options,message)=>{window.calls.push({command:'in-app:'+kind,args:{options,message}});return kind==='confirm'?true:kind==='open'?null:'C:/fixture/questions.json';});
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='knowledge_snapshot')return structuredClone(window.saved);
 if(command==='knowledge_save_inbox'){window.saved.inbox=args.inbox;persist();return;}
 if(command==='knowledge_configure'){Object.assign(window.saved.library,args);persist();return structuredClone(window.saved);}
 if(command==='knowledge_save_question'){const q={...args.question,updatedAt:'test'};window.saved.questions=window.saved.questions.filter(p=>p.id!==q.id).concat(q);persist();return q;}
 if(command==='knowledge_lookup'){const q=window.saved.questions.find(q=>q.question===args.query);return {enabled:true,exact:q,questions:q?[q]:[],passages:[],projects:[]};}
 if(command==='knowledge_prepare'){const token=crypto.randomUUID();window.plans[token]=args.input;return {token,action:args.input.action,model:args.endpoint.model,destination:args.endpoint.baseUrl,characters:500,files:['SYNTHETIC_ONLY.txt · 文档开头'],preview:'SYNTHETIC DATA: '+JSON.stringify(args.input),batch:0,totalBatches:1};}
 if(command==='knowledge_run'){const input=window.plans[args.token];if(input.action==='draft')return {items:[{...input.question,answer:'API 的新回答草稿',explanation:'可修改的展开',missing:['候选人需核实'],references:[],status:'draft'}],matches:[],warnings:['这只是草稿'],model:'deepseek-flash',elapsedMs:100,usage:{prompt_tokens:500,completion_tokens:100}};
  if(input.action==='dedup')return {items:input.items.map((q,i)=>({...q,project:'A',category:'技术基础',task:i?'使用条件':'定义'})),matches:input.items.map((q,i)=>({questionId:q.id,duplicateId:i?'':initial.id,relation:i?'new':'same',reason:i?'任务不同':'同一任务的不同问法'})),warnings:[],model:'deepseek-flash',elapsedMs:100,usage:{}};
 }
 if(command==='knowledge_history_questions')return [{...emptyQuestion('A'),category:'技术基础',question:'解释一下 PPO',origins:[{sessionId:'past',entryId:'one',at:'',original:'解释一下 PPO'}]},{...emptyQuestion('A'),category:'技术基础',question:'什么情况下使用 PPO',origins:[{sessionId:'past',entryId:'two',at:'',original:'什么情况下使用 PPO'}]}];

 return null;},{shouldMockEvents:true});
 function Root(){const [opened,setOpened]=useState(true);const [history,setHistory]=useState('');return opened?React.createElement(KnowledgeView,{model:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},historyId:history,onClose:()=>setOpened(false),onChange:()=>{},onBusyChange:()=>{}}):React.createElement('div',null,React.createElement('button',{onClick:()=>{setHistory('');setOpened(true)}},'打开题库'),React.createElement('button',{onClick:()=>{setHistory('past');setOpened(true)}},'导入历史问题'));}createRoot(document.getElementById('root')).render(React.createElement(Root));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5210','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',v=>output+=v);server.stderr.on('data',v=>output+=v);let browser;
 try{const url='http://127.0.0.1:5210/'+fixture;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1180,height:880}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(30000);await page.goto(url);
 await page.getByRole('button',{name:'自己写问题',exact:true}).click();await page.getByRole('textbox',{name:'问题',exact:true}).fill('我如何实现项目缓存？');
 await page.getByRole('button',{name:'让模型准备答案',exact:true}).click();await page.getByRole('alertdialog').waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),0);
 await page.getByRole('button',{name:'取消发送',exact:true}).click();await page.getByRole('status').filter({hasText:'已取消本次发送'}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_run').length),0);
 await page.getByRole('button',{name:'让模型准备答案',exact:true}).click();await page.getByRole('button',{name:'同意本次发送',exact:true}).click();await page.getByText('API 的新回答草稿',{exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'回答',exact:true}).inputValue(),'');assert.equal(await page.evaluate(()=>window.saved.questions.length),1);
 await page.getByRole('button',{name:'放入编辑区',exact:true}).click();await page.getByRole('textbox',{name:'回答',exact:true}).fill('我核对后采用的真实回答');
 if(await page.getByRole('button',{name:'保存并关闭编辑',exact:true}).count())await page.getByRole('button',{name:'保存并关闭编辑',exact:true}).click();await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();await page.getByRole('button',{name:'打开题库',exact:true}).click();const pending=page.locator('.knowledge-review-card').filter({hasText:'我如何实现项目缓存？'});await pending.locator('summary').first().click();await pending.getByRole('button',{name:'编辑问答',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'回答',exact:true}).inputValue(),'我核对后采用的真实回答');
 assert.equal(await page.evaluate(()=>window.saved.questions.length),1);await page.getByRole('checkbox',{name:'我已核对当前答案，不确定内容已修正或明确说明',exact:true}).check();await page.getByRole('button',{name:'已核对，采用这题',exact:true}).click();await page.waitForFunction(()=>window.saved.questions.length===2);
 assert.equal(await page.evaluate(()=>window.saved.questions[0].answer),'本人核实的原回答');
 const before=await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_prepare'||c.command==='knowledge_run').length);
 const exact=await page.evaluate(()=>window.lookup('PPO 是什么？'));assert.equal(exact.exact.answer,'本人核实的原回答');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_prepare'||c.command==='knowledge_run').length),before);
 await page.getByRole('button',{name:'已采用',exact:true}).click();await page.getByText('PPO 是什么？',{exact:true}).click();await page.getByRole('button',{name:'让模型准备答案',exact:true}).click();await page.getByRole('button',{name:'同意本次发送',exact:true}).click();await page.getByText('API 的新回答草稿',{exact:true}).waitFor();await page.getByRole('button',{name:'放入编辑区',exact:true}).click();await page.getByRole('button',{name:'保存，稍后检查',exact:true}).click();assert.equal(await page.evaluate(()=>window.saved.questions[0].answer),'本人核实的原回答');assert.equal(await page.evaluate(()=>window.saved.questions[0].status),'confirmed');
 await page.getByRole('button',{name:'让模型准备答案',exact:true}).click();await page.getByRole('button',{name:'取消发送',exact:true}).click();assert.equal(await page.locator('.knowledge-draft').count(),0);assert.equal(await page.getByRole('textbox',{name:'回答',exact:true}).inputValue(),'API 的新回答草稿');
 await page.getByRole('textbox',{name:'回答',exact:true}).fill('还在核实的新版本');await page.getByRole('button',{name:'保存，稍后检查',exact:true}).click();assert.equal(await page.evaluate(()=>window.saved.questions[0].answer),'本人核实的原回答');
 await page.setViewportSize({width:640,height:780});assert.ok(await page.locator('.knowledge-window').evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:'outputs/knowledge-ui.png'});
 if(await page.getByRole('button',{name:'保存并关闭编辑',exact:true}).count())await page.getByRole('button',{name:'保存并关闭编辑',exact:true}).click();await page.getByRole('button',{name:'关闭面试准备',exact:true}).click();await page.getByRole('button',{name:'导入历史问题',exact:true}).click();await page.locator('.knowledge-review-card').first().waitFor();await page.getByText(/批量操作 \/ 导出/).click();
 await page.getByRole('button',{name:'导出问题',exact:true}).click();await page.getByRole('button',{name:'同意本次发送',exact:true}).click();await page.getByRole('status').filter({hasText:'相似题已检查'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='knowledge_export_questions').length),0);
 await page.getByRole('button',{name:'导出问题',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.command==='knowledge_export_questions'));
 const exported=await page.evaluate(()=>window.calls.find(c=>c.command==='knowledge_export_questions').args.questions);assert.equal(exported.length,2);assert.equal(exported[0].answer,'本人核实的原回答');assert.ok(exported[0].aliases.includes('解释一下 PPO'));assert.equal(exported[0].origins.length,2);
 assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
