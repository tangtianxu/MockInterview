import assert from "node:assert/strict";
import {test} from "node:test";
import {connectModel,validateModelAddress} from "../src/modelConnection.ts";
import {serviceDefaults,serviceId,sharedConnectionDefault,patchModelConnection} from "../src/modelProviders.ts";

test("a missing model list does not prevent a real chat probe",async()=>{
  const config=serviceDefaults("deepseek");
  let probed;
  const result=await connectModel(config,{list:async()=>{throw new Error("404");},test:async next=>{probed=next;}});
  assert.equal(probed.model,"deepseek-flash");
  assert.equal(result.names,null);
  assert.match(String(result.listError),/404/);
});
test("manual model IDs survive incomplete service lists",async()=>{
  const config={api:"openai",baseUrl:"https://example.com/v1",model:"private-model",modelSelection:"manual"};
  const result=await connectModel(config,{list:async()=>["embedding-only"],test:async next=>assert.equal(next.model,"private-model")});
  assert.equal(result.config.model,"private-model");
});
test("unknown multiple models require selection before any chat request",async()=>{
  let requests=0;
  await assert.rejects(connectModel({...serviceDefaults("custom"),baseUrl:"https://example.com/v1"},
    {list:async()=>["embedding","chat"],test:async()=>{requests++;}}),/选择一个聊天模型/);
  assert.equal(requests,0);
});
test("a returned model list does not mask chat failure",async()=>{
  await assert.rejects(connectModel(serviceDefaults("deepseek"),{
    list:async()=>["deepseek-flash"],test:async()=>{throw new Error("401 invalid key");}
  }),/401/);
});
test("new shared connections and legacy separate connections preserve their scope",()=>{
  assert.equal(sharedConnectionDefault({}),true);
  assert.equal(sharedConnectionDefault({decision:serviceDefaults("deepseek"),answer:serviceDefaults("deepseek")}),false);
  const before={sharedModelConnection:false,decision:serviceDefaults("ollama"),answer:serviceDefaults("deepseek")};
  assert.deepEqual(patchModelConnection(before,"answer",{model:"manual"}).decision,before.decision);
  const shared=patchModelConnection({...before,sharedModelConnection:true},"answer",{model:"manual"});
  assert.deepEqual(shared.decision,shared.answer);
  assert.equal(before.answer.model,"deepseek-flash");
});
test("preset identification does not accept lookalike endpoints",()=>{
  assert.equal(serviceId(serviceDefaults("siliconflow")),"siliconflow");
  assert.equal(serviceId({...serviceDefaults("siliconflow"),baseUrl:"https://api.siliconflow.cn.evil.example/v1"}),"custom");
  assert.throws(()=>validateModelAddress({...serviceDefaults("custom"),baseUrl:"http://example.com/v1"}),/HTTPS/);
  assert.throws(()=>validateModelAddress({...serviceDefaults("custom"),baseUrl:"https://user:pass@example.com/v1"}),/账户/);
  validateModelAddress({...serviceDefaults("custom"),baseUrl:"http://127.0.0.1:8080/v1"});
});
