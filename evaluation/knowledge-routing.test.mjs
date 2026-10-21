import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mockIPC} from '@tauri-apps/api/mocks';
import {emptyQuestion,knowledgeForQuestion,answerEvidence} from '../src/knowledge.ts';
import {currentAction} from '../src/inAppActions.ts';
globalThis.window={};
const endpoint={api:'deepseek',baseUrl:'https://api.deepseek.com',model:'fixture',historySessionId:'session'};
const question=(id,project)=>({...emptyQuestion(project),id,question:`${project}职责`,answer:`${project}已核实的事实`,status:'confirmed'});
const a=question('a','项目A'),b=question('b','项目B');
const lookup={enabled:true,exact:null,questions:[a,b],passages:[],projects:['项目A','项目B'],ambiguous:true};
function fixture(value=lookup){const calls=[];mockIPC(async(command,args)=>{calls.push({command,args});assert.equal(command,'knowledge_lookup','Runtime retrieval must not invoke an API matcher');if(value instanceof Error)throw value;return value;});return calls;}

test('overview and differently phrased personal questions can use multiple projects without an API gate',async()=>{
 for(const text of ['介绍一下实习期间做过的项目','你在实习中主要承担什么工作','比较这两个项目的难点']){
  const calls=fixture();const result=await knowledgeForQuestion(text,endpoint,()=>true,'刚才讨论实习');
  assert.deepEqual(result.context.questions.map(q=>q.id),['a','b']);assert.equal(result.context.consent,true);
  assert.equal(result.exact,undefined);assert.equal(calls.length,1);assert.equal(calls[0].args.context,'刚才讨论实习');assert.equal(calls[0].args.historySessionId,'session');assert.equal(currentAction(),null);
 }
});
test('general technical and unmatched personal questions remain answerable with no evidence',async()=>{
 for(const text of ['π0.5的架构是什么','什么时候使用PPO','说说你的实习项目','你是如何处理一次冲突的']){
  fixture({...lookup,questions:[],projects:[]});const result=await knowledgeForQuestion(text,endpoint,()=>true);
  assert.equal(result.context,undefined);assert.equal(result.exact,undefined);assert.equal(result.missingProject,undefined);assert.equal(result.missingEvidence,undefined);
 }
});
test('literal confirmed answers retain the zero-network shortcut; stale answers are never reused',async()=>{
 fixture({...lookup,exact:b});assert.equal((await knowledgeForQuestion(b.question,endpoint,()=>true)).exact,b);
 fixture({...lookup,exact:{...b,status:'stale'},questions:[{...a,status:'draft'},{...b,status:'stale'}]});const result=await knowledgeForQuestion('问题',endpoint,()=>true);assert.equal(result.context,undefined);assert.equal(result.exact,undefined);
});
test('disabled and superseded retrieval cannot supply evidence',async()=>{
 fixture({...lookup,enabled:false});assert.deepEqual(await knowledgeForQuestion('问题',endpoint,()=>true),{});
 fixture();assert.deepEqual(await knowledgeForQuestion('过期问题',endpoint,()=>false),{});
 let release;mockIPC(()=>new Promise(resolve=>release=resolve));let current=true;const task=knowledgeForQuestion('旧问题',endpoint,()=>current);current=false;release(lookup);assert.deepEqual(await task,{});
});
test('unavailable local libraries fall back instead of rejecting the task',async()=>{
 for(const cause of [Error('文件损坏'),Error('FOREIGN KEY constraint failed')]){fixture(cause);const result=await knowledgeForQuestion('当前问题',endpoint,()=>true);assert.match(result.note,/继续生成回答/);assert.equal(result.context,undefined);}
});
test('a hung lookup has a bounded wait and a late result cannot restart an answer',async()=>{
 let release;mockIPC(()=>new Promise(resolve=>release=resolve));const result=await knowledgeForQuestion('当前问题',endpoint,()=>true);
 assert.match(result.note,/读取超时/);assert.equal(result.context,undefined);release(lookup);
});
test('evidence keeps leading relevance while reserving room for other projects',()=>{
 const qs=[...Array.from({length:8},(_,i)=>question('a'+i,'A')),question('b','B'),question('c','C')];
 const result=answerEvidence({...lookup,questions:qs});assert.deepEqual(result.questions.map(q=>q.id),['a0','a1','a2','b','c']);
});
test('oversized evidence is skipped without truncating verified answers or blocking generation',()=>{
 const huge={...a,answer:'x'.repeat(50001)};const result=answerEvidence({...lookup,questions:[huge,b]});assert.deepEqual(result.questions.map(q=>q.id),['b']);assert.equal(result.questions[0].answer,b.answer);
});
