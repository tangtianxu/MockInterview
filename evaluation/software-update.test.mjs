import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('updates retry safely, preserve pending profile edits, stay alive across tabs, and separate personal settings',{timeout:60000},async()=>{
 const fixture='outputs/software-update-fixture.html';await mkdir('outputs',{recursive:true});
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import App from '/src/App.tsx';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();
 window.calls=[];window.checkMode='latest';window.failDownload=false;window.downloadGate=false;
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='load_interview_profile')return {settings:{targetRole:'算法工程师',focusTopics:'机器人',domain:'ai',selfIntroduction:'保留的自我介绍',answerInstructions:'保留的身份背景要求'},resumeAnalysis:null};
 if(command==='plugin:app|version')return '1.0.10';
 if(command==='list_audio_devices')return JSON.stringify({inputs:[],outputs:[]});
 if(command==='list_local_stt_engines')return JSON.stringify([]);
 if(command==='mvp_list_models')return ['test'];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {executable:null,connected:false,configFile:'fixture'};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command==='has_api_key')return true;
 if(command.includes('is_registered'))return false;
 if(command==='check_for_update'){
  if(window.checkMode==='error')throw '更新源连接失败';
  return window.checkMode==='latest'?null:{version:'1.0.11',body:'新版：软件内更新与独立个人资料设置'};
 }
 if(command==='download_update'){
  await emit('update_download_progress',{downloaded:1048576,total:2097152});
  if(window.failDownload)throw '下载或签名校验失败';
  if(window.downloadGate)await new Promise(resolve=>window.releaseDownload=resolve);
  await emit('update_download_progress',{downloaded:2097152,total:2097152});return null;
 }
 if(command==='install_downloaded_update')throw '测试安装启动失败';
 if(command==='practice_model')return {question:'解释 PPO',topic:'强化学习',intent:'technical'};
 return null;},{shouldMockEvents:true});createRoot(document.getElementById('root')).render(React.createElement(App));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5198','--strictPort'],{windowsHide:true,stdio:'pipe'});
 let output='';server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>output+=data);let browser;
 try{
  const url='http://127.0.0.1:5198/'+fixture;
  for(let i=0;i<70;i++){if(server.exitCode!==null)throw new Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage({viewport:{width:760,height:600}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(url);await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('tab',{name:'个人资料'}).click();
  assert.equal(await page.getByRole('textbox',{name:'自我介绍稿',exact:true}).inputValue(),'保留的自我介绍');
  assert.equal(await page.getByRole('textbox',{name:'给回答模型的附加要求'}).inputValue(),'保留的身份背景要求');
  assert.equal(await page.locator('.settings-drawer').getByRole('textbox',{name:'目标岗位（可选）',exact:true}).inputValue(),'算法工程师');
  await page.getByRole('textbox',{name:'自我介绍稿',exact:true}).fill('新填写的个人稿');
  await page.getByRole('tab',{name:'模型与服务'}).click();
  assert.equal(await page.getByRole('textbox',{name:'自我介绍稿',exact:true}).count(),0);
  assert.equal(await page.getByRole('textbox',{name:'给回答模型的附加要求'}).count(),0);
  await page.getByRole('tab',{name:'软件更新'}).click();
  assert.match(await page.locator('.update-network-note').textContent(),/GitHub.*网络/);
  await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByText('已是最新版本。',{exact:true}).waitFor();
  await page.evaluate(()=>window.checkMode='error');await page.getByRole('button',{name:'检查更新',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'连接失败'}).waitFor();assert.equal(await page.getByText('已是最新版本。',{exact:true}).count(),0);
  await page.evaluate(()=>{window.checkMode='available';window.failDownload=true;});await page.getByRole('button',{name:'检查更新',exact:true}).click();
  await page.getByRole('button',{name:'下载并安装',exact:true}).click();await page.getByRole('alert').filter({hasText:'签名校验失败'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='install_downloaded_update').length),0);
  await page.evaluate(()=>{window.failDownload=false;window.downloadGate=true;});
  await page.getByRole('button',{name:'下载并安装',exact:true}).click();await page.getByRole('progressbar',{name:'更新下载进度'}).waitFor();
  assert.equal(await page.getByRole('progressbar',{name:'更新下载进度'}).getAttribute('value'),'50');
  await page.getByRole('tab',{name:'个人资料'}).click();assert.equal(await page.getByRole('textbox',{name:'自我介绍稿',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'完成设置',exact:true}).click();assert.equal(await page.getByRole('button',{name:'开始练习',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'软件更新'}).click();await page.getByRole('progressbar',{name:'更新下载进度'}).waitFor();
  await page.evaluate(()=>window.releaseDownload());await page.getByRole('alert').filter({hasText:'安装启动失败'}).waitFor();
  const calls=await page.evaluate(()=>window.calls);const installIndex=calls.findIndex(x=>x.command==='install_downloaded_update');
  assert.ok(installIndex>0);const saves=calls.slice(0,installIndex).filter(x=>x.command==='save_interview_profile');
  assert.equal(saves.at(-1).args.profile.settings.selfIntroduction,'新填写的个人稿');
  const downloads=calls.filter(x=>x.command==='download_update').length;
  await page.getByRole('button',{name:'安装已下载的更新',exact:true}).click();
  await page.waitForFunction(()=>window.calls.filter(x=>x.command==='install_downloaded_update').length===2);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.command==='download_update').length),downloads);
  await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.getByRole('button',{name:'下载并安装',exact:true}).waitFor();
  await page.getByRole('button',{name:'完成设置',exact:true}).click();await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.getByRole('button',{name:'结束练习',exact:true}).waitFor();
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'软件更新'}).click();
  assert.equal(await page.getByRole('button',{name:'下载并安装',exact:true}).isDisabled(),true);
  await page.screenshot({path:'outputs/software-update-compact.png'});assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
