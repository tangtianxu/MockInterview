import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('single-key screen solving stays separate from voice, supports correction, cancellation and remapping',{timeout:90000},async()=>{
 const fixture='outputs/screen-code-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';
 import App from '/src/App.tsx';import '/src/index.css';mockWindows('launcher');localStorage.clear();window.calls=[];window.shortcuts={};window.saved=[];window.gates=[];window.captureError=false;window.hold=false;
 window.fakeEvent=emit;window.overlay=null;const {listen}=await import('@tauri-apps/api/event');
 mockIPC(async(command,args)=>{window.calls.push({command,args});
  if(command==='load_interview_profile')return {settings:{answer:{api:'openai',baseUrl:'https://example.test/v1',model:'code-fixture'},sharedModelConnection:true},resumeAnalysis:null};
  if(command==='plugin:app|version')return '1.0.29';if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';
  if(command==='ollama_runtime_status')return {executable:null,connected:false};if(command==='mvp_list_models')return ['code-fixture'];if(command==='has_api_key')return true;
  if(command.includes('is_registered'))return false;
  if(command==='plugin:global-shortcut|register'){for(const key of args.shortcuts)window.shortcuts[key]=args.handler.onmessage;return;}
  if(command==='plugin:global-shortcut|unregister'){for(const key of args.shortcuts)delete window.shortcuts[key];return;}
  if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:false};
  if(command==='capture_code_screen'){if(window.captureError)throw '模拟OCR不可用';return {text:'浏览器菜单 广告 推荐题目\\n题目：给定数组，求两数之和。输入输出与约束完整。',width:1920,height:1080,preview:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII='};}
  if(command==='history_record'){window.saved.push(args.entry);return;}
  if(command==='mvp_answer'){
   if(window.hold)await new Promise(resolve=>window.gates.push({id:args.requestId,resolve}));
   await emit('mvp_answer_token',{requestId:args.requestId,token:'### 题意\\n'+(args.question.includes('修正题目')?'修正后的题目':'求数组中两数之和')+'\\n### 思路\\n用哈希表记录已访问的数字。\\n### 代码\\n'});
   await emit('mvp_answer_token',{requestId:args.requestId,token:'\u0060\u0060\u0060python\\ndef solve(nums, target): # 定义求解函数\\n    seen = {} # 保存数字及下标\\n    return seen # 示例返回\\n\u0060\u0060\u0060\\n### 复杂度与检查\\n时间 O(n)，空间 O(n)。'});
   await emit('mvp_answer_done',{requestId:args.requestId});return;
  }
  return null;
 },{shouldMockEvents:true});await listen('mvp_ui_state',e=>window.overlay=e.payload);createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5217','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);let browser;
 try{
  const url='http://127.0.0.1:5217/'+fixture;for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:1500,height:1000}});page.setDefaultTimeout(7000);page.setDefaultNavigationTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).waitFor();assert.equal(await page.evaluate(()=>!!window.shortcuts.F8),false);
  await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();await page.waitForFunction(()=>typeof window.shortcuts.F8==='function');
  await page.evaluate(()=>window.shortcuts.F8({state:'Pressed'}));await page.locator('.screen-code-panel pre code').waitFor();
  assert.match(await page.locator('.screen-code-panel').innerText(),/题意/);assert.match(await page.locator('.screen-code-panel pre code').innerText(),/    seen = \{\} # 保存/);
  const calls=await page.evaluate(()=>window.calls);const request=calls.find(x=>x.command==='mvp_answer');assert.equal(request.args.codeQuestion,true);assert.deepEqual(request.args.constraints,['Python 3']);assert.equal('preview' in request.args,false);assert.equal('knowledgeContext' in request.args,false);assert.equal(calls.some(x=>x.command==='mvp_decide'||x.command==='start_capture_per_party'),false);
  await page.waitForFunction(()=>window.overlay?.coding===true&&window.overlay.hint.includes('复杂度'));
  await page.evaluate(()=>window.fakeEvent('mvp_answer_token',{requestId:'voice-other',token:'不应覆盖代码题'}));assert.doesNotMatch(await page.locator('.screen-code-panel').innerText(),/不应覆盖/);
  await page.screenshot({path:'outputs/screen-code-ui.png'});
  await page.locator('.screen-source summary').click();await page.getByRole('textbox',{name:'截屏识别的题目文字'}).fill('修正题目：求两数之和，保留完整样例。');await page.getByRole('button',{name:'按当前文字重新解题'}).click();await page.waitForFunction(()=>document.querySelector('.code-answer')?.textContent.includes('修正后的题目'));
  await page.evaluate(()=>window.hold=true);await page.evaluate(()=>window.shortcuts.F8({state:'Pressed'}));await page.waitForFunction(()=>window.gates.length===1);const oldId=await page.evaluate(()=>window.gates[0].id);
  await page.getByRole('button',{name:'停止',exact:true}).click();await page.evaluate(()=>{window.hold=false;window.shortcuts.F8({state:'Pressed'});});await page.locator('.screen-code-panel pre code').waitFor();
  await page.evaluate(()=>window.gates[0].resolve());await page.waitForTimeout(100);assert.match(await page.locator('.screen-code-panel').innerText(),/两数之和/);
  assert.equal(await page.evaluate(id=>window.calls.some(c=>c.command==='mvp_cancel_answer'&&c.args.requestId===id),oldId),true);
  assert.equal(await page.evaluate(id=>window.saved.find(e=>e.id===id+'-answer')?.data.complete,oldId),false);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'界面与隐私'}).click();await page.getByRole('button',{name:'更改截屏键',exact:true}).click();await page.getByRole('textbox',{name:'截屏解题快捷键',exact:true}).press('F9');await page.getByRole('button',{name:'保存截屏键',exact:true}).click();await page.waitForFunction(()=>!!window.shortcuts.F9&&!window.shortcuts.F8);await page.getByRole('button',{name:'完成设置',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'更改截屏键',exact:true}).click();await page.getByRole('textbox',{name:'截屏解题快捷键',exact:true}).press('F10');await page.getByRole('button',{name:'完成设置',exact:true}).click();await page.waitForFunction(()=>!!window.shortcuts.F9);
  const count=await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_answer').length);await page.evaluate(()=>{window.captureError=true;window.shortcuts.F9({state:'Pressed'});});await page.getByRole('alert').filter({hasText:'模拟OCR不可用'}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='mvp_answer').length),count);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();server.kill();await unlink(fixture).catch(()=>{});}
});
