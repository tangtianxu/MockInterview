import {test} from "node:test";
import assert from "node:assert/strict";
import {practiceHistory,repeatedPracticeQuestion,PracticeRequestGate,practiceBackground} from "../src/practiceSession.ts";

test("background snapshots preserve domain and bounded project facts without leaking them into technical practice",()=>{
  const input={scope:"project",difficulty:"medium",role:"机器人算法",topics:"VLA",domain:"ai",local:true,
    personalization:"回复简短",resume:{text:"机械臂".repeat(5000)},analysis:{summary:"SO-101 微调"}};
  const background=practiceBackground(input);
  input.topics="通信";
  input.analysis.summary="后续修改";
  assert.equal(background.topics,"人工智能；VLA");
  assert.equal(background.resumeText.length,8000);
  assert.match(background.resumeAnalysis,/SO-101/);
  assert.equal(Object.hasOwn(background,"consentToSendResume"),false);
  const technical=practiceBackground({...input,scope:"technical",local:false});
  assert.equal(technical.resumeText,"");
  assert.equal(technical.resumeAnalysis,"");
  assert.equal(technical.preferences,"");
  assert.equal(technical.role,"机器人算法");
});

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
