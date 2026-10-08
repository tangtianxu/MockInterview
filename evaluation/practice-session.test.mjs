import {test} from "node:test";
import assert from "node:assert/strict";
import {practiceHistory,repeatedPracticeQuestion,PracticeRequestGate} from "../src/practiceSession.ts";

test("all questions survive long answers and a session longer than six turns",()=>{
  const turns=Array.from({length:12},(_,index)=>({question:`第 ${index+1} 个考点？`,answer:"很长的作答".repeat(500)}));
  const input=practiceHistory(turns);
  assert.equal(input.askedQuestions.length,12);
  assert.equal(input.askedQuestions[11],"第 12 个考点？");
  assert.match(input.history,/第 12 个考点/);
  assert.equal(input.history.includes("第 1 个考点"),false);
  assert.ok(input.history.length<1000);
});
test("an exact repeat is blocked without treating a different Redis task as a repeat",()=>{
  assert.equal(repeatedPracticeQuestion("解释 Redis?",["解释 redis？"]),true);
  assert.equal(repeatedPracticeQuestion("解释 Redis 淘汰策略",["解释 Redis"]),false);
});
test("double submission and stale replies cannot take over a new request",()=>{
  const gate=new PracticeRequestGate();
  const first=gate.begin();
  assert.notEqual(first,null);
  assert.equal(gate.begin(),null);
  gate.reset();
  const next=gate.begin();
  assert.equal(gate.current(first),false);
  assert.equal(gate.finish(first),false);
  assert.equal(gate.busy,true);
  assert.equal(gate.current(next),true);
  assert.equal(gate.finish(next),true);
  assert.equal(gate.busy,false);
});
