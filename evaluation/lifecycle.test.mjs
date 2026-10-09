import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('failed profile reads, immediate quit, pending questions and late microphone setup remain safe',{timeout:60000},async t=>{
 const fixture='outputs/lifecycle-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import App from '/src/App.tsx';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();window.calls=[];window.askGate=false;window.micGate=false;
 const failed=new URLSearchParams(location.search).has('failed');
 mockIPC(async(command,args)=>{window.calls.push({command,args});
  if(command==='load_interview_profile'){if(failed)throw '模拟配置读取失败';return {settings:{},resumeAnalysis:null};}
  if(command==='plugin:app|version')return '1.0.12';
  if(command==='list_audio_devices')return JSON.stringify({inputs:[],outputs:[]});
  if(command==='list_local_stt_engines')return JSON.stringify([]);
  if(command==='mvp_list_models')return ['fixture'];
  if(command==='local_stt_model_directory')return 'fixture';
  if(command==='ollama_runtime_status')return {executable:null,connected:false,configFile:'fixture'};
  if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
  if(command.includes('is_registered')||command==='has_api_key')return false;
  if(command==='practice_model'){if(window.askGate)await new Promise(resolve=>window.releaseAsk=resolve);return {question:'PPO 是什么？',topic:'强化学习',intent:'technical'};}
  if(command==='start_capture_per_party'&&window.micGate)await new Promise(resolve=>window.releaseMic=resolve);
  return null;
 },{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5200','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',value=>output+=value);server.stderr.on('data',value=>output+=value);let browser;
 try{
  const url='http://127.0.0.1:5200/'+fixture;
  for(let i=0;i<70;i++){if(server.exitCode!==null)throw new Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const create=async suffix=>{const page=await browser.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(20000);await page.goto(url+(suffix||''));await page.getByRole('button',{name:'开始练习',exact:true}).waitFor();return page;};
  await t.test('read failure never overwrites the existing profile',async()=>{
   const page=await create('?failed');await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'个人资料'}).click();
   await page.getByRole('alert').filter({hasText:'读取配置'}).waitFor();await page.waitForTimeout(600);
   assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.command==='save_interview_profile').length),0);
   await page.close();
  });
  await t.test('closing immediately after editing saves the newest draft first',async()=>{
   const page=await create();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'个人资料'}).click();
   await page.getByRole('textbox',{name:'自我介绍稿',exact:true}).fill('刚输入的最新草稿');
   await page.getByRole('button',{name:'完成设置',exact:true}).click();await page.getByRole('button',{name:'关闭程序',exact:true}).click();
   await page.waitForFunction(()=>window.calls.some(call=>call.command==='plugin:process|exit'));
   const calls=await page.evaluate(()=>window.calls);const exit=calls.findIndex(call=>call.command==='plugin:process|exit');
   assert.equal(calls.slice(0,exit).filter(call=>call.command==='save_interview_profile').at(-1).args.profile.settings.selfIntroduction,'刚输入的最新草稿');
   await page.close();
  });
  await t.test('a pending first question blocks mode switching and late microphone startup is stopped',async()=>{
   const page=await create();await page.evaluate(()=>window.askGate=true);await page.getByRole('button',{name:'开始练习',exact:true}).click();
   await page.waitForFunction(()=>typeof window.releaseAsk==='function');await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
   assert.equal(await page.locator('.practice-workspace').count(),1);
   await page.evaluate(()=>{window.askGate=false;window.releaseAsk();});await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();
   await page.evaluate(()=>window.micGate=true);await page.getByRole('button',{name:'麦克风作答',exact:true}).click();
   await page.waitForFunction(()=>typeof window.releaseMic==='function');
   assert.equal(await page.getByRole('button',{name:'正在启动麦克风…',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'结束练习',exact:true}).click();await page.evaluate(()=>window.releaseMic());
   await page.waitForFunction(()=>window.calls.some(call=>call.command==='stop_capture'));
   assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.command==='start_capture_per_party').length),1);
   assert.equal(await page.getByRole('button',{name:'停止麦克风',exact:true}).count(),0);
   await page.close();
  });
  await t.test('time expiration also invalidates a microphone still starting',async()=>{
   const page=await create();await page.clock.install();
   await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();
   await page.evaluate(()=>window.micGate=true);await page.getByRole('button',{name:'麦克风作答',exact:true}).click();
   await page.waitForFunction(()=>typeof window.releaseMic==='function');await page.clock.runFor(20*60*1000);
   await page.waitForFunction(()=>!document.querySelector('.practice-toolbar .stop-btn'));
   await page.evaluate(()=>window.releaseMic());await page.waitForFunction(()=>window.calls.some(call=>call.command==='stop_capture'));
   await page.close();
  });
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
