import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answerConversation} from '../src/answerContext.ts';
import {answerBackground,practiceBackground} from '../src/practiceSession.ts';
const t=(id,speaker,text,timestamp_ms)=>({id,speaker,text,timestamp_ms});

test('answer receives the candidate reply and latest ASR revision with provenance',()=>{
 const original=[t('a','Them','空档期间在做什么',1),t('b','User','我在备考',2)];
 const partial=t('b','User','我在备考，同时投递岗位',2);
 const snapshot=answerConversation(original,[partial],'live');
 assert.deepEqual(snapshot.map(v=>[v.id,v.channel,v.isFinal]),[['a','system',true],['b','microphone',false]]);
 assert.match(snapshot[1].text,/投递岗位/);partial.text='后来更新';original[0].text='后来更新';
 assert.match(snapshot[0].text,/空档/);assert.match(snapshot[1].text,/投递岗位/);
});
test('video and offline speech stay mixed, and large contexts preserve newest complete turns',()=>{
 for(const mode of ['video','offline'])assert.equal(answerConversation([t('a','Them','一段双方对话',1)],[],mode)[0].channel,'mixed');
 const turns=Array.from({length:30},(_,i)=>t('id'+i,i%2?'User':'Them','起点'+i+'背景'.repeat(1000)+'条件'+i,i));
 const snapshot=answerConversation(turns,[],'live');
 assert.ok(snapshot.length<=12);assert.ok(snapshot.reduce((n,t)=>n+t.text.length,0)<=3600);
 assert.equal(snapshot.at(-1).id,'id29');assert.match(snapshot.at(-1).text,/起点29/);assert.match(snapshot.at(-1).text,/条件29/);
 assert.deepEqual(answerConversation([],[],'live'),[]);
});
test('runtime uses original resume facts without erasing the saved analysis used by practice',()=>{
 const input={scope:'comprehensive',difficulty:'medium',role:'机器人算法',topics:'部署',domain:'ai',local:false,resume:{text:'原文指标与现场仍处于方案阶段'},analysis:{summary:'旧版分析的指标'}};
 const normal=practiceBackground(input),answer=answerBackground(input);
 assert.match(normal.resumeAnalysis,/旧版/);assert.equal(answer.resumeAnalysis,'');assert.equal(answer.resumeText,input.resume.text);
 assert.equal(answer.role,normal.role);assert.equal(answer.topics,normal.topics);assert.match(JSON.stringify(input.analysis),/旧版/);
});
