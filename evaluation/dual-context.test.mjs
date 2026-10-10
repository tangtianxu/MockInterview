import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('dual and microphone-only transcription route questions and preserve context; stored introduction is isolated',{timeout:120000},async()=>{
 const fixture='outputs/dual-context-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import App from '/src/App.tsx';import '/src/index.css';
 const params=new URLSearchParams(location.search);mockWindows('launcher');localStorage.clear();
 localStorage.setItem('interviewCue.settings',JSON.stringify({sttEngine:'whisper_cpp',sttModel:'small',mode:params.get('offline')?'offline':params.get('video')?'video':'live',mic:params.get('namedMic')?'fixture-mic':'default',output:'fixture-speakers',micTranscription:!params.get('disabled'),sttMode:params.get('api')?'api':'local',sharedModelConnection:true,decisionIntervalSeconds:params.has('throttle')?undefined:2,answer:{api:'openai',baseUrl:'https://example.com/v1',model:'test'},selfIntroduction:params.get('emptyIntro')?'':'INTRO_PRIVATE_我是研究生，研究机器人。'}));
 window.calls=[];window.decisions=[];window.hold=false;window.send=async(name,payload)=>emit(name,payload);
 mockIPC(async(command,args)=>{window.calls.push({command,args,at:performance.now()});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return 'test';
 if(command==='list_audio_devices')return JSON.stringify({inputs:[{id:'fixture-mic',name:'测试麦克风'}],outputs:[{id:'fixture-speakers',name:'测试扬声器'}]});
 if(command==='list_local_stt_engines')return JSON.stringify([{engine:'whisper_cpp',name:'Whisper',models:[{definition:{model_id:'small',display_name:'Small',is_streaming:true},is_downloaded:true}]}]);
 if(command==='mvp_list_models')return ['test'];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {executable:null,connected:false,configFile:'fixture'};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command==='has_api_key')return true;
 if(command.includes('is_registered'))return false;
 if(command==='mvp_decide'){
  if(window.decisions.length)return window.decisions.shift();
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
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5197','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>output+=data);let browser;
 try{
 const url='http://127.0.0.1:5197/'+fixture;
 for(let i=0;i<70;i++){if(server.exitCode!==null)throw new Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:850}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 async function load(query=''){await page.goto(url+query);await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();await page.getByRole('button',{name:'开始聆听',exact:true}).click();await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();}
 async function speech(speaker,id,text,time,final=true){await page.evaluate(({speaker,id,text,time,final})=>window.send(final?'transcript_final':'transcript_update',{segment:{id,text,speaker,timestamp_ms:time,is_final:final}}),{speaker,id,text,time,final});}
 // Existing profiles without an interval get the new 5-second default.
 await load('?throttle=1');
 for(let i=0;i<25;i++)await speech('Them','burst','PPO 是什'+i,100,false);
 await speech('Them','burst','PPO 是什么',100);await page.locator('.answer-text').filter({hasText:'PPO 是什么'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),1,'25 revisions produce one decision');
 for(let i=0;i<5;i++)await speech('Them','burst','PPO 是什么',100);
 await speech('Them','background','实际部署出现动作抖动',200);
 await speech('Them','follow','怎么解决这个问题',300);
 await page.waitForTimeout(800);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),1,'final fragments cannot bypass cooldown');
 await page.waitForFunction(()=>window.calls.filter(x=>x.command==='mvp_decide').length===2);
 const batch=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide'));
 assert.ok(batch[1].at-batch[0].at>=4990,'requests are separated by at least 5 seconds, allowing timer precision');
 assert.equal(batch[1].args.input.currentText,'实际部署出现动作抖动\n怎么解决这个问题');
 assert.match(batch[1].args.input.context,/PPO 是什么/);assert.doesNotMatch(batch[1].args.input.context,/实际部署/);
 await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),2);
 await speech('Them','cancelled','结束后不应发出此请求',400);
 await page.getByRole('button',{name:'结束练习',exact:true}).click();await page.waitForTimeout(5100);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),2,'stop cancels the pending batch');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'模型与服务'}).click();
 const interval=page.getByRole('combobox',{name:'语义判别最小间隔'});assert.equal(await interval.inputValue(),'5');
 await interval.selectOption('10');await page.waitForFunction(()=>window.calls.some(x=>x.command==='save_interview_profile'&&x.args.profile.settings.decisionIntervalSeconds===10));
 await page.getByRole('button',{name:'完成设置',exact:true}).click();
 // A batched video follow-up must replace the previous definition, including when
 // the last fragment is a partial candidate answer rather than the question.
 const decision=(question,relation='new',action='show',intent='question')=>({intent,relation,action,question,focus:[],key_terms:[],constraints:[],uncertain_terms:[]});
 await load('?video=1&throttle=1');
 await page.evaluate(d=>window.decisions.push(d),decision('解释一下模型的泛化能力是什么'));
 await speech('Them','definition','解释一下模型的泛化能力是什么',100);
 await page.locator('.answer-text').filter({hasText:'解释一下模型的泛化能力是什么'}).waitFor();
 await page.evaluate(d=>window.decisions.push(d),decision('如何提升模型的泛化能力','follow_up'));
 await speech('Them','question','那一般怎么样去提升模型的方法能力呢',200);
 await speech('Them','reply-1','嗯首先是呢需要对区域训练它这个过程当中他的数据',300);
 await speech('Them','reply-2','集的构成首先要做到尽量的',400,false);
 await page.locator('.answer-text').filter({hasText:'如何提升模型的泛化能力'}).waitFor();
 const mixed=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').at(-1).args.input);
 assert.equal(mixed.currentText,'那一般怎么样去提升模型的方法能力呢\n嗯首先是呢需要对区域训练它这个过程当中他的数据\n集的构成首先要做到尽量的');
 assert.match(mixed.context,/解释一下模型的泛化能力/);assert.equal(mixed.isFinal,false);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),2);
 await page.evaluate(d=>window.decisions.push(d),decision('','none','wait','statement'));
 await speech('Them','reply-2','集的构成首先要做到尽量的覆盖测试分布',400);
 await page.waitForFunction(()=>window.calls.filter(x=>x.command==='mvp_decide').length===3);
 await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),2,'candidate answers cannot recreate a previous question');
 assert.match(await page.locator('.answer-text').textContent(),/如何提升模型的泛化能力/);
 // A weak classifier may mistakenly emit show again with changed metadata.
 await page.evaluate(d=>window.decisions.push({...d,focus:['训练数据覆盖'],key_terms:['正则化']}),decision('如何提升模型的泛化能力'));
 await speech('Them','reply-3','还可以做正则化',500);
 await page.waitForFunction(()=>window.calls.filter(x=>x.command==='mvp_decide').length===4);
 await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),2,'unchanged questions must not regenerate when classifier metadata changes');
 await page.getByRole('button',{name:'结束练习',exact:true}).click();
 // Only the question channel controls pausing: online/video = system; offline = mic.
 for(const query of ['', '?video=1', '?offline=1']){
  const source=query.includes('offline')?'Mic':'System';const other=source==='Mic'?'System':'Mic';
  await load(query);await page.evaluate(source=>window.send('audio_level',{source,level:1}),other);
  await speech('Them','other-audio','PPO 的应用条件是什么',100,false);
  await page.waitForFunction(()=>window.calls.filter(x=>x.command==='mvp_decide').length===1);
  await page.getByRole('button',{name:'结束练习',exact:true}).click();
  await load(query);await speech('Them','active-audio','PPO 的应用条件是什么',100,false);
  for(let i=0;i<7;i++){
   await page.evaluate(source=>window.send('audio_level',{source,level:0.5}),source);await page.waitForTimeout(200);
  }
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').length),0,source+' speech must defer a provisional question');
  await page.evaluate(source=>window.send('audio_level',{source,level:0}),source);
  await page.waitForFunction(()=>window.calls.filter(x=>x.command==='mvp_decide').length===1);
  await page.getByRole('button',{name:'结束练习',exact:true}).click();
 }
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
 // Offline questions use one selected mic and one STT provider, including the OS default mic.
 for(const query of ['?offline=1','?offline=1&namedMic=1','?offline=1&api=1']){
  await load(query);
  const configs=await page.evaluate(()=>{
   const args=window.calls.find(x=>x.command==='start_capture_per_party').args;
   return {you:JSON.parse(args.youConfig),them:JSON.parse(args.themConfig)};
  });
  const device=query.includes('namedMic')?'fixture-mic':'default';
  assert.equal(configs.you.device_id,device);assert.equal(configs.them.device_id,device);
  assert.equal(configs.you.stt_provider,'disabled');assert.equal(configs.you.local_model_id,null);
  assert.equal(configs.them.is_input_device,true);
  assert.equal(configs.them.stt_provider,query.includes('api')?'groq_whisper':'whisper_cpp');
  assert.equal(configs.them.local_model_id,query.includes('api')?null:'small');
  await page.evaluate(()=>window.send('audio_level',{source:'Mic',level:0.7}));
  await speech('Them','offline-question','PPO 的原理是什么',100);
  await page.locator('.answer-text').filter({hasText:'PPO 的原理是什么'}).waitFor();
  assert.match(await page.locator('.transcript-scroll').textContent(),/麦克风提问/);
  assert.doesNotMatch(await page.locator('.meter-foot').textContent(),/锁定/);
  await speech('Them','offline-followup','什么时候使用',200);
  await page.locator('.answer-text').filter({hasText:'什么时候使用'}).waitFor();
  const follow=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_decide').at(-1).args.input);
  assert.match(follow.context,/PPO 的原理/);assert.equal(follow.videoMode,false);
  assert.equal(await page.getByRole('button',{name:/线下面试/}).isDisabled(),true);
  await page.getByRole('button',{name:'结束练习',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音频设备'}).click();
  assert.equal(await page.getByRole('combobox',{name:'采集模式'}).inputValue(),'offline');
  assert.equal(await page.getByRole('combobox',{name:'面试音频输出设备'}).isDisabled(),true);
  assert.equal(await page.getByRole('combobox',{name:'提问麦克风'}).inputValue(),device);
  await page.getByRole('combobox',{name:'采集模式'}).selectOption('video');
  assert.equal(await page.getByRole('combobox',{name:'面试音频输出设备'}).inputValue(),'fixture-speakers');
  assert.equal(await page.getByRole('combobox',{name:'面试音频输出设备'}).isDisabled(),false);
  await page.getByRole('combobox',{name:'采集模式'}).selectOption('offline');
  await page.waitForFunction(()=>window.calls.some(c=>c.command==='save_interview_profile'&&c.args.profile.settings.mode==='offline'));
  await page.getByRole('button',{name:'完成设置',exact:true}).click();
 }
 await load('?emptyIntro=1');await speech('Them','intro-empty','请介绍一下你自己',1);
 await page.locator('.answer-text').filter({hasText:'尚未保存自我介绍'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_answer').length),0);
 await page.getByRole('button',{name:'结束练习',exact:true}).click();
 assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
