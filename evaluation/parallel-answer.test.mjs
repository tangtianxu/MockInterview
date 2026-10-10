import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('parallel streams, Enter/IME, follow-up context, cancellation and cursors in the real UI',{timeout:45000},async()=>{
 const fixture='outputs/parallel-answer-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import App from '/src/App.tsx';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();localStorage.setItem('interviewCue.settings',JSON.stringify({sharedModelConnection:false,parallelAnswer:true,answer:{api:'openai',baseUrl:'https://example.com/v1',model:'api'},parallelLocal:{api:'ollama',baseUrl:'http://127.0.0.1:11434',model:'local'}}));
 window.calls=[];window.requests=[];window.send=async(id,token,error,done=false)=>{if(token)await emit('mvp_answer_token',{requestId:id,token});if(done)await emit('mvp_answer_done',{requestId:id,error});};
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return 'test';
 if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';
 if(command==='mvp_list_models')return ['local','api'];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {executable:null,connected:false,configFile:'fixture'};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command==='has_api_key'||command.includes('is_registered'))return false;
 if(command==='mvp_answer'){window.requests.push(args);return new Promise(()=>{});}
 return null;},{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5196','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>output+=data);let browser;
 try{
  const url='http://127.0.0.1:5196/'+fixture;
  for(let i=0;i<70;i++){if(server.exitCode!==null)throw new Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1360,height:850}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(url);await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
  const input=page.getByRole('textbox',{name:'修正模型理解的问题'});
  async function submit(text,count){await page.locator('.question-box').click();await input.fill(text);await input.press('Enter');await page.waitForFunction(n=>window.requests.length===n,count);return page.evaluate(()=>window.requests.slice(-2));}
  await page.locator('.question-box').click();await input.fill('PPO 是什么');
  assert.equal(await input.evaluate(el=>getComputedStyle(el).cursor),'default');
  await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  assert.equal(await page.evaluate(()=>window.requests.length),0);
  await input.press('Shift+Enter');assert.match(await input.inputValue(),/\n/);
  await input.press('Enter');await page.waitForFunction(()=>window.requests.length===2);
  const first=await page.evaluate(()=>window.requests);const local=first.find(x=>x.endpoint.api==='ollama'),api=first.find(x=>x.endpoint.api==='openai');
  await page.evaluate(id=>window.send(id,'定义：这是本地的 PPO 解释。'),local.requestId);
  await page.locator('.answer-text').filter({hasText:'本地的 PPO'}).waitFor();
  assert.match(await page.locator('.answer-footer').textContent(),/本地回答.*API 完善中/);
  await page.evaluate(id=>window.send(id,'定义：这是 API 的 PPO 解释。'),api.requestId);
  assert.match(await page.locator('.answer-text').textContent(),/本地的 PPO/);
  await page.evaluate(id=>window.send(id,null,undefined,true),api.requestId);
  assert.match(await page.locator('.answer-text').textContent(),/本地的 PPO/);
  await page.evaluate(id=>window.send(id,'迟到的本地内容。',undefined,true),local.requestId);
  await page.locator('.answer-text').filter({hasText:'API 的 PPO'}).waitFor();
  assert.match(await page.locator('.answer-text').textContent(),/API 的 PPO/);
  const second=await submit('什么情况下使用',4);assert.deepEqual(second[0].questionContext,['PPO 是什么']);
  const secondLocal=second.find(x=>x.endpoint.api==='ollama'),secondApi=second.find(x=>x.endpoint.api==='openai');
  await page.evaluate(id=>window.send(id,'定义：PPO 适用于在线策略优化。',undefined,true),secondLocal.requestId);
  await page.evaluate(id=>window.send(id,null,'网络中断',true),secondApi.requestId);
  assert.match(await page.locator('.answer-text').textContent(),/在线策略优化/);
  assert.equal(await page.locator('.error-box').count(),0);
  const third=await submit('比较 PPO 与 SAC',6);const fourth=await submit('什么是注意力',8);
  await page.evaluate(id=>window.send(id,'这是新问题的正确答案。',undefined,true),fourth.find(x=>x.endpoint.api==='openai').requestId);
  await page.evaluate(id=>window.send(id,'旧问题迟到的错误覆盖。',undefined,true),third[0].requestId);
  assert.match(await page.locator('.answer-text').textContent(),/新问题/);assert.doesNotMatch(await page.locator('.answer-text').textContent(),/旧问题/);
  const cancelled=await page.evaluate(()=>window.calls.filter(x=>x.command==='mvp_cancel_answer').map(x=>x.args.requestId));assert.ok(third.every(x=>cancelled.includes(x.requestId)));
  assert.equal(await page.getByRole('button',{name:'开始聆听',exact:true}).evaluate(el=>getComputedStyle(el).cursor),'default');
  assert.equal(await page.locator('.resize-northwest').evaluate(el=>getComputedStyle(el).cursor),'nwse-resize');
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
