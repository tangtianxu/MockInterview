import {useCallback,useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen,type UnlistenFn} from "@tauri-apps/api/event";
import {register,unregister} from "@tauri-apps/plugin-global-shortcut";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {Camera,Copy,Square,RefreshCw} from "lucide-react";
import type {ModelConfig} from "./modelProviders";
import type {HistoryRecorder} from "./history";
import "./screen-code.css";

export const DEFAULT_SCREEN_SHORTCUT="F8";
export const CODE_LANGUAGES=["Python 3","C++17","Java","JavaScript"];
type CapturedScreen={text:string;width:number;height:number;preview:string};
type CodeEndpoint=ModelConfig&{credentialSlot:string};
type SolverOptions={enabled:boolean;shortcutEnabled:boolean;blocked:()=>boolean;shortcut:string;forbidden:string[];
  language:string;endpoint:CodeEndpoint;history:HistoryRecorder;onOpen:()=>void};

export function useScreenCode(options:SolverOptions){
 const opts=useRef(options);opts.current=options;
 const [draft,setDraft]=useState("");const [answer,setAnswer]=useState("");
 const [capture,setCapture]=useState<CapturedScreen|null>(null);
 const [phase,setPhase]=useState<"idle"|"capturing"|"generating">("idle");
 const [error,setError]=useState("");const [shortcutError,setShortcutError]=useState("");
 const epoch=useRef(0);const request=useRef("");const capturePending=useRef(false);
 const text=useRef("");const mounted=useRef(true);
 const queue=useRef<Promise<void>>(Promise.resolve());const registered=useRef("");
 const cancel=useCallback(()=>{
  epoch.current++;const id=request.current;request.current="";
  if(id)void invoke("mvp_cancel_answer",{requestId:id}).catch(()=>{});
  setPhase("idle");
 },[]);
 const generate=useCallback(async(problem:string,turn:number)=>{
  const {endpoint,history,language}=opts.current;
  if(!problem.trim()){setError("请先截图，或在识别文字中输入完整题目。");setPhase("idle");return;}
  if(problem.length>24000){setError("请将文字缩减到24000字以内，保留当前题目、约束与样例。");setPhase("idle");return;}
  if(turn!==epoch.current)return;
  const id=crypto.randomUUID();request.current=id;text.current="";setAnswer("");setError("");setPhase("generating");
  const stops:UnlistenFn[]=[];let failure="";let cancelled=false;let completed=false;let received="";
  const current=()=>mounted.current&&turn===epoch.current&&request.current===id;
  history.ensure("manual","截屏代码题");
  history.record("question",problem,{coding:true,language},`${id}-question`);
  try{
   stops.push(await listen<{requestId:string;token:string}>("mvp_answer_token",event=>{
    if(event.payload.requestId===id&&current()){received+=event.payload.token;text.current=received;setAnswer(received);}
   }));
   stops.push(await listen<{requestId:string;error?:string|null}>("mvp_answer_done",event=>{
    if(event.payload.requestId!==id||!current())return;
    completed=true;failure=event.payload.error||"";if(failure)setError(failure);
   }));
   if(endpoint.api==="ollama")await invoke("start_local_service",{service:"ollama"});
   if(!current()){cancelled=true;return;}
   await invoke("mvp_answer",{endpoint:history.endpoint(endpoint,"截屏代码题解答"),requestId:id,question:problem,
    codeQuestion:true,focus:[],keyTerms:[],constraints:[language],uncertainTerms:[]});
   if(current()&&!text.current.trim()&&!failure)throw new Error("模型没有返回解答，请检查模型连接后重试。");
  }catch(cause){failure=String(cause);if(current())setError(failure);}
  finally{
   stops.forEach(stop=>stop());cancelled=cancelled||!current();
   history.record("answer",received,{coding:true,question:"截屏代码题",language,complete:completed&&!failure&&!cancelled,error:failure||null,cancelled},`${id}-answer`);
   if(current()){request.current="";setPhase("idle");}
  }
 },[]);
 const screenshot=useCallback(async()=>{
  if(!opts.current.enabled||opts.current.blocked()||capturePending.current)return;
  cancel();const turn=epoch.current;capturePending.current=true;
  opts.current.onOpen();setPhase("capturing");setError("");setAnswer("");setCapture(null);
  let recognitionFinished=false;
  try{
   const result=await invoke<CapturedScreen>("capture_code_screen");
   recognitionFinished=true;capturePending.current=false;
   if(!mounted.current||turn!==epoch.current)return;
   setCapture(result);setDraft(result.text);
   await generate(result.text,turn);
  }catch(cause){if(mounted.current&&turn===epoch.current){setError(String(cause));setPhase("idle");}}
  finally{if(!recognitionFinished)capturePending.current=false;}
 },[cancel,generate]);
 const solve=useCallback(()=>{
  if(!opts.current.enabled||opts.current.blocked()||capturePending.current)return;
  cancel();opts.current.onOpen();void generate(draft,epoch.current);
 },[cancel,generate,draft]);
 const screenshotRef=useRef(screenshot);screenshotRef.current=screenshot;
 useEffect(()=>{
  let disposed=false;const shortcut=options.shortcut;
  const sync=async()=>{
   if(registered.current){const previous=registered.current;registered.current="";await unregister(previous);}
   if(disposed||!options.enabled||!options.shortcutEnabled)return;
   if(options.forbidden.includes(shortcut)){setShortcutError("截屏键与退出或恢复任务栏快捷键冲突，请更换。");return;}
   try{
    await register(shortcut,event=>{if(event.state==="Pressed")void screenshotRef.current();});
    if(disposed){await unregister(shortcut);return;}
    registered.current=shortcut;setShortcutError("");
   }catch(cause){if(!disposed)setShortcutError(`截屏键 ${shortcut} 注册失败，请在设置中换一个功能键。${String(cause)}`);}
  };
  queue.current=queue.current.then(sync,sync);
  return()=>{disposed=true;queue.current=queue.current.then(async()=>{if(registered.current===shortcut){registered.current="";await unregister(shortcut);}}).catch(()=>{});};
 },[options.enabled,options.shortcutEnabled,options.shortcut,options.forbidden.join("|")]);
 useEffect(()=>{if(!options.enabled)cancel();},[options.enabled,cancel]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;const id=request.current;request.current="";if(id)void invoke("mvp_cancel_answer",{requestId:id}).catch(()=>{});};},[]);
 return {draft,setDraft,answer,capture,phase,error,shortcutError,screenshot,solve,cancel,busy:phase!=="idle"};
}

function CodeBlock({children}:{children:React.ReactNode}){
 const [copied,setCopied]=useState(false);
 return <div className="code-block"><button type="button" aria-label="复制这段代码" onClick={event=>{
  // Read rendered code only; preserve indentation and never copy button text.
  const element=event.currentTarget.parentElement?.querySelector("code");
  if(element)void navigator.clipboard.writeText(element.textContent||"").then(()=>setCopied(true)).catch(()=>setCopied(false));
 }}><Copy size={13}/>{copied?"已复制":"复制代码"}</button><pre>{children}</pre></div>;
}
export function CodeAnswer({text}:{text:string}){
 return <div className="code-answer"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
  components={{pre:({children})=><CodeBlock>{children}</CodeBlock>,img:()=>null,a:({children})=><span>{children}</span>}}>{text}</ReactMarkdown></div>;
}

export function ScreenCodePanel({solver,language,onLanguage,shortcut}:{solver:ReturnType<typeof useScreenCode>;language:string;onLanguage:(value:string)=>void;shortcut:string}){
 return <div className="screen-code-panel">
  <div className="screen-code-toolbar"><button className="download-btn" onClick={()=>void solver.screenshot()} disabled={solver.phase==="capturing"}><Camera size={15}/>截屏解题 <kbd>{shortcut}</kbd></button>
   <label>默认语言<select aria-label="代码解答语言" value={language} onChange={e=>onLanguage(e.target.value)} disabled={solver.busy}>{CODE_LANGUAGES.map(x=><option key={x}>{x}</option>)}</select></label>
   {solver.busy&&<button className="download-btn" onClick={solver.cancel}><Square size={13}/>停止</button>}
  </div>
  <p className="screen-code-help">按 {shortcut} 截取鼠标所在屏幕并解题，自动排除本软件窗口。模型先筛选题干、约束和样例，再给出思路与逐行注释代码。仅识别文字发送给当前回答模型，截图留在内存中。</p>
  {solver.shortcutError&&<p className="error-box" role="alert">{solver.shortcutError}</p>}
  {solver.error&&<p className="error-box" role="alert">{solver.error}</p>}
  {solver.phase==="capturing"&&<p role="status"><RefreshCw size={14}/>正在截屏并识别文字…</p>}
  <details className="screen-source"><summary>识别文字与截图 · 可修正题目、符号或去掉无关内容</summary>
   <textarea aria-label="截屏识别的题目文字" value={solver.draft} maxLength={24000} rows={9} onChange={e=>solver.setDraft(e.target.value)} placeholder="也可以直接粘贴完整题目、输入输出和样例。" disabled={solver.busy}/>
   {solver.capture&&<img src={solver.capture.preview} alt="本次截屏预览，已排除软件窗口"/>}
  </details>
  <button className="download-btn" onClick={solver.solve} disabled={!solver.draft.trim()||solver.busy}>按当前文字重新解题</button>
  {solver.phase==="generating"&&<p className="screen-code-help" role="status">正在筛选题目并生成解答…</p>}
  {solver.answer?<CodeAnswer text={solver.answer}/>:!solver.busy&&<div className="answer-placeholder"><Camera size={24}/><strong>展示代码题后按 {shortcut}</strong><p>支持题目筛选、算法思路、完整代码、逐行注释及复杂度。</p></div>}
 </div>;
}

export function ScreenShortcutEditor({value,forbidden,onSave,onRecording}:{value:string;forbidden:string[];onSave:(value:string)=>void;onRecording:(active:boolean)=>void}){
 const [recording,setRecording]=useState(false);const [draft,setDraft]=useState("");const [error,setError]=useState("");
 const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(recording)input.current?.focus();},[recording]);
 useEffect(()=>()=>onRecording(false),[onRecording]);
 const stop=()=>{setRecording(false);onRecording(false);};
 return <div className="screen-shortcut-setting"><label>截屏解题快捷键（面试助手模式）<input ref={input} aria-label="截屏解题快捷键" readOnly value={recording?(draft||"请按下功能键…"):value} onKeyDown={event=>{
  if(!recording)return;event.preventDefault();event.stopPropagation();
  if(event.key==="Escape"){stop();return;}
  if(/^F(?:[1-9]|1[0-2])$/.test(event.code)){const parts=[event.ctrlKey&&"Control",event.altKey&&"Alt",event.shiftKey&&"Shift",event.code].filter(Boolean);setDraft(parts.join("+"));setError("");}
 }}/></label><div className="key-actions">{!recording?<button onClick={()=>{setDraft("");setError("");setRecording(true);onRecording(true);}}>更改截屏键</button>:<>
  <button disabled={!draft} onClick={()=>{if(forbidden.includes(draft)){setError("该快捷键已用于退出或恢复任务栏。");return;}onSave(draft);stop();}}>保存截屏键</button><button onClick={stop}>取消</button></>}</div>
  <p className="setting-help">默认单键 F8。可以换成 F1–F12，录入时按 Esc 取消。仅在面试助手页面注册；冲突时会提示更换。</p>{error&&<p className="error-box" role="alert">{error}</p>}</div>;
}
