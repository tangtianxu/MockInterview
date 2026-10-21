import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mockIPC} from '@tauri-apps/api/mocks';
import {emptyQuestion,knowledgeForQuestion} from '../src/knowledge.ts';
globalThis.window={};
const endpoint={api:'deepseek',baseUrl:'https://api.deepseek.com',model:'fixture',historySessionId:'session'};
const a={...emptyQuestion('A'),id:'a',question:'项目A架构',answer:'A的回答',status:'confirmed'};
const b={...emptyQuestion('B'),id:'b',question:'项目B职责',answer:'B的回答',status:'confirmed'};
function fixture({relation='same',consent=true,stale=false,disabled=false,needsPersonalEvidence,empty=false}={}){
 const calls=[];mockIPC(async(command,args)=>{calls.push({command,args});
  if(command==='knowledge_lookup')return {enabled:!disabled,exact:null,questions:empty?[]:[a,b],passages:[],projects:['A','B'],ambiguous:false};
  if(command==='knowledge_prepare')return {token:'once',characters:200,destination:endpoint.baseUrl,model:'fixture'};
  if(command==='plugin:dialog|ask')return consent;
  if(command==='knowledge_run')return {matches:[{relation,duplicateId:'b',needsPersonalEvidence}],items:relation==='ambiguous'||relation==='new'?[]:[b]};
  if(command==='knowledge_snapshot')return {library:{enabled:true,sources:[]},questions:stale?[{...b,answer:'已编辑的新回答'}]:[a,b]};
 });return calls;
}
test('multiple candidate projects reach semantic match and the fresh selected answer wins',async()=>{
 const calls=fixture();const result=await knowledgeForQuestion('请讲B的个人职责',endpoint,()=>true,'刚才讨论项目B');
 assert.equal(result.exact.id,'b');assert.ok(calls.some(c=>c.command==='knowledge_run'));
 assert.equal(calls.find(c=>c.command==='knowledge_prepare').args.input.dialogueContext,'刚才讨论项目B');
 assert.equal(calls[0].args.historySessionId,'session');
});
test('semantic ambiguity is surfaced after the model, not before it',async()=>{
 const calls=fixture({relation:'ambiguous'});assert.deepEqual(await knowledgeForQuestion('介绍你的项目',endpoint,()=>true),{missingProject:true});assert.ok(calls.some(c=>c.command==='knowledge_run'));
});
test('related tasks only pass selected project evidence and require a separate content consent',async()=>{
 const calls=fixture({relation:'related'});const result=await knowledgeForQuestion('你在B独立完成哪些部分',endpoint,()=>true);
 assert.deepEqual(result.context.questions.map(q=>q.id),['b']);assert.equal(result.exact,undefined);assert.equal(result.context.consent,true);
 assert.equal(calls.filter(c=>c.command==='plugin:dialog|ask').length,2);
});
test('declining sends no model request and changed answers cannot be reused',async()=>{
 let calls=fixture({consent:false});await assert.rejects(knowledgeForQuestion('项目职责',endpoint,()=>true),/已取消/);assert.equal(calls.filter(c=>c.command==='knowledge_run').length,0);assert.ok(calls.some(c=>c.command==='knowledge_discard_plan'));
 fixture({stale:true});await assert.rejects(knowledgeForQuestion('项目职责',endpoint,()=>true),/已更新/);
});
test('disabled or cancelled retrieval never schedules an API call',async()=>{
 const calls=fixture({disabled:true});assert.deepEqual(await knowledgeForQuestion('问题',endpoint,()=>true),{});assert.equal(calls.length,1);
 fixture();assert.deepEqual(await knowledgeForQuestion('过期问题',endpoint,()=>false),{});
});
test('general technical questions containing personal pronouns continue without project evidence',async()=>{
 fixture({relation:'new',needsPersonalEvidence:false});assert.deepEqual(await knowledgeForQuestion('你怎么理解PPO',endpoint,()=>true),{});
 fixture({relation:'new',needsPersonalEvidence:false,empty:true});assert.deepEqual(await knowledgeForQuestion('项目里一般如何选择缓存策略',endpoint,()=>true),{});
});
test('personal facts require evidence and a missing semantic classification cannot silently bypass the guard',async()=>{
 fixture({relation:'new',needsPersonalEvidence:true});assert.deepEqual(await knowledgeForQuestion('采集和标定都由你独立完成吗',endpoint,()=>true),{missingEvidence:true});
 fixture({relation:'new'});await assert.rejects(knowledgeForQuestion('实际个人贡献',endpoint,()=>true),/未判断/);
});
