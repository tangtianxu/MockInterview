import {test} from 'node:test';import assert from 'node:assert/strict';
import {timelineAt,eventSeconds,clock} from '../src/historyTimeline.ts';
import {AnswerRace} from '../src/answerRace.ts';
import {recognitionAttachment} from '../src/taskContext.ts';
test('playback aligns transcript, recognized question and actual visibility without inventing timestamps',()=>{
 const start=Date.parse('2026-11-12T00:00:00Z');const row=(id,kind,t,text,data={})=>({id,kind,at:new Date(start+t*1000).toISOString(),text,data});
 const rows=[row('t','transcript',9,'为什么这样写',{timestampMs:start+6000}),row('q','question',10,'为什么用哈希表'),row('v','visibility',12,'为什么用哈希表',{requestId:'task'}),row('task-0','answer',20,'保存的完整回答',{question:'为什么用哈希表'})];
 assert.equal(eventSeconds(rows[0],start),6);assert.equal(timelineAt(rows,start,5).transcript,null);assert.equal(timelineAt(rows,start,7).transcript.text,'为什么这样写');assert.equal(timelineAt(rows,start,10).answer,null);assert.equal(timelineAt(rows,start,13).answer.text,'保存的完整回答');assert.equal(clock(3605),'1:00:05');
});
test('a fallback replaces an incomplete stream instead of appending two code answers',()=>{
 const race=new AnswerRace([{id:'same',source:'api'}]);race.token('same','旧代码：```python\ndef old():\n',1);race.reset('same');race.token('same','```python\ndef solve(x):\n    return x\n```',10);race.finish('same');assert.equal(race.snapshot.text,'```python\ndef solve(x):\n    return x\n```');assert.equal(race.snapshot.complete,true);
});
test('screen attachment is bounded for recognition; full source is unchanged for answering',()=>{
 const value={id:'screen',kind:'screen_code',text:'x'.repeat(24000),answer:'y'.repeat(30000),language:'Python 3',complete:true};const copy=recognitionAttachment(value);assert.ok(copy.text.length<12100);assert.ok(copy.answer.length<8100);assert.equal(value.text.length,24000);assert.equal(copy.kind,'screen_code');assert.equal(recognitionAttachment(null),null);
});

test('a pinned display retains its exact text even after the model finishes a different version',()=>{
 const start=Date.parse('2026-11-12T00:00:00Z');const entries=[{id:'a',kind:'answer',at:new Date(start+3000).toISOString(),text:'后来生成的完整答案',data:{question:'题目'}},{id:'fixed',kind:'visibility',at:new Date(start+1000).toISOString(),text:'题目',data:{requestId:'a',presentationOnly:true,displayText:'用户锁定时的半截内容'}}];assert.equal(timelineAt(entries,start,4).answer.text,'用户锁定时的半截内容');
});
