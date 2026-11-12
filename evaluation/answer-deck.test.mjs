import {test} from 'node:test';import assert from 'node:assert/strict';
import {AnswerDeck} from '../src/answerDeck.ts';import {runtimeModels} from '../src/runtimeModels.ts';
const page=(id,text,complete=true,startedAt=Number(id))=>({id,kind:'voice',question:'问题'+id,text,complete,source:'api',terms:[],keyTerms:[],detail:'',startedAt,asrAt:null});
test('only complete pages are navigable; stored pages survive later streams, updates and out-of-order completions',()=>{
 const deck=new AnswerDeck();deck.observe(page('1','第一条'));deck.observe(page('3','尚未完整',false));deck.observe({...page('2','截图完成'),kind:'screen'});deck.observe(page('3','第三条完成'));assert.deepEqual(deck.pages.map(p=>p.id),['1','2','3']);
 assert.equal(deck.adjacent({...page('4','loading',false),source:'guide'},-1).id,'3');
 const reading={...deck.pages[0]};deck.observe(page('1','后台换成另一个完整版本'));assert.equal(reading.text,'第一条');assert.equal(deck.adjacent(reading,1).id,'2');assert.equal(deck.adjacent(page('4','新的增量',false),-1).id,'3');assert.equal(deck.adjacent(page('4','新的增量',false),1),null);
 for(let i=4;i<=110;i++)deck.observe(page(String(i),'answer'));assert.equal(deck.pages.length,100);assert.equal(reading.text,'第一条');
});
test('manual API choice changes future endpoint snapshots, preserves credentials and never mutates an active request',()=>{
 const main={api:'deepseek',baseUrl:'https://api.deepseek.com',model:'main'};const model={api:'openai',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.8-flash'};const s={answer:main,decision:main,sharedModelConnection:true,backup:{enabled:true,model}};
 const active=runtimeModels(s,false),switched=runtimeModels(s,true);assert.equal(active.answer.model,'main');assert.equal(switched.answer.model,'qwen3.8-flash');assert.match(switched.answer.credentialSlot,/^interview_cue_fallback@/);assert.equal(switched.decision.credentialSlot,switched.answer.credentialSlot);assert.match(switched.backup.credentialSlot,/^interview_cue_answer@/);assert.equal(active.answer.model,'main');assert.equal(s.answer.model,'main');assert.equal(runtimeModels({...s,backup:{...s.backup,enabled:false}},true).usingBackup,false);
});
