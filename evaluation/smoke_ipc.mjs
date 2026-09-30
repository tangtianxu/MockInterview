/** Exercise the built local Tauri app with synthetic, non-personal interview text. */
import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = process.env.CDP_PORT || '9246';
const output = process.argv[2] || resolve('interview-cue-ipc-smoke.json');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const pages = browser.contexts().flatMap(context => context.pages());
  const page = (await Promise.all(pages.map(async item => ({item,
    label:await item.evaluate(() => window.__TAURI__?.window?.getCurrentWindow?.().label).catch(() => ''),
  })))).find(row => row.label === 'launcher')?.item;
  if (!page) throw new Error('Launcher Tauri IPC page unavailable');
  const invoke = (command,args={}) => page.evaluate(({command,args}) =>
    window.__TAURI__.core.invoke(command,args),{command,args});
  const cases = JSON.parse(await readFile(new URL('./semantic-smoke.json',import.meta.url),'utf8'));
  const endpoint = {api:'ollama',baseUrl:'http://127.0.0.1:11434',model:'qwen3:4b-instruct'};
  const devices = JSON.parse(await invoke('list_audio_devices'));
  const engines = JSON.parse(await invoke('list_local_stt_engines'));
  const models = await invoke('mvp_list_models',{api:'ollama',baseUrl:'http://127.0.0.1:11434'});
  const decisions = [];
  for (const row of cases) {
    const started = Date.now();
    try {
      const result = await invoke('mvp_decide',{endpoint,input:{
        context:row.context||'',currentText:row.currentText,previousQuestion:row.previousQuestion||'',
        visibleQuestion:row.visibleQuestion||'',videoMode:false,
      }});
      decisions.push({id:row.id,expected:row.expectedAction,result,latencyMs:Date.now()-started});
    } catch(error) {
      decisions.push({id:row.id,expected:row.expectedAction,error:String(error),latencyMs:Date.now()-started});
    }
  }
  const answer = await page.evaluate(async endpoint => {
    const events=[];
    const requestId=`smoke-${Date.now()}`;
    const start=Date.now();
    const stops=await Promise.all(['mvp_answer_token','mvp_answer_done'].map(name =>
      window.__TAURI__.event.listen(name,event=>events.push({name,at:Date.now(),payload:event.payload}))));
    try {await window.__TAURI__.core.invoke('mvp_answer',{endpoint,requestId,
      question:'Redis 缓存穿透是什么？通常怎么处理？',focus:[],keyTerms:['Redis 缓存穿透'],constraints:[],uncertainTerms:[],answerInstructions:''});}
    finally {for (const stop of stops) stop();}
    return {requestId,firstTokenMs:events.find(row=>row.name==='mvp_answer_token')?.at-start??null,
      text:events.filter(row=>row.name==='mvp_answer_token').map(row=>row.payload.token).join(''),
      done:events.some(row=>row.name==='mvp_answer_done')};
  },endpoint);
  const report={devices:{inputs:devices.inputs?.length,outputs:devices.outputs?.length},
    asr:engines.flatMap(item=>item.models||[]).filter(item=>item.is_downloaded).map(item=>`${item.engine}:${item.id}`),
    models,decisions,answer};
  await writeFile(output,JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify({output,decisions:decisions.map(row=>({id:row.id,
    expected:row.expected,actual:row.result?.action||'invalid',error:row.error,latencyMs:row.latencyMs})),
    firstTokenMs:answer.firstTokenMs,answer:answer.text}));
} finally {await browser.close();}
