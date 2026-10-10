// Synthetic local endpoint only; no saved credentials or personal resume contents.
const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const http=require('node:http');const {chromium}=require('playwright-core');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 let requests=0;let deletions=0;let receivedText='';let responseMode='valid';let phase=0;let browser;let app;let page;
 const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
  assert.ok(!request.headers.authorization);const input=JSON.parse(body);
  if(request.method==='DELETE'){assert.equal(request.url,'/api/delete');assert.equal(input.model,'SYNTHETIC_MODEL_ONLY');deletions++;response.writeHead(200);response.end();return;}
  requests++;receivedText=input.messages.at(-1).content;
  const valid=JSON.stringify({summary:'SYNTHETIC_ANALYSIS',skills:[],projects:[],uncertainties:[],suggestedTopics:[]});
  const malformed='{summary: "SYNTHETIC_ANALYSIS", skills: [], projects: [], uncertainties: [], suggestedTopics: []}';
  const content=responseMode==='repair'?(phase++===0?malformed:valid):responseMode==='broken'?malformed:responseMode==='bad-schema'?JSON.stringify({summary:'SYNTHETIC_ANALYSIS',skills:[],projects:[{invented:'story'}],uncertainties:[],suggestedTopics:[]}):valid;
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:responseMode==='truncated'?'length':'stop',message:{content}}],usage:{prompt_tokens:100,completion_tokens:20}}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  app=spawn('E:\\Apps\\面试即答\\interview-cue.exe',[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9338'}});
  for(let i=0;i<50&&!page;i++){
   if(app.exitCode!==null)throw Error('Installed app exited before audit startup');
   try{browser ||=await chromium.connectOverCDP('http://127.0.0.1:9338');for(const candidate of browser.contexts().flatMap(c=>c.pages()))if(await candidate.locator('.practice-workspace').count()){page=candidate;break;}}catch{}
   if(!page)await pause(300);
  }
  assert.ok(page);assert.equal(await page.locator('.app-version').innerText(),'v1.0.16');
  const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const endpoint={api:'openai',baseUrl:'http://127.0.0.1:'+server.address().port,model:'synthetic-analysis'};
  const input={action:'analyze',scope:'technical',difficulty:'medium',minutes:20,history:'',question:'',answer:'',preferences:'',resumeText:'SYNTHETIC_RESUME_ONLY',consentToSendResume:false};
  await assert.rejects(()=>invoke('practice_model',{endpoint,input}),/未确认发送简历/);assert.equal(requests,0,'no request before consent');
  const analysis=await invoke('practice_model',{endpoint,input:{...input,consentToSendResume:true}});assert.equal(analysis.summary,'SYNTHETIC_ANALYSIS');assert.equal(requests,1);assert.ok(receivedText.includes('SYNTHETIC_RESUME_ONLY'));
  await assert.rejects(()=>invoke('practice_model',{endpoint,input}),/未确认发送简历/);assert.equal(requests,1,'consent is not inherited');
  responseMode='repair';phase=0;const repaired=await invoke('practice_model',{endpoint,input:{...input,consentToSendResume:true}});assert.equal(repaired.summary,'SYNTHETIC_ANALYSIS');assert.equal(requests,3,'malformed JSON gets one format repair');
  responseMode='broken';await assert.rejects(()=>invoke('practice_model',{endpoint,input:{...input,consentToSendResume:true}}),/结构化输出仍不合法/);assert.equal(requests,5,'repair must stop after one extra request');
  responseMode='truncated';await assert.rejects(()=>invoke('practice_model',{endpoint,input:{...input,consentToSendResume:true}}),/长度上限/);assert.equal(requests,6,'truncated output must not be repaired by inventing a tail');
  responseMode='bad-schema';await assert.rejects(()=>invoke('practice_model',{endpoint,input:{...input,consentToSendResume:true}}),/projects.*非字符串/);assert.equal(requests,7);
  await assert.rejects(()=>invoke('practice_model',{endpoint,input}),/未确认发送简历/);assert.equal(requests,7);
  assert.equal(await invoke('check_audio_devices',{mic:'default',output:'default'}),true);
  await assert.rejects(()=>invoke('check_audio_devices',{mic:'SYNTHETIC_MISSING_INPUT',output:'default'}),/Input device.*not found/);
  await assert.rejects(()=>invoke('check_audio_devices',{mic:'default',output:'SYNTHETIC_MISSING_OUTPUT'}),/Output device.*not found/);
  const engines=JSON.parse(await invoke('list_local_stt_engines'));
  const speech=engines.find(engine=>engine.engine==='sherpa_bilingual');
  const downloaded=speech?.models.find(model=>model.is_downloaded);
  assert.ok(downloaded,'a downloaded streaming model is required for this local capture audit');
  await invoke('set_recording_enabled',{enabled:false});await invoke('set_stt_language',{language:'zh-CN'});
  const you={role:'You',device_id:'default',is_input_device:true,stt_provider:'disabled',local_model_id:null};
  const them={role:'Them',device_id:'default',is_input_device:true,stt_provider:'sherpa_bilingual',local_model_id:downloaded.definition.model_id};
  const previousRequests=requests;
  try{await invoke('start_capture_per_party',{youConfig:JSON.stringify(you),themConfig:JSON.stringify(them)});}finally{await invoke('stop_capture');}
  assert.equal(requests,previousRequests,'microphone startup uses the downloaded local speech runtime and no model API');
  console.log('Default microphone question capture opened and stopped with a downloaded local streaming model, no duplicate recognizer, no recording file or cloud request.');
  const privacy=await invoke('get_privacy_display_state');assert.equal(privacy.capture_mode,'exclude');assert.ok(privacy.windows_build>=19041);
  console.log('Installed format repair, repair limit, output truncation, resume schema, audio role checks and Windows build detection passed.');
  const malformed=await invoke('download_local_stt_model',{engine:'audit-invalid',modelId:'audit-invalid'}).then(()=>false,()=>true);assert.equal(malformed,true,'download startup errors reach IPC callers');
  await assert.rejects(()=>invoke('delete_ollama_model',{baseUrl:'https://example.org',model:'SYNTHETIC_MODEL_ONLY'}),/只能删除本机/);assert.equal(deletions,0);
  await invoke('delete_ollama_model',{baseUrl:'http://127.0.0.1:'+server.address().port,model:'SYNTHETIC_MODEL_ONLY'});assert.equal(deletions,1);
  console.log('Native Ollama deletion uses DELETE /api/delete with the selected model and rejects remote endpoints; synthetic loopback server only, no actual model removed.');
  console.log('Installed API resume analysis accepted explicit consent and rejected both unconsented calls before HTTP. No Ollama or real API used; only synthetic resume text sent to loopback.');
 }finally{
  if(page)await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'launcher'})).catch(()=>{});
  if(app){for(let i=0;i<50&&app.exitCode===null;i++)await pause(100);assert.equal(app.exitCode,0);}
  await browser?.close().catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
})().catch(error=>{console.error(String(error));process.exitCode=1;});
