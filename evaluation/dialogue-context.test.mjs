import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dialogueContext} from '../src/dialogueContext.ts';
const turn=(id,speaker,text,timestamp_ms)=>({id,speaker,text,timestamp_ms});
test('batched latest speech is excluded from historical context while candidate replies remain',()=>{
 const context=dialogueContext([turn('a','Them','PPO 是什么',1),turn('b','User','我使用 GAE',2),
   turn('c','Them','工程背景',3),turn('d','Them','怎么解决',4)],[],['c','d'],false);
 assert.equal(context,'面试官：PPO 是什么\n候选人：我使用 GAE');
});
test('dialogue retains both roles in time order and uses the newest partial revision',()=>{
 const context=dialogueContext([turn('a','Them','你采用什么方法？',1),turn('b','User','使用 GAE',2)],
 [turn('b','User','使用 GAE 估计优势',2),turn('c','Them','为什么选择它？',3)],'c',false);
 assert.equal(context,'面试官：你采用什么方法？\n候选人：使用 GAE 估计优势');
});
test('video context is identified as mixed audio and long contexts remain bounded',()=>{
 const video=dialogueContext([turn('a','Them','视频里的对话',1)],[],'b',true);
 assert.match(video,/视频音频（可能包含双方）/);
 const turns=Array.from({length:30},(_,i)=>turn(String(i),i%2?'User':'Them',`术语${i}`+'背景'.repeat(600),i));
 const text=dialogueContext(turns,[],'none',false);assert.ok(text.length<=2800);
 assert.ok(text.startsWith('候选人：')||text.startsWith('面试官：'));
 assert.match(text,/背景/);
});

test('long replies retain both the chosen method and the final engineering conditions',()=>{
 const reply='我采用 GAE。'+'中间工程背景'.repeat(300)+'最后观察到动作抖动。';
 const text=dialogueContext([turn('a','User',reply,1)],[],'b',false);
 assert.match(text,/我采用 GAE/);assert.match(text,/动作抖动/);
});
