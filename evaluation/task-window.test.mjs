import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskWindow} from '../src/dialogueContext.ts';
import {sameQuestion} from '../src/decisionStability.ts';
import {DecisionScheduler,decisionEvidenceSource} from '../src/decisionScheduler.ts';
const t=(id,text,speaker='Them',timestamp_ms=0)=>({id,text,speaker,timestamp_ms});
test('current evidence uses submitted snapshot, not a newer ASR revision',()=>{
 const value=taskWindow([t('old','解释一个概念'),t('now','新版本', 'Them',2)],[t('now','更新的未提交版本')],[{sourceId:'now',text:'已提交的真实请求',isFinal:false}],'live');
 assert.equal(value[0].current,false);assert.equal(value[1].text,'已提交的真实请求');assert.equal(value[1].current,true);assert.equal(value[1].isFinal,false);
});
test('audio channels remain hints and microphone replies cannot become current by merging',()=>{
 const value=taskWindow([t('reply','我想问公司业务','User',2),t('ask','我们正在建设仿真平台','Them',3)],[],[{sourceId:'ask',text:'我们正在建设仿真平台',isFinal:true}],'live');
 assert.equal(value[0].channel,'microphone');assert.equal(value[0].current,false);assert.equal(value[1].channel,'system');
 assert.ok(taskWindow([t('a','麦克风对话')],[],[],'offline').every(t=>t.channel==='mixed'));
});
test('only near simultaneous exact cross-channel echoes are removed',()=>{
 const text='我们接下来讨论模型训练和验证的具体流程';
 const value=taskWindow([t('a',text,'Them',100),t('b',text,'User',200),t('c','我实际采用了另外一种训练方法','User',300),t('d',text,'User',9000)],[],[],'live');
 assert.deepEqual(value.map(t=>t.id),['a','c','d']);
});
test('punctuation revisions do not create another answer; different tasks still do',()=>{
 assert.ok(sameQuestion('PPO 是什么？','ppo是什么'));assert.equal(sameQuestion('PPO是什么','PPO什么时候使用'),false);assert.equal(sameQuestion('',''),false);
 assert.equal(sameQuestion('解释x+y','解释x-y'),false);
});
test('a later candidate fragment does not replace the task source or its final status',()=>{
 const scheduler=new DecisionScheduler();scheduler.enqueue({sourceId:'question',text:'如何验证部署',isFinal:true,receivedAt:10});scheduler.enqueue({sourceId:'reply',text:'首先我们考虑',isFinal:false,receivedAt:20});
 const batch=scheduler.take(1300,5);const source=decisionEvidenceSource(batch,['question']);assert.equal(source.sourceId,'question');assert.equal(source.isFinal,true);assert.equal(source.receivedAt,10);
});
