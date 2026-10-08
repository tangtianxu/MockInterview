export type ModelApi = "ollama" | "deepseek" | "openai";
export type ModelConfig = {api:ModelApi;baseUrl:string;model:string;modelSelection?:"auto"|"manual"};
export type ServiceId = "ollama" | "deepseek" | "dashscope" | "siliconflow" | "custom";

// Presets specify the destination explicitly. A key is never used to infer a service.
export const modelServices: {id:ServiceId;name:string;api:ModelApi;baseUrl:string;model:string;help:string}[] = [
  {id:"ollama",name:"本地 Ollama",api:"ollama",baseUrl:"http://127.0.0.1:11434",model:"qwen3:4b-instruct",help:"使用本机已下载的模型，不需要 API 密钥。"},
  {id:"deepseek",name:"DeepSeek 官方",api:"deepseek",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",help:"已预填官方地址和快速模型，填入密钥后即可检测。"},
  {id:"dashscope",name:"阿里云百炼 · 北京",api:"openai",baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",model:"qwen-plus",help:"使用北京地域的百炼密钥；其他地域或工作空间地址请选自定义服务。"},
  {id:"siliconflow",name:"硅基流动 · 国内",api:"openai",baseUrl:"https://api.siliconflow.cn/v1",model:"Qwen/Qwen2.5-7B-Instruct",help:"已预填国内接口；模型是否可用以账户权限及检测结果为准。"},
  {id:"custom",name:"自定义兼容服务",api:"openai",baseUrl:"",model:"",help:"先填写服务商提供的接口地址。支持聊天接口 /chat/completions，不能仅凭密钥判断地址。"},
];

export function serviceId(config:ModelConfig):ServiceId {
  const url=config.baseUrl.trim().replace(/\/+$/,"");
  if(config.api==="ollama")return "ollama";
  if(config.api==="deepseek")return "deepseek";
  return modelServices.find(item=>item.id!=="custom" && item.api===config.api && item.baseUrl===url)?.id || "custom";
}

export function serviceDefaults(id:ServiceId):ModelConfig {
  const item=modelServices.find(item=>item.id===id)!;
  return {api:item.api,baseUrl:item.baseUrl,model:item.model,modelSelection:"auto"};
}

export function connectionModel(config:ModelConfig,names:string[]):string {
  // Saved and manually entered IDs remain valid even if /models is partial or absent.
  if(config.modelSelection!=="auto" && config.model.trim())return config.model;
  if(names.includes(config.model))return config.model;
  if(config.api==="ollama" || config.api==="deepseek")return discoveredModel(config.api,config.model,names) || config.model;
  // Other lists can contain embeddings, speech or reasoning models. Never pick the first.
  return config.model || (names.length===1 ? names[0] : "");
}

export function sharedConnectionDefault(old:{sharedModelConnection?:unknown;decision?:unknown;answer?:unknown;api?:unknown}):boolean {
  if(typeof old.sharedModelConnection==="boolean")return old.sharedModelConnection;
  // Existing per-stage keys may differ even if their addresses/models are identical.
  return !old.decision && !old.answer && !old.api;
}

export function patchModelConnection<T extends {sharedModelConnection:boolean;decision:ModelConfig;answer:ModelConfig}>(
  settings:T,stage:"decision"|"answer",patch:Partial<ModelConfig>):T {
  const next={...settings[stage],...patch};
  return settings.sharedModelConnection ? {...settings,decision:next,answer:next} : {...settings,[stage]:next};
}

export function providerDefaults(api: ModelApi): {baseUrl:string;model:string} {
  if (api === "ollama") return {baseUrl:"http://127.0.0.1:11434",model:"qwen3:4b-instruct"};
  if (api === "deepseek") return {baseUrl:"https://api.deepseek.com",model:"deepseek-flash"};
  return {baseUrl:"",model:""};
}

export function discoveredModel(api: ModelApi, current: string, names: string[]): string {
  if (names.includes(current)) return current;
  if (api === "deepseek") return names.includes("deepseek-flash") ? "deepseek-flash" : names[0] || "";
  if (api === "ollama") return names.includes("qwen3:4b-instruct") ? "qwen3:4b-instruct" : names[0] || "";
  return names.length === 1 ? names[0] : "";
}
