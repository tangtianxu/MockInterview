import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask as confirmSend, open as choosePath } from "@tauri-apps/plugin-dialog";
import { AudioLines, Clock3, FileText, Play, Send, Sparkles, Square } from "lucide-react";
import "./practice.css";
import { MathText } from "./MathText";
import {SetupGuide} from "./SetupGuide";
import {practiceHistory,repeatedPracticeQuestion,PracticeRequestGate,practiceBackground,type PracticeBackground} from "./practiceSession";

type ModelEndpoint = { api: string; baseUrl: string; model: string; credentialSlot: string };
type SttSettings = { mode: "local" | "api"; engine: string; model: string; apiProvider: string;
  apiModel: string; mic: string; output: string };
export type PracticeConfig = { minutes: number; scope: "technical" | "project" | "mixed" | "comprehensive";
  difficulty: "basic" | "medium" | "advanced" };
export type Resume = { name: string; text: string; truncated: boolean; hash: string };
export type Analysis = { summary: string; skills?: string[]; projects?: string[];
  uncertainties?: string[]; suggestedTopics?: string[] };
type Question = { question: string; topic?: string; intent?: string; background?:PracticeBackground };
type Feedback = { score:number;evidence:string;questionKind?:string;missing?:string[];
  corrections?:{quote:string;explanation:string;correct:string}[];missingPoints?:{point:string;explanation:string}[] };
type Turn = { id:string;question:string;answer:string;feedback:Feedback;reference?:string };

const initial: PracticeConfig = { minutes: 20, scope: "technical", difficulty: "medium" };
const aspects: Record<string,string> = {
  definition:"能否先说明核心概念或目标？", mechanism:"能否说明关键步骤及其作用？",
  tradeoff:"能否说明方案选择的依据和代价？", boundary:"能否说明适用条件与边界？",
  role:"如果确实参与，能否说明自己负责的部分？", verification:"如果确实做过，能否说明如何验证？",
  result:"如果有可核对的结果，能否说明结果？", uncertainty:"哪些内容需要先核实再回答？",
};
function loadConfig(): PracticeConfig {
  try {const saved = JSON.parse(localStorage.getItem("interviewCue.practiceConfig") || "{}");
    return {...initial,...saved};} catch {return initial;}
}
function minutesLabel(seconds: number) {
  const value = Math.max(0, seconds);
  return `${String(Math.floor(value / 60)).padStart(2,"0")}:${String(value % 60).padStart(2,"0")}`;
}

export function PracticeView({model, domain, liveRunning, stt, personalization, onSessionActiveChange,
  resume, analysis, onResumeImported, onAnalysis, onClearResume, role, topics, onRoleChange, onTopicsChange,
  setupVisible=true,feedbackVisible=true,resumePath="",resumeError="",onPreviewChange,onConfigChange,profileEpoch=0,onWorkActiveChange,updating=false,onModelSettings}: {model: ModelEndpoint; domain: string;
  liveRunning: boolean; stt: SttSettings; personalization?: string; onSessionActiveChange?: (active:boolean)=>void;
  resume: Resume|null; analysis: Analysis|null; onResumeImported:(path:string,resume:Resume)=>void;
  onAnalysis:(analysis:Analysis)=>void; onClearResume:()=>void; role:string; topics:string;
  onRoleChange:(value:string)=>void; onTopicsChange:(value:string)=>void;
  setupVisible?:boolean; feedbackVisible?:boolean; resumePath?:string; resumeError?:string;
  onPreviewChange?:(preview:{question:string;hint:string})=>void;
  onConfigChange?:()=>void;profileEpoch?:number;updating?:boolean;onWorkActiveChange?:(busy:boolean)=>void;onModelSettings?:()=>void}) {
  const [guideVisible,setGuideVisible]=useState(()=>localStorage.getItem("mockInterview.setupGuideSeen")!=="1");
  const dismissGuide=()=>{localStorage.setItem("mockInterview.setupGuideSeen","1");setGuideVisible(false);};
  const [config, setConfig] = useState<PracticeConfig>(loadConfig);
  const [question, setQuestion] = useState<Question | null>(null);
  const [draft, setDraft] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef=useRef<Turn[]>([]);
  const operationRef=useRef(new PracticeRequestGate());
  const sessionEpochRef=useRef(0);
  const referenceRequestRef=useRef<{id:string;turnId:string;text:string}|null>(null);
  const referenceStopsRef=useRef<UnlistenFn[]>([]);
  const [reference,setReference]=useState({text:"",loading:false,error:""});
  const [active, setActive] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState<"resume" | "analyze" | "question" | "feedback" | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [micStarting,setMicStarting]=useState(false);
  const micStartingRef=useRef(false);
  const [partialSpeech, setPartialSpeech] = useState("");
  const micOnRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn[]>([]);
  const seenSegmentsRef = useRef(new Set<string>());
  const [error, setError] = useState("");
  const local = model.api === "ollama";
  const average = useMemo(() => turns.length ? (turns.reduce((sum, turn) => sum + turn.feedback.score, 0) / turns.length).toFixed(1) : "—", [turns]);
  useEffect(() => {localStorage.setItem("interviewCue.practiceConfig",JSON.stringify(config));onConfigChange?.();},[config,onConfigChange]);
  useEffect(() => {if(profileEpoch)setConfig(loadConfig());},[profileEpoch]);
  useEffect(() => {onSessionActiveChange?.(active);},[active,onSessionActiveChange]);
  useEffect(()=>{onWorkActiveChange?.(active || !!busy || micOn || micStarting || reference.loading);},[active,busy,micOn,micStarting,reference.loading,onWorkActiveChange]);
  useEffect(()=>()=>onWorkActiveChange?.(false),[onWorkActiveChange]);
  useEffect(() => {
    const hint=feedback ? reference.text || `参考评分 ${feedback.score}/5。${(feedback.missingPoints || []).slice(0,2).map(item=>item.explanation).join(" ") || (feedback.missing || []).slice(0,2).map(code=>aspects[code]).filter(Boolean).join(" ")}` :
      active ? "请先口头回答；提交后查看复盘。" : "设置练习范围后开始。";
    onPreviewChange?.({question:question?.question || "",hint});
  },[question,feedback,reference.text,active,onPreviewChange]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setRemaining(value => Math.max(0,value-1)),1000);
    return () => window.clearInterval(timer);
  },[active]);
  useEffect(()=>{if(active && remaining===0)endSession();},[active,remaining]);

  const currentBackground=()=>practiceBackground({scope:config.scope,difficulty:config.difficulty,role,topics,
    domain,local,personalization,resume,analysis});
  const authorizeBackground=async (background:PracticeBackground,label:string,projectQuestion=false)=>{
    if(local)return false;
    const includesResume=!!(background.resumeText || background.resumeAnalysis);
    if(!includesResume && !projectQuestion)return false;
    const destination=(()=>{try{return new URL(model.baseUrl).host;}catch{return model.baseUrl;}})();
    const agreed=await confirmSend(`本次${label}会将领域、岗位、主题及当前问题${label==="评价" ? "与你的作答" : ""}${includesResume ? "、简历摘录（最多 8,000 字）和本地分析" : "（可能包含项目相关信息）"}发送至 ${destination}。仅本次授权，是否继续？`,
      {title:"确认本次背景发送",kind:"warning"});
    if(!agreed)throw new Error("已取消本次请求");
    return agreed;
  };
  const request = async (action: "analyze" | "ask" | "evaluate", fields: Record<string,unknown> = {}, background=currentBackground()) => {
    const epoch=sessionEpochRef.current;
    if (local) await invoke("start_local_service",{service:"ollama"});
    if(epoch!==sessionEpochRef.current)throw new Error("本轮操作已结束");
    const consentToSendResume=action==="analyze" ? false : await authorizeBackground(background,action==="ask" ? "出题" : "评价",fields.questionKind==="project" || fields.questionKind==="mixed");
    if(epoch!==sessionEpochRef.current)throw new Error("本轮操作已结束");
    return invoke<Record<string,unknown>>("practice_model",{endpoint:model,input:{
      ...background,preferences:local ? background.preferences : "",action,minutes:config.minutes,
      consentToSendResume,history:"",askedQuestions:[],question:"",questionKind:"",answer:"",...fields,
    }});
  };
  const importResume = async () => {
    if(updating)return;
    const path = await choosePath({multiple:false,directory:false,filters:[{name:"简历",extensions:["pdf","docx","txt","md"]}]});
    if (typeof path !== "string") return;
    setBusy("resume");setError("");
    try {const loaded = await invoke<Resume>("practice_read_resume",{path});onResumeImported(path,loaded);}
    catch (cause) {setError(`导入简历失败：${String(cause)}`);}
    finally {setBusy(null);}
  };
  const analyzeResume = async () => {
    if(updating)return;
    if (!resume) return;
    setBusy("analyze");setError("");
    try {const value = await request("analyze",{resumeText:resume.text,resumeAnalysis:""});onAnalysis(value as Analysis);}
    catch (cause) {setError(`简历分析失败：${String(cause)}`);}
    finally {setBusy(null);}
  };
  const cancelReference=()=>{
    const current=referenceRequestRef.current;referenceRequestRef.current=null;
    if(current){
      void invoke("mvp_cancel_answer",{requestId:current.id}).catch(()=>{});
      const next=turnsRef.current.map(turn=>turn.id===current.turnId ? {...turn,reference:undefined} : turn);
      turnsRef.current=next;setTurns(next);
    }
    for(const stop of referenceStopsRef.current.splice(0))stop();
    setReference({text:"",loading:false,error:""});
  };
  const generateReference=async (currentQuestion:Question,turnId:string,epoch=sessionEpochRef.current)=>{
    if(updating || referenceRequestRef.current)return;
    const current={id:`practice-reference-${crypto.randomUUID()}`,turnId,text:""};
    referenceRequestRef.current=current;
    const stillCurrent=()=>referenceRequestRef.current===current && sessionEpochRef.current===epoch;
    setReference({text:"",loading:true,error:""});
    try {
      const background=currentQuestion.background || currentBackground();
      const consentToSendResume=await authorizeBackground(background,"参考生成",currentQuestion.intent!=="technical");
      if(!stillCurrent())return;
      if(local)await invoke("start_local_service",{service:"ollama"});
      if(!stillCurrent())return;
      const stop=await listen<{requestId:string;token:string}>("mvp_answer_token",event=>{
        if(!stillCurrent() || event.payload.requestId!==current.id)return;
        current.text+=event.payload.token;
        setReference({text:current.text,loading:true,error:""});
        setTurns(value=>{
          const next=value.map(turn=>turn.id===turnId ? {...turn,reference:current.text} : turn);
          turnsRef.current=next;return next;
        });
      });
      if(!stillCurrent()){stop();return;}
      referenceStopsRef.current.push(stop);
      await invoke("mvp_answer",{endpoint:model,requestId:current.id,question:currentQuestion.question,
        focus:[],keyTerms:[],constraints:[],uncertainTerms:[],practiceReference:true,
        practiceContext:{...background,preferences:local ? background.preferences : "",consentToSendResume}});
      if(stillCurrent() && !current.text.trim())throw new Error("回答模型未返回参考答案，请重试。");
    }catch(cause){if(stillCurrent()){
      setReference(value=>({...value,error:`参考生成失败：${String(cause)}`}));
      setTurns(value=>{
        const next=value.map(turn=>turn.id===turnId ? {...turn,reference:undefined} : turn);
        turnsRef.current=next;return next;
      });
    }}
    finally{
      if(stillCurrent()){
        referenceRequestRef.current=null;
        for(const stop of referenceStopsRef.current.splice(0))stop();
        setReference(value=>({...value,loading:false}));
      }
    }
  };
  const endSession=()=>{
    setActive(false);sessionEpochRef.current++;operationRef.current.reset();setBusy(null);
    if(referenceRequestRef.current)cancelReference();
    if(micOnRef.current)void stopMic();
  };
  const ask = async (previous: Turn[] = turnsRef.current): Promise<boolean> => {
    const token=operationRef.current.begin();
    if(token===null)return false;
    cancelReference();
    setBusy("question");setError("");
    try {
      const history=practiceHistory(previous);
      const background=currentBackground();
      const value = await request("ask",history,background) as Question;
      if(!operationRef.current.current(token))return false;
      if(!value.question?.trim() || repeatedPracticeQuestion(value.question,history.askedQuestions))
        throw new Error("服务返回了空题目或重复题目，已阻止展示，请重试下一题。");
      setQuestion({...value,background});setFeedback(null);setDraft("");
      return true;
    } catch (cause) {if(operationRef.current.current(token))setError(`生成问题失败：${String(cause)}`);return false;}
    finally {if(operationRef.current.finish(token))setBusy(null);}
  };
  const start = async () => {
    if(updating)return;
    if(operationRef.current.busy || micStartingRef.current)return;
    if (liveRunning) {setError("请先结束实时聆听，再开始模拟练习。");return;}
    if (config.scope !== "technical" && !analysis) {setError("项目、混合或综合练习需要先导入并分析简历。");return;}
    const epoch=++sessionEpochRef.current;cancelReference();turnsRef.current=[];
    setTurns([]);setQuestion(null);setFeedback(null);setRemaining(config.minutes*60);
    const started=await ask([]);
    if(epoch===sessionEpochRef.current){if(started)setActive(true);else setRemaining(0);}
  };
  const submit = async () => {
    if (!active || micStartingRef.current || !question || !draft.trim() || feedback) return;
    const token=operationRef.current.begin();
    if(token===null)return;
    const currentQuestion=question;
    const currentAnswer=draft.trim();
    const epoch=sessionEpochRef.current;
    if (micOnRef.current) await stopMic();
    setBusy("feedback");setError("");
    try {
      const value = await request("evaluate",{question:currentQuestion.question,questionKind:currentQuestion.intent || "mixed",answer:currentAnswer},currentQuestion.background);
      if(!operationRef.current.current(token))return;
      const result = value as Feedback;
      setFeedback(result);
      const turnId=crypto.randomUUID();
      const next=[...turnsRef.current,{id:turnId,question:currentQuestion.question,answer:currentAnswer,feedback:result}];
      turnsRef.current=next;setTurns(next);
      // Knowledge questions automatically receive an independent reference answer.
      // Project-related questions require an explicit action/consent for the extra call.
      if(result.questionKind==="technical")void generateReference(currentQuestion,turnId,epoch);
    } catch (cause) {if(operationRef.current.current(token))setError(`生成反馈失败：${String(cause)}`);}
    finally {if(operationRef.current.finish(token))setBusy(null);}
  };

  const stopMic = async () => {
    micOnRef.current=false;setMicOn(false);
    try {await invoke("stop_capture");} catch (cause) {setError(`停止麦克风失败：${String(cause)}`);}
    finally {for (const stop of unlistenRef.current.splice(0)) stop();setPartialSpeech("");}
  };
  const startMic = async () => {
    if(updating)return;
    if (!active || liveRunning || micOnRef.current || micStartingRef.current || !question || feedback) return;
    micStartingRef.current=true;setMicStarting(true);
    const epoch=sessionEpochRef.current;
    const stillCurrent=()=>epoch===sessionEpochRef.current;
    let captureStarted=false;
    setError("");seenSegmentsRef.current.clear();setPartialSpeech("");
    try {
      await invoke("set_stt_language",{language:"zh-CN"});
      const topic = ["中文模拟技术面试，英文术语保持原文",topics].filter(Boolean).join("；");
      const localTopic=[topic,...(analysis?.skills || []).filter(term=>resume?.text.toLowerCase().includes(term.toLowerCase())).slice(0,6)].join("；");
      await invoke("set_whisper_topic_prompt",{prompt:stt.mode==="local" && stt.engine==="whisper_cpp" ? localTopic : ""});
      if (stt.mode==="api" && stt.apiProvider==="deepgram")
        await invoke("update_deepgram_config",{configJson:JSON.stringify({model:stt.apiModel || "nova-3",
          smart_format:false,interim_results:true,endpointing:300,punctuate:true,diarize:false,
          profanity_filter:false,numerals:false,dictation:false,vad_events:true,keyterms:[]})});
      if (stt.mode==="api" && stt.apiProvider==="groq_whisper")
        await invoke("update_groq_config",{configJson:JSON.stringify({model:stt.apiModel || "whisper-large-v3-turbo",
          language:"zh",temperature:0,response_format:"json",timestamp_granularities:[],prompt:topic,segment_duration_secs:3})});
      if(!stillCurrent())return;
      const you = {role:"You",device_id:stt.mic,is_input_device:true,
        stt_provider:stt.mode==="local" ? stt.engine : stt.apiProvider,
        local_model_id:stt.mode==="local" ? stt.model : null};
      const them = {role:"Them",device_id:stt.output,is_input_device:false,stt_provider:"web_speech",local_model_id:null};
      unlistenRef.current.push(await listen<{segment:{id:string;text:string;speaker:string}}>("transcript_update",event=>{
        if (stillCurrent() && event.payload.segment.speaker==="User") setPartialSpeech(event.payload.segment.text);
      }));
      unlistenRef.current.push(await listen<{segment:{id:string;text:string;speaker:string}}>("transcript_final",event=>{
        const segment=event.payload.segment;
        if (!stillCurrent() || segment.speaker!=="User" || seenSegmentsRef.current.has(segment.id)) return;
        seenSegmentsRef.current.add(segment.id);
        setDraft(value=>`${value}${value.trim()?" ":""}${segment.text}`);
        setPartialSpeech("");
      }));
      if(!stillCurrent())return;
      await invoke("start_capture_per_party",{youConfig:JSON.stringify(you),themConfig:JSON.stringify(them)});
      captureStarted=true;
      if(!stillCurrent()){await invoke("stop_capture");captureStarted=false;return;}
      micOnRef.current=true;setMicOn(true);
    } catch (cause) {
      for (const stop of unlistenRef.current.splice(0)) stop();
      try {await invoke("stop_capture");} catch { /* Initial capture may not have started. */ }
      if(stillCurrent())setError(`无法开始语音作答：${String(cause)}`);
    } finally {
      if(!captureStarted)for(const stop of unlistenRef.current.splice(0))stop();
      micStartingRef.current=false;setMicStarting(false);
    }
  };
  useEffect(() => () => {
    sessionEpochRef.current++;operationRef.current.reset();
    const referenceRequest=referenceRequestRef.current;referenceRequestRef.current=null;
    if(referenceRequest)void invoke("mvp_cancel_answer",{requestId:referenceRequest.id}).catch(()=>{});
    for(const stop of referenceStopsRef.current.splice(0))stop();
    for (const stop of unlistenRef.current.splice(0)) stop();
    if (micOnRef.current) {micOnRef.current=false;void invoke("stop_capture");}
  },[]);
  useEffect(() => {if (!active && micOnRef.current) void stopMic();},[active]);

  return <main className={`practice-workspace${setupVisible?"":" practice-hide-setup"}${feedbackVisible?"":" practice-hide-feedback"}${guideVisible && !active && !busy?" practice-with-guide":""}`}>
    <section className="practice-setup">
      <div className="hero-card practice-hero"><div className="hero-icon"><AudioLines size={25}/></div>
        <h1>练习表达，<br/>看清薄弱点。</h1><p>模型担任模拟面试官。你作答后，它给出参考反馈与下一题。</p>
        <button className="practice-secondary" disabled={active || !!busy || micStarting || updating} onClick={()=>setGuideVisible(value=>!value)}>使用指南</button></div>
      <div className="practice-options">
        <h2>练习设置</h2>
        <label>时长<select value={config.minutes} disabled={active || !!busy || micStarting || updating} onChange={event=>setConfig(value=>({...value,minutes:Number(event.target.value)}))}>
          {[10,20,30,45,60].map(value=><option key={value} value={value}>{value} 分钟</option>)}</select></label>
        <label>覆盖范围<select value={config.scope} disabled={active || !!busy || micStarting || updating} onChange={event=>setConfig(value=>({...value,scope:event.target.value as PracticeConfig["scope"]}))}>
          <option value="technical">技术基础</option><option value="project">简历项目</option>
          <option value="mixed">技术＋项目</option><option value="comprehensive">综合</option></select></label>
        <label>难度<select value={config.difficulty} disabled={active || !!busy || micStarting || updating} onChange={event=>setConfig(value=>({...value,difficulty:event.target.value as PracticeConfig["difficulty"]}))}>
          <option value="basic">基础</option><option value="medium">中等</option><option value="advanced">进阶</option></select></label>
        <label>目标岗位（可选）<input value={role} disabled={active || !!busy || micStarting || updating} maxLength={120} placeholder="如：算法工程师" onChange={event=>onRoleChange(event.target.value)}/></label>
        <label>关注主题（可选）<input value={topics} disabled={active || !!busy || micStarting || updating} maxLength={300} placeholder="如：RAG、通信协议" onChange={event=>onTopicsChange(event.target.value)}/></label>
        <p>岗位和主题与实时提示页共用，只调整选题与术语背景，不作为经历事实。</p>
      </div>
      <div className="practice-options">
        <h2>简历背景 <span>可选</span></h2>
        <p>支持 PDF、DOCX、TXT、MD。记住所选路径，重启后只读重新加载；简历分析只允许本地 Ollama。</p>
        <button className="practice-secondary" disabled={updating || !!busy || active} onClick={()=>void importResume()}><FileText size={16}/> {resume ? "重新选择简历" : "选择简历"}</button>
        {resume && <p className="practice-file">{resume.name}{resume.truncated ? " · 仅使用前 1.2 万字" : ""}</p>}
        {resumePath && !resume && <p className="practice-warning">{resumeError || "正在重新读取已保存的简历…"}</p>}
        {resumePath && <button className="practice-secondary" disabled={updating || !!busy || active} onClick={onClearResume}>移除已保存简历</button>}
        {resume && <button className="practice-secondary" disabled={updating || !!busy || !local || active} onClick={()=>void analyzeResume()}>
          <Sparkles size={16}/> {busy === "analyze" ? "正在分析…" : "分析简历"}</button>}
        {resume && !local && <p className="practice-warning">分析简历需先用本地 Ollama；已有本地分析可继续用 API 练习项目题，每次发送摘录前单独确认。</p>}
        {!local && <p>技术题练习会把问题与回答发送给所选回答 API；简历内容不会发送。</p>}
        {local && personalization && <p>已沿用个人资料中的个性化回答偏好调整选题；这段偏好不作为简历事实。</p>}
        {analysis && <div className="practice-analysis"><strong>简历分析</strong><p>{analysis.summary}</p>
          {!!analysis.suggestedTopics?.length && <small>建议覆盖：{analysis.suggestedTopics.join("、")}</small>}</div>}
      </div>
    </section>
    <section className="practice-dialogue">
      <div className="panel-header"><div><span className="panel-kicker">模拟现场</span><h2>模拟面试</h2></div><span className="panel-count"><Clock3 size={15}/> {minutesLabel(remaining)}</span></div>
      <div className="practice-controls">
        {!active && <button className="start-btn" disabled={updating || !!busy || micStarting} onClick={()=>void start()}><Play size={15}/> {turns.length ? "重新开始" : "开始练习"}</button>}
        {active && <button className="stop-btn" onClick={endSession}><Square size={14}/> 结束练习</button>}
        <span>{turns.length} 题已答 · 平均 {average}/5</span>
      </div>
      <div className="practice-conversation">
        {guideVisible && !active && !busy && <SetupGuide onSettings={onModelSettings} onDismiss={dismissGuide}/>}
        {turns.map((turn,index)=><div className="practice-turn" key={turn.id}>
          <div className="practice-bubble interviewer"><small>面试官 · 第 {index+1} 题</small><p><MathText text={turn.question}/></p></div>
          <div className="practice-bubble candidate"><small>我的回答</small><p><MathText text={turn.answer}/></p></div>
          <div className="practice-mini-score">参考评分 {turn.feedback.score}/5 · 回答依据：“{turn.feedback.evidence}”</div>
          {turn.reference && <details className="practice-history-reference"><summary>{turn.feedback.questionKind==="technical" ? "查看参考答案" : "查看回答思路"}</summary><p><MathText text={turn.reference}/></p></details>}
        </div>)}
        {question && !feedback && <div className="practice-bubble interviewer current"><small>面试官 · 当前问题</small><p><MathText text={question.question}/></p><span>{question.topic}</span></div>}
        {!question && !busy && !guideVisible && <div className="practice-empty"><AudioLines size={31}/><h3>准备开始模拟面试</h3><p>设置范围、难度和时长后，模型会逐题提问。</p></div>}
        {busy === "question" && <div className="practice-empty">正在准备下一题…</div>}
      </div>
      {question && !feedback && <div className="practice-compose"><label htmlFor="practice-answer">用麦克风转写，或自行输入回答</label>
        <textarea id="practice-answer" value={draft} onChange={event=>setDraft(event.target.value)} rows={5} maxLength={2500}
          placeholder="写下刚才实际说出的内容，再获取反馈。"/>
        {partialSpeech && <div className="practice-partial">正在识别：{partialSpeech}</div>}
        <div className="practice-compose-actions"><button className="practice-secondary" disabled={!!busy || micStarting || !active} onClick={()=>void (micOn ? stopMic() : startMic())}>
          {micStarting ? "正在启动麦克风…" : micOn ? "停止麦克风" : "麦克风作答"}</button>
        <button className="start-btn" disabled={!draft.trim() || !!busy || micOn || micStarting} onClick={()=>void submit()}><Send size={15}/> {busy === "feedback" ? "正在评估…" : micOn ? "先停麦克风" : "提交回答"}</button></div></div>}
      {question && !feedback && stt.mode==="api" && <div className="practice-api-note">麦克风作答会按模型设置，将语音发送给所选识别服务。</div>}
      {error && <div className="error-box" role="alert">{error}</div>}
    </section>
    <section className="practice-feedback">
      <div className="panel-header"><div><span className="panel-kicker">练习反馈</span><h2>回答复盘</h2></div><span className="answer-spark"><Sparkles size={17}/></span></div>
      {feedback ? <div className="practice-feedback-body">
        <div className="practice-score">{feedback.score}<span>/ 5</span></div>
        <h3>本次回答片段</h3><p>“{feedback.evidence}”</p>
        {feedback.questionKind==="technical" ? <>
          {!!feedback.corrections?.length && <><h3>需要纠正</h3>{feedback.corrections.map((item,index)=><div className="practice-knowledge-point" key={index}>
            <blockquote>“{item.quote}”</blockquote><p><MathText text={item.explanation}/></p><p className="practice-correct"><MathText text={`正确理解：${item.correct}`}/></p></div>)}</>}
          {!!feedback.missingPoints?.length && <><h3>本题漏答的知识点</h3>{feedback.missingPoints.map((item,index)=><div className="practice-knowledge-point" key={index}>
            <strong>{item.point}</strong><p><MathText text={item.explanation}/></p></div>)}</>}
          {!feedback.corrections?.length && !feedback.missingPoints?.length && <p className="practice-feedback-note">本次评价未指出明确的错漏知识点。</p>}
        </> : <>
          {!!feedback.missing?.length && <><h3>对照本题检查</h3><ul>{feedback.missing.map((item,index)=><li key={index}>{aspects[item]}</li>)}</ul></>}
        </>}
        <div className="practice-reference-answer"><h3>{feedback.questionKind==="technical" ? "参考答案" : "回答思路"}</h3>
          {reference.text && <p><MathText text={reference.text}/></p>}
          {reference.loading && <p role="status">{reference.text ? "正在继续生成…" : "回答模型正在生成参考内容…"}</p>}
          {reference.error && <p className="practice-reference-error" role="alert">{reference.error}</p>}
          {!reference.loading && (!reference.text || reference.error) && <button className="practice-secondary" disabled={updating || !!busy}
            onClick={()=>{const turn=turnsRef.current.slice(-1)[0];if(question && turn)void generateReference(question,turn.id);}}>
            {reference.error ? "重新生成" : feedback.questionKind==="technical" ? "生成参考答案" : "生成参考思路"}</button>}
        </div>
        <p className="practice-feedback-note">参考内容由当前回答模型生成，技术事实与评分仍需核对。项目题只给组织思路，不编造本人做过的机制、职责或成果。</p>
        <button className="start-btn" disabled={!active || !!busy || reference.loading} onClick={()=>void ask()}>下一题</button>
      </div> : <div className="practice-feedback-empty"><Sparkles size={30}/><h3>提交回答后查看反馈</h3><p>评分用于练习，不等同于真实面试评价。</p></div>}
    </section>
  </main>;
}
