import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {open,save} from './inAppActions';
import type {KnowledgeSnapshot,ProjectProposal} from './knowledge';
import {PreparationRoadmap} from './PreparationRoadmap';
import {AgentMaterialInstructions} from './AgentMaterialInstructions';
import './knowledge-intake.css';

type Props={snapshot:KnowledgeSnapshot;busy:boolean;mode:'auto'|'organized';onMode:(mode:'auto'|'organized')=>void;
 selectedSources:string[];project:string;classify:()=>void;apply:(assignments:ProjectProposal[])=>Promise<void>;
 work:(label:string,action:()=>Promise<void>)=>Promise<void>;notice:(text:string)=>void;importQuestions:(folder?:boolean)=>void;
 importFolder:(mode?:'auto'|'organized')=>void;importProject:(name:string)=>Promise<boolean>;importFiles:()=>void;build:()=>void;buildLabel:string;pendingCount:number;review:()=>void;generationName:string};
export function KnowledgeIntake({snapshot,busy,mode,onMode,selectedSources,project,classify,apply,work,notice,importQuestions,importFolder,importProject,importFiles,build,buildLabel,pendingCount,review,generationName}:Props){
 const [prompt,setPrompt]=useState('');const [kind,setKind]=useState<'materials'|'bank'>('materials');
 const [proposals,setProposals]=useState<ProjectProposal[]>([]);const [manualProject,setManualProject]=useState('');const [projectName,setProjectName]=useState('');
 useEffect(()=>setProposals(snapshot.library.projectProposals||[]),[snapshot.library.projectProposals]);
 const showPrompt=(choice:'materials'|'bank')=>void work('准备Agent说明',async()=>{setKind(choice);setPrompt(await invoke<string>('knowledge_agent_prompt',{kind:choice}));});
 const copyText=async(text:string)=>{try{await navigator.clipboard.writeText(text);notice(kind==='bank'?'已复制问答准备说明。把说明与导出的工作包交给Agent。':'已复制。把整理说明和原资料、新输出位置交给电脑上的Agent。完成后导入它输出的“资料”目录。');}catch{setPrompt(text);notice('无法直接复制，请复制下方说明，或保存说明文件。');}};
 const savePrompt=()=>void work('保存说明',async()=>{const path=await save({defaultPath:kind==='materials'?'资料整理说明.txt':'问答准备说明.txt',filters:[{name:'说明文件',extensions:['txt']}]});if(path){await invoke('knowledge_export_agent_prompt',{path,kind});notice(`已保存说明：${path}`);}});
 const exportKit=()=>void work('准备Agent工作包',async()=>{const path=await open({directory:true,multiple:false});if(typeof path!=='string')return;const output=await invoke<string>('knowledge_export_agent_kit',{path,sourceIds:selectedSources,project});notice(`工作包已保存：${output}。把整个文件夹交给Agent，完成后点击“导入Agent结果文件夹”。本操作没有发送资料。`);});
 const ready=snapshot.library.sources.filter(s=>s.status==='ready');const unknown=ready.filter(s=>s.project==='待确认资料').length;
 const failed=snapshot.library.sources.length-ready.length;
 const projects=[...new Set(ready.map(s=>s.project))];
 return <div className="knowledge-intake">
  <PreparationRoadmap generationName={generationName}
   projectAction={<div className="preparation-actions"><label>项目名（可选）<input value={projectName} disabled={busy} onChange={e=>setProjectName(e.target.value)} placeholder="默认使用所选文件夹名" maxLength={100}/></label><button className="selected" disabled={busy} onClick={()=>void importProject(projectName).then(ok=>{if(ok)setProjectName('');})}>导入项目文件夹</button><small>每次选择一个项目。代码子目录也归入这个项目；简历可作为“共享资料”导入。</small></div>}
   agentAction={<><AgentMaterialInstructions busy={busy} work={work} notice={notice}/><div className="preparation-actions"><button className="selected" disabled={busy} onClick={()=>importFolder('organized')}>导入Agent整理目录</button><small>选择包含各项目子目录的“资料”目录。解释与导读保存在资料目录之外，导入前核对Agent的“处理说明”。</small></div></>}
   checks={<>
    {!!snapshot.library.sources.length&&<div className="preparation-imported"><p>已读取 {ready.length} 份{failed?` · ${failed} 份需要处理（展开下方文件列表）`:''}</p><details><summary>已导入的项目（{projects.length}）</summary><ul>{projects.map(p=><li key={p}>{p} · {ready.filter(s=>s.project===p).length} 份</li>)}</ul></details></div>}
    {(unknown>0||proposals.length>0)&&<section className="knowledge-route"><h4>还有资料需要确认项目</h4><p>{unknown} 份资料尚未确定项目，可识别后检查归属。</p><button disabled={busy} onClick={classify}>{proposals.length?'识别剩余资料':'识别项目'}</button>
     {!!proposals.length&&<details className="knowledge-organization" open><summary>检查项目名 · {proposals.length} 份</summary><small>跨项目内容用“共享资料”；无法确定的保留“待确认资料”。</small><datalist id="knowledge-project-names">{[...new Set([...projects,'共享资料','待确认资料'])].map(p=><option key={p} value={p}/>)}</datalist>{proposals.map((p,index)=><div className="knowledge-organization-row" key={p.sourceId}><span>{snapshot.library.sources.find(s=>s.id===p.sourceId)?.relativePath||p.sourceId}<small>{p.reason}</small></span><label>项目名<input aria-label={`项目归属 ${index+1}`} list="knowledge-project-names" value={p.project} disabled={busy} onChange={e=>setProposals(v=>v.map((x,i)=>i===index?{...x,project:e.target.value}:x))}/></label></div>)}<button className="selected" disabled={busy||proposals.some(p=>!p.project.trim())} onClick={()=>void apply(proposals)}>项目名正确，保存</button></details>}
    </section>}
   </>}
   generationAction={<div className="preparation-actions"><button className="selected" disabled={busy||!ready.some(s=>s.project!=='待确认资料')} onClick={build}>{buildLabel}</button><small>{selectedSources.length?`当前选中 ${selectedSources.length} 份文件`:`范围：${project||'全部已导入项目'}`}。{generationName==='API'?'API可能计费；本轮发送前需确认范围。':'使用已配置的本地模型。'}</small></div>}
   reviewAction={<div className="preparation-actions"><button disabled={busy||!pendingCount} onClick={review}>{pendingCount?`检查已有 ${pendingCount} 道问答`:'等待问答生成'}</button><small>采用后，到模拟练习设置勾选“使用已采用问答出题”。</small></div>}
  />
  <details className="knowledge-other"><summary>其他功能（按需）</summary>
   <div className="knowledge-optional-section"><h4>补充资料与修改项目</h4><div className="key-actions"><button disabled={busy} onClick={importFiles}>添加文件</button><button disabled={busy} onClick={()=>importFolder(mode)}>导入混合资料文件夹</button><button disabled={busy||!ready.length} onClick={classify}>重新识别项目</button></div><label>混合资料的导入方式<select aria-label="资料导入方式" value={mode} disabled={busy} onChange={e=>onMode(e.target.value as 'auto'|'organized')}><option value="auto">软件识别项目</option><option value="organized">按第一层项目目录导入</option></select></label>{!!selectedSources.length&&<div className="key-actions"><label>选中文件的项目<input value={manualProject} disabled={busy} onChange={e=>setManualProject(e.target.value)} placeholder="项目名或共享资料"/></label><button disabled={busy||!manualProject.trim()} onClick={()=>void apply(snapshot.library.sources.filter(s=>selectedSources.includes(s.id)&&s.status==='ready').map(s=>({sourceId:s.id,hash:s.hash,project:manualProject.trim(),reason:'用户手动确认'})))}>保存归属</button></div>}</div>
   <div className="knowledge-optional-section"><h4>已有问答</h4><p>导入已有文档或软件备份，结果进入待检查。</p><button disabled={busy} onClick={()=>importQuestions()}>导入已有问答</button></div>
   <div className="knowledge-optional-section"><h4>让Agent直接准备问答</h4><p>这是可选方式。先导出工作包交给Agent，完成后导入“生成问答”目录。</p><div className="key-actions"><button disabled={busy||!ready.length||unknown>0} onClick={exportKit}>导出Agent工作包</button><button disabled={busy} onClick={()=>showPrompt('bank')}>查看问答准备说明</button><button disabled={busy} onClick={()=>importQuestions(true)}>导入Agent结果文件夹</button></div></div>
   <div className="knowledge-optional-section"><h4>问答管理</h4><p>新增、查找、编辑和删除在“待检查 / 已采用”中操作；历史问题可从历史会话导入。文件列表和备份操作在本页下方。</p><button disabled={busy} onClick={()=>showPrompt('materials')}>查看资料整理说明</button></div>
  </details>
  {prompt&&<div className="knowledge-agent-prompt"><h4>{kind==='materials'?'资料整理':'问答准备'} · 固定说明</h4><textarea aria-label="给Agent的说明" value={prompt} readOnly rows={8}/><div className="key-actions"><button disabled={busy} onClick={()=>void work('复制说明',async()=>copyText(prompt))}>复制说明</button><button disabled={busy} onClick={savePrompt}>保存说明文件</button><button disabled={busy} onClick={()=>setPrompt('')}>收起说明</button></div></div>}
 </div>;
}
