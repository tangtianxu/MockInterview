import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {ask,save} from "@tauri-apps/plugin-dialog";
import {MathText} from "./MathText";
import type {HistorySession,HistoryRecord} from "./history";
const labels:Record<string,string>={transcript:"转录",question:"问题",answer:"模型回答",feedback:"评分与复盘",detail:"补充解释",usage:"模型用量"};
export function HistoryView({activeIds}:{activeIds:(string|null)[]}){
 const [query,setQuery]=useState("");const [date,setDate]=useState("");const [sessions,setSessions]=useState<HistorySession[]>([]);const [selected,setSelected]=useState<HistoryRecord|null>(null);const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 const reload=async()=>{setBusy(true);try{setSessions(await invoke("history_list",{query,date}));setError("");}catch(cause){setError(String(cause));}finally{setBusy(false);}};
 useEffect(()=>{void reload();},[]);
 const read=async(id:string)=>{setBusy(true);try{setSelected(await invoke("history_read",{id}));setError("");}catch(cause){setError(String(cause));}finally{setBusy(false);}};
 const remove=async()=>{if(!selected||activeIds.includes(selected.session.id))return;if(!await ask("删除这场会话的全部转录、问答与用量记录？无法恢复。",{title:"删除历史会话",kind:"warning"}))return;setBusy(true);try{await invoke("history_delete",{id:selected.session.id});setSelected(null);await reload();}catch(cause){setError(String(cause));}finally{setBusy(false);}};
 const exportFile=async()=>{if(!selected)return;const path=await save({defaultPath:`面试记录-${selected.session.startedAt.slice(0,10)}.md`,filters:[{name:"Markdown",extensions:["md"]},{name:"JSON",extensions:["json"]}]});if(!path)return;try{await invoke("history_export",{id:selected.session.id,path});setError("");}catch(cause){setError(String(cause));}};
 const stats=new Map<string,{requests:number;known:number;input:number;cached:number;output:number}>();
 for(const entry of selected?.entries || [])if(entry.kind==="usage"){
  const stage=`${entry.data.stage || "其他"} · ${entry.data.provider==="ollama"?"本地 Ollama":entry.data.provider==="deepseek"?"DeepSeek API":"兼容 API"} · ${entry.data.model || ""}`;const value=stats.get(stage)||{requests:0,known:0,input:0,cached:0,output:0};value.requests++;
  const usage=entry.data.usage;if(typeof usage?.prompt_tokens==="number"&&typeof usage?.completion_tokens==="number"){value.known++;value.input+=usage.prompt_tokens;value.output+=usage.completion_tokens;value.cached+=usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;}
  stats.set(stage,value);
 }
 return <section className="history-view"><p className="setting-help">自动保存在本机，从本版本开始记录；不保存原始音频。不代表语音转录或模型解释完全正确。</p>
  <label>关键词<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索问题、作答或回答" onKeyDown={e=>{if(e.key==="Enter")void reload();}}/></label>
  <label>日期（可选）<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
  <button className="download-btn" disabled={busy} onClick={()=>void reload()}>查询 / 刷新</button>
  {error&&<p className="error-box" role="alert">{error}</p>}
  <div className="history-list">{sessions.map(item=><button className="history-session" key={item.id} disabled={busy} onClick={()=>void read(item.id)}>
   <strong>{item.title}</strong><span>{new Date(item.startedAt).toLocaleString("zh-CN")} · {item.mode==="practice"?"模拟练习":item.mode==="manual"?"手动测试":"实时会话"}{!item.endedAt?" · 进行中 / 未正常结束":""}</span></button>)}{!busy&&!sessions.length&&<p>暂无匹配会话。查询显示最新 100 场，可按日期或关键词查找更早记录。</p>}</div>
  {selected&&<div className="history-detail"><h3>{selected.session.title}</h3><div className="key-actions"><button onClick={()=>void exportFile()}>导出 Markdown / JSON</button><button disabled={busy||activeIds.includes(selected.session.id)} onClick={()=>void remove()}>删除本场</button></div>
   {!!stats.size&&<><h4>按阶段统计模型用量</h4><div className="history-table"><table><thead><tr><th>阶段</th><th>返回请求</th><th>输入 token</th><th>缓存命中</th><th>输出 token</th></tr></thead><tbody>{[...stats].map(([stage,v])=><tr key={stage}><td>{stage}</td><td>{v.requests}（{v.known} 条含用量）</td><td>{v.input}</td><td>{v.cached}</td><td>{v.output}</td></tr>)}</tbody></table></div><p className="setting-help">只累计接口实际返回的用量；未返回、失败或取消的请求可能仍被服务商计费，缺失用量不代表零费用。缓存命中包含在输入 token 内，不重复相加。最终账单以平台为准。</p></>}
   {selected.entries.filter(e=>e.kind!=="usage").map(entry=><article className="history-entry" key={entry.id}><small>{labels[entry.kind]||entry.kind} · {new Date(entry.at).toLocaleTimeString("zh-CN")}{entry.data.speaker?` · ${entry.data.speaker==="User"?"我的作答":"面试音频"}`:""}{entry.data.complete===false?" · 未完成":""}</small>
    {entry.data.question&&<h4>{entry.data.question}</h4>}<MathText text={entry.text}/>{entry.kind==="feedback"&&<>
      <p>回答依据：{entry.data.feedback?.evidence}</p>
      {(entry.data.feedback?.corrections||[]).map((item:any,index:number)=><p key={`c-${index}`}><MathText text={`需纠正：${item.quote}\n${item.explanation}\n正确理解：${item.correct}`}/></p>)}
      {(entry.data.feedback?.missingPoints||[]).map((item:any,index:number)=><p key={`m-${index}`}><MathText text={`漏答：${item.point}\n${item.explanation}`}/></p>)}
      {!!entry.data.feedback?.missing?.length&&<p>需对照本题检查：{entry.data.feedback.missing.join("、")}</p>}
    </>}</article>)}
  </div>}
 </section>;
}
