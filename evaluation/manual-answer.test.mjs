import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir,writeFile,unlink} from "node:fs/promises";
import {chromium} from "playwright-core";

test("idle question editing calls only the selected answer model without ASR or decision prerequisites",{timeout:45000},async()=>{
  const fixture="outputs/manual-answer-fixture.html";
  await mkdir("outputs",{recursive:true});
  await writeFile(fixture,"<!doctype html><html lang=\"zh\"><head><meta charset=\"UTF-8\"></head><body><div id=\"root\"></div><script type=\"module\">\nimport React from 'react';import {createRoot} from 'react-dom/client';\nimport {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';\nimport App from '/src/App.tsx';import '/src/index.css';\nmockWindows('launcher');localStorage.clear();\nconst local=new URLSearchParams(location.search).get('local')==='true';\nlocalStorage.setItem('interviewCue.settings',JSON.stringify({sharedModelConnection:false,\n decision:{api:'openai',baseUrl:'https://example.com/v1',model:''},\n answer:{api:local?'ollama':'openai',baseUrl:local?'http://127.0.0.1:11434':'https://example.com/v1',model:'answer-fixture',modelSelection:'manual'}}));\nwindow.calls=[];\nmockIPC(async(command,args)=>{\n window.calls.push({command,args});\n if(command==='load_interview_profile')return null;\n if(command==='plugin:app|version')return '1.0.5';\n if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';\n if(command==='mvp_list_models')return ['answer-fixture'];\n if(command==='local_stt_model_directory')return 'fixture';\n if(command==='ollama_runtime_status')return {executable:null,connected:false,configuredExecutable:null,modelsDirectory:null,configFile:'fixture'};\n if(command==='get_privacy_display_state')return {errors:[],launcher_capture_excluded:false,overlay_capture_excluded:false,taskbar_hidden:false};\n if(command==='has_api_key'||command==='get_saved_taskbar_preference'||command.includes('is_registered'))return false;\n if(command==='mvp_answer'){\n   await emit('mvp_answer_token',{requestId:args.requestId,token:'定义：手动输入的问题可直接回答。\\n'});\n   await new Promise(resolve=>setTimeout(resolve,20));\n   await emit('mvp_answer_token',{requestId:args.requestId,token:'原理：\\\\[A=\\\\frac{QK^\\\\top}{\\\\sqrt{d_k}}\\\\]'});\n   await emit('mvp_answer_done',{requestId:args.requestId});\n }\n return null;\n},{shouldMockEvents:true});\ncreateRoot(document.getElementById('root')).render(React.createElement(App));\n</script></body></html>");
  const server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","5193","--strictPort"],{windowsHide:true,stdio:"pipe"});
  let output="";server.stdout.on("data",data=>output+=data);server.stderr.on("data",data=>output+=data);
  let browser;
  try{
    const url="http://127.0.0.1:5193/"+fixture;
    for(let attempt=0;attempt<60;attempt++){
      if(server.exitCode!==null)throw new Error(output);
      try{if((await fetch(url)).ok)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    browser=await chromium.launch({headless:true,channel:"msedge"});
    const page=await browser.newPage({viewport:{width:1360,height:850}});
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    for(const local of [false,true]){
      await page.goto(url+"?local="+local);
      await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
      const edit=page.getByRole('button',{name:'编辑问题',exact:true});
      assert.equal(await edit.isEnabled(),true);
      await edit.click();
      const input=page.getByRole('textbox',{name:'修正模型理解的问题'});
      assert.equal(await page.getByRole('button',{name:'生成回答',exact:true}).isEnabled(),false);
      await input.fill('请写出注意力计算公式');
      await page.getByRole('button',{name:'生成回答',exact:true}).click();
      await page.locator('.answer-text .katex').waitFor();
      assert.equal(await page.getByRole('button',{name:'开始聆听',exact:true}).count(),1);
      await edit.click();await input.fill('解释一下缩放因子');await input.press('Control+Enter');
      await page.waitForFunction(()=>window.calls.filter(item=>item.command==='mvp_answer').length===2);
      await page.locator('.answer-text .katex').waitFor();
      const calls=await page.evaluate(()=>window.calls);
      assert.equal(calls.some(item=>item.command==='start_capture_per_party'||item.command==='mvp_decide'),false);
      const answers=calls.filter(item=>item.command==='mvp_answer');
      assert.equal(answers[0].args.question,'请写出注意力计算公式');
      assert.equal(answers[1].args.question,'解释一下缩放因子');
      assert.equal(answers[0].args.endpoint.model,'answer-fixture');
      assert.equal(answers[0].args.endpoint.api,local?'ollama':'openai');
      assert.equal(calls.some(item=>item.command==='start_local_service'),local);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});}
});
