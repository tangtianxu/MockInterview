import assert from "node:assert/strict";
import {discoveredModel,providerDefaults} from "../src/modelProviders.ts";

assert.deepEqual(providerDefaults("deepseek"),{baseUrl:"https://api.deepseek.com",model:"deepseek-flash"});
assert.deepEqual(providerDefaults("openai"),{baseUrl:"",model:""});
assert.equal(discoveredModel("deepseek","qwen3:4b-instruct",["deepseek-v4-pro","deepseek-flash"]),"deepseek-flash");
assert.equal(discoveredModel("deepseek","deepseek-v4-pro",["deepseek-v4-pro","deepseek-flash"]),"deepseek-v4-pro");
assert.equal(discoveredModel("ollama","missing",["qwen3:4b-instruct","qwen3:4b"]),"qwen3:4b-instruct");
assert.equal(discoveredModel("openai","old-model",["a","b"]),"",
  "unknown custom API models must not be selected arbitrarily");
assert.equal(discoveredModel("openai","old-model",["one"]),"one");
console.log("Provider selection: 7 passed");
