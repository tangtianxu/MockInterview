// Synthetic local endpoint only; no saved credentials or personal resume contents.
const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const http=require('node:http');const {chromium}=require('playwright-core');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 let requests=0;let deletions=0;let receivedText='';let browser;let app;let page;
 const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
  assert.ok(!request.headers.authorization);const input=JSON.parse(body);
  if(request.method==='DELETE'){assert.equal(request.url,'/api/delete');assert.equal(input.model,'SYNTHETIC_MODEL_ONLY');deletions++;response.writeHead(200);response.end();return;}
  requests++;receivedText=input.messages.at(-1).content;
  response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'SYNTHETIC_ANALYSIS',skills:[],projects:[],uncertainties:[],suggestedTopics:[]})}}],usage:{prompt_tokens:100,completion_tokens:20}}));
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  app=spawn('E:\\Apps\\面试即答\\interview-cue.exe',[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9338'}});
  for(let i=0;i<50&&!page;i++){
   if(app.exitCode!==null)throw Error('Installed app exited before audit startup');
   try{browser ||=await chromium.connectOverCDP('http://127.0.0.1:9338');for(const candidate of browser.contexts().flatMap(c=>c.pages()))if(await candidate.locator('.practice-workspace').count()){page=candidate;break;}}catch{}
   if(!page)await pause(300);
  }
  assert.ok(page);assert.equal(await page.locator('.app-version').innerText(),'v1.0.15');
  const invoke=(command,args)=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
  const endpoint={api:'openai',baseUrl:'http://127.0.0.1:'+server.address().port,model:'synthetic-analysis'};
  const input={action:'analyze',scope:'technical',difficulty:'medium',minutes:20,history:'',question:'',answer:'',preferences:'',resumeText:'SYNTHETIC_RESUME_ONLY',consentToSendResume:false};
  await assert.rejects(()=>invoke('practice_model',{endpoint,input}),/未确认发送简历/);assert.equal(requests,0,'no request before consent');
  const analysis=await invoke('practice_model',{endpoint,input:{...input,consentToSendResume:true}});assert.equal(analysis.summary,'SYNTHETIC_ANALYSIS');assert.equal(requests,1);assert.ok(receivedText.includes('SYNTHETIC_RESUME_ONLY'));
  await assert.rejects(()=>invoke('practice_model',{endpoint,input}),/未确认发送简历/);assert.equal(requests,1,'consent is not inherited');
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
