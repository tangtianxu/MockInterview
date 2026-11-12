import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-shell';
import {modelServices,serviceDefaults,serviceId,type ModelConfig,type ServiceId} from './modelProviders';
import {validateModelAddress} from './modelConnection';
export type BackupSettings={enabled:boolean;model:ModelConfig;wait:number;policyVersion?:number};
export function backupEndpoint(value:BackupSettings){return value.enabled&&value.model.baseUrl.trim()&&value.model.model.trim()?{...value.model,credentialSlot:`interview_cue_fallback@${value.model.baseUrl.trim().replace(/\/+$/,"")}`}:null;}
export function FallbackSettings({value,onChange,disabled}:{value:BackupSettings;onChange:(next:BackupSettings)=>void;disabled:boolean}){
 const [key,setKey]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState(false);
 const keyUrl=({deepseek:'https://platform.deepseek.com/api_keys',dashscope:'https://bailian.console.aliyun.com/',zhipu:'https://bigmodel.cn/',siliconflow:'https://cloud.siliconflow.cn/'} as Record<string,string>)[serviceId(value.model)];
 const patch=(p:Partial<BackupSettings>)=>{setMessage('');onChange({...value,...p});};
 const test=async()=>{setBusy(true);setMessage('正在检测备用服务…');try{
  validateModelAddress(value.model);const endpoint=backupEndpoint({...value,enabled:true})!;
  if(key.trim()){await invoke('store_api_key',{provider:endpoint.credentialSlot,key:key.trim()});setKey('');}
  await invoke('mvp_test_model_endpoint',{endpoint,structured:false});await invoke('mvp_test_model_endpoint',{endpoint,structured:true});setMessage('备用服务已通过聊天与问题识别检测。');
 }catch(e){setMessage('备用服务检测失败：'+String(e));}finally{setBusy(false);}};
 return <div className="setting-group"><div className="setting-heading">备用 API</div>
  <label className="check-row"><input type="checkbox" checked={value.enabled} disabled={disabled||busy} onChange={e=>patch({enabled:e.target.checked})}/><span>主服务异常时自动切换备用服务</span></label>
  <p className="setting-help">用于口述回答、截图解题和语义判别。明确报错立即切换；无正文超过下方时间，或正文停更超过 {Math.max(5,value.wait)} 秒时，自动切换一次；不会拼接两份代码。备用服务会收到完成当前任务所需的相同问题、对话、截图识别文字及已启用的相关个人资料，按该平台计费。</p>
  {value.enabled&&<>
   <label>备用服务<select aria-label="备用服务" disabled={disabled||busy} value={serviceId(value.model)} onChange={e=>{patch({model:serviceDefaults(e.target.value as ServiceId)});setKey('');}}>{modelServices.filter(s=>s.id!=='ollama').map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
   {keyUrl&&<div className="key-actions"><button disabled={disabled||busy} onClick={()=>void open(keyUrl).catch(e=>setMessage(String(e)))}>获取备用 API 密钥</button></div>}
   <label>备用密钥<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder="已保存时可留空；与主服务密钥独立" disabled={disabled||busy}/></label>
   <p className="setting-help">接口地址决定请求发给哪家平台及哪个地域；模型 ID 决定调用该平台的哪个模型，例如 qwen3.8-flash。同一个密钥可使用账户有权限的模型，更换模型通常只需修改模型 ID。</p>
   <label>备用接口地址<input aria-label="备用接口地址" value={value.model.baseUrl} disabled={disabled||busy} onChange={e=>patch({model:{...value.model,baseUrl:e.target.value}})}/></label>
   <label>备用模型 ID<input aria-label="备用模型 ID" value={value.model.model} disabled={disabled||busy} onChange={e=>patch({model:{...value.model,model:e.target.value,modelSelection:'manual'}})}/></label>
   <label>无正文等待时间<select value={value.wait} disabled={disabled||busy} onChange={e=>patch({wait:Number(e.target.value)})}>{[2,3,5,8,12,20,30,60].map(n=><option key={n} value={n}>{n} 秒{n===3?'（默认）':''}</option>)}</select></label>
   <button disabled={disabled||busy} onClick={()=>void test()}>{busy?'检测中…':'保存密钥并检测备用服务'}</button>
   <p className="setting-help">优先选择不同厂商，例如百炼 Qwen。百炼可使用控制台提供的业务空间专属地址；默认旧域名仍可用。模型 ID 以账户可用列表为准。备用服务仍可能发生故障，切换不保证回答质量相同。</p>
  </>}{message&&<p className="setting-help" role="status">{message}</p>}
 </div>;
}
