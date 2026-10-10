// Run only against an installed audit build. All records and HTTP replies are synthetic.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {readFileSync,unlinkSync}=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright-core');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function boot(){
 const app=spawn('E:\\Apps\\面试即答\\interview-cue.exe',[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9338'}});
 let browser,page;
 for(let i=0;i<50&&!page;i++){
  if(app.exitCode!==null)throw Error('Audit app exited before startup');
  try{browser ||= await chromium.connectOverCDP('http://127.0.0.1:9338');for(const candidate of browser.contexts().flatMap(c=>c.pages()))if(await candidate.locator('.practice-workspace').count()){page=candidate;break;}}catch{}
  if(!page)await pause(300);
 }
 assert.ok(page,'installed practice page loaded');
 assert.equal(await page.locator('.app-version').innerText(),'v1.0.14');
 return {app,browser,page};
}
async function call(page,command,args){return page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});}
async function close(state){
 await call(state.page,'plugin:window|close',{label:'launcher'}).catch(error=>{if(!/closed|Target|Execution context/.test(String(error)))throw error;});
 for(let i=0;i<50&&state.app.exitCode===null;i++)await pause(100);
 assert.equal(state.app.exitCode,0,'native close flushes and exits');await state.browser.close().catch(()=>{});
}
(async()=>{
 const id=randomUUID();const at=new Date().toISOString();const title='AUDIT_HISTORY_'+id;
 const file=path.resolve('outputs/native-history-synthetic.json');let state;let created=false;
 const server=http.createServer((request,response)=>{
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
   const input=JSON.parse(body);assert.ok(!request.headers.authorization,'fixture must not use saved credentials');
   const usage={prompt_tokens:123,completion_tokens:17,prompt_cache_hit_tokens:100};
   if(input.stream){response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta:{content:'SYNTHETIC_REFERENCE'},finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n');}
   else {response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({intent:'question',relation:'new',action:'show',question:'测试问题',focus:[],key_terms:[],constraints:[],uncertain_terms:[]})}}],usage}));}
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  state=await boot();
  await call(state.page,'history_begin',{session:{id,mode:'manual',startedAt:at,endedAt:null,title}});created=true;
  await call(state.page,'history_record',{sessionId:id,entry:{id:'transcript-1',kind:'transcript',at,text:'SYNTHETIC_QUESTION',data:{speaker:'Them'}}});
  const endpoint={api:'openai',model:'audit-fixture',baseUrl:'http://127.0.0.1:'+server.address().port,historySessionId:id};
  await call(state.page,'mvp_decide',{endpoint:{...endpoint,usageStage:'语义判别'},input:{context:'',currentText:'测试问题',previousQuestion:'',visibleQuestion:'',videoMode:false,isFinal:true}});
  await call(state.page,'mvp_answer',{endpoint:{...endpoint,usageStage:'回答生成'},requestId:'audit-'+id,question:'测试问题',focus:[],constraints:[],uncertainTerms:[]});
  await call(state.page,'history_end',{id,at:new Date().toISOString()});
  const saved=await call(state.page,'history_read',{id});
  const usage=saved.entries.filter(item=>item.kind==='usage');assert.equal(usage.length,2);assert.equal(usage[0].data.usage.prompt_cache_hit_tokens,100);assert.equal(usage[1].data.usage.completion_tokens,17);
  const listed=await call(state.page,'history_list',{query:title,date:new Date().toLocaleDateString('en-CA')});assert.ok(listed.some(item=>item.id===id),'local-date search finds synthetic session');
  await call(state.page,'history_export',{id,path:file});assert.equal(JSON.parse(readFileSync(file,'utf8')).entries.length,3);
  await close(state);state=null;await pause(700);state=await boot();
  assert.equal((await call(state.page,'history_read',{id})).entries[0].text,'SYNTHETIC_QUESTION','history survives native process restart');
  await call(state.page,'history_delete',{id});created=false;
  await assert.rejects(()=>call(state.page,'history_read',{id}));
  console.log('Installed history persists across process restart; local-date search, export, delete and nonstream/stream usage with cache fields verified. No real API or private content used.');
 }finally{
  if(state){if(created)await call(state.page,'history_delete',{id}).catch(()=>{});await close(state);}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));try{unlinkSync(file);}catch{}
 }
})().catch(error=>{console.error(String(error));process.exitCode=1;});
