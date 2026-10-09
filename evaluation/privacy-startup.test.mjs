import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,writeFile,unlink} from "node:fs/promises";
import {chromium} from "playwright-core";

test("startup hides taskbar only after a recovery shortcut is registered and reports failures",{timeout:45000},async()=>{
  const fixture="outputs/privacy-startup-fixture.html";
  await mkdir("outputs",{recursive:true});
  await writeFile(fixture,String.raw`<!doctype html><html lang="zh"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import App from '/src/App.tsx';import '/src/index.css';
mockWindows('launcher');localStorage.clear();window.calls=[];
const scenario=new URLSearchParams(location.search).get('scenario');
let attempts=0;
const state={errors:scenario==='capture-failure'?['捕获排除设置失败']:[],launcher_capture_excluded:scenario!=='capture-failure',overlay_capture_excluded:scenario!=='capture-failure',taskbar_hidden:false};
mockIPC(async(command,args)=>{
 window.calls.push({command,args});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return '1.0.6';
 if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';
 if(command==='mvp_list_models')return [];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {executable:null,connected:false,configuredExecutable:null,modelsDirectory:null,configFile:'fixture'};
 if(command==='get_privacy_display_state')return {...state};
 if(command==='set_taskbar_hidden'){
   if(args.enabled&&scenario==='style-failure')throw new Error('刷新窗口样式失败');
   state.taskbar_hidden=args.enabled;return {...state};
 }
 if(command==='plugin:global-shortcut|register'&&args.shortcuts?.some(value=>value.includes('Shift'))){
   attempts++;if(scenario==='shortcut-failure'||(scenario==='fallback'&&attempts===1))throw new Error('Hotkey already registered');
 }
 if(command==='has_api_key'||command==='get_saved_taskbar_preference'||command.includes('is_registered'))return false;
 return null;
},{shouldMockEvents:true});
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`);
  const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","5194","--strictPort"],{windowsHide:true,stdio:"pipe"});
  let output="";server.stdout.on("data",data=>output+=data);server.stderr.on("data",data=>output+=data);
  let browser;
  try{
    const url="http://127.0.0.1:5194/"+fixture;
    for(let attempt=0;attempt<60;attempt++){
      if(server.exitCode!==null)throw new Error(output);
      try{if((await fetch(url)).ok)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    browser=await chromium.launch({headless:true,channel:"msedge"});
    const page=await browser.newPage({viewport:{width:1360,height:850}});
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    for(const scenario of ['success','fallback','shortcut-failure','style-failure','capture-failure']){
      await page.goto(url+'?scenario='+scenario);
      await page.waitForFunction(()=>window.calls.some(item=>item.command==='set_taskbar_hidden'));
      assert.equal(await page.getByRole('button',{name:'开始练习',exact:true}).count(),1);
      await page.getByRole('button',{name:'设置',exact:true}).click();
      const preset=page.getByRole('button',{name:'两项都开启',exact:true});
      if(scenario==='success'||scenario==='fallback'){
        await page.waitForFunction(()=>document.querySelector('.privacy-presets button:last-child')?.getAttribute('aria-pressed')==='true');
        assert.equal(await preset.getAttribute('aria-pressed'),'true');
      }else{
        const message=scenario==='shortcut-failure'?'恢复快捷键注册失败':scenario==='style-failure'?'启动任务栏隐藏失败':'捕获排除设置失败';
        await page.getByRole('alert').filter({hasText:message}).waitFor();
        assert.equal(await preset.getAttribute('aria-pressed'),'false');
        if(scenario==='shortcut-failure')assert.equal(await preset.isEnabled(),false);
      }
      const calls=await page.evaluate(()=>window.calls);
      const hide=calls.findIndex(item=>item.command==='set_taskbar_hidden'&&item.args.enabled);
      const registrations=calls.filter(item=>item.command==='plugin:global-shortcut|register'&&item.args.shortcuts?.some(value=>value.includes('Shift')));
      assert.equal(registrations.length,scenario==='fallback'||scenario==='shortcut-failure'?2:1);
      if(scenario==='shortcut-failure')assert.equal(hide,-1);
      else assert.ok(hide>calls.findIndex(item=>item===registrations.at(-1)));
      assert.equal(calls.some(item=>item.command==='get_saved_taskbar_preference'),false);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
