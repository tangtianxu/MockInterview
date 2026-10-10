import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryRecorder} from '../src/history.ts';
test('history creates a session before entries, finalizes buffered streams and separates sessions',async()=>{
 const calls=[];const errors=[];const recorder=new HistoryRecorder(error=>errors.push(error),async(command,args)=>{calls.push({command,args});});
 const first=recorder.begin('live','第一场');recorder.record('answer','旧增量',{complete:false},'answer-1',true);recorder.record('answer','完整内容',{complete:true},'answer-1');
 const endpoint=recorder.endpoint({model:'fixture'},'回答生成');assert.equal(endpoint.historySessionId,first);
 recorder.end();const second=recorder.begin('practice','第二场');recorder.record('question','PPO 是什么？');recorder.end();await recorder.flush();
 assert.deepEqual(calls.map(call=>call.command),['history_begin','history_record','history_end','history_begin','history_record','history_end']);
 assert.equal(calls[1].args.entry.text,'完整内容');assert.equal(calls[1].args.sessionId,first);assert.equal(calls[4].args.sessionId,second);assert.notEqual(first,second);assert.equal(errors.length,0);
});
test('history flush preserves unfinished output and reports disk errors',async()=>{
 const calls=[];const errors=[];const recorder=new HistoryRecorder(error=>errors.push(error),async(command,args)=>{if(command==='history_record')throw 'disk full';calls.push({command,args});});
 recorder.begin('manual','手动测试');recorder.record('answer','还没生成完',{complete:false},'answer-2',true);
 await assert.rejects(recorder.flush());assert.ok(errors[0].includes('disk full'));recorder.end();await recorder.flush();assert.equal(calls.at(-1).command,'history_end');
});
