import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import { open as choosePath, save as chooseBackupPath } from "@tauri-apps/plugin-dialog";
import { isRegistered, register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { exit } from "@tauri-apps/plugin-process";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Activity, AudioLines, Check, ChevronDown, CircleHelp, FileText, Headphones, LockKeyhole, Pencil,
  Maximize2, Mic2, Minus, MonitorPlay, Moon, PanelLeftClose, PanelLeftOpen, Pause, Pin, Play, Radio, RefreshCw, ScanText, Settings2, Sparkles, Sun,
  Square, Volume2, X } from "lucide-react";
import { questionTransition } from "./decisionStability";
import { dialogueContext } from "./dialogueContext";
import {isSelfIntroductionRequest} from "./selfIntroduction";
import { AnswerRace, rememberQuestion, type AnswerSource } from "./answerRace";
import { MathText } from "./MathText";
import {SoftwareUpdate,useSoftwareUpdate} from "./SoftwareUpdate";
import {useHistoryRecorder} from "./history";
import {HistoryView} from "./HistoryView";
import {connectModel,validateModelAddress} from "./modelConnection";
import { connectionModel, modelServices, serviceId, serviceDefaults, sharedConnectionDefault, patchModelConnection,
  type ModelApi, type ModelConfig, type ServiceId } from "./modelProviders";
import { PracticeView, type Resume, type Analysis, type PracticeConfig } from "./PracticeView";

type Api = ModelApi;
type SttMode = "local" | "api";
type SttApiProvider = "groq_whisper" | "deepgram";
type Mode = "live" | "video";
type Status = "idle" | "listening" | "deciding" | "generating" | "error";
type DisplaySource = AnswerSource | "saved";
type ModelEndpoint = ModelConfig & { credentialSlot: string };
type OllamaRuntime = { executable: string | null; configuredExecutable: string | null;
  configFile: string; modelsDirectory: string | null; connected: boolean };
type PullProgress = { model: string; status: string; completed?: number; total?: number };
type Settings = {
  mode: Mode; output: string; mic: string; sttMode: SttMode; sttEngine: string; sttModel: string;
  sttApiProvider: SttApiProvider; sttApiModel: string; domain: "general" | "ai" | "communication";
  decision: ModelConfig; answer: ModelConfig; answerInstructions: string;
  sharedModelConnection: boolean; separateDecision?: ModelConfig;
  parallelAnswer: boolean; parallelLocal: ModelConfig;
  launcherOnTop: boolean; quitShortcut: string;
  compactView: boolean; transcriptVisible: boolean; answerVisible: boolean;
  theme: "dark" | "light"; opacity: number;
  targetRole: string; focusTopics: string; resumePath: string;
  micTranscription:boolean; selfIntroduction:string;
  decisionFinalOnly:boolean;
};
type SavedProfile = {settings:Settings;resumeAnalysis:{hash:string;analysis:Analysis}|null;
  practiceConfig?:PracticeConfig|null};
type PrivacyDisplayState = {launcher_capture_excluded:boolean;overlay_capture_excluded:boolean;taskbar_hidden:boolean;errors:string[]};
type Device = { id: string; name: string; is_default: boolean };
type ModelInfo = { id: string; name: string; is_downloaded: boolean; is_streaming: boolean; engine: string };
type EngineInfo = { engine: string; name: string; models: ModelInfo[] };
type Segment = { id: string; text: string; speaker: string; timestamp_ms: number; is_final: boolean };
type Decision = { intent: string; relation: string; action: "wait" | "show" | "revise" | "keep"; question: string;
  focus: string[]; key_terms: string[]; constraints: string[]; uncertain_terms: string[] };
type OverlayState = { question: string; hint: string; status: Status; locked: boolean;
  uncertainTerms: string[]; keyTerms: string[]; detail: string; detailLoading: boolean; detailAvailable?:boolean };
type PracticePreview = {question:string;hint:string};

const ANSWER_PROMPT_EXAMPLE = "我是一名 XX 方向的研究生，目前正在进行秋招技术面试。请把听到的技术问题转成便于口头回答的中文提示：首次出现英文术语时给中文释义，缩写能确认时先给英文全称和中文含义；然后简短说明定义与关键原理。每段一到两句话，避免空话。比较题说明选择依据和适用边界；不要编造我的项目经历。";

const defaults: Settings = {
  mode: "live", output: "default", mic: "default", sttMode: "local", sttEngine: "whisper_cpp", sttModel: "small",
  sttApiProvider: "groq_whisper", sttApiModel: "whisper-large-v3-turbo", domain: "general",
  launcherOnTop: false, quitShortcut: "Control+Backquote",
  compactView: false, transcriptVisible: true, answerVisible: true, theme: "dark", opacity: 100,
  targetRole: "", focusTopics: "", resumePath: "",
  micTranscription:true, selfIntroduction:"",decisionFinalOnly:false,
  decision: {api:"ollama",baseUrl:"http://127.0.0.1:11434",model:"qwen3:4b-instruct",modelSelection:"auto"},
  answer: {api:"ollama",baseUrl:"http://127.0.0.1:11434",model:"qwen3:4b-instruct",modelSelection:"auto"},
  answerInstructions: "",
  sharedModelConnection: true,
  parallelAnswer: false, parallelLocal: {api:"ollama",baseUrl:"http://127.0.0.1:11434",model:"qwen3:4b-instruct",modelSelection:"manual"},
};

function loadSettings(input?: unknown): Settings {
  try {
    const old = (input ?? JSON.parse(localStorage.getItem("interviewCue.settings") || "{}")) as any;
    if (!old || typeof old !== "object" || Array.isArray(old)) return defaults;
    const shared = {api:old.api || defaults.decision.api,baseUrl:old.baseUrl || defaults.decision.baseUrl};
    const sttEngine = old.sttEngine === "sherpa_bilingual" ? "sherpa_bilingual" : "whisper_cpp";
    const sttModel = sttEngine === "sherpa_bilingual"
      ? (["zipformer-zh-en","paraformer-zh-en"].includes(old.sttModel) ? old.sttModel : "zipformer-zh-en")
      : (old.sttEngine && old.sttEngine !== "whisper_cpp" ? defaults.sttModel : old.sttModel || defaults.sttModel);
    const normalize = (stage: ModelConfig): ModelConfig => {
      if (stage.api !== "openai" || !/^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(stage.baseUrl)) return stage;
      return {...stage,api:"deepseek",model:stage.model.startsWith("qwen3:") ? "deepseek-flash" : stage.model};
    };
    let previousPractice: {role?:string;topics?:string} = {};
    try {previousPractice=JSON.parse(localStorage.getItem("interviewCue.practiceConfig") || "{}");} catch { /* Older settings may be malformed. */ }
    const decision=normalize({...defaults.decision,...shared,model:old.decisionModel || defaults.decision.model,...old.decision,
      modelSelection:old.decision?.modelSelection || (old.decision || old.decisionModel || old.api ? "manual" : "auto")});
    const answer=normalize({...defaults.answer,...shared,model:old.answerModel || defaults.answer.model,...old.answer,
      modelSelection:old.answer?.modelSelection || (old.answer || old.answerModel || old.api ? "manual" : "auto")});
    const sharedModelConnection=sharedConnectionDefault(old);
    return {...defaults,...old,sttEngine,sttModel,sharedModelConnection,
      micTranscription:old.micTranscription!==false,
      decisionFinalOnly:old.decisionFinalOnly===true,
      selfIntroduction:typeof old.selfIntroduction === "string" ? old.selfIntroduction.slice(0,4000) : "",
      parallelAnswer:old.parallelAnswer===true,
      parallelLocal:{...defaults.parallelLocal,...old.parallelLocal,api:"ollama"},
      targetRole:typeof old.targetRole === "string" ? old.targetRole.slice(0,120) :
        (typeof previousPractice.role === "string" ? previousPractice.role.slice(0,120) : ""),
      focusTopics:typeof old.focusTopics === "string" ? old.focusTopics.slice(0,300) :
        (typeof previousPractice.topics === "string" ? previousPractice.topics.slice(0,300) : ""),
      resumePath:typeof old.resumePath === "string" ? old.resumePath : "",
      answerInstructions:typeof old.answerInstructions === "string" ? old.answerInstructions.slice(0,1200) : "",
      quitShortcut:typeof old.quitShortcut === "string" && old.quitShortcut ? old.quitShortcut : defaults.quitShortcut,
      transcriptVisible:old.transcriptVisible !== false,
      answerVisible:old.answerVisible !== false,
      theme:old.theme === "light" ? "light" : "dark",
      opacity:Math.max(70,Math.min(100,Number(old.opacity) || 100)),
      decision:sharedModelConnection ? answer : decision,answer};
  }
  catch { return defaults; }
}

function savedResumeAnalysis(): SavedProfile["resumeAnalysis"] {
  try {
    const saved=JSON.parse(localStorage.getItem("interviewCue.resumeAnalysis") || "null");
    return typeof saved?.hash === "string" && saved.analysis && typeof saved.analysis === "object"
      ? saved as SavedProfile["resumeAnalysis"] : null;
  } catch {return null;}
}

function savedPracticeConfig(): PracticeConfig|null {
  try {
    const saved=JSON.parse(localStorage.getItem("interviewCue.practiceConfig") || "null");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as PracticeConfig : null;
  } catch {return null;}
}

const statusText: Record<Status, string> = {
  idle: "尚未开始", listening: "正在聆听", deciding: "正在理解问题", generating: "正在生成提示", error: "需要检查",
};

function useAppVersion() {
  const [version, setVersion] = useState("");
  useEffect(() => {void getVersion().then(setVersion).catch(() => {});}, []);
  return version;
}

function capturedShortcut(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = event.code === "Backquote" ? "Backquote" :
    /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) :
    /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) :
    /^F(?:[1-9]|1[0-2])$/.test(event.code) ? event.code : "";
  const modifiers = [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"]
    .filter(Boolean) as string[];
  return key && modifiers.length ? [...modifiers,key].join("+") : null;
}

function shortcutLabel(shortcut: string): string {
  return shortcut.replace("Control", "Ctrl").replace("Backquote", "`").replaceAll("+", " + ");
}

type DiagnosticEntry = {time:string;event:string;detail:string};
function loadDiagnostics(): DiagnosticEntry[] {
  try {const value=JSON.parse(localStorage.getItem("interviewCue.diagnostics") || "[]");
    return Array.isArray(value) ? value.slice(-80) : [];}
  catch {return [];}
}

function credentialSlot(config: ModelConfig, stage: "decision" | "answer"): string {
  try {new URL(config.baseUrl);return `interview_cue_${stage}@${config.baseUrl.trim().replace(/\/+$/,"")}`;}
  catch {return `interview_cue_${stage}@invalid`;}
}

function endpoint(config: ModelConfig, stage: "decision" | "answer", shared=false): ModelEndpoint {
  return {...config, credentialSlot:credentialSlot(config,shared ? "answer" : stage)};
}

function topicBackground(settings:Settings,resume:Resume|null,analysis:Analysis|null,includeResume:boolean) {
  const selected=[settings.targetRole.trim(),settings.focusTopics.trim()].filter(Boolean);
  if (includeResume && resume && analysis) {
    const source=resume.text.toLowerCase();
    const terms=[...(Array.isArray(analysis.skills)?analysis.skills:[]),
      ...(Array.isArray(analysis.suggestedTopics)?analysis.suggestedTopics:[])];
    selected.push(...terms.filter((term):term is string=>typeof term==="string" && term.length<=40 &&
      source.includes(term.toLowerCase())).slice(0,8));
  }
  return [...new Set(selected)].join("；").slice(0,400);
}

function modelConnectionError(config: ModelConfig, cause: unknown, listing = false): string {
  const detail = String(cause);
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(config.baseUrl);
  if (local && /error sending request|connection refused|tcp connect|os error 10061/i.test(detail)) {
    return config.api === "ollama"
      ? "本机 Ollama 服务未启动或端口不对。请在上方启动 Ollama，再重试。"
      : `本机地址 ${config.baseUrl} 没有响应。请启动对应服务并核对端口；使用 DeepSeek 官方 API 时请选择“DeepSeek 官方 API”。`;
  }
  if (/401|unauthorized/i.test(detail)) return "密钥未获授权，请核对 API 密钥及接口地址。";
  if (/403|forbidden/i.test(detail)) return "服务拒绝访问，请检查账号权限或密钥。";
  if (listing && /404|not found|405|method not allowed/i.test(detail))
    return "该服务可能不提供模型列表；手动填写模型 ID，再点“测试对话接口”即可验证。";
  return detail;
}

// Delegate from the whole title bar so nested text, badges and control gaps drag too.
function dragWindow(event: MouseEvent<HTMLElement>) {
  if(event.button!==0 || event.defaultPrevented || (event.target as Element).closest(
    "button,[role=button],input,select,textarea,a,summary,[contenteditable],[data-no-window-drag]"))return;
  event.preventDefault();
  void getCurrentWebviewWindow().startDragging().catch(cause=>console.error("窗口拖动失败",cause));
}

function ResizeCorners() {
  const corners=(["NorthWest","NorthEast","SouthWest","SouthEast"] as const);
  return <>{corners.map(direction=><div key={direction} className={`resize-corner resize-${direction.toLowerCase()}`}
    role="presentation" onMouseDown={event=>{
      if(event.button!==0)return;
      event.preventDefault();event.stopPropagation();
      void getCurrentWebviewWindow().startResizeDragging(direction);
    }}/>)}</>;
}

function Overlay() {
  const version = useAppVersion();
  const [appearance, setAppearance] = useState(() => {
    const value=loadSettings();return {theme:value.theme,opacity:value.opacity};
  });
  const [state, setState] = useState<OverlayState>({ question: "", hint: "", status: "idle", locked: false,
    uncertainTerms: [], keyTerms: [], detail: "", detailLoading: false });
  const [practice,setPractice] = useState<PracticePreview|null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true; let unlisten: UnlistenFn | undefined;
    listen<OverlayState>("mvp_ui_state", event => { if (active) setState(event.payload); }).then(stop => { unlisten = stop; });
    let practiceStop: UnlistenFn | undefined;
    listen<PracticePreview & {enabled:boolean}>("mvp_practice_ui_state",event=>{
      if(active)setPractice(event.payload.enabled ? event.payload : null);
    }).then(stop=>{practiceStop=stop;});
    let appearanceStop: UnlistenFn | undefined;
    listen<{theme:"dark"|"light";opacity:number}>("mvp_appearance", event => {
      if (active) setAppearance(event.payload);
    }).then(stop => {appearanceStop=stop;});
    void emit("mvp_overlay_ready");
    return () => { active = false; unlisten?.();practiceStop?.();appearanceStop?.(); };
  }, []);
  return <div className={`floating-shell theme-${appearance.theme}`} style={{opacity:appearance.opacity/100}}>
    <div className="floating-head" onMouseDown={dragWindow}><div className="brand-mark small"><Sparkles size={18}/></div>
      <span>模拟面试练习</span>{version && <span className="app-version">v{version}</span>}<span className="floating-status">{practice?"模拟练习":statusText[state.status]}</span>
      <button className="icon-btn" aria-label="隐藏提示窗" onClick={() => void getCurrentWebviewWindow().hide()}><X size={16}/></button></div>
    <div className="floating-body">
      <div className="eyebrow">当前问题 {!practice && state.locked && <span className="lock-note"><LockKeyhole size={12}/> 正在说话，暂停更新</span>}</div>
      <div className="floating-question"><MathText text={practice ? (practice.question || "等待练习问题…") : (state.question || "等待面试官提出问题…")}/></div>
      {!practice && state.keyTerms.length > 0 && <div className="term-list">{state.keyTerms.map(term=><span className="term-chip" key={term}>{term}</span>)}</div>}
      {!practice && state.uncertainTerms.length > 0 && <div className="term-warning">术语待确认：{state.uncertainTerms.join("、")}</div>}
      <div className={expanded ? "floating-answer expanded" : "floating-answer"}>{practice ? (practice.hint ? <MathText text={practice.hint}/> : <span className="placeholder">回答后查看复盘</span>) : (state.hint ? <MathText text={state.hint}/> : <span className="placeholder">答案要点会出现在这里</span>)}</div>
      {!practice && state.hint && state.detailAvailable!==false && <button className="floating-expand" onClick={()=>{
        if (!expanded && (!state.detail || state.detail.startsWith("原理解释失败：")) && !state.detailLoading)
          void emit("mvp_detail_request");
        setExpanded(value=>!value);
      }} aria-expanded={expanded}>{expanded ? "收起细节" : "展开细节"}</button>}
      {!practice && expanded && state.hint && state.detailAvailable!==false && <div className="floating-detail"><MathText text={state.detailLoading ? "正在补充细节…" : state.detail || "等待补充细节…"}/></div>}
    </div>
    <div className="floating-foot"><span className="live-dot"/> {practice?"模拟练习":"面试提示"} <span>·</span> 内容仅供参考</div>
    <ResizeCorners/>
  </div>;
}

function Main() {
  const version = useAppVersion();
  const [workspaceMode, setWorkspaceMode] = useState<"practice" | "assist">("practice");
  const [practiceSetupVisible,setPracticeSetupVisible] = useState(true);
  const [practiceFeedbackVisible,setPracticeFeedbackVisible] = useState(true);
  const [practiceActive, setPracticeActive] = useState(false);
  const [practiceWorking,setPracticeWorking] = useState(false);
  const [practicePreview,setPracticePreview] = useState<PracticePreview>({question:"",hint:"设置练习范围后开始。"});
  const [switchNotice, setSwitchNotice] = useState("");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [resume, setResume] = useState<Resume|null>(null);
  const [resumeAnalysis, setResumeAnalysis] = useState<Analysis|null>(null);
  const [resumeError, setResumeError] = useState("");
  const [profileReady, setProfileReady] = useState(false);
  const [profileWritable, setProfileWritable] = useState(false);
  const [profileEpoch, setProfileEpoch] = useState(0);
  const [practiceConfigEpoch, setPracticeConfigEpoch] = useState(0);
  const [profileNotice, setProfileNotice] = useState("");
  const [profileError, setProfileError] = useState("");
  const [privacy, setPrivacy] = useState<PrivacyDisplayState | null>(null);
  const [privacyError, setPrivacyError] = useState("");
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [restoreReady, setRestoreReady] = useState(false);
  const [recordingQuitShortcut, setRecordingQuitShortcut] = useState(false);
  const [quitShortcutDraft, setQuitShortcutDraft] = useState("");
  const [quitShortcutError, setQuitShortcutError] = useState("");
  const lastRegisteredShortcutRef = useRef("");
  const shortcutQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [restoreShortcutLabel, setRestoreShortcutLabel] = useState("");
  const restoreShortcutRef = useRef("");
  const quitShortcutInputRef = useRef<HTMLInputElement>(null);
  const [devices, setDevices] = useState<{inputs: Device[]; outputs: Device[]}>({inputs:[], outputs:[]});
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [decisionModels, setDecisionModels] = useState<string[]>([]);
  const [answerModels, setAnswerModels] = useState<string[]>([]);
  const [decisionReady, setDecisionReady] = useState(false);
  const [answerReady, setAnswerReady] = useState(false);
  const [modelErrors, setModelErrors] = useState<{decision:string;answer:string}>({decision:"",answer:""});
  const [modelTests, setModelTests] = useState<{decision:string;answer:string}>({decision:"",answer:""});
  const [testingModel, setTestingModel] = useState<"decision" | "answer" | null>(null);
  const [linkingModels,setLinkingModels]=useState(false);
  const [connectedModels,setConnectedModels]=useState<{decision:string;answer:string}>({decision:"",answer:""});
  const [advancedModels,setAdvancedModels]=useState<{decision:boolean;answer:boolean}>({decision:false,answer:false});
  const modelActionRef=useRef(false);
  const connectionEpochRef=useRef(0);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>(loadDiagnostics);
  const [savedKeys, setSavedKeys] = useState<Record<string,boolean>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string,string>>({});
  const [startingService, setStartingService] = useState(false);
  const [ollamaRuntime, setOllamaRuntime] = useState<OllamaRuntime | null>(null);
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [ollamaCheckError, setOllamaCheckError] = useState("");
  const [ollamaExeDraft, setOllamaExeDraft] = useState("");
  const [ollamaModelsDraft, setOllamaModelsDraft] = useState("");
  const [sttModelsDirectory, setSttModelsDirectory] = useState("");
  const [ollamaNotice, setOllamaNotice] = useState("");
  const [pullModelId, setPullModelId] = useState("qwen3:4b-instruct");
  const [pullProgress, setPullProgress] = useState("");
  const [pulling, setPulling] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [partial, setPartial] = useState<Segment | null>(null);
  const [micPartial, setMicPartial] = useState<Segment|null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [editingQuestion, setEditingQuestion] = useState(false);
  const [questionDraft, setQuestionDraft] = useState("");
  const [hint, setHint] = useState("");
  const [uncertainTerms, setUncertainTerms] = useState<string[]>([]);
  const [keyTerms, setKeyTerms] = useState<string[]>([]);
  const [detail, setDetail] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [systemLevel, setSystemLevel] = useState(0);
  const [locked, setLocked] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"display" | "audio" | "profile" | "models" | "updates" | "diagnostics" | "history">("display");
  const {recorder:liveHistory,error:historyError}=useHistoryRecorder();
  const [historyNativeError,setHistoryNativeError]=useState("");
  const {recorder:practiceHistoryRecorder,error:practiceHistoryError}=useHistoryRecorder();
  const [showDetail, setShowDetail] = useState(false);
  const [download, setDownload] = useState("");
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [decisionMs, setDecisionMs] = useState<number | null>(null);
  const [answerSource, setAnswerSource] = useState<DisplaySource|null>(null);
  const [apiPending, setApiPending] = useState(false);
  const [parallelModels, setParallelModels] = useState<string[]>([]);
  const [answerMs, setAnswerMs] = useState<number | null>(null);
  const [visibleMs, setVisibleMs] = useState<number | null>(null);
  const [completeMs, setCompleteMs] = useState<number | null>(null);
  const [transcriptToCompleteMs, setTranscriptToCompleteMs] = useState<number | null>(null);
  const settingsRef = useRef(settings);
  const workspaceModeRef = useRef(workspaceMode);
  const practicePreviewRef = useRef(practicePreview);
  const resumeRef = useRef<Resume|null>(null);
  const resumeAnalysisRef = useRef<Analysis|null>(null);
  const runningRef = useRef(false);
  const segmentsRef = useRef<Segment[]>([]);
  const partialRef = useRef<Segment | null>(null);
  const micPartialRef = useRef<Segment|null>(null);
  const savedIntroductionRef = useRef(false);
  const questionRef = useRef("");
  const visibleQuestionRef = useRef("");
  const visibleTermsRef = useRef<string[]>([]);
  const visibleKeyTermsRef = useRef<string[]>([]);
  const detailRef = useRef("");
  const detailLoadingRef = useRef(false);
  const activeSourceRef = useRef("");
  const manualOverrideSourceRef = useRef("");
  const revisedSourceRef = useRef("");
  const answerTaskRef = useRef("");
  const hintRef = useRef("");
  const visibleHintRef = useRef("");
  const uncertainRef = useRef<string[]>([]);
  const lockedRef = useRef(false);
  const pendingHintRef = useRef("");
  const pendingDisplayRef = useRef<{question:string;terms:string[];keyTerms:string[];hint:string;
    requestId:string;startedAt:number;asrAt:number|null;source:DisplaySource}|null>(null);
  const micLastActiveRef = useRef(0);
  const captureStartingRef = useRef(false);
  const decisionBusyRef = useRef(false);
  const decisionPendingRef = useRef<{text:string;sourceId:string;isFinal:boolean;version:number;receivedAt:number}|null>(null);
  const decisionVersionRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const lastDecisionTextRef = useRef("");
  const decisionTimerRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastDecisionAtRef = useRef(0);
  const answerRequestRef = useRef("");
  const answerStartedRef = useRef(0);
  const answerRaceRef = useRef<AnswerRace|null>(null);
  const questionHistoryRef = useRef<string[]>([]);
  const visibleAnswerRequestRef = useRef("");
  const detailRequestRef = useRef("");
  const answerDisplayRef = useRef<{question:string;terms:string[];keyTerms:string[];
    transition:"first"|"new"|"revision";lastShown:string;requestId:string;startedAt:number;asrAt:number|null;source:DisplaySource}|null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const profileWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const profileWritableRef = useRef(false);
  const quitRef = useRef<()=>Promise<void>>(async()=>{});
  const quittingRef = useRef(false);

  useEffect(() => {
    let cancelled=false;
    void invoke<SavedProfile|null>("load_interview_profile").then(profile=>{
      if(cancelled)return;
      if(profile){
        const restored=loadSettings(profile.settings);
        localStorage.setItem("interviewCue.settings",JSON.stringify(restored));
        if(profile.practiceConfig)localStorage.setItem("interviewCue.practiceConfig",JSON.stringify(profile.practiceConfig));
        if(profile.resumeAnalysis) localStorage.setItem("interviewCue.resumeAnalysis",JSON.stringify(profile.resumeAnalysis));
        else localStorage.removeItem("interviewCue.resumeAnalysis");
        settingsRef.current=restored;connectionEpochRef.current++;
        setSettings(restored);
      }
      setProfileEpoch(value=>value+1);
      profileWritableRef.current=true;setProfileWritable(true);
      setProfileReady(true);
    }).catch(cause=>{
      if(cancelled)return;
      setProfileError(`读取配置文件失败，暂用当前窗口设置，未覆盖原配置。可从备份文件恢复：${String(cause)}`);
      setProfileReady(true);
    });
    return()=>{cancelled=true;};
  },[]);
  useEffect(() => { settingsRef.current = settings; localStorage.setItem("interviewCue.settings", JSON.stringify(settings)); }, [settings]);
  useEffect(() => {
    if(!profileReady || !profileWritable)return;
    const timer=window.setTimeout(()=>{
      const profile:SavedProfile={settings,resumeAnalysis:savedResumeAnalysis(),practiceConfig:savedPracticeConfig()};
      const save=profileWriteQueueRef.current.catch(()=>{}).then(()=>invoke("save_interview_profile",{profile}));
      profileWriteQueueRef.current=save;
      void save.then(()=>setProfileError(""))
        .catch(cause=>setProfileError(`自动保存配置失败：${String(cause)}`));
    },350);
    return()=>window.clearTimeout(timer);
  },[settings,resumeAnalysis,practiceConfigEpoch,profileReady,profileWritable]);
  const flushProfile=useCallback(async()=>{
    await liveHistory.flush();await practiceHistoryRecorder.flush();
    if(!profileWritableRef.current)return;
    const profile:SavedProfile={settings:settingsRef.current,resumeAnalysis:savedResumeAnalysis(),practiceConfig:savedPracticeConfig()};
    const save=profileWriteQueueRef.current.catch(()=>{}).then(()=>invoke("save_interview_profile",{profile}));
    profileWriteQueueRef.current=save;await save;
  },[]);
  quitRef.current=async()=>{
    if(quittingRef.current)return;
    quittingRef.current=true;
    try {liveHistory.end();practiceHistoryRecorder.end();await flushProfile();await exit(0);}
    catch(cause){setProfileError(`关闭前保存配置失败，程序仍保持打开：${String(cause)}`);}
    finally{quittingRef.current=false;}
  };
  useEffect(()=>{
    let cancelled=false;let stop:UnlistenFn|undefined;
    void getCurrentWebviewWindow().onCloseRequested(event=>{
      event.preventDefault();return quitRef.current();
    }).then(unlisten=>{if(cancelled)unlisten();else stop=unlisten;});
    return()=>{cancelled=true;stop?.();};
  },[]);
  const updateBlocked=running || practiceActive || practiceWorking || !profileReady ||
    startingService || testingModel!==null || linkingModels || !!download || pulling ||
    status==="deciding" || status==="generating" || detailLoading;
  const updater=useSoftwareUpdate(updateBlocked,flushProfile);
  const softwareUpdatingRef=useRef(false);softwareUpdatingRef.current=updater.busy;
  const onPracticeConfigChange=useCallback(()=>setPracticeConfigEpoch(value=>value+1),[]);
  useEffect(() => {
    workspaceModeRef.current=workspaceMode;practicePreviewRef.current=practicePreview;
    void emit("mvp_practice_ui_state",{enabled:workspaceMode==="practice",...practicePreview});
  },[workspaceMode,practicePreview]);
  useEffect(() => {resumeRef.current=resume;resumeAnalysisRef.current=resumeAnalysis;},[resume,resumeAnalysis]);
  useEffect(() => {
    if (!settings.resumePath) {setResume(null);setResumeAnalysis(null);setResumeError("");return;}
    let cancelled=false;
    void invoke<Resume>("practice_read_resume",{path:settings.resumePath}).then(loaded=>{
      if(cancelled)return;
      resumeRef.current=loaded;setResume(loaded);setResumeError("");
      try {const saved=JSON.parse(localStorage.getItem("interviewCue.resumeAnalysis") || "null");
        setResumeAnalysis(saved?.hash===loaded.hash ? saved.analysis as Analysis : null);
      } catch {setResumeAnalysis(null);}
    }).catch(cause=>{if(!cancelled){resumeRef.current=null;setResume(null);setResumeAnalysis(null);setResumeError(`已保存的简历无法重新读取：${String(cause)}`);}});
    return ()=>{cancelled=true;};
  },[settings.resumePath,profileEpoch]);
  const importResume = (path:string,loaded:Resume) => {
    localStorage.removeItem("interviewCue.resumeAnalysis");
    resumeRef.current=loaded;resumeAnalysisRef.current=null;
    setResume(loaded);setResumeAnalysis(null);setResumeError("");
    setSettings(current=>({...current,resumePath:path}));
  };
  const chooseSharedResume = async () => {
    const path=await choosePath({multiple:false,directory:false,
      filters:[{name:"简历",extensions:["pdf","docx","txt","md"]}]});
    if (typeof path!=="string") return;
    try {importResume(path,await invoke<Resume>("practice_read_resume",{path}));}
    catch (cause) {setResumeError(`导入简历失败：${String(cause)}`);}
  };
  const storeResumeAnalysis = (analysis:Analysis) => {
    if (!resumeRef.current) return;
    setResumeAnalysis(analysis);resumeAnalysisRef.current=analysis;
    localStorage.setItem("interviewCue.resumeAnalysis",JSON.stringify({hash:resumeRef.current.hash,analysis}));
  };
  const clearResume = () => {
    localStorage.removeItem("interviewCue.resumeAnalysis");
    resumeRef.current=null;resumeAnalysisRef.current=null;
    setResume(null);setResumeAnalysis(null);setResumeError("");
    setSettings(current=>({...current,resumePath:""}));
  };
  useEffect(() => {void emit("mvp_appearance",{theme:settings.theme,opacity:settings.opacity});},[settings.theme,settings.opacity]);
  useEffect(() => {if (recordingQuitShortcut) quitShortcutInputRef.current?.focus();}, [recordingQuitShortcut]);
  useEffect(() => {
    void getCurrentWebviewWindow().setAlwaysOnTop(settings.launcherOnTop)
      .catch(cause => setError(`设置窗口置顶失败：${String(cause)}`));
  }, [settings.launcherOnTop]);
  useEffect(() => {
    let cancelled = false;
    const shortcut = settings.quitShortcut;
    const sync = async () => {
      const previous=lastRegisteredShortcutRef.current;
      if(previous){try{await unregister(previous);}catch{/* Registration may already be gone. */}lastRegisteredShortcutRef.current="";}
      if(cancelled || recordingQuitShortcut)return;
      try {
        if(shortcut===restoreShortcutRef.current)throw new Error("该组合键已用于恢复任务栏");
        // A WebView reload can leave an app-owned registration behind.
        if(await isRegistered(shortcut))await unregister(shortcut);
        if(cancelled)return;
        await register(shortcut,event=>{if(event.state==="Pressed")void quitRef.current();});
        if(cancelled){await unregister(shortcut);return;}
        lastRegisteredShortcutRef.current=shortcut;
        setQuitShortcutError("");
      } catch(cause) {
        if(cancelled)return;
        setQuitShortcutError(`快捷键 ${shortcutLabel(shortcut)} 注册失败：${String(cause)}。请更换组合键。`);
        setDiagnostics(current=>[...current,{time:new Date().toISOString(),event:"退出快捷键注册失败",detail:String(cause)}].slice(-80));
      }
    };
    shortcutQueueRef.current=shortcutQueueRef.current.then(sync,sync);
    return () => {
      cancelled=true;
      shortcutQueueRef.current=shortcutQueueRef.current.then(async()=>{
        if(lastRegisteredShortcutRef.current===shortcut){
          await unregister(shortcut);lastRegisteredShortcutRef.current="";
        }
      }).catch(()=>{});
    };
  }, [settings.quitShortcut,recordingQuitShortcut]);
  useEffect(() => {localStorage.setItem("interviewCue.diagnostics",JSON.stringify(diagnostics));}, [diagnostics]);
  useEffect(() => {visibleQuestionRef.current=question;visibleTermsRef.current=uncertainTerms;
    visibleKeyTermsRef.current=keyTerms;}, [question,uncertainTerms,keyTerms]);
  useEffect(() => {visibleHintRef.current=hint;}, [hint]);
  useEffect(() => {detailRef.current=detail;detailLoadingRef.current=detailLoading;}, [detail,detailLoading]);
  useEffect(() => {
    const container=transcriptScrollRef.current;
    if (container && followTranscriptRef.current) container.scrollTop=segments.length || partial || micPartial ? container.scrollHeight : 0;
  }, [segments, partial, micPartial, workspaceMode]);
  useEffect(() => {
    const state: OverlayState = {question, hint, status, locked, uncertainTerms, keyTerms, detail, detailLoading, detailAvailable:answerSource!=="saved"};
    void emit("mvp_ui_state", state);
  }, [question, hint, status, locked, uncertainTerms, keyTerms, detail, detailLoading, answerSource]);

  const refreshDevices = useCallback(async () => {
    try { setDevices(JSON.parse(await invoke<string>("list_audio_devices"))); }
    catch (cause) { setError(`读取音频设备失败：${String(cause)}`); }
  }, []);
  const refreshEngines = useCallback(async () => {
    try {
      const raw = JSON.parse(await invoke<string>("list_local_stt_engines")) as Array<{
        engine:string;name:string;models:Array<{definition:{model_id:string;display_name:string;is_streaming:boolean};is_downloaded:boolean}>}>;
      setEngines(raw.map(item=>({engine:item.engine,name:item.name,models:item.models.map(model=>({
        id:model.definition.model_id,name:model.definition.display_name,engine:item.engine,
        is_streaming:model.definition.is_streaming,is_downloaded:model.is_downloaded,
      }))})));
    }
    catch (cause) { setError(`读取语音模型失败：${String(cause)}`); }
  }, []);
  const refreshSttModelsDirectory = useCallback(async () => {
    try { setSttModelsDirectory(await invoke<string>("local_stt_model_directory")); }
    catch (cause) { setError(`读取语音模型目录失败：${String(cause)}`); }
  }, []);
  const logDiagnostic = useCallback((event:string,detail="") => {
    setDiagnostics(current=>[...current,{time:new Date().toISOString(),event,detail}].slice(-80));
  }, []);
  useEffect(() => {
    let active=true;
    const restore = (event: {state:string})=>{
      if(event.state!=="Pressed")return;
      void invoke<PrivacyDisplayState>("set_taskbar_hidden",{enabled:false}).then(state=>{
        setPrivacy(state);logDiagnostic("恢复普通窗口");
        const window=getCurrentWebviewWindow();
        void window.show().then(()=>window.unminimize()).then(()=>window.setFocus());
      }).catch(cause=>setPrivacyError(`恢复窗口失败：${String(cause)}`));
    };
    let registered="";
    void (async()=>{
      try {
        const state=await invoke<PrivacyDisplayState>("get_privacy_display_state");
        if(!active)return;
        setPrivacy(state);
        if(state.errors.length)setPrivacyError(state.errors.join("；"));
      } catch(cause){if(active)setPrivacyError(`读取隐私显示状态失败：${String(cause)}`);}
      if(!active)return;
      const errors:string[]=[];
      for(const shortcut of ["Control+Shift+Backquote","Control+Alt+Shift+F12"]){
        try {
          if(shortcut===settingsRef.current.quitShortcut)continue;
          if(await isRegistered(shortcut))await unregister(shortcut);
          await register(shortcut,restore);
          if(!active){await unregister(shortcut);return;}
          registered=shortcut;
          restoreShortcutRef.current=shortcut;
          setRestoreShortcutLabel(shortcutLabel(shortcut));
          setRestoreReady(true);
          try {
            const state=await invoke<PrivacyDisplayState>("set_taskbar_hidden",{enabled:true});
            if(!active)return;
            setPrivacy(state);
            if(state.errors.length)setPrivacyError(state.errors.join("；"));
          } catch(cause){
            if(!active)return;
            setPrivacyError(current=>[current,`启动任务栏隐藏失败：${String(cause)}`].filter(Boolean).join("；"));
            logDiagnostic("启动任务栏隐藏失败",String(cause));
            try {
              const state=await invoke<PrivacyDisplayState>("get_privacy_display_state");
              if(active)setPrivacy(state);
            } catch { /* Keep last observed state. */ }
          }
          return;
        } catch(cause){errors.push(`${shortcutLabel(shortcut)}：${String(cause)}`);}
      }
      if(!active)return;
      setRestoreReady(false);
      setPrivacyError(`恢复快捷键注册失败，任务栏隐藏不可用：${errors.join("；")}`);
      logDiagnostic("恢复快捷键注册失败",errors.join("；"));
      try {setPrivacy(await invoke<PrivacyDisplayState>("set_taskbar_hidden",{enabled:false}));}
      catch { /* The launcher remains visible on startup. */ }
    })();
    return()=>{active=false;restoreShortcutRef.current="";if(registered)void unregister(registered);};
  },[logDiagnostic]);
  const changePrivacy = async (capture:boolean,taskbar:boolean) => {
    if(taskbar && !restoreReady){setPrivacyError("恢复窗口快捷键未就绪，不能隐藏任务栏入口。");return;}
    setPrivacyBusy(true);setPrivacyError("");
    try {
      let next=privacy;
      if(!next || next.launcher_capture_excluded!==capture || next.overlay_capture_excluded!==capture){
        next=await invoke<PrivacyDisplayState>("set_capture_exclusion",{enabled:capture});
        setPrivacy(next);
      }
      if(!next || next.taskbar_hidden!==taskbar){
        next=await invoke<PrivacyDisplayState>("set_taskbar_hidden",{enabled:taskbar});
        setPrivacy(next);
      }
      if(next?.errors.length)setPrivacyError(next.errors.join("；"));
      logDiagnostic("隐私显示设置",`捕获排除 ${capture?"开":"关"} · 任务栏隐藏 ${taskbar?"开":"关"}`);
    } catch(cause) {
      setPrivacyError(`设置未完成：${String(cause)}`);
      logDiagnostic("隐私显示失败",String(cause));
      try {setPrivacy(await invoke<PrivacyDisplayState>("get_privacy_display_state"));}catch { /* Keep last observed state. */ }
    } finally {setPrivacyBusy(false);}
  };
  const commitModelConfig=useCallback((stage:"decision"|"answer",patch:Partial<ModelConfig>)=>{
    connectionEpochRef.current++;
    const next=patchModelConnection(settingsRef.current,stage,patch);
    settingsRef.current=next;
    setSettings(next);
    setConnectedModels(current=>next.sharedModelConnection ? {decision:"",answer:""} : {...current,[stage]:""});
    setModelTests(current=>next.sharedModelConnection ? {decision:"",answer:""} : {...current,[stage]:""});
  },[]);
  const refreshModels = useCallback(async (requestedStage: "decision" | "answer", selectDiscovered=false): Promise<string[]|null> => {
    const shared=settingsRef.current.sharedModelConnection;
    const stage=shared ? "answer" : requestedStage;
    const config = settingsRef.current[stage];
    const epoch=connectionEpochRef.current;
    try {
      const names = await invoke<string[]>("mvp_list_models", {endpoint:endpoint(config,stage)});
      if(epoch!==connectionEpochRef.current)return null;
      if (stage === "decision") {setDecisionModels(names);setDecisionReady(true);}
      else {setAnswerModels(names);setAnswerReady(true);}
      setModelErrors(current=>({...current,[stage]:""}));
      if (selectDiscovered && names.length) {
        const selected=connectionModel(config,names);
        if(selected!==config.model)commitModelConfig(stage,{model:selected});
      }
      logDiagnostic("模型列表已刷新",`${stage} · ${config.api} · ${names.length} 个`);
      return names;
    } catch (cause) {
      if(epoch!==connectionEpochRef.current)return null;
      if (stage === "decision") {setDecisionModels([]);setDecisionReady(false);}
      else {setAnswerModels([]);setAnswerReady(false);}
      const message=modelConnectionError(config,cause,true);
      setModelErrors(current=>({...current,[stage]:message}));
      logDiagnostic("模型列表获取失败",`${stage} · ${config.api} · ${message}`);
      return null;
    }
  }, [logDiagnostic,commitModelConfig]);
  const testModelEndpoint = async (stage: "decision" | "answer") => {
    if(modelActionRef.current)return;
    modelActionRef.current=true;
    const config=settingsRef.current[stage];
    const shared=settingsRef.current.sharedModelConnection;
    const slot=credentialSlot(config,shared ? "answer" : stage);
    const epoch=connectionEpochRef.current;
    setTestingModel(stage);
    setModelTests(current=>({...current,[stage]:""}));
    setConnectedModels(current=>({...current,[stage]:""}));
    try {
      validateModelAddress(config);
      const key=keyDrafts[slot]?.trim();
      if(key){
        await invoke("store_api_key",{provider:slot,key});
        setSavedKeys(current=>({...current,[slot]:true}));
        setKeyDrafts(current=>({...current,[slot]:""}));
      }
      const hasKey=key || await invoke<boolean>("has_api_key",{provider:slot});
      if(serviceId(config)!=="custom" && config.api!=="ollama" && !hasKey)throw new Error("请先填入所选服务的 API 密钥。");
      const result=await connectModel(config,{
        list:async current=>{
          const names=await invoke<string[]>("mvp_list_models",{endpoint:endpoint(current,stage,shared)});
          if(epoch===connectionEpochRef.current){
            if(stage==="answer"){setAnswerModels(names);setAnswerReady(true);}else{setDecisionModels(names);setDecisionReady(true);}
          }
          return names;
        },
        test:current=>invoke("mvp_test_model_endpoint",{endpoint:endpoint(current,stage,shared)})
      });
      if(epoch!==connectionEpochRef.current)return;
      if(result.config.model!==config.model)commitModelConfig(stage,{model:result.config.model});
      setConnectedModels(current=>({...current,[stage]:result.config.model}));
      setModelErrors(current=>({...current,[stage]:result.listError ? modelConnectionError(config,result.listError,true) : ""}));
      setModelTests(current=>({...current,[stage]:`已连接 · ${result.config.model}。聊天请求已返回有效文字。`}));
      logDiagnostic("模型对话接口可用",`${stage} · ${config.api} · ${result.config.model}`);
    } catch (cause) {
      if(epoch!==connectionEpochRef.current)return;
      const message=modelConnectionError(config,cause);
      setModelTests(current=>({...current,[stage]:`连接未通过：${message}`}));
      setAdvancedModels(current=>({...current,[stage]:true}));
      logDiagnostic("模型对话接口失败",`${stage} · ${config.api} · ${message}`);
    } finally {setTestingModel(null);modelActionRef.current=false;}
  };
  const refreshOllamaRuntime = useCallback(async () => {
    setOllamaChecking(true);
    setOllamaCheckError("");
    try {
      const status = await invoke<OllamaRuntime>("ollama_runtime_status");
      setOllamaRuntime(status);
      setOllamaExeDraft(current=>status.executable || current);
      setOllamaModelsDraft(current=>status.modelsDirectory || current);
    } catch (cause) {
      setOllamaRuntime(null);
      setOllamaCheckError(String(cause));
      logDiagnostic("Ollama 检测失败",String(cause));
    } finally {setOllamaChecking(false);}
  }, [logDiagnostic]);
  useEffect(() => {
    void refreshDevices(); void refreshEngines(); void refreshSttModelsDirectory();
    void refreshOllamaRuntime();
    for (const slot of ["groq_whisper","deepgram"]) {
      void invoke<boolean>("has_api_key",{provider:slot}).then(present=>setSavedKeys(current=>({...current,[slot]:present}))).catch(()=>{});
    }
  }, [refreshDevices, refreshEngines, refreshOllamaRuntime, refreshSttModelsDirectory]);
  useEffect(() => {
    if (showSettings && settingsTab === "models") void refreshOllamaRuntime();
  }, [showSettings, settingsTab, refreshOllamaRuntime]);
  const chooseSttModelsDirectory = async () => {
    const selected = await choosePath({multiple:false,directory:true});
    if (typeof selected !== "string") return;
    try {
      await invoke("save_local_stt_model_directory", {directory:selected});
      await Promise.all([refreshSttModelsDirectory(),refreshEngines()]);
      setError("");
    } catch (cause) { setError(`选择语音模型目录失败：${String(cause)}`); }
  };
  useEffect(() => {
    if(!profileReady)return;
    if(settings.sharedModelConnection)return;
    const config=settings.decision;
    if (!config.baseUrl) return;
    if (config.api === "ollama") {void refreshModels("decision",true);return;}
    const slot=credentialSlot(config,"decision");
    let active=true;
    void invoke<boolean>("has_api_key",{provider:slot}).then(present=>{
      if (!active) return;
      setSavedKeys(current=>({...current,[slot]:present}));
      if (present) void refreshModels("decision",true);
    }).catch(()=>{});
    return ()=>{active=false;};
  }, [profileReady,settings.decision.api,settings.decision.baseUrl,settings.sharedModelConnection,refreshModels]);
  useEffect(() => {
    if(!profileReady)return;
    const config=settings.answer;
    if (!config.baseUrl) return;
    if (config.api === "ollama") {void refreshModels("answer",true);return;}
    const slot=credentialSlot(config,"answer");
    let active=true;
    void invoke<boolean>("has_api_key",{provider:slot}).then(present=>{
      if (!active) return;
      setSavedKeys(current=>({...current,[slot]:present}));
      if (present) void refreshModels("answer",true);
    }).catch(()=>{});
    return ()=>{active=false;};
  }, [profileReady,settings.answer.api,settings.answer.baseUrl,refreshModels]);
  const saveKey = async (slot: string, stage?: "decision" | "answer") => {
    const key = keyDrafts[slot]?.trim();
    if (!key) return;
    try {
      await invoke("store_api_key",{provider:slot,key});
      setSavedKeys(current=>({...current,[slot]:true}));setKeyDrafts(current=>({...current,[slot]:""}));setError("");
      logDiagnostic("API 密钥已保存",stage || "语音识别");
      if (stage) await refreshModels(stage,true);
    } catch (cause) {setError(`保存密钥失败：${String(cause)}`);}
  };
  const removeKey = async (slot: string, stage?: "decision" | "answer") => {
    try {
      await invoke("delete_api_key",{provider:slot});setSavedKeys(current=>({...current,[slot]:false}));setError("");
      if (stage === "decision") {setDecisionModels([]);setDecisionReady(false);}
      if (stage === "answer") {setAnswerModels([]);setAnswerReady(false);}
      if (stage) setModelErrors(current=>({...current,[stage]:""}));
      if (stage) {
        connectionEpochRef.current++;
        setConnectedModels(current=>({...current,[stage]:""}));
        setModelTests(current=>({...current,[stage]:""}));
      }
      logDiagnostic("API 密钥已删除",stage || "语音识别");
    }
    catch (cause) {setError(`删除密钥失败：${String(cause)}`);}
  };
  const configureStage = (stage:"decision"|"answer", service:ServiceId) => {
    const config=serviceDefaults(service);
    commitModelConfig(stage,config);
    if (stage === "decision") {setDecisionModels([]);setDecisionReady(false);}
    else {setAnswerModels([]);setAnswerReady(false);}
    setModelErrors(current=>({...current,[stage]:""}));
    setModelTests(current=>({...current,[stage]:""}));
    setAdvancedModels(current=>({...current,[stage]:service==="custom"}));
    logDiagnostic("模型服务已切换",`${stage} · ${service}`);
  };
  const toggleSharedModels=async (enabled:boolean)=>{
    if(modelActionRef.current || running || practiceActive || practiceWorking || startingService)return;
    modelActionRef.current=true;setLinkingModels(true);
    const current=settingsRef.current;
    try {
      const decision=enabled ? current.answer : current.separateDecision || {...current.answer};
      const sameAddress=current.decision.api===current.answer.api &&
        current.decision.baseUrl.trim().replace(/\/+$/,"")===current.answer.baseUrl.trim().replace(/\/+$/,"");
      if(enabled && sameAddress && current.answer.api!=="ollama" && current.answer.baseUrl){
        const present=await invoke<boolean>("mvp_copy_model_key",{endpoint:endpoint(current.decision,"decision"),targetStage:"answer"});
        setSavedKeys(keys=>({...keys,[credentialSlot(current.answer,"answer")]:present}));
      }else if(!enabled && !current.separateDecision && current.answer.api!=="ollama" && current.answer.baseUrl){
        const present=await invoke<boolean>("mvp_copy_model_key",{endpoint:endpoint(current.answer,"answer"),targetStage:"decision"});
        setSavedKeys(keys=>({...keys,[credentialSlot(decision,"decision")]:present}));
      }
      const next={...current,sharedModelConnection:enabled,decision,
        separateDecision:enabled ? current.decision : undefined};
      connectionEpochRef.current++;settingsRef.current=next;setSettings(next);
      setDecisionModels([]);setDecisionReady(false);
      setConnectedModels({decision:"",answer:""});setModelTests({decision:"",answer:""});
      setModelErrors({decision:"",answer:""});setError("");
    }catch(cause){setError(`连接配置未切换：${String(cause)}`);}
    finally{setLinkingModels(false);modelActionRef.current=false;}
  };
  const startService = async () => {
    setStartingService(true);setError("");
    try {await invoke("start_local_service",{service:"ollama"});await refreshOllamaRuntime();await refreshModels("decision");await refreshModels("answer");}
    catch (cause) {setError(`启动 Ollama 失败：${String(cause)}`);}
    finally {setStartingService(false);}
  };
  const saveOllamaPaths = async () => {
    setError("");setOllamaNotice("");
    try {
      await invoke("save_ollama_runtime",{executable:ollamaExeDraft,modelsDirectory:ollamaModelsDraft});
      await refreshOllamaRuntime();
      setOllamaNotice("路径已保存。若 Ollama 已在运行，请先退出该服务再重新启动，模型目录更改才会生效。");
    } catch (cause) {setError(`保存 Ollama 路径失败：${String(cause)}`);}
  };
  const chooseOllamaExe = async () => {
    const selected = await choosePath({multiple:false,directory:false,filters:[{name:"Ollama 程序",extensions:["exe"]}]});
    if (typeof selected === "string") {
      setOllamaExeDraft(selected);
      try {
        await invoke("save_ollama_runtime",{executable:selected,modelsDirectory:ollamaModelsDraft});
        await refreshOllamaRuntime();
        setOllamaNotice("已保存所选 Ollama 程序位置。");
      } catch (cause) {setOllamaCheckError(`保存所选程序失败：${String(cause)}`);}
    }
  };
  const chooseOllamaModels = async () => {
    const selected = await choosePath({multiple:false,directory:true});
    if (typeof selected === "string") setOllamaModelsDraft(selected);
  };
  const pullOllamaModel = async () => {
    const model = pullModelId.trim();
    if (!model) return;
    setPulling(true);setPullProgress("准备下载…");setError("");
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<PullProgress>("ollama_pull_progress", event => {
        if (event.payload.model !== model) return;
        const {status,completed,total} = event.payload;
        const percent = total && completed != null ? ` ${Math.round(completed/total*100)}%` : "";
        setPullProgress(`${status || "下载中"}${percent}`);
      });
      await invoke("start_local_service",{service:"ollama"});
      await invoke("pull_ollama_model",{model});
      setPullProgress(`${model} 已下载`);
      await Promise.all([refreshOllamaRuntime(),refreshModels("decision"),refreshModels("answer")]);
    } catch (cause) {setPullProgress("");setError(`下载模型失败：${String(cause)}`);}
    finally {unlisten?.();setPulling(false);}
  };

  const publishHint = useCallback((value: string, immediate=false) => {
    hintRef.current = value;
    if (lockedRef.current && !immediate) pendingHintRef.current = value;
    else setHint(value);
  }, []);

  const markVisible = useCallback((requestId:string,startedAt:number,asrAt:number|null) => {
    if (visibleAnswerRequestRef.current === requestId) return;
    visibleAnswerRequestRef.current = requestId;
    const elapsed=Math.round(performance.now()-startedAt);
    setVisibleMs(elapsed);
    logDiagnostic("首条可见提示",asrAt === null ? `${elapsed} ms · 手动修正` :
      `${elapsed} ms · 转录更新后 ${Math.round(performance.now()-asrAt)} ms`);
  }, [logDiagnostic]);
  const showAnswerSnapshot = useCallback((display:NonNullable<typeof answerDisplayRef.current>, value:string) => {
    if (!value.trim() || display.lastShown === value) return;
    display.lastShown=value;
    if (lockedRef.current && display.asrAt !== null && display.source!=="saved") {
      pendingDisplayRef.current={question:display.question,terms:display.terms,keyTerms:display.keyTerms,
        hint:value,requestId:display.requestId,startedAt:display.startedAt,asrAt:display.asrAt,source:display.source};
      return;
    }
    setQuestion(display.question);setUncertainTerms(display.terms);setKeyTerms(display.keyTerms);
    setAnswerSource(display.source);savedIntroductionRef.current=display.source==="saved";
    publishHint(value,display.source==="saved");
    markVisible(display.requestId,display.startedAt,display.asrAt);
  }, [publishHint,markVisible]);
  const cancelAnswer = useCallback(() => {
    for(const branch of answerRaceRef.current?.branches || []) {
      if(!branch.done && branch.text)liveHistory.record("answer",branch.text,{question:answerDisplayRef.current?.question||questionRef.current,source:branch.source,complete:false,cancelled:true},branch.id);
      if(!branch.done)void invoke("mvp_cancel_answer",{requestId:branch.id}).catch(()=>{});
    }
    answerRaceRef.current=null;answerRequestRef.current="";setApiPending(false);
  }, []);

  const finishAnswer = useCallback((id:string,error?:string) => {
    const race=answerRaceRef.current;
    if(!race || !race.finish(id,error,Math.round(performance.now()-answerStartedRef.current)))return;
    const branch=race.branches.find(item=>item.id===id)!;
    liveHistory.record("answer",branch.text,{question:questionRef.current,source:branch.source,complete:!branch.error,error:branch.error||null},id);
    const elapsed=Math.round(performance.now()-answerStartedRef.current);
    logDiagnostic(branch.error ? "回答分路失败" : "回答分路完成",
      `${branch.source=== "local" ? "本地" : "API"} · ${elapsed} ms${branch.error ? ` · ${branch.error}` : ""}`);
    const display=answerDisplayRef.current;
    const snapshot=race.snapshot;
    if(display && snapshot){
      display.source=snapshot.source;setAnswerMs(snapshot.firstMs);
      showAnswerSnapshot(display,snapshot.text);
      if(snapshot.complete){
        setCompleteMs(snapshot.completeMs);
        if(display.asrAt!==null)setTranscriptToCompleteMs(Math.round(display.startedAt+(snapshot.completeMs || 0)-display.asrAt));
      }
    }
    setApiPending(race.pendingApi);
    if(race.finished){
      answerRequestRef.current="";answerDisplayRef.current=null;
      setStatus(race.failure ? "error" : runningRef.current ? "listening" : "idle");
      if(race.failure)setError(race.failure);
      logDiagnostic("回答完成",`${elapsed} ms${display?.asrAt!=null ? ` · 转录→完整 ${Math.round(performance.now()-display.asrAt)} ms` : ""}`);
    }
  }, [showAnswerSnapshot,logDiagnostic]);

  const startAnswer = useCallback(async (nextQuestion: string, focus: string[], keyTerms: string[],
    constraints: string[], terms: string[], transition:"first"|"new"|"revision", asrAt:number|null) => {
    if(softwareUpdatingRef.current)return;
    liveHistory.ensure(runningRef.current?"live":"manual",runningRef.current?"实时问答":"手动问题测试");
    cancelAnswer();
    const settings=settingsRef.current;
    const parallel=settings.parallelAnswer && settings.answer.api!=="ollama";
    const requestId=crypto.randomUUID();answerRequestRef.current=requestId;
    liveHistory.record("question",nextQuestion,{focus,keyTerms,uncertainTerms:terms,transition},requestId);
    const configs=parallel ? [settings.parallelLocal,settings.answer] : [settings.answer];
    const requests=configs.map((config,index)=>({id:`${requestId}-${index}`,
      source:(config.api==="ollama" ? "local" : "api") as AnswerSource}));
    const race=new AnswerRace(requests);answerRaceRef.current=race;
    answerStartedRef.current=performance.now();if(!visibleHintRef.current)setAnswerSource(null);setApiPending(parallel);
    setAnswerMs(null);setVisibleMs(null);setCompleteMs(null);setTranscriptToCompleteMs(null);
    detailRequestRef.current="";setDetail("");setDetailLoading(false);setShowDetail(false);
    pendingDisplayRef.current=null;pendingHintRef.current="";
    answerDisplayRef.current={question:nextQuestion,terms,keyTerms,transition,lastShown:"",requestId,
      startedAt:answerStartedRef.current,asrAt,source:requests[0].source};
    const context=rememberQuestion(questionHistoryRef.current,nextQuestion);
    questionHistoryRef.current=context.history;
    questionRef.current=nextQuestion;uncertainRef.current=terms;
    answerTaskRef.current=JSON.stringify([nextQuestion,focus,keyTerms,constraints,terms]);
    if(!visibleHintRef.current){setQuestion(nextQuestion);setUncertainTerms(terms);setKeyTerms(keyTerms);}
    setStatus("generating");
    await Promise.all(configs.map(async(config,index)=>{
      const id=requests[index].id;
      try{
        if(config.api==="ollama" && (!runningRef.current || parallel)){
          const serviceStarted=performance.now();
          await invoke("start_local_service",{service:"ollama"});
          logDiagnostic("本地服务就绪",`${Math.round(performance.now()-serviceStarted)} ms`);
        }
        if(answerRaceRef.current!==race)return;
        const background=topicBackground(settings,resumeRef.current,resumeAnalysisRef.current,config.api==="ollama");
        await invoke("mvp_answer",{endpoint:liveHistory.endpoint(endpoint(config,"answer"),"回答生成"),requestId:id,
          question:nextQuestion,questionContext:context.previous,focus,keyTerms,constraints,uncertainTerms:terms,
          answerInstructions:[settings.answerInstructions,background && `术语与选题背景（不能作为经历事实）：${background}`].filter(Boolean).join("\n")});
      }catch(cause){if(answerRaceRef.current===race)finishAnswer(id,String(cause));}
    }));
  }, [cancelAnswer,finishAnswer,logDiagnostic]);

  const showSelfIntroduction = useCallback((sourceId:string,asrAt:number|null) => {
    cancelAnswer();savedIntroductionRef.current=true;setError("");
    detailRequestRef.current="";setDetail("");setDetailLoading(false);setShowDetail(false);
    pendingDisplayRef.current=null;pendingHintRef.current="";
    const question="请进行自我介绍";
    const text=settingsRef.current.selfIntroduction.trim() || "尚未保存自我介绍，请在设置 → 个人资料 → 自我介绍中填写。";
    liveHistory.ensure(runningRef.current?"live":"manual",runningRef.current?"实时问答":"手动问题测试");
    liveHistory.record("question",question);
    liveHistory.record("answer",text,{question,source:"saved",complete:true});
    const startedAt=performance.now();const requestId=crypto.randomUUID();
    answerStartedRef.current=startedAt;answerTaskRef.current="self_introduction";
    questionRef.current=question;activeSourceRef.current=sourceId;uncertainRef.current=[];
    setAnswerMs(null);setVisibleMs(null);setCompleteMs(0);
    setTranscriptToCompleteMs(asrAt===null ? null : Math.round(startedAt-asrAt));
    answerDisplayRef.current=null;
    showAnswerSnapshot({question,terms:[],keyTerms:[],transition:"new",lastShown:"",requestId,
      startedAt,asrAt,source:"saved"},text);
    setStatus(runningRef.current ? "listening" : "idle");
    logDiagnostic("显示自我介绍","直接显示本机保存稿，未调用回答模型");
  }, [cancelAnswer,showAnswerSnapshot,logDiagnostic]);

  const submitEditedQuestion = useCallback(() => {
    if(updater.busy)return;
    const corrected=questionDraft.trim();
    if (!corrected) {setError("请填写问题");return;}
    setEditingQuestion(false);setError("");setDecisionMs(null);
    manualOverrideSourceRef.current=activeSourceRef.current;
    if(isSelfIntroductionRequest(corrected)){
      showSelfIntroduction(`manual-introduction-${crypto.randomUUID()}`,null);return;
    }
    pendingHintRef.current="";pendingDisplayRef.current=null;
    hintRef.current="";visibleHintRef.current="";setHint("");
    visibleQuestionRef.current=corrected;setQuestion(corrected);
    setUncertainTerms([]);setKeyTerms([]);
    logDiagnostic("手动修正问题",`已提交 ${corrected.length} 字，重新生成回答`);
    void startAnswer(corrected,[],[],[],[],"new",null);
  }, [questionDraft,startAnswer,showSelfIntroduction,logDiagnostic,updater.busy]);

  const loadDetail = useCallback(async () => {
    const question=visibleQuestionRef.current;
    const summary=visibleHintRef.current;
    if (softwareUpdatingRef.current || savedIntroductionRef.current || !question || !summary || detailRequestRef.current ||
        (detailRef.current && !detailRef.current.startsWith("原理解释失败："))) return;
    const requestId=crypto.randomUUID();detailRequestRef.current=requestId;
    setDetail("");setDetailLoading(true);
    try {
      const background=topicBackground(settingsRef.current,resumeRef.current,resumeAnalysisRef.current,
        settingsRef.current.answer.api==="ollama");
      const explanation=await invoke<string>("mvp_explain",{endpoint:liveHistory.endpoint(endpoint(settingsRef.current.answer,"answer"),"补充解释"),
        question,keyTerms:visibleKeyTermsRef.current,summary,
        answerInstructions:[settingsRef.current.answerInstructions,background && `术语背景（不能作为经历事实）：${background}`].filter(Boolean).join("\n")});
      liveHistory.record("detail",explanation,{question});
      if (detailRequestRef.current===requestId && visibleQuestionRef.current===question) setDetail(explanation);
    } catch (cause) {
      if (detailRequestRef.current===requestId) setDetail(`原理解释失败：${String(cause)}`);
    } finally {
      if (detailRequestRef.current===requestId) {detailRequestRef.current="";setDetailLoading(false);}
    }
  }, []);

  const decideLatestRef = useRef<() => Promise<void>>(async () => {});
  decideLatestRef.current = async () => {
    if (decisionBusyRef.current || !runningRef.current) return;
    const pending = decisionPendingRef.current;
    if (!pending) return;
    if (manualOverrideSourceRef.current && pending.sourceId === manualOverrideSourceRef.current) {
      decisionPendingRef.current=null;
      return;
    }
    decisionPendingRef.current = null; decisionBusyRef.current = true;
    const epoch = sessionEpochRef.current;
    lastDecisionAtRef.current = Date.now(); setStatus(current => current === "generating" ? current : "deciding");
    const started = performance.now();
    try {
      if(isSelfIntroductionRequest(pending.text)){
        if(manualOverrideSourceRef.current && pending.sourceId===manualOverrideSourceRef.current)return;
        setDecisionMs(Math.round(performance.now()-started));
        if(answerTaskRef.current!=="self_introduction" || activeSourceRef.current!==pending.sourceId)
          showSelfIntroduction(pending.sourceId,pending.receivedAt);
        return;
      }
      const recent=dialogueContext(segmentsRef.current,[partialRef.current,micPartialRef.current],
        pending.sourceId,settingsRef.current.mode==="video");
      const decision = await invoke<Decision>("mvp_decide", {
        endpoint:liveHistory.endpoint(endpoint(settingsRef.current.decision,"decision",settingsRef.current.sharedModelConnection),"语义判别"),
        input:{ context:recent, currentText:pending.text, previousQuestion:questionRef.current,
          candidateReply:micPartialRef.current?.text || [...segmentsRef.current].reverse().find(item=>item.speaker==="User")?.text || "",
          visibleQuestion:visibleQuestionRef.current, isFinal:pending.isFinal,
          videoMode:settingsRef.current.mode === "video",
          topicBackground:topicBackground(settingsRef.current,resumeRef.current,resumeAnalysisRef.current,
            settingsRef.current.decision.api==="ollama") },
      });
      const elapsed=Math.round(performance.now()-started);
      if (!runningRef.current || epoch !== sessionEpochRef.current) return;
      if (manualOverrideSourceRef.current && pending.sourceId === manualOverrideSourceRef.current) {
        logDiagnostic("保留手动修正",`忽略同一转录片段的判别 · ${elapsed} ms`);
        if (!answerRequestRef.current) setStatus("listening");
        return;
      }
      setDecisionMs(elapsed);
      logDiagnostic("语义判别",`${elapsed} ms · ${decision.action}/${decision.relation} · ${pending.isFinal?"稳定片段":"增量"}`);
      setError("");
      // A newer ASR increment may already be queued. The decision for this
      // snapshot can still produce an early, revisable hint; the queued text
      // is judged next. A stopped session is never allowed to update the UI.
      if (decision.intent==="self_introduction" && (decision.action==="show" || decision.action==="revise")) {
        if(answerTaskRef.current!=="self_introduction" || activeSourceRef.current!==pending.sourceId)showSelfIntroduction(pending.sourceId,pending.receivedAt);
      } else if (decision.action === "show" || decision.action === "revise") {
        const transition = questionTransition({hasActiveQuestion:Boolean(questionRef.current),
          activeSourceId:activeSourceRef.current,sourceId:pending.sourceId,isFinal:pending.isFinal,
          alreadyRevisedSource:revisedSourceRef.current===pending.sourceId,
          action:decision.action,relation:decision.relation});
        if (!transition) {
          if (!answerRequestRef.current) setStatus("listening");
          return;
        }
        const keyTerms = [...new Set((decision.key_terms || []).map(term => term.trim()).filter(Boolean))].slice(0,3);
        const task = JSON.stringify([decision.question,decision.focus || [],keyTerms,decision.constraints || [],decision.uncertain_terms || []]);
        if (task !== answerTaskRef.current) {
          manualOverrideSourceRef.current="";
          if (transition === "revision") revisedSourceRef.current=pending.sourceId;
          activeSourceRef.current = pending.sourceId;
          void startAnswer(decision.question,decision.focus || [],keyTerms,
            decision.constraints || [],decision.uncertain_terms || [],transition,pending.receivedAt);
        } else if (!answerRequestRef.current) setStatus("listening");
      } else if (!answerRequestRef.current) setStatus("listening");
    } catch (cause) {setStatus("error");setError(`语义判别失败：${String(cause)}`);logDiagnostic("语义判别失败");}
    finally {
      decisionBusyRef.current = false;
      if (decisionPendingRef.current && runningRef.current) {
        const delay = Math.max(0,450-(Date.now()-lastDecisionAtRef.current));
        decisionTimerRef.current = setTimeout(() => void decideLatestRef.current(),delay);
      }
    }
  };

  const queueDecision = useCallback((segment: Segment, isFinal: boolean) => {
    if(settingsRef.current.decisionFinalOnly && !isFinal)return;
    const text = segment.text;
    const normalized = text.trim();
    const decisionKey = `${segment.id}:${isFinal ? "final" : "partial"}:${normalized}`;
    if (!normalized || decisionKey === lastDecisionTextRef.current) return;
    lastDecisionTextRef.current = decisionKey;
    decisionPendingRef.current = {text:normalized,sourceId:segment.id,isFinal,
      version:++decisionVersionRef.current,receivedAt:performance.now()};
    if (decisionBusyRef.current) return;
    if (decisionTimerRef.current) clearTimeout(decisionTimerRef.current);
    const delay = Math.max(0,450-(Date.now()-lastDecisionAtRef.current));
    decisionTimerRef.current = setTimeout(() => void decideLatestRef.current(),delay);
  }, []);

  useEffect(() => {
    let active = true; const stops: UnlistenFn[] = [];
    const register = async () => {
      stops.push(await listen<string>("history_save_error",event=>{if(active)setHistoryNativeError(`历史用量保存失败：${event.payload}`);}));
      stops.push(await listen<{segment:Segment}>("transcript_update", event => {
        if (!active || !runningRef.current) return;
        const segment = event.payload.segment;
        if(segment.speaker==="User"){
          if(settingsRef.current.mode!=="live" || !settingsRef.current.micTranscription)return;
          micPartialRef.current=segment;setMicPartial(segment);return;
        }
        partialRef.current = segment; setPartial(segment); queueDecision(segment,false);
      }));
      stops.push(await listen<{segment:Segment}>("transcript_final", event => {
        if (!active || !runningRef.current) return;
        const segment = event.payload.segment;
        liveHistory.record("transcript",segment.text,{speaker:segment.speaker,timestampMs:segment.timestamp_ms},segment.id);
        if(segment.speaker==="User"){
          if(settingsRef.current.mode!=="live" || !settingsRef.current.micTranscription)return;
          micPartialRef.current=null;setMicPartial(null);
        }else{partialRef.current=null;setPartial(null);}
        segmentsRef.current=[...segmentsRef.current.filter(item=>item.id!==segment.id),segment]
          .sort((a,b)=>a.timestamp_ms-b.timestamp_ms).slice(-80);
        setSegments(segmentsRef.current);
        if(segment.speaker!=="User")queueDecision(segment,true);
      }));
      stops.push(await listen<{party?:string;status:string;error?:string;message?:string}>("stt_connection_status",event=>{
        if(!active || (!runningRef.current && !captureStartingRef.current) || event.payload.status!=="error")return;
        const party=event.payload.party==="You" ? "麦克风" : "面试音频";
        setError(`${party}转录连接失败：${event.payload.error || event.payload.message || "请检查所选识别服务"}`);
        logDiagnostic("转录连接失败",party);
      }));
      stops.push(await listen<{source:string;level:number}>("audio_level", event => {
        if (!active) return;
        const {source,level} = event.payload;
        if (source === "System") setSystemLevel(level);
        if (source === "Mic") {
          setMicLevel(level);
          if (level > 0.11) micLastActiveRef.current = Date.now();
          const speaking = runningRef.current && settingsRef.current.mode === "live" &&
            Date.now()-micLastActiveRef.current < 500;
          if (speaking !== lockedRef.current) {
            lockedRef.current = speaking; setLocked(speaking);
            if (!speaking && pendingDisplayRef.current) {
              const display=pendingDisplayRef.current;pendingDisplayRef.current=null;
              setQuestion(display.question);setUncertainTerms(display.terms);setKeyTerms(display.keyTerms);
              setAnswerSource(display.source);savedIntroductionRef.current=display.source==="saved";publishHint(display.hint);
              markVisible(display.requestId,display.startedAt,display.asrAt);
            } else if (!speaking && pendingHintRef.current) {
              setHint(pendingHintRef.current);pendingHintRef.current="";
            }
          }
        }
      }));
      stops.push(await listen<{requestId:string;phase:string;elapsedMs:number;duration?:boolean}>("mvp_answer_phase", event => {
        const branch=answerRaceRef.current?.branches.find(item=>item.id===event.payload.requestId);
        if(!branch)return;
        logDiagnostic("回答阶段",`${branch.source=== "local" ? "本地" : "API"} · ${event.payload.phase} · ${Math.round(event.payload.elapsedMs)} ms${event.payload.duration ? "（阶段耗时）" : "（请求后）"}`);
      }));
      stops.push(await listen<{requestId:string;token:string}>("mvp_answer_token", event => {
        const race=answerRaceRef.current;
        if(!race)return;
        const branch=race.branches.find(item=>item.id===event.payload.requestId);
        if(!branch)return;
        const first=branch.firstMs===null;
        const elapsed=Math.round(performance.now()-answerStartedRef.current);
        if(!race.token(branch.id,event.payload.token,elapsed))return;
        liveHistory.record("answer",branch.text,{question:answerDisplayRef.current?.question||questionRef.current,source:branch.source,complete:false},branch.id,true);
        if(first)logDiagnostic("模型首字",`${branch.source=== "local" ? "本地" : "API"} · ${elapsed} ms`);
        const display=answerDisplayRef.current;const snapshot=race.snapshot;
        if(display && snapshot){
          display.source=snapshot.source;setAnswerMs(snapshot.firstMs);
          showAnswerSnapshot(display,snapshot.text);
        }
      }));
      stops.push(await listen<{requestId:string;error?:string}>("mvp_answer_done", event => {
        finishAnswer(event.payload.requestId,event.payload.error);
      }));
      stops.push(await listen("mvp_detail_request", () => {void loadDetail();}));
      stops.push(await listen<{engine:string;model_id:string;percent:number;status:string}>("model_download_progress", event => {
        const item = event.payload;
        setDownload(item.status === "extracting" ? `${item.model_id} · 正在解压…` : `${item.model_id} · ${Math.round(item.percent)}%`);
        if (item.status === "complete") {setDownload("");void refreshEngines();}
        else if (item.status === "error") {setDownload("");setError(`下载或解压 ${item.model_id} 失败，请检查磁盘空间和网络后重试。`);}
      }));
      stops.push(await listen("mvp_overlay_ready", () => {
        if(workspaceModeRef.current==="practice"){
          void emit("mvp_practice_ui_state",{enabled:true,...practicePreviewRef.current});return;
        }
        void emit("mvp_ui_state", {question:visibleQuestionRef.current,hint:visibleHintRef.current,
          status:"listening",locked:lockedRef.current,uncertainTerms:visibleTermsRef.current,
          keyTerms:visibleKeyTermsRef.current,detail:detailRef.current,detailLoading:detailLoadingRef.current,detailAvailable:!savedIntroductionRef.current});
      }));
    };
    void register();
    return () => {active=false;stops.forEach(stop=>stop());};
  }, [queueDecision,publishHint,refreshEngines,logDiagnostic,markVisible,showAnswerSnapshot,finishAnswer,loadDetail]);

  const chosenEngine = engines.find(item => item.engine === settings.sttEngine);
  const chosenModel = chosenEngine?.models.find(item => item.id === settings.sttModel);
  const decisionChoices = useMemo(() => [...new Set(settings.sharedModelConnection ? answerModels : decisionModels)],
    [decisionModels,answerModels,settings.sharedModelConnection]);
  const answerChoices = useMemo(() => [...new Set(answerModels)],[answerModels]);
  const update = (patch: Partial<Settings>) => setSettings(current => ({...current,...patch}));
  const updateStage = (stage: "decision" | "answer", patch: Partial<ModelConfig>) => {
    commitModelConfig(stage,patch);
  };

  const start = async () => {
    if(updater.busy || practiceWorking || captureStartingRef.current || runningRef.current)return;
    captureStartingRef.current=true;setStartingService(true);
    try {await startCapture();}
    finally {captureStartingRef.current=false;setStartingService(false);}
  };
  const startCapture = async () => {
    setError("");
    if (settings.sttMode === "local" && !chosenModel?.is_downloaded) {setShowSettings(true);setError("请先下载所选语音模型");return;}
    if (settings.sttMode === "api" && !savedKeys[settings.sttApiProvider]) {setShowSettings(true);setError("请先保存语音识别 API 密钥");return;}
    if (!settings.decision.model.trim() || !settings.answer.model.trim()) {setShowSettings(true);setError("请先填写判别和回答模型 ID");return;}
    for (const stage of ["decision","answer"] as const) {
      if (settings[stage].api === "deepseek" && !savedKeys[credentialSlot(settings[stage],settings.sharedModelConnection ? "answer" : stage)]) {
        setShowSettings(true);setError(`请先保存${stage === "decision" ? "判别" : "回答"}环节的 DeepSeek API 密钥`);return;
      }
    }
    if ((settings.decision.api === "ollama" && !(settings.sharedModelConnection ? answerReady : decisionReady)) || (settings.answer.api === "ollama" && !answerReady)) {
      try {
        await invoke("start_local_service",{service:"ollama"});
        await Promise.all([refreshModels("decision"),refreshModels("answer")]);
      } catch (cause) {
        setShowSettings(true);setError(`启动本地 Ollama 失败：${String(cause)}`);return;
      }
    }
    try {
      cancelAnswer();answerDisplayRef.current=null;questionHistoryRef.current=[];
      await invoke("set_stt_language",{language:"zh-CN"});
      const topic = settings.domain === "ai" ? "中文技术面试，人工智能与机器学习，英文技术缩写保持原文。" :
        settings.domain === "communication" ? "中文技术面试，通信和计算机网络，英文技术缩写保持原文。" :
        "中文技术面试，英文技术缩写保持原文。";
      const selectedBackground=topicBackground(settings,null,null,false);
      const localBackground=topicBackground(settings,resume,resumeAnalysis,true);
      const remoteTopic=[topic,selectedBackground].filter(Boolean).join(" ").slice(0,400);
      const localTopic=[topic,localBackground].filter(Boolean).join(" ").slice(0,400);
      await invoke("set_whisper_topic_prompt",{prompt:settings.sttMode === "local" && settings.sttEngine === "whisper_cpp" ? localTopic : ""});
      if (settings.sttMode === "api" && settings.sttApiProvider === "deepgram") {
        await invoke("update_deepgram_config",{configJson:JSON.stringify({model:settings.sttApiModel || "nova-3",
          smart_format:false,interim_results:true,endpointing:300,punctuate:true,diarize:false,
          profanity_filter:false,numerals:false,dictation:false,vad_events:true,keyterms:[]})});
      }
      if (settings.sttMode === "api" && settings.sttApiProvider === "groq_whisper") {
        await invoke("update_groq_config",{configJson:JSON.stringify({model:settings.sttApiModel || "whisper-large-v3-turbo",
          language:"zh",temperature:0,response_format:"json",timestamp_granularities:[],
          prompt:remoteTopic,segment_duration_secs:3})});
      }
      const transcribeMic=settings.mode==="live" && settings.micTranscription;
      const you={role:"You",device_id:settings.mic,is_input_device:true,
        stt_provider:transcribeMic ? settings.sttMode==="local" ? settings.sttEngine : settings.sttApiProvider : "web_speech",
        local_model_id:transcribeMic && settings.sttMode==="local" ? settings.sttModel : null};
      const them = {role:"Them",device_id:settings.output,is_input_device:false,
        stt_provider:settings.sttMode === "local" ? settings.sttEngine : settings.sttApiProvider,
        local_model_id:settings.sttMode === "local" ? settings.sttModel : null};
      await invoke("start_capture_per_party",{youConfig:JSON.stringify(you),themConfig:JSON.stringify(them)});
      segmentsRef.current=[];setSegments([]);setPartial(null);partialRef.current=null;
      micPartialRef.current=null;setMicPartial(null);savedIntroductionRef.current=false;
      questionRef.current="";activeSourceRef.current="";
      revisedSourceRef.current="";manualOverrideSourceRef.current="";
      answerDisplayRef.current=null;pendingDisplayRef.current=null;
      pendingHintRef.current="";answerTaskRef.current="";detailRequestRef.current="";
      setQuestion("");setEditingQuestion(false);setQuestionDraft("");
      setUncertainTerms([]);setKeyTerms([]);setDetail("");setDetailLoading(false);setShowDetail(false);
      setDecisionMs(null);setAnswerMs(null);setVisibleMs(null);setCompleteMs(null);setTranscriptToCompleteMs(null);
      publishHint("");lastDecisionTextRef.current="";decisionVersionRef.current++;
      liveHistory.begin("live","实时问答");
      sessionEpochRef.current++;runningRef.current=true;setRunning(true);setStatus("listening");
      logDiagnostic("开始聆听",`${settings.sttEngine}/${settings.sttModel} · 判别 ${settings.decision.api} · 回答 ${settings.answer.api}`);
    } catch (cause) {
      await invoke("stop_capture").catch(()=>{});
      setStatus("error");setError(`无法开始采集：${String(cause)}`);
    }
  };
  const stop = async () => {
    sessionEpochRef.current++;runningRef.current=false;setRunning(false);setStatus("idle");decisionVersionRef.current++;
    decisionPendingRef.current=null;
    if (decisionTimerRef.current) clearTimeout(decisionTimerRef.current);
    cancelAnswer();answerDisplayRef.current=null;pendingDisplayRef.current=null;
    partialRef.current=null;setPartial(null);micPartialRef.current=null;setMicPartial(null);
    lockedRef.current=false;setLocked(false);pendingHintRef.current="";
    detailRequestRef.current="";setDetailLoading(false);
    logDiagnostic("结束聆听");
    liveHistory.end();
    try {await invoke("stop_capture");} catch (cause) {setError(`停止采集失败：${String(cause)}`);}
  };
  const toggleOverlay = async () => {
    const overlay = await WebviewWindow.getByLabel("overlay");
    if (!overlay) return;
    if (overlayVisible) await overlay.hide(); else {
      await overlay.show();await overlay.setFocus();
      void emit("mvp_practice_ui_state",{enabled:workspaceModeRef.current==="practice",...practicePreviewRef.current});
    }
    setOverlayVisible(!overlayVisible);
  };
  const downloadModel = async () => {
    setError("");setDownload("准备下载…");
    try {await invoke("download_local_stt_model",{engine:settings.sttEngine,modelId:settings.sttModel});}
    catch (cause) {setDownload("");setError(`模型下载失败：${String(cause)}`);}
  };

  const exportProfile = async () => {
    setProfileError("");setProfileNotice("");
    try {
      const path=await chooseBackupPath({defaultPath:"模拟面试练习-配置备份.json",
        filters:[{name:"JSON 配置文件",extensions:["json"]}]});
      if(typeof path!=="string")return;
      const profile:SavedProfile={settings,resumeAnalysis:savedResumeAnalysis(),practiceConfig:savedPracticeConfig()};
      await invoke("export_interview_profile",{path,profile});
      setProfileNotice(`配置已导出：${path}`);
    } catch(cause) {setProfileError(`导出配置失败：${String(cause)}`);}
  };
  const importProfile = async () => {
    setProfileError("");setProfileNotice("");
    try {
      const path=await choosePath({multiple:false,directory:false,
        filters:[{name:"JSON 配置文件",extensions:["json"]}]});
      if(typeof path!=="string")return;
      await profileWriteQueueRef.current.catch(()=>{});
      const profile=await invoke<SavedProfile>("import_interview_profile",{path});
      const restored=loadSettings(profile.settings);
      localStorage.setItem("interviewCue.settings",JSON.stringify(restored));
      if(profile.practiceConfig)localStorage.setItem("interviewCue.practiceConfig",JSON.stringify(profile.practiceConfig));
      else localStorage.removeItem("interviewCue.practiceConfig");
      if(profile.resumeAnalysis)localStorage.setItem("interviewCue.resumeAnalysis",JSON.stringify(profile.resumeAnalysis));
      else localStorage.removeItem("interviewCue.resumeAnalysis");
      settingsRef.current=restored;connectionEpochRef.current++;
      profileWritableRef.current=true;setProfileWritable(true);
      setSettings(restored);
      setProfileEpoch(value=>value+1);
      setProfileNotice("配置已导入。模型存放路径及 Ollama 程序路径重启后生效；请重新选择或确认 API 密钥。");
    } catch(cause) {setProfileError(`导入配置失败：${String(cause)}`);}
  };

  const stageEditor = (stage: "decision" | "answer", title: string, choices: string[], ready: boolean) => {
    const config = settings[stage];
    const slot = credentialSlot(config,settings.sharedModelConnection ? "answer" : stage);
    const selectedService=serviceId(config);
    const service=modelServices.find(item=>item.id===selectedService)!;
    const busy=running || startingService || practiceWorking || practiceActive || testingModel!==null || linkingModels;
    const connected=connectedModels[stage]===config.model && Boolean(config.model);
    return <div className="setting-group model-connection" key={stage}>
      <div className="setting-heading"><Sparkles size={18}/>{title}
        <span className={`connection-badge ${connected ? "connected" : ""}`}>{connected ? "聊天已连接" : "待检测"}</span></div>
      <label>选择服务<select value={selectedService} onChange={e=>configureStage(stage,e.target.value as ServiceId)} disabled={busy}>
        {modelServices.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <p className="setting-help">{service.help}</p>
      {config.api !== "ollama" && <div className="key-control"><label>API 密钥（保存到 Windows 凭据管理器）
        <input type="password" value={keyDrafts[slot] || ""} onChange={e=>setKeyDrafts(current=>({...current,[slot]:e.target.value}))}
          placeholder={savedKeys[slot]?"已保存；留空继续使用，填写可替换":"粘贴所选服务的密钥"} disabled={busy}/></label>
        {savedKeys[slot] && <div className="key-actions"><button onClick={()=>void removeKey(slot,stage)} disabled={busy}>删除已存密钥</button></div>}</div>}
      <div className="connection-summary"><span>当前模型</span><strong>{config.model || "检测后选择"}</strong></div>
      <div className="setup-actions"><button className="download-btn" onClick={()=>void testModelEndpoint(stage)}
        disabled={busy || !config.baseUrl.trim()}>
        {testingModel===stage?"正在检测连接…":"检测并连接"}</button>
        <button className="text-link" onClick={()=>setAdvancedModels(current=>({...current,[stage]:!current[stage]}))}
          aria-expanded={advancedModels[stage] || selectedService==="custom"}>高级设置 <ChevronDown size={14}/></button></div>
      {modelTests[stage] && <p className="setting-help" role="status">{modelTests[stage]}</p>}
      <p className="setting-help">{modelErrors[stage] ? `模型列表未获取：${modelErrors[stage]} 列表失败不等于对话接口不可用。` :
        ready ? `已发现 ${choices.length} 个模型，可在高级设置中选择。` : "设置自动保存；密钥在点击检测时保存。"}
        {config.api!=="ollama" && " 检测只发送简短测试文字，不发送简历或对话；可能产生少量服务费用。"}</p>
      {(advancedModels[stage] || selectedService==="custom") && <div className="connection-advanced">
        <label>接口地址<input value={config.baseUrl} onChange={e=>{
          updateStage(stage,{baseUrl:e.target.value});
          if(stage==="decision"){setDecisionModels([]);setDecisionReady(false);}else{setAnswerModels([]);setAnswerReady(false);}
          setModelErrors(current=>({...current,[stage]:""}));
        }} disabled={busy || config.api==="deepseek"} spellCheck={false} placeholder="https://服务地址/v1"/></label>
        <p className="setting-help">使用服务的基础地址，不要包含 /chat/completions 或 /models。密钥只发送到此地址。</p>
        <label>模型 ID<input value={config.model} onChange={e=>updateStage(stage,{model:e.target.value,modelSelection:"manual"})}
          disabled={busy} spellCheck={false} placeholder="服务提供的聊天模型 ID"/></label>
        {choices.length>0 && <label>从服务列表选择<select value={choices.includes(config.model)?config.model:""}
          onChange={e=>{if(e.target.value)updateStage(stage,{model:e.target.value,modelSelection:"manual"});}} disabled={busy}>
          <option value="">手动填写 / 未在列表中</option>{choices.map(model=><option key={model} value={model}>{model}</option>)}</select></label>}
        <button className="text-link" disabled={busy || !config.baseUrl.trim()} onClick={()=>void refreshModels(stage,true)}>刷新模型列表</button>
        <p className="setting-help">兼容服务需要支持聊天接口；出题、评价和判别还要求模型能按要求输出 JSON。聊天检测通过不代表所有模型都支持结构化结果。</p>
      </div>}
    </div>;
  };

  const captureExcluded=Boolean(privacy?.launcher_capture_excluded && privacy?.overlay_capture_excluded);
  const taskbarHidden=Boolean(privacy?.taskbar_hidden);

  const visiblePanels=Number(!settings.compactView)+Number(settings.transcriptVisible)+Number(settings.answerVisible);
  return <div className={`app-shell theme-${settings.theme}${settings.compactView?" compact":""}${settings.transcriptVisible?"":" hide-transcript"}${settings.answerVisible?"":" hide-answer"}`} style={{opacity:settings.opacity/100}}>
    <header className="app-header" onMouseDown={dragWindow}>
      <div className="brand">
        <div className="brand-mark" role="button" tabIndex={0} title="双击切换练习与实时提示页面"
          aria-label="双击切换练习与实时提示页面" onDoubleClick={()=>{
            if (running || startingService || practiceWorking || practiceActive || updater.busy) {setSwitchNotice("请先结束当前操作");return;}
            setSwitchNotice("");setWorkspaceMode(value=>value==="practice"?"assist":"practice");
          }}
          onKeyDown={event=>{if(event.key==="Enter" && !running && !startingService && !practiceWorking && !practiceActive && !updater.busy)setWorkspaceMode(value=>value==="practice"?"assist":"practice");}}><Sparkles size={22}/></div>
        <div><strong>模拟面试练习 <span className="app-version">{version && `v${version}`}</span></strong>
          <span>{switchNotice || (workspaceMode==="practice"?"模拟面试官 · 回答复盘":"实时听题 · 回答提示")}</span></div></div>
      <div className="header-actions"><span className="local-pill"><span className="live-dot"/> {settings.sttMode === "api" || settings.decision.api !== "ollama" || settings.answer.api !== "ollama" ? "已启用可选 API" : (settings.sharedModelConnection ? answerReady : decisionReady && answerReady) ? "本地模型已连接" : "本地模型未连接"}</span>
        {workspaceMode==="assist" && <>
        <button className="ghost-btn panel-toggle" onClick={()=>update({compactView:!settings.compactView})} aria-pressed={!settings.compactView}
          disabled={!settings.compactView && visiblePanels===1} title="显示或隐藏控制区">
          {settings.compactView?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>} 控制区</button>
        <button className="ghost-btn panel-toggle" onClick={()=>update({transcriptVisible:!settings.transcriptVisible})} aria-pressed={settings.transcriptVisible}
          disabled={settings.transcriptVisible && visiblePanels===1} title="显示或隐藏实时转录"><ScanText size={17}/> 转录</button>
        <button className="ghost-btn panel-toggle" onClick={()=>update({answerVisible:!settings.answerVisible})} aria-pressed={settings.answerVisible}
          disabled={settings.answerVisible && visiblePanels===1} title="显示或隐藏回答提示"><Sparkles size={17}/> 提示</button>
        </>}
        {workspaceMode==="practice" && <>
          <button className="ghost-btn panel-toggle" aria-pressed={practiceSetupVisible}
            onClick={()=>setPracticeSetupVisible(value=>!value)}><PanelLeftClose size={17}/> 练习设置</button>
          <button className="ghost-btn panel-toggle" aria-pressed={practiceFeedbackVisible}
            onClick={()=>setPracticeFeedbackVisible(value=>!value)}><Sparkles size={17}/> 回答复盘</button>
        </>}
        <button className="ghost-btn" onClick={()=>{setSettingsTab("history");setShowSettings(true);}}><FileText size={17}/> 历史</button>
        <button className="ghost-btn" onClick={() => setShowSettings(!showSettings)}><Settings2 size={17}/> 设置</button>
        <button className={settings.launcherOnTop ? "ghost-btn top-active" : "ghost-btn"}
          aria-pressed={settings.launcherOnTop} onClick={() => update({launcherOnTop:!settings.launcherOnTop})}>
          <Pin size={16}/> {settings.launcherOnTop ? "取消置顶" : "窗口置顶"}</button>
        <button className="ghost-btn" onClick={() => void toggleOverlay()}><MonitorPlay size={17}/> {overlayVisible?"隐藏悬浮窗":"显示悬浮窗"}</button>
        {workspaceMode==="assist" && <>
        <button className={running?"stop-btn":"start-btn"} onClick={() => void (running?stop():start())} disabled={startingService || updater.busy}>
          {running?<><Square size={14} fill="currentColor"/> 结束练习</>:startingService?"连接本地模型…":<><Play size={15} fill="currentColor"/> 开始聆听</>}
        </button>
        </>}
      </div>
        <div className="window-actions">
          <button className="window-action" aria-label="最小化" title="最小化" onClick={()=>void getCurrentWebviewWindow().minimize()}><Minus size={16}/></button>
          <button className="window-action" aria-label="最大化或还原" title="最大化或还原" onClick={()=>void getCurrentWebviewWindow().toggleMaximize()}><Maximize2 size={14}/></button>
          <button className="window-action close" aria-label="关闭程序" title="关闭程序" onClick={()=>void quitRef.current()}><X size={17}/></button>
        </div>
    </header>
    {(historyError || practiceHistoryError || historyNativeError) && <p className="error-box history-save-error" role="alert">{historyError || practiceHistoryError || historyNativeError}</p>}
    {workspaceMode==="practice" ? <PracticeView model={endpoint(settings.answer,"answer")}
      domain={settings.domain} liveRunning={running} personalization={settings.answerInstructions}
      onSessionActiveChange={setPracticeActive} onWorkActiveChange={setPracticeWorking} updating={updater.busy}
      onPreviewChange={setPracticePreview} history={practiceHistoryRecorder}
      onModelSettings={()=>{setSettingsTab("models");setShowSettings(true);}}
      onConfigChange={onPracticeConfigChange} profileEpoch={profileEpoch}
      resume={resume} analysis={resumeAnalysis} resumePath={settings.resumePath} resumeError={resumeError}
      onResumeImported={importResume} onAnalysis={storeResumeAnalysis} onClearResume={clearResume}
      role={settings.targetRole} topics={settings.focusTopics}
      onRoleChange={value=>update({targetRole:value})} onTopicsChange={value=>update({focusTopics:value})}
      setupVisible={practiceSetupVisible} feedbackVisible={practiceFeedbackVisible}
      stt={{mode:settings.sttMode,engine:settings.sttEngine,model:settings.sttModel,
        apiProvider:settings.sttApiProvider,apiModel:settings.sttApiModel,mic:settings.mic,output:settings.output}}/> : <main className="workspace">
      <section className="left-rail">
        <div className="rail-caption">工作台 <span>01 / 03</span></div>
        <div className="hero-card"><div className="hero-icon"><AudioLines size={25}/></div><h1>专注听题，<br/>从容作答。</h1><p>听到面试官的问题后，自动提炼关键意图，生成可扫读的中文提示。</p>
          <div className="hero-footer"><span className="live-dot"/> {settings.sttMode === "api" || settings.decision.api !== "ollama" || settings.answer.api !== "ollama" ? "所选 API 会接收对应环节的数据" : "当前为本地模型模式"}</div></div>
        <div className="section-title"><span>当前模式</span><CircleHelp size={15}/></div>
        <div className="mode-grid"><button className={settings.mode==="live"?"mode-card selected":"mode-card"} onClick={()=>update({mode:"live"})} disabled={running}><Headphones size={19}/><strong>远程面试</strong><small>{settings.micTranscription ? "面试音频＋我的回答" : "只听系统声音"}</small></button>
          <button className={settings.mode==="video"?"mode-card selected":"mode-card"} onClick={()=>update({mode:"video"})} disabled={running}><MonitorPlay size={19}/><strong>视频测试</strong><small>双方同一音轨</small></button></div>
        <div className="status-card"><div className="status-top"><span>采集状态</span><span className={`status-chip ${status}`}>{statusText[status]}</span></div>
          <div className="meter-label"><Volume2 size={15}/> 面试音频 <span>{Math.round(systemLevel*100)}%</span></div><div className="meter"><i style={{width:`${systemLevel*100}%`}}/></div>
          <div className="meter-label"><Mic2 size={15}/> 我的麦克风 <span>{Math.round(micLevel*100)}%</span></div><div className="meter mic"><i style={{width:`${micLevel*100}%`}}/></div>
          <div className="meter-foot">{locked?<><LockKeyhole size={13}/> 你正在说话，提示更新已锁定</>:settings.mode==="live" && settings.micTranscription ? "麦克风转录用于理解追问" : "麦克风仅用于控制提示更新"}</div></div>
        <div className="rail-note"><span>使用提示</span><p>播放视频时，先确认「面试音频」音量条有变化。若始终为 0，请在设置中选择视频实际使用的输出设备。</p></div>
      </section>
      <section className="transcript-panel"><div className="panel-header"><div><span className="panel-kicker">实时识别</span><h2>实时转录</h2></div><span className="panel-count">{segments.length} 条记录</span></div>
        <div className="transcript-scroll" ref={transcriptScrollRef} onScroll={event=>{
          const node=event.currentTarget;
          followTranscriptRef.current=node.scrollHeight-node.clientHeight-node.scrollTop<56;
        }}>{segments.length===0 && !partial && !micPartial && <div className="empty-state"><div className="empty-icon"><ScanText size={30}/></div><h3>等待声音进入</h3><p>开始聆听后，这里会出现面试音频的增量转录。</p><span>中英文术语会保留原始识别结果</span></div>}
          {segments.map((item,index)=><div className="utterance" key={item.id}><div className="utterance-meta"><span className="speaker-dot"/> {item.speaker==="User" ? "我的回答" : settings.mode==="video" ? "视频音频" : "面试官"} <span>#{String(index+1).padStart(2,"0")}</span></div><p>{item.text}</p></div>)}
          {partial && <div className="utterance partial"><div className="utterance-meta"><span className="speaker-dot"/> {settings.mode==="video" ? "视频音频" : "面试官"} · 正在识别 <Activity size={13}/></div><p>{partial.text}</p></div>}
          {micPartial && <div className="utterance partial"><div className="utterance-meta"><span className="speaker-dot"/> 我的回答 · 正在识别 <Activity size={13}/></div><p>{micPartial.text}</p></div>}
          </div>
        <div className="panel-footer"><Radio size={14}/> {running?"转录会持续更新，问题是否已足够明确由模型判断":"开始后自动接收音频与转录"}</div>
      </section>
      <section className="answer-panel"><div className="panel-header"><div><span className="panel-kicker">要点提示</span><h2>回答提示</h2></div><span className="answer-spark"><Sparkles size={17}/></span></div>
        <div className="answer-content"><div className="question-heading"><div className="answer-label">模型理解的问题</div></div>
          {editingQuestion ? <div className="question-editor"><textarea aria-label="修正模型理解的问题" autoFocus
              value={questionDraft} maxLength={600} rows={3} placeholder="输入要测试或修正的问题，例如：请写出注意力计算公式" onChange={event=>setQuestionDraft(event.target.value)}
              onKeyDown={event=>{
                if (event.key==="Escape") {event.preventDefault();setEditingQuestion(false);}
                else if (event.key==="Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode!==229) {
                  event.preventDefault();submitEditedQuestion();
                }
              }}/><div className="question-editor-actions"><span>{running ? "修正后重新生成提示" : "直接测试回答，无需开始聆听"} · Enter 提交，Shift+Enter 换行</span>
              <button onClick={()=>setEditingQuestion(false)}>取消</button>
              <button className="primary" disabled={!questionDraft.trim()} onClick={submitEditedQuestion}>{question ? "保存并重新回答" : "生成回答"}</button></div></div>
            : <button type="button" className={question?"question-box editable active":"question-box editable"} aria-label="编辑问题" title="点击编辑问题"
              onClick={()=>{setQuestionDraft(question);setEditingQuestion(true);}}><MathText text={question || "点击输入问题，或等待转录识别…"}/></button>}
          {keyTerms.length>0 && <div className="term-list" aria-label="技术关键词">{keyTerms.map(term=><span className="term-chip" key={term}>{term}</span>)}</div>}
          {uncertainTerms.length>0 && <div className="term-warning">可能听错的术语：{uncertainTerms.join("、")}</div>}
          <div className="answer-label answer-label-space">{answerSource==="saved" ? "自我介绍稿" : "定义与原理"} <span>{status==="generating"&&<span className="inline-loading"><RefreshCw size={13}/> 生成中</span>}</span></div>
          <div className="answer-card">{hint?<div className="answer-text"><MathText text={hint}/></div>:<div className="answer-placeholder"><span className="answer-placeholder-icon"><Sparkles size={22}/></span><strong>提示将在这里出现</strong><p>先看概念定义，再看具体工作原理。</p></div>}</div>
          {hint && answerSource!=="saved" && <button className="detail-btn" onClick={()=>{
            if (!showDetail && (!detail || detail.startsWith("原理解释失败：")) && !detailLoading) void loadDetail();
            setShowDetail(!showDetail);
          }}><ChevronDown size={15} className={showDetail?"rotated":""}/>{showDetail?"收起细节":"展开细节"}</button>}
          {showDetail && hint && answerSource!=="saved" && <div className="detail-card"><b>进一步解释</b><p><MathText text={detailLoading?"正在补充细节…":detail || "等待补充细节…"}/></p>
            <div className="detail-timings">判别 {decisionMs??"—"} ms · 模型首字 {answerMs??"—"} ms · 首条可见 {visibleMs??"—"} ms · 完成 {completeMs??"—"} ms · 转录至完整 {transcriptToCompleteMs??"—"} ms</div></div>}
          {error && <div className="error-box">{error}</div>}</div>
        <div className="answer-footer"><span><Check size={14}/> {answerSource===null ? "等待回答" : answerSource==="saved" ? "已保存的自我介绍" : answerSource === "local" ? "本地回答" : "API 回答"}{apiPending ? " · API 完善中" : ""}</span><span>判别 {decisionMs??"—"} ms</span><span>提示可见 {visibleMs??"—"} ms</span><span title="从触发本次判别的转录更新，到这次回答完整生成">转录→完整 {transcriptToCompleteMs??"—"} ms</span></div>
      </section>
    </main>}
    {showSettings && <div className="settings-scrim" onClick={()=>setShowSettings(false)}><aside className="settings-drawer" onClick={event=>event.stopPropagation()}>
      <div className="drawer-head" onMouseDown={dragWindow}><div><span className="panel-kicker">偏好设置</span><h2>{({display:"界面与隐私",audio:"音频设备",profile:"个人资料",models:"模型与服务",updates:"软件更新",diagnostics:"诊断日志",history:"历史会话"} as const)[settingsTab]}</h2></div><button className="icon-btn" aria-label="关闭设置" onClick={()=>setShowSettings(false)}><X size={20}/></button></div>
      <nav className="settings-tabs" role="tablist" aria-label="设置分类">
        {([ ["display","界面与隐私",Sun], ["audio","音频设备",Headphones], ["profile","个人资料",FileText], ["models","模型与服务",Sparkles], ["updates","软件更新",RefreshCw], ["diagnostics","诊断日志",Activity], ["history","历史会话",FileText] ] as const).map(([tab,label,Icon])=><button
          key={tab} role="tab" aria-selected={settingsTab===tab} className={settingsTab===tab?"settings-tab selected":"settings-tab"}
          onClick={()=>{setSettingsTab(tab);setRecordingQuitShortcut(false);setQuitShortcutDraft("");}}><Icon size={15}/><span>{label}</span></button>)}
      </nav>
      <div className="drawer-scroll" key={settingsTab}><fieldset className="settings-fields" disabled={updater.busy && settingsTab!=="updates"}>
        {settingsTab === "display" && <>
        <div className="setting-group"><div className="setting-heading"><LockKeyhole size={18}/> 隐私与显示</div>
          <p className="setting-help">每次启动默认开启“录屏排除”和“隐藏任务栏”，本次关闭后，下次启动会重新开启。任务栏隐藏需恢复快捷键可用；隐藏后本机任务栏也不显示该图标。录屏排除仅对支持 Windows 排除机制的捕获方式有效，实际共享效果需验证。</p>
          <div className="privacy-presets">
            {([['普通模式',false,false],['录屏排除',true,false],['隐藏任务栏',false,true],['两项都开启',true,true]] as const).map(([name,capture,taskbar])=><button key={name}
              className={captureExcluded===capture && taskbarHidden===taskbar ? "privacy-preset selected" : "privacy-preset"}
              aria-pressed={captureExcluded===capture && taskbarHidden===taskbar}
              disabled={privacyBusy || !privacy || (taskbar && !restoreReady)}
              onClick={()=>void changePrivacy(capture,taskbar)}>{name}</button>)}
          </div>
          <div className="privacy-row"><div><strong>排除屏幕捕获</strong><small>同时作用于主窗口和悬浮窗</small></div>
            <button className={captureExcluded?"privacy-switch on":"privacy-switch"} aria-pressed={captureExcluded}
              disabled={privacyBusy || !privacy} onClick={()=>void changePrivacy(!captureExcluded,taskbarHidden)}>{captureExcluded?"已开启":"已关闭"}</button></div>
          <div className="privacy-row"><div><strong>隐藏任务栏与 Alt+Tab</strong><small>窗口仍留在屏幕上，可直接操作；{restoreShortcutLabel || "恢复快捷键准备中"} 可恢复任务栏入口</small></div>
            <button className={taskbarHidden?"privacy-switch on":"privacy-switch"} aria-pressed={taskbarHidden}
              disabled={privacyBusy || !privacy || (!taskbarHidden && !restoreReady)}
              onClick={()=>void changePrivacy(captureExcluded,!taskbarHidden)}>{taskbarHidden?"已开启":"已关闭"}</button></div>
          <p className="setting-help">窗口样式状态：主窗口捕获排除 {privacy?.launcher_capture_excluded?"已设置":"未设置"}；悬浮窗 {privacy?.overlay_capture_excluded?"已设置":"未设置"}；任务栏隐藏 {taskbarHidden?"已设置":"未设置"}。{restoreReady?"恢复快捷键可用。":"恢复快捷键不可用，不能隐藏任务栏。"}请以任务栏和实际共享画面为准。</p>
          <p className="setting-help">“隐藏任务栏”只隐藏主窗口在任务栏和 Alt+Tab 的入口，不会缩小或关闭窗口。需要恢复时，点击“恢复普通模式”，或按上方显示的恢复快捷键。录屏排除与此独立。</p>
          {privacyError && <div className="error-box" role="alert">{privacyError}</div>}
          <button className="download-btn" disabled={privacyBusy || !privacy} onClick={()=>void changePrivacy(false,false)}>恢复普通模式</button>
        </div>
        <div className="setting-group"><div className="setting-heading"><Sun size={18}/> 界面外观</div>
          <label>皮肤<select value={settings.theme} onChange={event=>update({theme:event.target.value as Settings["theme"]})}>
            <option value="dark">深色</option><option value="light">浅色</option></select></label>
          <label>窗口透明度 · {settings.opacity}%<input type="range" min="70" max="100" step="5" value={settings.opacity}
            onChange={event=>update({opacity:Number(event.target.value)})}/></label>
          <p className="setting-help">透明度会同时作用于文字和背景；低于 80% 时，请留意文字是否仍清晰。控制区可从顶部收起，转录与回答会保留。</p>
          <label>面试场景<select value={settings.mode} onChange={event=>update({mode:event.target.value as Mode})} disabled={running}>
            <option value="live">远程面试 · 只听系统声音</option><option value="video">视频测试 · 双方同一音轨</option></select></label>
          <p className="setting-help">主窗口顶部的“控制区、转录、提示”可分别显示或隐藏；至少保留一块内容。窗口缩小时其余内容可滚动查看。</p>
        </div>
        </>}
        {settingsTab === "audio" && <>
        <div className="setting-group"><div className="setting-heading"><Headphones size={18}/> 音频设备 <button className="text-link" onClick={()=>void refreshDevices()}>刷新</button></div>
        <label>面试音频输出设备<select value={settings.output} onChange={e=>update({output:e.target.value})} disabled={running}><option value="default">系统默认输出</option>{devices.outputs.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>我的麦克风<select value={settings.mic} onChange={e=>update({mic:e.target.value})} disabled={running}><option value="default">系统默认麦克风</option>{devices.inputs.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="connection-sharing"><input type="checkbox" checked={settings.micTranscription} disabled={running || practiceActive}
            onChange={e=>update({micTranscription:e.target.checked})}/><span>转录我的回答，用于理解追问（远程面试）</span></label>
          <p className="setting-help">麦克风与系统音频使用所选识别服务，分别标记角色。你的回答仅提供上下文，面试官的发言触发判别。双路会增加本机资源或 API 用量；语音 API 会收到麦克风声音，判别 API 会收到相关对话文本。视频测试沿用视频单音轨。</p></div>
        </>}
        {settingsTab === "profile" && <>
        <div className="setting-group"><div className="setting-heading"><FileText size={18}/> 面试背景</div>
          <label>目标岗位（可选）<input value={settings.targetRole} maxLength={120} disabled={running || practiceActive || practiceWorking || startingService}
            placeholder="如：算法工程师" onChange={event=>update({targetRole:event.target.value})}/></label>
          <label>关注主题（可选）<input value={settings.focusTopics} maxLength={300} disabled={running || practiceActive || practiceWorking || startingService}
            placeholder="如：具身智能、通信协议" onChange={event=>update({focusTopics:event.target.value})}/></label>
          <p className="setting-help">岗位与主题只帮助选题和术语消歧，不作为个人经历事实。使用外部模型时，这两个填写项可能随请求发送。</p>
          <div className="setup-actions"><button className="download-btn" disabled={running || practiceActive || practiceWorking || startingService} onClick={()=>void chooseSharedResume()}>
            {settings.resumePath?"更换简历":"选择简历"}</button>
            {settings.resumePath && <button className="download-btn" disabled={running || practiceActive || practiceWorking || startingService} onClick={clearResume}>移除简历</button>}</div>
          {settings.resumePath && <p className="setting-help">已保存路径：{settings.resumePath}。{resumeAnalysis?"本地分析已保存；只取简历原文中出现的术语作本地消歧。":"尚未分析；在练习页使用本地 Ollama 分析后可供实时提示使用。"}</p>}
          {resumeError && <p className="setting-help" role="alert">{resumeError}</p>}
          <p className="setting-help">简历原文不用于实时技术题答案。外部判别、回答及语音 API 默认不会收到简历提取内容。</p>
        </div>
        <div className="setting-group"><div className="setting-heading"><FileText size={18}/> 领域背景</div>
          <label>技术背景<select value={settings.domain} onChange={e=>update({domain:e.target.value as Settings["domain"]})} disabled={running}>
            <option value="general">通用技术</option><option value="ai">人工智能</option><option value="communication">通信与网络</option></select></label>
          <p className="setting-help">背景目前仅作为 Whisper.cpp 和 Groq 的短提示，不作为回答事实；Deepgram 暂不使用该选项。Groq 按音频段返回，实时性可能弱于流式服务；语音 API 会收到面试音频。</p>
        </div>
        <div className="setting-group"><div className="setting-heading"><FileText size={18}/> 自我介绍</div>
          <label>自我介绍稿（自动保存）<textarea aria-label="自我介绍稿" value={settings.selfIntroduction} maxLength={4000} rows={7}
            placeholder="粘贴你准备好的自我介绍。请填写真实经历；可按教育背景、研究或项目、岗位匹配度组织。"
            onChange={e=>update({selfIntroduction:e.target.value})}/></label>
          <p className="setting-help">面试官要求你进行自我介绍时，直接在提示区显示这份稿子。保存稿不交给模型改写，也不加入其他问题的生成上下文。留空时提示你填写，最多 4000 字。</p>
        </div>
        <div className="setting-group"><div className="setting-heading"><Pencil size={18}/> 回答要求</div>
          <p className="setting-help">自定义回答的表达方式、简短程度和关注方向；只影响后续回答及“展开细节”。留空使用内置要求。</p>
          <label>给回答模型的附加要求<textarea value={settings.answerInstructions} maxLength={1200} rows={7}
            onChange={event=>update({answerInstructions:event.target.value})}
            placeholder={ANSWER_PROMPT_EXAMPLE}/></label>
          <div className="setup-actions"><button className="download-btn" onClick={()=>update({answerInstructions:ANSWER_PROMPT_EXAMPLE})}>填入示例（覆盖当前内容）</button>
            <button className="download-btn" disabled={!settings.answerInstructions} onClick={()=>update({answerInstructions:""})}>清空，使用内置要求</button></div>
          <p className="setting-help">示例中的“XX”请改成你的方向。个人背景只用于调整讲解重点，不作为项目经历的事实依据。若回答模型使用云端 API，这段要求也会发送给对应服务。</p>
        </div>
        <div className="setting-group"><div className="setting-heading"><FileText size={18}/> 配置保存与备份</div>
          <p className="setting-help">模型选择、接口地址、个人资料、简历路径和已完成的简历分析会自动保存到本机配置文件，更新同一应用后继续读取。</p>
          <div className="setup-actions"><button className="download-btn" disabled={!profileReady || running || practiceActive || practiceWorking || startingService}
            onClick={()=>void exportProfile()}>导出配置文件</button>
            <button className="download-btn" disabled={!profileReady || running || practiceActive || practiceWorking || startingService}
              onClick={()=>void importProfile()}>从文件导入</button></div>
          <p className="setting-help">备份包含资料和简历分析，请妥善保管。API 密钥由 Windows 凭据管理器单独保存，不写入备份；简历原文件也不会复制进去。</p>
          {profileNotice && <p className="setting-help" role="status">{profileNotice}</p>}
          {profileError && <div className="error-box" role="alert">{profileError}</div>}
        </div>
        </>}
        {settingsTab === "models" && <>
        <div className="setting-group"><div className="setting-heading"><ScanText size={18}/> 语音识别</div>
          <label>运行方式<select value={settings.sttMode} onChange={e=>update({sttMode:e.target.value as SttMode})} disabled={running}>
            <option value="local">本地模型</option><option value="api">语音识别 API</option></select></label>
          {settings.sttMode === "local" ? <>
            <p className="setting-help">当前已适配：Whisper.cpp 的下列 GGML 模型，以及官方 Sherpa-ONNX 的 Zipformer 中英双语版和 Paraformer 中英双语版。两款双语模型是真流式识别，可持续输出增量文字；Whisper 按音频块推理。其他 ONNX 或同名模型不能仅靠选择文件夹直接使用。</p>
            <label>识别引擎<select value={settings.sttEngine} onChange={e=>update({sttEngine:e.target.value,
              sttModel:e.target.value === "sherpa_bilingual" ? "zipformer-zh-en" : "small"})} disabled={running || !!download}>
              <option value="whisper_cpp">Whisper.cpp · 分块识别</option>
              <option value="sherpa_bilingual">Sherpa-ONNX · 中英双语流式</option>
            </select></label>
            <label>识别模型<select value={settings.sttModel} onChange={e=>update({sttModel:e.target.value})} disabled={running}>{chosenEngine?.models.map(item=><option key={item.id} value={item.id}>{item.name} {item.is_downloaded?"✓":"· 未下载"}</option>)}</select></label>
            {settings.sttEngine === "sherpa_bilingual" && <p className="setting-help">这两款使用已打包的 sherpa-onnx CPU 运行库。首次点击下载会从魔搭镜像取得已核对的模型包，经 SHA-256 校验后解压；Zipformer 约 511 MB，Paraformer 约 226 MB，请预留解压空间。双语支持不等于术语识别已验证，具体效果以试听为准。</p>}
            <p className="setting-help">当前语音模型目录：{sttModelsDirectory || "正在读取…"}</p>
            <div className="key-actions"><button onClick={()=>void chooseSttModelsDirectory()} disabled={running || !!download}>选择已有模型文件夹</button>
              <button onClick={()=>void refreshEngines()} disabled={running}>重新检测</button></div>
            <p className="setting-help">选择模型总目录；其中 Whisper 放在 whisper_cpp，双语模型放在 sherpa_bilingual 子文件夹。已有模型不会被移动或重新下载。</p>
            {!chosenModel?.is_downloaded && <button className="download-btn" onClick={()=>void downloadModel()} disabled={!!download}>{download||"下载所选模型"}</button>}
          </> : <>
            <p className="setting-help">语音 API 目前分别适配 Groq Whisper 的分段上传接口与 Deepgram Nova 的实时流式接口。模型 ID 必须由所选服务提供；其他语音服务即使也叫“Whisper”或提供 API，仍需对应的接入适配。</p>
            <label>服务<select value={settings.sttApiProvider} onChange={e=>update({sttApiProvider:e.target.value as SttApiProvider,
              sttApiModel:e.target.value === "deepgram" ? "nova-3" : "whisper-large-v3-turbo"})} disabled={running}>
              <option value="groq_whisper">Groq Whisper · 分段请求</option><option value="deepgram">Deepgram Nova · 流式</option></select></label>
            <label>模型 ID<input value={settings.sttApiModel} onChange={e=>update({sttApiModel:e.target.value})} disabled={running}/></label>
            <div className="key-control"><label>API 密钥（保存到 Windows 凭据管理器）<input type="password"
              value={keyDrafts[settings.sttApiProvider] || ""}
              onChange={e=>setKeyDrafts(current=>({...current,[settings.sttApiProvider]:e.target.value}))}
              placeholder={savedKeys[settings.sttApiProvider]?"已保存；留空表示继续使用":"输入服务密钥"} disabled={running}/></label>
              <div className="key-actions"><button onClick={()=>void saveKey(settings.sttApiProvider)} disabled={!keyDrafts[settings.sttApiProvider]?.trim() || running}>保存密钥</button>
                {savedKeys[settings.sttApiProvider] && <button onClick={()=>void removeKey(settings.sttApiProvider)} disabled={running}>删除已存密钥</button>}</div></div>
          </>}
</div>
        <div className="setting-group"><div className="setting-heading"><Sparkles size={18}/> 模型连接方式</div>
          <label className="connection-sharing"><input type="checkbox" checked={settings.sharedModelConnection}
            disabled={running || practiceActive || practiceWorking || startingService || testingModel!==null || linkingModels}
            onChange={e=>void toggleSharedModels(e.target.checked)}/><span>判别与回答共用连接（推荐）</span></label>
          <p className="setting-help">{linkingModels ? "正在切换连接设置…" : settings.sharedModelConnection
            ? "只需设置一次服务、密钥和模型。练习出题与评价也使用这份连接。复杂追问及术语纠偏依赖判别模型能力；本地小模型不稳定时，可选择更强的 API 模型。"
            : "分别配置不同服务或模型。已有配置已保留；开启共用后采用回答生成的连接，关闭后恢复原判别配置。"}</p></div>
        {!settings.sharedModelConnection && stageEditor("decision","语义判别",decisionChoices,decisionReady)}
        {stageEditor("answer",settings.sharedModelConnection ? "共用模型连接" : "回答生成",answerChoices,answerReady)}
        <div className="setting-group"><div className="setting-heading"><Sparkles size={18}/> 回答并行</div>
          <label className="connection-sharing"><input type="checkbox" checked={settings.parallelAnswer}
            disabled={running || practiceActive} onChange={e=>update({parallelAnswer:e.target.checked})}/>
            <span>本地与 API 同时生成实时回答</span></label>
          <p className="setting-help">先显示较快的一路，两路结束后用完整成功的 API 回答替换。本地结果仅供临时参考；并行会增加本机负载及 API 用量。出题和评分仍使用共用或判别连接。API 不会自动收到简历内容。</p>
          {settings.parallelAnswer && <>
            {settings.answer.api === "ollama" && <p className="setting-help" role="alert">请将上方回答连接设置为 API；当前仍只调用本地模型。</p>}
            <label>并行本地模型<input list="parallel-local-models" value={settings.parallelLocal.model}
              disabled={running || practiceActive} onChange={e=>update({parallelLocal:{...settings.parallelLocal,model:e.target.value}})}/>
              <datalist id="parallel-local-models">{parallelModels.map(model=><option key={model} value={model}/>)}</datalist></label>
            <button disabled={running || practiceActive} onClick={()=>void invoke<string[]>("mvp_list_models",{endpoint:endpoint(settings.parallelLocal,"answer")})
              .then(setParallelModels).catch(cause=>setError(`获取本地模型失败：${String(cause)}`))}>检测本地模型</button>
            <label>本地 Ollama 地址<input value={settings.parallelLocal.baseUrl} disabled={running || practiceActive}
              onChange={e=>update({parallelLocal:{...settings.parallelLocal,baseUrl:e.target.value}})}/></label>
          </>}
        </div>
        <div className="setting-group"><label className="check-row"><input type="checkbox" checked={settings.decisionFinalOnly} disabled={running || practiceWorking} onChange={e=>update({decisionFinalOnly:e.target.checked})}/>语义判别仅使用稳定转录片段（省 API 用量）</label>
          <p className="setting-help">勾选后仍显示增量转录，但等片段稳定才调用判别模型；可减少重复请求，首条提示可能稍晚。默认保留增量判别。手动输入问题会跳过判别。</p></div>
        {(settings.decision.api === "ollama" || settings.answer.api === "ollama" || settings.parallelAnswer) && <div className="setting-group ollama-setup">
          <div className="setting-heading"><Sparkles size={18}/> 本地 Ollama
            <button className="text-link" onClick={()=>void refreshOllamaRuntime()} disabled={ollamaChecking}>{ollamaChecking?"检测中…":"重新检测"}</button></div>
          <p className="setting-help">选择本地模式需要先安装 Ollama，并下载至少一个本地大模型。首次下载需要联网；之后可在本机运行。</p>
          <div className="runtime-state">{ollamaChecking ? "正在检测 Ollama…" : ollamaCheckError ? "检测失败，请查看下方原因" :
            ollamaRuntime?.connected ? "服务已连接" : ollamaRuntime?.executable ? "已找到程序，服务未启动" : "未找到 Ollama 程序"}</div>
          {ollamaCheckError && <p className="setting-help" role="alert">检测失败：{ollamaCheckError}</p>}
          {!ollamaChecking && !ollamaCheckError && !ollamaRuntime?.executable && ollamaRuntime?.configuredExecutable &&
            <p className="setting-help">保存的程序路径无法访问：{ollamaRuntime.configuredExecutable}</p>}
          {!ollamaChecking && !ollamaCheckError && !ollamaRuntime?.executable && ollamaRuntime?.configFile &&
            <p className="setting-help">当前配置位置：{ollamaRuntime.configFile}</p>}
          <div className="setup-actions"><button className="download-btn" onClick={()=>void openExternal("https://ollama.com/download/windows").catch(cause=>setError(`无法打开官方下载页：${String(cause)}`))}>打开 Ollama 官方下载页</button>
            <button className="download-btn" onClick={()=>void openExternal("https://docs.ollama.com/windows").catch(cause=>setError(`无法打开安装说明：${String(cause)}`))}>查看安装教程</button></div>
          <p className="setting-help">官方安装程序可指定安装位置；安装后点击“重新检测”。若仍未找到，请在下面选择实际的 ollama.exe。应用不会改动已有 Ollama 安装。</p>
          <label>Ollama 程序位置<div className="path-row"><input value={ollamaExeDraft} onChange={e=>setOllamaExeDraft(e.target.value)} placeholder="自动检测或选择 ollama.exe" disabled={running}/><button onClick={()=>void chooseOllamaExe()} disabled={running}>选择文件</button></div></label>
          <label>模型存放文件夹（可选）<div className="path-row"><input value={ollamaModelsDraft} onChange={e=>setOllamaModelsDraft(e.target.value)} placeholder="留空使用 Ollama 默认位置" disabled={running}/><button onClick={()=>void chooseOllamaModels()} disabled={running}>选择文件夹</button></div></label>
          <p className="setting-help">此文件夹只对本应用启动的 Ollama 生效。若 Ollama 已在后台运行，需退出后再启动；本应用不会迁移已有模型文件。</p>
          <div className="setup-actions"><button className="download-btn" onClick={()=>void saveOllamaPaths()} disabled={running}>保存本地路径</button>
            {!ollamaRuntime?.connected && <button className="download-btn" onClick={()=>void startService()} disabled={startingService}>{startingService?"正在启动…":"启动 Ollama"}</button>}</div>
          {ollamaNotice && <p className="setting-help">{ollamaNotice}</p>}
          <label>下载本地模型<div className="path-row"><input value={pullModelId} onChange={e=>setPullModelId(e.target.value)} placeholder="例如 qwen3:4b-instruct" disabled={pulling}/><button onClick={()=>void pullOllamaModel()} disabled={pulling || !pullModelId.trim()}>{pulling?"下载中…":"下载模型"}</button></div></label>
          {pullProgress && <p className="setting-help" role="status">{pullProgress}</p>}
          <p className="setting-help">下载完成后，在下方判别和回答设置中选择该模型。模型文件可能占用数 GB；API 模式无需安装 Ollama。</p>
        </div>}
        </>}
        {settingsTab === "display" &&
        <div className="setting-group"><div className="setting-heading"><Pin size={18}/> 窗口与快捷键</div>
          <p className="setting-help">主窗口置顶可在顶部随时切换；悬浮提示窗默认置顶。</p>
          <label>老板键：立即退出整个程序
            <input ref={quitShortcutInputRef} value={recordingQuitShortcut ? (quitShortcutDraft ? shortcutLabel(quitShortcutDraft) : "请按下新快捷键…") : shortcutLabel(settings.quitShortcut)}
              readOnly onKeyDown={event => {
                if (!recordingQuitShortcut) return;
                event.preventDefault();event.stopPropagation();
                if (event.key === "Escape") {setRecordingQuitShortcut(false);setQuitShortcutDraft("");return;}
                const shortcut=capturedShortcut(event);
                if (shortcut) {setQuitShortcutDraft(shortcut);setQuitShortcutError("");}
              }} aria-label="退出程序快捷键"/>
          </label>
          <div className="key-actions">
            {!recordingQuitShortcut ? <button onClick={()=>{setQuitShortcutDraft("");setRecordingQuitShortcut(true);}}>
              更改快捷键</button> : <>
              <button onClick={()=>{
                if(quitShortcutDraft===restoreShortcutRef.current){setQuitShortcutError("该组合键已用于恢复任务栏，请选择其他组合键。");return;}
                setSettings(current=>({...current,quitShortcut:quitShortcutDraft}));setRecordingQuitShortcut(false);
              }}
                disabled={!quitShortcutDraft}>保存快捷键</button>
              <button onClick={()=>{setRecordingQuitShortcut(false);setQuitShortcutDraft("");}}>取消</button>
            </>}
          </div>
          <p className="setting-help">默认 Ctrl + `。录入时同时按 Ctrl、Alt 或 Shift 与字母、数字、F1–F12 或 ` 键；Esc 取消。快捷键在其他窗口中也生效，按下后立即退出。</p>
          {quitShortcutError && <div className="error-box" role="alert">{quitShortcutError}</div>}
        </div>}
        {settingsTab === "updates" && <SoftwareUpdate version={version} blocked={updateBlocked} updater={updater}/>}
        {settingsTab === "history" && <HistoryView activeIds={[liveHistory.sessionId,practiceHistoryRecorder.sessionId]}/>}
        {settingsTab === "diagnostics" &&
        <div className="setting-group"><div className="setting-heading"><Activity size={18}/> 诊断日志</div>
          <p className="setting-help">仅保存在本机，最多保留最近 80 条状态与耗时；不记录音频、转录内容或 API 密钥。</p>
          <details className="diagnostic-panel"><summary>查看记录（{diagnostics.length} 条）</summary>
            <pre>{diagnostics.length ? diagnostics.map(item=>
              `${new Date(item.time).toLocaleString("zh-CN")}  ${item.event}${item.detail?` · ${item.detail}`:""}`).join("\n") : "暂无记录"}</pre>
            <div className="key-actions"><button disabled={!diagnostics.length} onClick={()=>void navigator.clipboard.writeText(
              diagnostics.map(item=>`${item.time} ${item.event} ${item.detail}`).join("\n"))
              .catch(cause=>setError(`复制日志失败：${String(cause)}`))}>复制日志</button>
              <button disabled={!diagnostics.length} onClick={()=>setDiagnostics([])}>清除日志</button></div>
          </details>
        </div>}
      </fieldset></div><div className="drawer-foot"><button className="start-btn wide" onClick={()=>setShowSettings(false)}>完成设置</button></div>
    </aside></div>}
    <ResizeCorners/>
  </div>;
}

export default function App() {
  const label = getCurrentWebviewWindow().label;
  return label === "overlay" ? <Overlay/> : <Main/>;
}
