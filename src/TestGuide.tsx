import {useState} from "react";
import {open} from "@tauri-apps/plugin-shell";

export const TEST_VIDEO="https://www.bilibili.com/video/BV1XzyWY6EJC/";
export function TestGuide({blocked,running,transcribed,understood,answered,onStart,onAudio,onDismiss}:{
  blocked:boolean;running:boolean;transcribed:boolean;understood:boolean;answered:boolean;
  onStart:(mode:"video"|"offline")=>void;onAudio:()=>void;onDismiss:()=>void;
}) {
  const [branch,setBranch]=useState<"video"|"offline">("video");
  const [error,setError]=useState("");
  return <section className="setup-guide test-guide" aria-label="转录与回答测试">
    <span className="panel-kicker">准备完成后测试</span><h3>先用一段问题检查效果</h3>
    <div className="guide-branches"><button className={branch==="video"?"start-btn":"practice-secondary"} disabled={running || blocked} onClick={()=>setBranch("video")}>视频测试</button>
      <button className={branch==="offline"?"start-btn":"practice-secondary"} disabled={running || blocked} onClick={()=>setBranch("offline")}>麦克风测试</button></div>
    {branch==="video"?<><p>固定素材：大模型面试现场【八股、项目细节拷问】。打开视频后，点击开始视频测试，再播放一小段，观察系统音量、转录与回答。B 站通常可国内直连。</p>
      <button className="practice-secondary" onClick={()=>void open(TEST_VIDEO).catch(cause=>setError(`无法打开视频：${String(cause)}`))}>打开 B 站测试视频</button></>:<p>选择提问麦克风，点击开始麦克风测试后，自己说一个问题。也可先说背景，再问“这种情况怎么解决”。此分支只采集麦克风，不区分说话人。</p>}
    <div className="setup-guide-actions"><button className="practice-secondary" onClick={onAudio}>选择音频设备</button>
      <button className="start-btn" disabled={running || blocked} onClick={()=>onStart(branch)}>{running?"正在聆听…":branch==="video"?"开始视频测试":"开始麦克风测试"}</button></div>
    <p className="test-progress" role="status">{transcribed?"✓":"○"} 收到转录　{understood?"✓":"○"} 理解问题　{answered?"✓":"○"} 完成回答</p>
    <p>重点核对技术缩写和上下文。若未识别到声音，先检查所选设备；若问题理解偏差，可点击问题框修改。完成状态由实际事件更新。</p>
    {error&&<p role="alert" className="practice-reference-error">{error}</p>}
    <button className="practice-secondary" onClick={onDismiss}>收起测试引导</button>
  </section>;
}
