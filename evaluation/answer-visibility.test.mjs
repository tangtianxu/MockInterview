import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('historical PPO answer stays visible during sustained mic activity in all capture modes',{timeout:90000},async()=>{
 const replay=JSON.parse(await readFile(new URL('./fixtures/ppo-display-replay.json',import.meta.url),'utf8'));
 const fixture='outputs/answer-visibility-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit,listen} from '@tauri-apps/api/event';import App from '/src/App.tsx';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();
 localStorage.setItem('interviewCue.settings',JSON.stringify({mode:new URLSearchParams(location.search).get('mode'),sttEngine:'whisper_cpp',sttModel:'small',mic:'fixture-mic',output:'fixture-speakers',decisionIntervalSeconds:2,answer:{api:'openai',baseUrl:'https://example.com/v1',model:'fixture'}}));
 const replay=${JSON.stringify(replay)};
 window.calls=[];window.requests=[];window.overlays=[];window.send=(name,payload)=>emit(name,payload);
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return 'test';
 if(command==='list_audio_devices')return JSON.stringify({inputs:[{id:'fixture-mic',name:'测试麦克风'}],outputs:[{id:'fixture-speakers',name:'测试扬声器'}]});
 if(command==='list_local_stt_engines')return JSON.stringify([{engine:'whisper_cpp',name:'Whisper',models:[{definition:{model_id:'small',display_name:'Small',is_streaming:true},is_downloaded:true}]}]);
 if(command==='has_api_key')return true;
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='mvp_list_models')return ['fixture'];
 if(command==='ollama_runtime_status')return {connected:false};
 if(command==='knowledge_lookup')return {enabled:false,exact:null,questions:[],passages:[],projects:[]};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command.includes('is_registered'))return false;
 if(command==='mvp_decide'){
  const text=args.input.turns.filter(x=>x.current).map(x=>x.text).join('');
  return text===replay.transcript?replay.decision:{intent:'question',action:'show',relation:'new',question:text,focus:[],key_terms:[],constraints:[],uncertain_terms:[]};
 }
 if(command==='mvp_answer'){window.requests.push(args);return new Promise(()=>{});}
 return null;},{shouldMockEvents:true});
 await listen('mvp_ui_state',event=>window.overlays.push(event.payload));
 createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5204','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',v=>output+=v);server.stderr.on('data',v=>output+=v);let browser;
 try{
  const url='http://127.0.0.1:5204/'+fixture;
  for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});
  for(const mode of ['live','video','offline']){
   const page=await browser.newPage({viewport:{width:1360,height:850}});page.setDefaultTimeout(12000);
   const errors=[];page.on('pageerror',e=>errors.push(String(e)));
   await page.goto(url+'?mode='+mode,{waitUntil:'domcontentloaded',timeout:30000});
   await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
   await page.getByRole('button',{name:'开始聆听',exact:true}).click();
   await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();
   const speech=(id,text)=>page.evaluate(({id,text})=>window.send('transcript_final',{segment:{id,text,speaker:'Them',timestamp_ms:Date.now(),is_final:true}}),{id,text});
   const reply=(id,token,done=false)=>page.evaluate(async({id,token,done})=>{if(token)await window.send('mvp_answer_token',{requestId:id,token});if(done)await window.send('mvp_answer_done',{requestId:id});},{id,token,done});
   await speech('previous','你使用过哪些强化学习算法？');
   await page.waitForFunction(()=>window.requests.length===1);
   const previous=await page.evaluate(()=>window.requests[0].requestId);
   await reply(previous,'先说明实际使用过的算法。',true);
   await page.locator('.answer-text').filter({hasText:'实际使用过的算法'}).waitFor();
   // The acknowledgement and sustained microphone energy must not hide a new
   // system-audio task, its first sentence, later tokens, or its final answer.
   await page.evaluate(()=>{window.micPulse=setInterval(()=>window.send('audio_level',{source:'Mic',level:0.8}),30);return window.send('audio_level',{source:'Mic',level:0.8});});
   await speech('ppo',replay.transcript);
   await page.waitForFunction(()=>window.requests.length===2);
   await page.waitForFunction(question=>document.querySelector('.question-box')?.textContent.includes(question),replay.decision.question);
   const current=await page.evaluate(()=>window.requests[1].requestId);
   const split=replay.answer.indexOf('。')+1;
   await reply(current,replay.answer.slice(0,split));
   await page.locator('.answer-text').filter({hasText:'PPO'}).waitFor();
   await reply(current,replay.answer.slice(split),true);
   await page.waitForFunction(()=>window.calls.some(x=>x.command==='history_record'&&x.args.entry.kind==='visibility'&&x.args.entry.text.includes('PPO')));
   assert.match(await page.locator('.answer-text').textContent(),/裁剪|优势/);
   assert.equal(await page.getByText('你正在说话，提示更新已锁定',{exact:true}).count(),0);
   assert.ok(await page.evaluate(()=>window.overlays.some(x=>x.question.includes('PPO')&&x.hint.includes('PPO')&&!x.locked)),mode+' overlay receives answer');
   assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='history_record'&&x.args.entry.kind==='visibility'&&x.args.entry.text.includes('PPO')).length),1,'visibility is recorded once per task');
   await speech('followup','它和SAC有什么区别？');
   await page.waitForFunction(()=>window.requests.length===3);
   const follow=await page.evaluate(()=>window.requests[2].requestId);
   await reply(current,'旧回答迟到的内容。',true);
   await reply(follow,'PPO与SAC的主要区别是采样和更新方式。',true);
   await page.locator('.answer-text').filter({hasText:'主要区别是采样'}).waitFor();
   assert.doesNotMatch(await page.locator('.answer-text').textContent(),/旧回答迟到/);
   await page.evaluate(()=>clearInterval(window.micPulse));
   await page.getByRole('button',{name:'结束练习',exact:true}).click();
   assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
