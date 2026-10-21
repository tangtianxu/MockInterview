import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdir,writeFile,unlink} from 'node:fs/promises';import {chromium} from 'playwright-core';
test('confirmed project questions work without resume analysis; feedback stays concrete and reference uses the saved answer',{timeout:60000},async()=>{
 const fixture='outputs/knowledge-practice-fixture.html';await mkdir('outputs',{recursive:true});await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import {mockActionResponses} from '/evaluation/helpers/in-app-actions.mjs';
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import App from '/src/App.tsx';import {emptyQuestion} from '/src/knowledge.ts';import '/src/index.css';
 mockWindows('launcher');localStorage.setItem('interviewCue.practiceConfig',JSON.stringify({scope:'project',minutes:20,difficulty:'medium'}));window.calls=[];
 const bank=[{...emptyQuestion('A'),question:'你在项目中如何设置缓存过期？',answer:'本人确认的真实标准回答',explanation:'本人确认的展开说明',status:'confirmed',priority:1},{...emptyQuestion('A'),question:'缓存击穿时怎么保护后端？',answer:'第二题标准回答',status:'confirmed',priority:2}];
 mockActionResponses((kind,options,message)=>{window.calls.push({command:'in-app:'+kind,args:{options,message}});return kind==='confirm'?true:kind==='open'?null:null;});
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='knowledge_snapshot')return {root:'fixture',library:{enabled:true,activeProject:'A',buildModel:'current',folders:[],sources:[]},questions:bank,errors:[]};
 if(command==='load_interview_profile')return {settings:{sharedModelConnection:true,answer:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'}},resumeAnalysis:null};
 if(command==='plugin:app|version')return '1.0.20';if(command==='mvp_list_models')return ['deepseek-flash'];if(command==='has_api_key')return true;if(command.includes('is_registered'))return false;
 if(command==='list_audio_devices')return JSON.stringify({inputs:[],outputs:[]});if(command==='list_local_stt_engines')return '[]';
 if(command==='ollama_runtime_status')return {connected:false,executable:null};if(command==='set_taskbar_hidden'||command==='get_privacy_display_state')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};

 if(command==='practice_model'){if(args.input.action!=='evaluate')throw Error('Bank practice must not ask/analyze via API');return {score:2,evidence:'设置 TTL',questionKind:'project',corrections:[],missingPoints:[{point:'具体策略',explanation:'说明 TTL 的选择和刷新行为'}]};}
 if(command==='mvp_answer')throw Error('A saved reference must not be regenerated');return null;
 },{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5211','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',v=>output+=v);server.stderr.on('data',v=>output+=v);let browser;
 try{const url='http://127.0.0.1:5211/'+fixture;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage();page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
 await page.getByRole('checkbox',{name:'使用已采用问答出题（无需先分析简历）'}).check();await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.getByText('你在项目中如何设置缓存过期？',{exact:true}).first().waitFor();
 await page.locator('#practice-answer').fill('设置 TTL');await page.getByRole('button',{name:'提交回答',exact:true}).click();await page.getByText('说明 TTL 的选择和刷新行为',{exact:true}).waitFor();await page.locator('.practice-reference-answer').getByText('本人确认的真实标准回答',{exact:false}).waitFor();
 const request=await page.evaluate(()=>window.calls.find(c=>c.command==='practice_model').args);assert.equal(request.input.knowledgeContext.consent,true);assert.equal(request.input.knowledgeContext.questions[0].answer,'本人确认的真实标准回答');assert.equal(request.input.resumeText,'');assert.equal(request.input.consentToSendResume,false);
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_answer').length),0);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='practice_model').length),1);
 await page.getByRole('button',{name:'下一题',exact:true}).click();await page.getByText('缓存击穿时怎么保护后端？',{exact:true}).first().waitFor();assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
