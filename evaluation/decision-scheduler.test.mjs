import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DecisionScheduler,decisionIntervalSeconds} from '../src/decisionScheduler.ts';
const speech=(sourceId,text,receivedAt,isFinal=false)=>({sourceId,text,receivedAt,isFinal});

test('ASR increments coalesce; final updates also obey the configured interval',()=>{
 const scheduler=new DecisionScheduler();
 for(let i=0;i<30;i++)scheduler.enqueue(speech('a','PPO '+i,i*100));
 assert.equal(scheduler.take(2900,5),null);
 scheduler.enqueue(speech('a','PPO 是什么',3000,true));
 const first=scheduler.take(3250,5);assert.equal(first.text,'PPO 是什么');
 for(let i=0;i<20;i++)scheduler.enqueue(speech('b','工程背景 '+i,3400+i*100));
 scheduler.enqueue(speech('b','PPO 用于策略优化',5500,true));
 scheduler.enqueue(speech('c','它什么时候使用',5600,true));
 assert.equal(scheduler.take(8000,5),null);
 const second=scheduler.take(8250,5);
 assert.equal(second.text,'PPO 用于策略优化\n它什么时候使用');
 assert.deepEqual(second.sourceIds,['b','c']);assert.equal(second.sourceId,'c');
 assert.equal(scheduler.nextDelay(20000,5),null,'no periodic polling without new text');
 assert.equal(scheduler.enqueue(speech('c','它什么时候使用',21000,true)),false);
});

test('active speech defers partial decisions; a pause alone cannot cause a request',()=>{
 const scheduler=new DecisionScheduler();scheduler.audio(0.5,0);
 assert.equal(scheduler.nextDelay(1000,5),null);
 scheduler.enqueue(speech('a','怎么解决动作抖动',100));
 for(let now=200;now<=2400;now+=100)scheduler.audio(0.5,now);
 assert.equal(scheduler.take(2500,5),null,'continuous audio does not flush the partial text');
 scheduler.audio(0,2700);
 const pending=scheduler.take(3200,5);assert.equal(pending.text,'怎么解决动作抖动');assert.equal(pending.isFinal,false);
 scheduler.audio(0,4000);assert.equal(scheduler.nextDelay(9000,5),null);
});

test('text stability is a fallback without audio telemetry; finals can upgrade the same partial once',()=>{
 const scheduler=new DecisionScheduler();scheduler.enqueue(speech('a','PPO 是什么',0));
 assert.equal(scheduler.take(1199,5),null);assert.ok(scheduler.take(1200,5));
 assert.equal(scheduler.enqueue(speech('a','PPO 是什么',1300)),false);
 assert.equal(scheduler.enqueue(speech('a','PPO 是什么',1400,true)),true);
 assert.equal(scheduler.take(1650,5),null);assert.ok(scheduler.take(6200,5));
 assert.equal(scheduler.enqueue(speech('a','PPO 是什么',6500,true)),false);
 assert.equal(scheduler.enqueue(speech('a','late interim',6600)),false);
});

test('final-only, manual overrides and session resets cancel pending work',()=>{
 const scheduler=new DecisionScheduler();scheduler.enqueue(speech('a','未结束的发言',0));
 assert.equal(scheduler.nextDelay(5000,5,true),null);
 scheduler.enqueue(speech('a','稳定后的发言',6000,true));assert.ok(scheduler.take(6250,5,true));
 scheduler.enqueue(speech('b','手动改写的源片段',6300,true));scheduler.discard('b');
 assert.equal(scheduler.nextDelay(12000,5),null);
 scheduler.enqueue(speech('c','停止后不能调用',13000,true));scheduler.reset();
 assert.equal(scheduler.nextDelay(14000,5),null);
 scheduler.enqueue(speech('a','新会话同样的问题',15000,true));assert.ok(scheduler.take(15250,5));
});

test('interval validation supplies safe defaults for existing profiles',()=>{
 assert.equal(decisionIntervalSeconds(undefined),5);assert.equal(decisionIntervalSeconds('5'),5);
 assert.equal(decisionIntervalSeconds(NaN),5);assert.equal(decisionIntervalSeconds(Infinity),5);
 assert.equal(decisionIntervalSeconds(0),2);assert.equal(decisionIntervalSeconds(100),30);
});
