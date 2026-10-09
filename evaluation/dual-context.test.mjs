import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('dual transcription supplies candidate context without triggering questions; stored introduction is isolated',{timeout:60000},async()=>{
 const fixture='outputs/dual-context-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import App from '/src/App.tsx';import '/src/index.css';
 const params=new URLSearchParams(location.search);mockWindows('launcher');localStorage.clear();
 localStorage.setItem('interviewCue.settings',JSON.stringify({mode:params.get('video')?'video':'live',micTranscription:!params.get('disabled'),sttMode:params.get('api')?'api':'local',sharedModelConnection:true,answer:{api:'openai',baseUrl:'https://example.com/v1',model:'test'},selfIntroduction:params.get('emptyIntro')?'':'INTRO_PRIVATE_我是研究生，研究机器人。'}));
 window.calls=[];window.hold=false;window.send=async(name,payload)=>emit(name,payload);
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return 'test';
 if(command==='list_audio_devices')return JSON.stringify({inputs:[],outputs:[]});
 if(command==='list_local_stt_engines')return JSON.stringify([{engine:'whisper_cpp',name:'Whisper',models:[{definition:{model_id:'small',display_name:'Small',is_streaming:true},is_downloaded:true}]}]);
 if(command==='mvp_list_models')return ['test'];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {executable:null,connected:false,configFile:'fixture'};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command==='has_api_key')return true;
 if(command.includes('is_registered'))return false;
 if(command==='mvp_decide'){
  const text=args.input.currentText;
  const intro=text==='请介绍一下你自己';
  const question=text==='为什么选择它'&&args.input.context.includes('GAE')?'为什么选择 GAE':text;
  return {intent:intro?'self_introduction':'question',relation:'new',action:'show',question:intro?'请进行自我介绍':question,focus:[],key_terms:[],constraints:[],uncertain_terms:[]};
 }
 if(command==='mvp_answer'){
  await emit('mvp_answer_token',{requestId:args.requestId,token:'定义：'+args.question+'的技术解释。'});
  if(window.hold)return new Promise(()=>{});
  await emit('mvp_answer_done',{requestId:args.requestId});
 }
 return null;},{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5197','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>output+=data);let browser;
 try{
 const url='http://127.0.0.1:5197/'+fixture;
 for(let i=0;i<70;i++){if(server.exitCode!==null)throw new Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:850}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 async function load(query=''){await page.goto(url+query);await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();await page.getByRole('button',{name:'开始聆听',exact:true}).click();await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();}
 async function speech(speaker,id,text,time,final=true){await page.evaluate(({speaker,id,text,time,final})=>window.send(final?'transcript_final':'transcript_update',{segment:{id,text,speaker,timestamp_ms:time,is_final:final}}),{speaker,id,text,time,final});}
 await load();
 const capture=await page.evaluate(()=>window.calls.find(x=>x.command==='start_capture_per_party').args);
 assert.equal(JSON.parse(capture.youConfig).stt_provider,'whisper_cpp');assert.equal(JSON.parse(capture.youConfig).local_model_id,'small');
 await speech('Them','a','介绍 PPO',100);await page.locator('.answer-text').filter({hasText:'介绍 PPO'}).waitFor();
 const count=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length);
 await speech('User','b','我采用的是 GAE',200,false);await speech('User','b','我采用的是 GAE',200,true);
 await page.waitForTimeout(550);assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),count);
 assert.match(await page.locator('.transcript-scroll').textContent(),/我的回答/);
 await speech('Them','c','为什么选择它',300);await page.locator('.answer-text').filter({hasText:'为什么选择 GAE'}).waitFor();
 const follow=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').at(-1).args.input);
 assert.equal(follow.candidateReply,'我采用的是 GAE');assert.match(follow.context,/候选人：我采用的是 GAE/);assert.match(follow.context,/面试官：介绍 PPO/);
 // Partial candidate replies also reach the next question without generating their own task.
 await speech('User','d','这里使用了优势归一化',400,false);
 await speech('Them','e','如何实现这个步骤',500);await page.locator('.answer-text').filter({hasText:'如何实现这个步骤'}).waitFor();
 assert.match(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').at(-1).args.input.context),/候选人：这里使用了优势归一化/);
 // Introduction cancels an unfinished answer, remains visible while speaking and never invokes explanation.
 await page.evaluate(()=>window.hold=true);await speech('Them','f','解释 Transformer',600);await page.locator('.answer-text').filter({hasText:'Transformer'}).waitFor();
 const old=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').at(-1).args.requestId);
 const answersBefore=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length);
 await page.evaluate(()=>window.send('audio_level',{source:'Mic',level:0.5}));
 await speech('Them','g','请介绍一下你自己',700);await page.locator('.answer-text').filter({hasText:'INTRO_PRIVATE_'}).waitFor();
 assert.equal(await page.locator('.answer-text').textContent(),'INTRO_PRIVATE_我是研究生，研究机器人。');
 assert.equal(await page.locator('.detail-btn').count(),0);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),answersBefore);
 await page.evaluate(id=>window.send('mvp_answer_token',{requestId:id,token:'旧答案错误覆盖。'}),old);
 assert.match(await page.locator('.answer-text').textContent(),/INTRO_PRIVATE_/);
 assert.ok(await page.evaluate(id=>window.calls.some(x=>x.command==='mvp_cancel_answer'&&x.args.requestId===id),old));
 await page.evaluate(()=>window.send('mvp_detail_request',{}));
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_explain').length),0);
 const overlay=await page.evaluate(()=>window.calls.filter(x=>x.command==='plugin:event|emit'&&x.args.event==='mvp_ui_state').at(-1));
 if(overlay)assert.equal(overlay.args.payload.detailAvailable,false);
 // A question mentioning an introduction is still a technical question.
 await page.evaluate(()=>window.hold=false);await page.waitForTimeout(550);await page.evaluate(()=>window.send('audio_level',{source:'Mic',level:0}));
 await speech('Them','h','你自我介绍里提到的 PPO 是什么',800);await page.locator('.answer-text').filter({hasText:'PPO 是什么'}).waitFor();
 assert.doesNotMatch(await page.locator('.answer-text').textContent(),/INTRO_PRIVATE_/);
 assert.equal(await page.locator('.detail-btn').count(),1);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>['mvp_decide','mvp_answer','mvp_explain'].includes(x.command)).some(x=>JSON.stringify(x.args).includes('INTRO_PRIVATE_'))),false);
 await page.getByRole('button',{name:'结束练习',exact:true}).click();
 // Settings save the prepared text in the existing profile file.
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'个人资料'}).click();
 await page.getByRole('textbox',{name:'自我介绍稿',exact:true}).fill('UPDATED_INTRO');
 await page.waitForFunction(()=>window.calls.some(x=>x.command==='save_interview_profile'&&JSON.stringify(x.args).includes('UPDATED_INTRO')));
 await page.getByRole('button',{name:'完成设置',exact:true}).click();
 // The user's idle manual-test phrase must use the same saved-draft route.
 const beforeManual=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length);
 await page.getByRole('button',{name:'编辑问题',exact:true}).click();
 await page.getByRole('textbox',{name:'修正模型理解的问题'}).fill('请你先做个简单的自我介绍');
 await page.getByRole('textbox',{name:'修正模型理解的问题'}).press('Enter');
 await page.locator('.answer-text').filter({hasText:'UPDATED_INTRO'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),beforeManual);
 await page.getByRole('button',{name:'编辑问题',exact:true}).click();
 await page.getByRole('textbox',{name:'修正模型理解的问题'}).fill('自我介绍里提到的 PPO 原理是什么');
 await page.getByRole('textbox',{name:'修正模型理解的问题'}).press('Enter');
 await page.locator('.answer-text').filter({hasText:'PPO 原理'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),beforeManual+1);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>['mvp_decide','mvp_answer','mvp_explain'].includes(x.command)).some(x=>JSON.stringify(x.args).includes('UPDATED_INTRO'))),false);
 for(const query of ['?disabled=1','?video=1','?api=1']){
  await load(query);const config=await page.evaluate(()=>JSON.parse(window.calls.find(x=>x.command==='start_capture_per_party').args.youConfig));
  assert.equal(config.stt_provider,query==='?api=1'?'groq_whisper':'web_speech');
  await speech('User','only-user','候选人提出的问题',1);await page.waitForTimeout(550);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),0);
  await page.getByRole('button',{name:'结束练习',exact:true}).click();
 }
 await load('?emptyIntro=1');await speech('Them','intro-empty','请介绍一下你自己',1);
 await page.locator('.answer-text').filter({hasText:'尚未保存自我介绍'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),0);
 await page.getByRole('button',{name:'结束练习',exact:true}).click();
 assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
