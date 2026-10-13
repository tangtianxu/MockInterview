import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {save} from '@tauri-apps/plugin-dialog';

type Props={busy:boolean;work:(label:string,action:()=>Promise<void>)=>Promise<void>;notice:(text:string)=>void};
export function AgentMaterialInstructions({busy,work,notice}:Props){
 const [prompt,setPrompt]=useState('');
 const copy=()=>void work('复制整理说明',async()=>{
  const text=await invoke<string>('knowledge_agent_prompt',{kind:'materials'});
  try{await navigator.clipboard.writeText(text);notice('已复制资料整理说明。把原资料位置、新输出位置和说明交给能读写本机文件的Agent；完成后导入“资料”目录。');}
  catch{setPrompt(text);notice('无法直接复制，请复制下方说明，或保存说明文件。');}
 });
 return <div className="preparation-actions">
  <button disabled={busy} onClick={copy}>复制Agent整理说明</button>
  <small>只整理资料，不生成问答。Agent需能读取并写入本机文件；扫描件还需OCR或转换能力。</small>
  {prompt&&<div className="knowledge-agent-prompt"><label>给Agent的资料整理说明<textarea readOnly value={prompt} rows={8}/></label><div className="key-actions">
   <button disabled={busy} onClick={()=>void work('保存整理说明',async()=>{const path=await save({defaultPath:'资料整理说明.txt',filters:[{name:'说明文件',extensions:['txt']}]});if(path){await invoke('knowledge_export_agent_prompt',{path,kind:'materials'});notice(`已保存说明：${path}`);}})}>保存整理说明</button>
   <button disabled={busy} onClick={()=>setPrompt('')}>收起整理说明</button>
  </div></div>}
 </div>;
}
