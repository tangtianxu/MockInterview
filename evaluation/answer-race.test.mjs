import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnswerRace,rememberQuestion} from '../src/answerRace.ts';

const create=()=>new AnswerRace([{id:'local',source:'local'},{id:'api',source:'api'}]);
test('first readable branch stays visible until API completes successfully',()=>{
  const race=create();
  race.token('local','定义：这是先出现的本地解释。',40);
  race.token('api','定义：这是较强模型的解释。',80);
  assert.equal(race.snapshot.source,'local');
  race.finish('local',undefined,100);
  assert.equal(race.pendingApi,true);
  race.finish('api',undefined,180);
  assert.equal(race.snapshot.source,'api');
  assert.equal(race.snapshot.completeMs,180);
  assert.equal(race.finished,true);
});
test('API first stays selected even when local completes later',()=>{
  const race=create();
  race.token('api','定义：这是先出现的 API 解释。',20);
  race.token('local','定义：这是较晚的本地解释。',50);
  race.finish('api',undefined,80);race.finish('local',undefined,120);
  assert.equal(race.snapshot.source,'api');
  assert.equal(race.snapshot.completeMs,80);
});
test('failed or empty API never replaces a successful local result',()=>{
  for(const error of [undefined,'网络连接中断']){
    const race=create();race.token('local','定义：这是完整的本地解释。',20);
    race.finish('local',undefined,40);race.finish('api',error,60);
    assert.equal(race.snapshot.source,'local');assert.equal(race.failure,'');
  }
});
test('failed first stream is replaced by a successful fallback, double failure retains received text',()=>{
  const race=create();race.token('api','定义：这是不完整的 API 解释。',10);
  race.finish('api','输出上限',20);
  race.token('local','定义：这是可用的本地解释。',30);race.finish('local',undefined,40);
  assert.equal(race.snapshot.source,'local');assert.equal(race.failure,'');
  const failed=create();failed.token('api','未完整生成的内容',10);
  failed.finish('api','连接断开');failed.finish('local','模型不存在');
  assert.equal(failed.snapshot.text,'未完整生成的内容');assert.match(failed.failure,/连接断开/);
});
test('streams are isolated, closed or unknown streams cannot change the answer',()=>{
  const race=create();race.token('api','定义：已经完整生成的内容。',10);race.finish('api');
  assert.equal(race.token('api','迟到的数据',20),false);
  assert.equal(race.token('old-request','上一问题的数据',20),false);
  assert.equal(race.finish('api','迟到的错误'),false);
  assert.equal(race.snapshot.text,'定义：已经完整生成的内容。');
});
test('follow-up context is bounded and excludes the current question',()=>{
  let state=rememberQuestion([],'PPO 是什么');
  state=rememberQuestion(state.history,'什么情况下使用');
  assert.deepEqual(state.previous,['PPO 是什么']);
  state=rememberQuestion(state.history,'什么情况下使用');
  assert.deepEqual(state.previous,['PPO 是什么']);
  assert.equal(rememberQuestion(['1','2','3','4','5'],'新问题').history.length,4);
});

test('an API finishing during the local preview replaces it only after both settle',()=>{
 const race=create();race.token('local','定义：先显示的本地解释。',10);
 race.token('api','定义：API 完整的最终解释。',20);race.finish('api',undefined,30);
 assert.equal(race.snapshot.source,'local');race.finish('local',undefined,40);
 assert.equal(race.snapshot.source,'api');assert.equal(race.snapshot.completeMs,30);
});
