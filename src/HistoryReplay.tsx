import {useEffect,useMemo,useRef,useState} from 'react';
import {convertFileSrc,invoke} from '@tauri-apps/api/core';
import {save} from './inAppActions';
import {AnswerText} from './AnswerText';
import {clock,eventSeconds,timelineAt} from './historyTimeline';
import type {HistoryRecord} from './history';
type Recording={path:string;startedAtMs:number;durationMs:number;complete:boolean;error:string|null;microphone:boolean};
export function HistoryReplay({record,active,revision}:{record:HistoryRecord;active:boolean;revision:number}){
 const [info,setInfo]=useState<Recording|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');
 const [time,setTime]=useState(0);const [playing,setPlaying]=useState(false);const audio=useRef<HTMLAudioElement>(null);
 useEffect(()=>{let current=true;setInfo(null);setTime(0);setError('');setPlaying(false);setLoading(true);
  invoke<Recording|null>('history_recording',{id:record.session.id}).then(value=>{if(current)setInfo(value);}).catch(e=>{if(current)setError(String(e));}).finally(()=>{if(current)setLoading(false);});
  return()=>{current=false;audio.current?.pause();};
 },[record.session.id,revision]);
 const start=info?.startedAtMs||Date.parse(record.session.startedAt);
 const duration=(info?.durationMs||0)/1000;
 const state=useMemo(()=>timelineAt(record.entries,start,time),[record.entries,start,time]);
 const marks=useMemo(()=>record.entries.filter(e=>['transcript','question','visibility'].includes(e.kind)).map(entry=>({entry,time:eventSeconds(entry,start)})).sort((a,b)=>a.time-b.time),[record.entries,start]);
 const seek=(seconds:number)=>{const next=Math.max(0,Math.min(duration||Infinity,seconds));setTime(next);if(audio.current)audio.current.currentTime=next;};
 const exportAudio=async()=>{const path=await save({defaultPath:`面试录音-${record.session.startedAt.slice(0,10)}.wav`,filters:[{name:'WAV 录音',extensions:['wav']}]});if(path)try{await invoke('history_export_audio',{id:record.session.id,path});}catch(e){setError(String(e));}};
 return <section className="history-replay" aria-label="录音与时间线复盘">
  <h4>录音与时间线复盘</h4>
  {loading?<p role="status">正在读取本场录音…</p>:active?<p>本场仍在进行。结束聆听后，刷新详情即可回放录音。</p>:info?<>
   <audio ref={audio} src={convertFileSrc(info.path)} preload="metadata" onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onError={()=>setError('录音无法播放，请导出 WAV 检查文件；未正常结束的录音可能只有部分内容。')}/>
   <div className="key-actions"><button onClick={()=>{if(playing)audio.current?.pause();else void audio.current?.play().catch(e=>setError(String(e)));}}>{playing?'暂停录音':'播放录音'}</button><button onClick={()=>seek(time-10)}>后退 10 秒</button><button onClick={()=>seek(time+10)}>前进 10 秒</button><button onClick={()=>void exportAudio()}>导出录音</button></div>
   <label>播放进度 {clock(time)} / {clock(duration)}<input aria-label="录音播放进度" type="range" min={0} max={Math.max(1,duration)} step={0.1} value={Math.min(time,Math.max(1,duration))} onChange={e=>seek(Number(e.target.value))}/></label>
   <p className="setting-help">{info.microphone?'左声道为面试音频，右声道为我的麦克风。':'录制所选提问音源。'}点击下方转录或问题可跳转。时间对应为片段级，包含转录和生成延迟；下方模型回答展示保存的最终文本，并非逐字动画重现。</p>
   {!info.complete&&<p className="setting-help">录音未完整结束，仅能回放已保存部分。</p>}{info.error&&<p className="error-box">{info.error}</p>}
  </>:<p className="setting-help">这场会话没有录音。此前版本未保存音频，无法补回。开启“设置 → 音频 → 保存本场录音”后，从下一次聆听开始保存。</p>}
  {error&&<p className="error-box" role="alert">{error}</p>}
  {info&&!active&&<div className="replay-current" aria-live="off"><p><small>此刻的转录</small>{state.transcript?.text||'尚无转录'}</p><p><small>已识别的问题</small>{state.question?.text||'尚未识别到问题'}</p><div><small>{state.visibility?.data.presentationOnly?'固定显示时的提示内容':state.visibility?'已显示的提示（保存的最终版本）':'保存的模型回答（没有对应的提示显示记录）'}</small>{state.answer?<AnswerText text={state.answer.text}/>:<p>此刻尚无回答</p>}</div></div>}
  <details><summary>按时间浏览转录、问题与提示（{marks.length} 条）</summary><div className="replay-marks">{marks.map(({entry,time})=><button key={entry.id} disabled={!info||active} onClick={()=>seek(time)}><time>{clock(time)}</time><span>{entry.kind==='transcript'?(entry.data.speaker==='User'?'我的回答':'提问音频'):entry.kind==='visibility'?'提示已显示':'问题'}：{entry.text}</span></button>)}</div></details>
 </section>;
}
