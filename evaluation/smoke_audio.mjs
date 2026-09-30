/** Windows system audio → local ASR → semantic model → hint, using a local WAV. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const port=process.env.CDP_PORT||'9246';
const wav=process.argv[2]||fileURLToPath(new URL('./fixtures/cache-question-zh.wav',import.meta.url));
const output=process.argv[3]||resolve('interview-cue-audio-smoke.json');
const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try{
  const pages=browser.contexts().flatMap(c=>c.pages());
  const page=(await Promise.all(pages.map(async p=>({p,label:await p.evaluate(()=>
    window.__TAURI__?.window?.getCurrentWindow?.().label).catch(()=>null)}))))
    .find(item=>item.label==='launcher')?.p;
  if(!page)throw new Error('Launcher unavailable');
  const events=await page.evaluate(async()=>{
    window.__cueEvents=[];
    window.__cueStops=await Promise.all(['audio_level','transcript_update','transcript_final',
      'mvp_answer_token','mvp_answer_done'].map(name=>window.__TAURI__.event.listen(name,
      event=>window.__cueEvents.push({name,at:Date.now(),payload:event.payload}))));
    return true;
  });
  if(!events)throw new Error('Could not subscribe to events');
  await page.getByRole('button',{name:'视频测试'}).click();
  await page.getByRole('button',{name:'开始聆听'}).click();
  await page.getByRole('button',{name:'结束练习'}).waitFor({timeout:10000});
  await new Promise(resolve=>setTimeout(resolve,2500));
  const child=spawn(process.env.INTERVIEW_CUE_TEST_PYTHON||'python',
    [fileURLToPath(new URL('./play_wav_device.py',import.meta.url)),wav,
      '--device',process.env.INTERVIEW_CUE_TEST_OUTPUT_DEVICE||'0'],
    {windowsHide:true});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const exit=await new Promise(resolve=>child.on('exit',resolve));
  if(exit!==0)throw new Error(`Playback failed: ${stderr}`);
  const playbackEnd=Date.now();
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    const done=await page.evaluate(()=>window.__cueEvents.some(row=>row.name==='mvp_answer_done'));
    if(done)break;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  const captured=await page.evaluate(()=>window.__cueEvents);
  const ui=await page.locator('body').innerText();
  await page.screenshot({path:output.replace(/\.json$/,'-ui.png')});
  await page.getByRole('button',{name:'结束练习'}).click();
  const finals=captured.filter(row=>row.name==='transcript_final').map(row=>row.payload.segment);
  const tokens=captured.filter(row=>row.name==='mvp_answer_token');
  const report={wav,playbackEnd,finals,answer:tokens.map(row=>row.payload.token).join(''),
    firstHintFromPlaybackEndMs:tokens.length?tokens[0].at-playbackEnd:null,
    systemLevelPeak:Math.max(0,...captured.filter(row=>row.name==='audio_level'&&row.payload.source==='System')
      .map(row=>Number(row.payload.level||0))),
    uiText:ui.slice(-1300),eventCounts:{finals:finals.length,tokens:tokens.length}};
  await writeFile(output,JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify({output,finals,answer:report.answer,firstHintFromPlaybackEndMs:report.firstHintFromPlaybackEndMs,
    systemLevelPeak:report.systemLevelPeak,eventCounts:report.eventCounts}));
}finally{await browser.close();}
