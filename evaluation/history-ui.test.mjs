import {test} from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdir,writeFile,unlink} from 'node:fs/promises';import {chromium} from 'playwright-core';
test('practice history survives reload, searches and exports; stable-only mode skips partial decisions',{timeout:60000},async()=>{
 const fixture='outputs/history-ui-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit as emitMockEvent} from '@tauri-apps/api/event';import App from '/src/App.tsx';import '/src/index.css';
 mockWindows('launcher');window.calls=[];window.saved=JSON.parse(localStorage.getItem('fixture.history')||'{"sessions":[],"entries":{}}');
 const persist=()=>localStorage.setItem('fixture.history',JSON.stringify(window.saved));window.fakeTranscript=(name,segment)=>emitMockEvent(name,{segment});
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='load_interview_profile')return {settings:{sttEngine:'whisper_cpp',sttModel:'small',answer:{api:'deepseek',baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},sharedModelConnection:true,decisionFinalOnly:true},resumeAnalysis:null};
 if(command==='plugin:app|version')return '1.0.14';if(command==='list_audio_devices')return JSON.stringify({inputs:[],outputs:[]});
 if(command==='list_local_stt_engines')return JSON.stringify([{engine:'whisper_cpp',name:'Whisper',models:[{definition:{model_id:'small',display_name:'Small',is_streaming:true},is_downloaded:true}]}]);
 if(command==='mvp_list_models')return ['deepseek-flash'];if(command==='has_api_key')return true;if(command.includes('is_registered'))return false;
 if(command==='ollama_runtime_status')return {connected:false,executable:null};if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command==='history_begin'){window.saved.sessions.push(args.session);window.saved.entries[args.session.id]=[];persist();return;}
 if(command==='history_record'){const entries=window.saved.entries[args.sessionId];const index=entries.findIndex(entry=>entry.id===args.entry.id);if(index<0)entries.push(args.entry);else entries[index]=args.entry;persist();return;}
 if(command==='history_end'){window.saved.sessions.find(item=>item.id===args.id).endedAt=args.at;persist();return;}
 if(command==='history_list')return window.saved.sessions.filter(item=>!args.query||JSON.stringify(window.saved.entries[item.id]).includes(args.query));
 if(command==='history_read')return {session:window.saved.sessions.find(item=>item.id===args.id),entries:window.saved.entries[args.id]};
 if(command==='plugin:dialog|save')return 'C:/fixture/history.md';if(command==='plugin:dialog|ask')return true;
 if(command==='history_delete'){window.saved.sessions=window.saved.sessions.filter(item=>item.id!==args.id);delete window.saved.entries[args.id];persist();return;}
 if(command==='practice_model')return args.input.action==='ask'?{question:'PPO 是什么？',intent:'technical',topic:'强化学习'}:{score:2,evidence:'我回答了 PPO',questionKind:'technical',corrections:[],missingPoints:[{point:'机制',explanation:'需要说明概率比与裁剪约束'}]};
 if(command==='mvp_answer'){await emitMockEvent('mvp_answer_token',{requestId:args.requestId,token:'PPO：Proximal Policy Optimization，近端策略优化。'});await emitMockEvent('mvp_answer_done',{requestId:args.requestId});return;}
 if(command==='mvp_decide')return {intent:'statement',relation:'none',action:'wait',question:'',focus:[],key_terms:[],constraints:[],uncertain_terms:[]};
 return null;
 },{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5201','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',s=>output+=s);server.stderr.on('data',s=>output+=s);let browser;
 try{const url='http://127.0.0.1:5201/'+fixture;for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage();page.on('pageerror',error=>console.log('Fixture error:',error.message));page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(20000);await page.goto(url);
 await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.locator('#practice-answer').fill('我回答了 PPO');await page.getByRole('button',{name:'提交回答',exact:true}).click();
 await page.waitForFunction(()=>Object.values(window.saved.entries).some(entries=>entries.some(e=>e.kind==='answer'&&e.data.complete===true)));
 await page.getByRole('button',{name:'结束练习',exact:true}).click();await page.waitForFunction(()=>window.saved.sessions[0].endedAt);
 await page.reload();await page.getByRole('button',{name:'历史',exact:true}).click();await page.locator('.history-session').first().click();
 assert.match(await page.locator('.history-detail').innerText(),/近端策略优化/);assert.match(await page.locator('.history-detail').innerText(),/我回答了 PPO/);
 await page.getByRole('textbox',{name:'关键词'}).fill('不存在的关键词');await page.getByRole('button',{name:'查询 / 刷新'}).click();await page.waitForFunction(()=>!document.querySelector('.history-session'));
 await page.getByRole('textbox',{name:'关键词'}).fill('PPO');await page.getByRole('button',{name:'查询 / 刷新'}).click();await page.locator('.history-session').click();
 await page.getByRole('button',{name:'导出 Markdown / JSON'}).click();await page.waitForFunction(()=>window.calls.some(c=>c.command==='history_export'));
 await page.getByRole('button',{name:'删除本场'}).click();await page.waitForFunction(()=>!window.saved.sessions.length);
 await page.getByRole('button',{name:'完成设置'}).click();await page.locator('.brand-mark').dblclick();await page.getByRole('button',{name:'开始聆听',exact:true}).click();await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();
 await page.evaluate(()=>window.fakeTranscript('transcript_update',{id:'t-1',text:'解释 PPO',speaker:'Them',timestamp_ms:0,is_final:false}));await page.waitForTimeout(650);
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_decide').length),0);
 await page.evaluate(()=>window.fakeTranscript('transcript_final',{id:'t-1',text:'解释 PPO',speaker:'Them',timestamp_ms:0,is_final:true}));await page.waitForFunction(()=>window.calls.some(c=>c.command==='mvp_decide'));
 assert.ok(await page.evaluate(()=>window.calls.find(c=>c.command==='mvp_decide').args.endpoint.historySessionId));
 await browser.close();browser=null;
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
