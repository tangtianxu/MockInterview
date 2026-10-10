import assert from "node:assert/strict";
import { questionTransition } from "../src/decisionStability.ts";

const base = {hasActiveQuestion:true,activeSourceId:"segment-1",sourceId:"segment-1",
  isFinal:false,alreadyRevisedSource:false,action:"show",relation:"new"};

assert.equal(questionTransition({...base,hasActiveQuestion:false}),"first");
assert.equal(questionTransition(base),null,"same-segment partial rewrite must stay hidden");
assert.equal(questionTransition({...base,action:"revise",relation:"follow_up"}),null,
  "partial follow-up is still provisional");
assert.equal(questionTransition({...base,action:"revise",relation:"follow_up",isFinal:true}),"revision");
assert.equal(questionTransition({...base,action:"revise",relation:"follow_up",isFinal:true,
  alreadyRevisedSource:true}),null,"one stable segment may revise only once");
assert.equal(questionTransition({...base,sourceId:"segment-2",action:"keep",relation:"repeat"}),null);
assert.equal(questionTransition({...base,sourceId:"segment-2",action:"revise",
  relation:"follow_up",isFinal:true}),"new");
assert.equal(questionTransition({...base,sourceId:"segment-2",action:"show",
  relation:"follow_up",isFinal:true}),"new","show/follow_up must reach the answer panel");
assert.equal(questionTransition({...base,sourceId:"segment-2",action:"revise",
  relation:"follow_up"}),"new","a new follow-up can be identified before ASR final");
assert.equal(questionTransition({...base,action:"show",relation:"follow_up",isFinal:true}),"revision");
assert.equal(questionTransition({...base,action:"show",relation:"new",isFinal:true}),"revision");
assert.equal(questionTransition({...base,sourceId:"segment-2",action:"show",relation:"repeat"}),null);
assert.equal(questionTransition({...base,sourceId:"segment-2",action:"revise",relation:"none"}),null);
assert.equal(questionTransition({...base,sourceId:"segment-2"}),"new",
  "a clearly new question may start from a new partial segment");

console.log("Question stability transitions: 14 passed");
