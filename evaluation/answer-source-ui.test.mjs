import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('source usage is reversible and independent of build selection and adoption',{timeout:45000},async()=>{
 const fixture='outputs/answer-source-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><meta charset="UTF-8"><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC} from '@tauri-apps/api/mocks';import {KnowledgeView} from '/src/KnowledgeView.tsx';import {emptyQuestion} from '/src/knowledge.ts';import '/src/index.css';
 window.state={root:'fixture',library:{enabled:true,activeProject:'',buildModel:'current',folders:[],sources:[{id:'source-1',relativePath:'项目/旧稿.md',project:'项目',status:'ready',hash:'hash',path:'fixture'}]},questions:[{...emptyQuestion('项目'),id:'question-1',question:'项目职责',answer:'本人核实的原回答',status:'confirmed'}],inbox:{items:[],matches:[],drafts:[],editor:null,cursor:null},errors:[]};window.calls=[];
 mockIPC(async(command,args)=>{window.calls.push({command,args});if(command==='knowledge_snapshot')return structuredClone(window.state);if(command==='knowledge_set_answer_source'){window.state.library.excludedAnswerSources=args.enabled?[]:[args.sourceId];return structuredClone(window.state);}return null;});
 createRoot(document.getElementById('root')).render(React.createElement(KnowledgeView,{model:{api:'deepseek',model:'fixture'},onClose:()=>{},onChange:()=>{},onBusyChange:()=>{}}));</script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5211','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',s=>output+=s);server.stderr.on('data',s=>output+=s);let browser;
 try{
  const url='http://127.0.0.1:5211/'+fixture;
  for(let i=0;i<70;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:850}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(8000);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await page.getByRole('button',{name:'资料',exact:true}).click();await page.locator('summary').filter({hasText:'查看文件 / 调整项目'}).click();
  const usage=page.getByRole('checkbox',{name:'将项目/旧稿.md用于回答',exact:true});assert.equal(await usage.isChecked(),true);await usage.uncheck();await page.getByText('已暂停该资料及其引用问答的自动使用；文件和问答均保留。',{exact:true}).waitFor();
  assert.equal(await usage.isChecked(),false);assert.equal(await page.locator('.knowledge-source input').first().isChecked(),false);
  assert.deepEqual(await page.evaluate(()=>[window.state.library.sources.length,window.state.questions.length,window.state.questions[0].status,window.state.questions[0].answer]),[1,1,'confirmed','本人核实的原回答']);
  await usage.check();await page.getByText('该资料及其已采用问答可用于回答。',{exact:true}).waitFor();assert.equal(await usage.isChecked(),true);
  assert.equal(await page.evaluate(()=>window.calls.some(c=>['knowledge_prepare','knowledge_run','knowledge_delete_question'].includes(c.command))),false);assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
