import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,writeFile,unlink,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {AnswerRace} from '../src/answerRace.ts';
import {readablePreview} from '../src/answerDisplay.ts';

const baselineFile=name=>execFileSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'show',`v1.0.36:src/${name}`],{encoding:'utf8'});
test('generation guidance, output budgets and normal request arguments remain intact',async()=>{
 const oldFile=path=>execFileSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'show',`v1.0.36:${path}`],{encoding:'utf8'}).replaceAll('\r\n','\n');
 const path='src-tauri/src/commands/mvp_commands.rs',before=oldFile(path),after=(await readFile(path,'utf8')).replaceAll('\r\n','\n');
 const answer=source=>source.slice(source.indexOf('pub async fn mvp_answer('),source.indexOf('pub async fn mvp_explain('));
 for(const marker of ['let token_limit = 6144','temperature\":0.2','CODE_ANSWER_SYSTEM','technical-answer.txt'])assert.ok(answer(after).includes(marker)&&answer(before).includes(marker),marker);
 for(const file of ['src/decisionScheduler.ts','src/knowledge.ts','src-tauri/src/commands/model_contract.rs','src-tauri/src/commands/speech_interpretation.rs','src-tauri/resources/technical-answer.txt','src-tauri/resources/answer-evidence.txt'])assert.equal((await readFile(file,'utf8')).replaceAll('\r\n','\n'),oldFile(file),file);
});
test('cached outputs retain every character; first clause arrives before a long first sentence completes',async()=>{
 const replay=JSON.parse(await readFile(new URL('./fixtures/ppo-display-replay.json',import.meta.url),'utf8'));
 const corpus=[replay.answer,'定义：PPO通过限制策略更新幅度，减少每轮优化时策略偏移过大的风险，通常结合优势估计构建目标函数。',String.raw`注意力的计算公式为：\[\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^T}{\sqrt{d_k}}\right)V\]。`,
 '```python\nclass Solution:\n    def twoSum(self, nums, target):\n        seen = {}\n        for i, value in enumerate(nums):\n            if target - value in seen:\n                return [seen[target - value], i]\n            seen[value] = i\n```\n时间复杂度为 O(n)，空间复杂度为 O(n)。',
 '实际工作：我负责算法实现与仿真验证，现场应用仍在方案设计阶段。\n验证材料保留了实验条件、对照结果和代码入口。'];
 // The display improvement was introduced in 1.0.36; preserve its comparison
 // against 1.0.35 while generation arguments above compare against 1.0.36.
 const oldSource=execFileSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,'show','v1.0.35:src/answerDisplay.ts'],{encoding:'utf8'});
 await mkdir('outputs',{recursive:true});const oldPath='outputs/latency-old-display.ts';await writeFile(oldPath,oldSource);
 try{
  const {readablePreview:old}=await import(pathToFileURL(process.cwd()+'/'+oldPath).href+'?v='+Date.now());
  const first=[];
  for(const text of corpus){for(const step of [1,7,31,text.length]){
   const race=new AnswerRace([{id:'same',source:'api'}]);let oldAt=null,newAt=null;
   for(let i=0;i<text.length;i+=step){const end=Math.min(text.length,i+step);race.token('same',text.slice(i,end),end);if(oldAt===null&&old(text.slice(0,end)))oldAt=end;if(newAt===null&&race.snapshot)newAt=end;}
   race.finish('same',undefined,1000);assert.equal(race.snapshot.text,text.trim());assert.equal(race.snapshot.complete,true);
   if(oldAt!==null&&newAt!==null)assert.ok(newAt<=oldAt,'preview must not be delayed');
   if(step===1)first.push({characters:text.length,oldFirstAt:oldAt,newFirstAt:newAt});
  }}
  assert.ok(first[1].newFirstAt<first[1].oldFirstAt);
  assert.equal(readablePreview(String.raw`公式：\(f(x,y), z\)`),'');
  assert.equal(readablePreview('代码片段：`function(a, b)`'),'');
  await writeFile('outputs/latency-stream-parity.json',JSON.stringify({corpus:corpus.length,chunkSizes:4,finalTextIdentical:true,first},null,2));
 }finally{await unlink(oldPath).catch(()=>{});}
});

test('real UI keeps baseline answer arguments and waits for evidence while transport prepares in parallel',{timeout:100000},async()=>{
 await mkdir('outputs',{recursive:true});
 const baseline='outputs/latency-baseline-App.tsx',fixture='outputs/latency-parity-fixture.html';
 await writeFile(baseline,baselineFile('App.tsx').replace(/(from\s+["'])\.\//g,'$1/src/').replace(/(import\s+["'])\.\//g,'$1/src/'));
 await writeFile(fixture,`<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">
 import React from 'react';import {createRoot} from 'react-dom/client';import {mockIPC,mockWindows} from '@tauri-apps/api/mocks';import {emit} from '@tauri-apps/api/event';import Current from '/src/App.tsx';import Baseline from '/outputs/latency-baseline-App.tsx';import {emptyQuestion} from '/src/knowledge.ts';import '/src/index.css';
 mockWindows('launcher');localStorage.clear();localStorage.setItem('interviewCue.settings',JSON.stringify({sharedModelConnection:false,targetRole:'机器人算法工程师',focusTopics:'训练、部署与评估',domain:'ai',answerInstructions:'保留项目阶段与原指标。',answer:{api:'openai',baseUrl:'https://example.com/v1',model:'same-model'}}));
 window.calls=[];window.requests=[];window.gates={};window.lookup='context';window.hold=false;window.send=(name,payload)=>emit(name,payload);
 mockIPC(async(command,args)=>{window.calls.push({command,args});
 if(command==='load_interview_profile')return null;
 if(command==='plugin:app|version')return 'test';
 if(command==='list_audio_devices'||command==='list_local_stt_engines')return '[]';
 if(command==='has_api_key')return true;
 if(command==='mvp_list_models')return ['same-model'];
 if(command==='local_stt_model_directory')return 'fixture';
 if(command==='ollama_runtime_status')return {connected:false};
 if(command==='get_privacy_display_state'||command==='set_taskbar_hidden')return {errors:[],launcher_capture_excluded:true,overlay_capture_excluded:true,taskbar_hidden:true};
 if(command.includes('is_registered'))return false;
 if(command==='mvp_prepare_model_transport'){if(window.hold)await new Promise(resolve=>window.gates.transport=resolve);return;}
 if(command==='knowledge_lookup'){
  if(window.hold)await new Promise(resolve=>window.gates.evidence=resolve);
  const q={...emptyQuestion('项目A'),id:'q1',question:args.query,answer:'本人负责算法实现，已完成仿真验证，现场处于方案阶段。',status:'confirmed',references:[{sourceId:'s1',hash:'h1',quote:'本人负责算法实现，已完成仿真验证，现场处于方案阶段。'}]};
  return {enabled:true,exact:window.lookup==='exact'?q:null,questions:[q],passages:[{sourceId:'s1',hash:'h1',project:'项目A',path:'report.md',locator:'第1节',text:q.answer}],projects:['项目A']};
 }
 if(command==='mvp_answer'){window.requests.push(args);return new Promise(()=>{});}
 return null;},{shouldMockEvents:true});
 createRoot(document.getElementById('root')).render(React.createElement(new URLSearchParams(location.search).has('baseline')?Baseline:Current));
 </script></body></html>`);
 const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--configLoader','runner','--host','127.0.0.1','--port','5205','--strictPort'],{windowsHide:true,stdio:'pipe'});let output='';server.stdout.on('data',s=>output+=s);server.stderr.on('data',s=>output+=s);let browser;
 try{
  const url='http://127.0.0.1:5205/'+fixture;
  for(let n=0;n<100;n++){if(server.exitCode!==null)throw Error(output);try{if((await fetch(url)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const payloads=[];
  for(const old of [true,false]){
   const page=await browser.newPage({viewport:{width:1360,height:850}});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(String(e)));
   await page.goto(url+(old?'?baseline=1':''),{waitUntil:'domcontentloaded',timeout:30000});await page.getByRole('button',{name:'双击切换练习与实时提示页面'}).dblclick();
   const submit=async text=>{await page.locator('.question-box').click();await page.getByRole('textbox',{name:'修正模型理解的问题'}).fill(text);await page.getByRole('textbox',{name:'修正模型理解的问题'}).press('Enter');};
   for(const [i,text]of ['PPO的目标函数是什么？','介绍一下项目中的个人工作。','这部分怎么验证？'].entries()){
    await submit(text);await page.waitForFunction(n=>window.requests.length===n,i+1);
    const id=await page.evaluate(()=>window.requests.at(-1).requestId);
    await page.evaluate(async id=>{await window.send('mvp_answer_token',{requestId:id,token:'定义：完整回答保留项目阶段、条件与结果。'});await window.send('mvp_answer_done',{requestId:id});},id);
   }
   payloads.push(await page.evaluate(()=>window.requests.map(({requestId,endpoint,taskAttachment,backupEndpoint,fallbackWaitSeconds,...args})=>({...args,endpoint:{...endpoint,historySessionId:'SESSION'}}))));
   if(!old){
    await page.evaluate(()=>window.hold=true);await submit('等待资料完整的测试问题。');await page.waitForFunction(()=>window.gates.transport&&window.gates.evidence);
    assert.equal(await page.evaluate(()=>window.requests.length),3);
    await page.evaluate(()=>window.gates.transport());assert.equal(await page.evaluate(()=>window.requests.length),3);
    await page.evaluate(()=>window.gates.evidence());await page.waitForFunction(()=>window.requests.length===4);
    assert.ok((await page.evaluate(()=>window.requests[3].knowledgeContext.passages[0].text)).includes('现场处于方案阶段'));
    await page.evaluate(()=>{window.lookup='exact';window.gates={};});await submit('精确命中不等待连接准备。');await page.waitForFunction(()=>window.gates.transport&&window.gates.evidence);await page.evaluate(()=>window.gates.evidence());await page.locator('.answer-text').filter({hasText:'本人负责算法实现'}).waitFor();assert.equal(await page.evaluate(()=>window.requests.length),4);await page.evaluate(()=>window.gates.transport());
    await page.evaluate(()=>{window.lookup='context';window.gates={};});await submit('等待中的旧问题。');await page.waitForFunction(()=>window.gates.transport&&window.gates.evidence);await page.evaluate(()=>{window.oldGates=window.gates;window.gates={};});await submit('替换后的新问题。');await page.waitForFunction(()=>window.gates.transport&&window.gates.evidence);
    await page.evaluate(()=>{window.oldGates.evidence();window.oldGates.transport();});assert.equal(await page.evaluate(()=>window.requests.length),4);
    await page.evaluate(()=>{window.gates.evidence();window.gates.transport();});await page.waitForFunction(()=>window.requests.length===5);assert.equal(await page.evaluate(()=>window.requests.at(-1).question),'替换后的新问题。');
   }
   assert.deepEqual(errors,[]);await page.close();
  }
  assert.deepEqual(payloads[1],payloads[0],'all generation arguments except request/session IDs must match 1.0.36');
  await writeFile('outputs/latency-request-parity.json',JSON.stringify({cases:payloads[0].length,allArgumentsIdentical:true,evidenceBarrierPassed:true,staleRequestGuardPassed:true},null,2));
 }finally{await browser?.close();server.kill();await unlink(fixture).catch(()=>{});await unlink(baseline).catch(()=>{});}
});
