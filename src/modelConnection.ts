import {connectionModel,type ModelConfig} from "./modelProviders.ts";

export function validateModelAddress(config:ModelConfig):void {
  let url:URL;
  try {url=new URL(config.baseUrl);} catch {throw new Error("请在高级设置中填写有效的接口地址。");}
  const local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
  if(url.username || url.password || url.search || url.hash)throw new Error("接口地址不能包含账户、查询参数或片段。");
  if(!(url.protocol==="https:" || (local && url.protocol==="http:")))throw new Error("远程服务须使用 HTTPS，本机服务可使用 HTTP。");
  if(config.api==="ollama" && !local)throw new Error("本地 Ollama 需要使用本机地址。");
}

export async function connectModel(config:ModelConfig,operations:{
  list:(config:ModelConfig)=>Promise<string[]>;
  test:(config:ModelConfig)=>Promise<void>;
}):Promise<{config:ModelConfig;names:string[]|null;listError:unknown}> {
  validateModelAddress(config);
  let names:string[]|null=null;
  let listError:unknown=null;
  try {names=await operations.list(config);}catch(cause){listError=cause;}
  const selected={...config,model:connectionModel(config,names || [])};
  if(!selected.model.trim())throw new Error(names?.length
    ? "发现了多个模型，请在高级设置中选择一个聊天模型，再检测连接。"
    : "服务未提供可选模型，请在高级设置中填写模型 ID，再检测连接。");
  // A /models response alone is not a successful chat connection.
  await operations.test(selected);
  return {config:selected,names,listError};
}
