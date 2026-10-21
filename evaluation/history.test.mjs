import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryRecorder} from '../src/history.ts';
test('history creates a session before entries, finalizes buffered streams and separates sessions',async()=>{
 const calls=[];const errors=[];const recorder=new HistoryRecorder(error=>errors.push(error),async(command,args)=>{calls.push({command,args});});
 const first=recorder.begin('live','第一场');recorder.record('answer','旧增量',{complete:false},'answer-1',true);recorder.record('answer','完整内容',{complete:true},'answer-1');
 const endpoint=await recorder.endpoint({model:'fixture'},'回答生成');assert.equal(endpoint.historySessionId,first);
 recorder.end();const second=recorder.begin('practice','第二场');recorder.record('question','PPO 是什么？');recorder.end();await recorder.flush();
 assert.deepEqual(calls.map(call=>call.command),['history_begin','history_record','history_end','history_begin','history_record','history_end']);
 assert.equal(calls[1].args.entry.text,'完整内容');assert.equal(calls[1].args.sessionId,first);assert.equal(calls[4].args.sessionId,second);assert.notEqual(first,second);assert.equal(errors.filter(Boolean).length,0);
});
test('history flush preserves unfinished output and reports disk errors',async()=>{
 const calls=[];const errors=[];const recorder=new HistoryRecorder(error=>errors.push(error),async(command,args)=>{if(command==='history_record')throw 'disk full';calls.push({command,args});});
 recorder.begin('manual','手动测试');recorder.record('answer','还没生成完',{complete:false},'answer-2',true);
 await assert.rejects(recorder.flush());assert.ok(errors.some(error=>error.includes('disk full')));recorder.end();await recorder.flush();assert.equal(calls.at(-1).command,'history_end');
});

test('native endpoints wait for the parent session commit, not just the JS recorder queue',async()=>{
 let commit;const committed=new Promise(resolve=>commit=resolve);const sessions=new Set();
 const recorder=new HistoryRecorder(()=>{},async(command,args)=>{if(command==='history_begin'){await committed;sessions.add(args.session.id);}});
 const id=recorder.begin('manual','新问题');let bound=false;
 const ready=recorder.endpoint({model:'fixture'},'本地召回').then(endpoint=>{bound=true;assert.ok(sessions.has(endpoint.historySessionId),'native audit parent must exist');return endpoint;});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(bound,false);commit();assert.equal((await ready).historySessionId,id);recorder.end();await recorder.flush();
});

test('failed session creation does not schedule orphan entries or native audits',async()=>{
 const calls=[];const errors=[];const recorder=new HistoryRecorder(error=>errors.push(error),async(command)=>{calls.push(command);if(command==='history_begin')throw Error('disk full');});
 recorder.begin('manual','无法保存的会话');recorder.record('question','问题');const endpoint=await recorder.endpoint({},'检索');assert.equal(endpoint.historySessionId,null);
 recorder.end();await recorder.flush();assert.deepEqual(calls,['history_begin']);assert.equal(errors.filter(Boolean).length,1);
});

test('ending or replacing an operation while initialization is pending cannot start a stale request',async()=>{
 let commit;const committed=new Promise(resolve=>commit=resolve);let active=true;
 const recorder=new HistoryRecorder(()=>{},async(command)=>{if(command==='history_begin')await committed;});
 recorder.begin('manual','旧操作');const ready=recorder.endpoint({},'检索',()=>active);active=false;commit();await assert.rejects(ready,/本轮操作已结束/);
 recorder.end();await recorder.flush();
});
