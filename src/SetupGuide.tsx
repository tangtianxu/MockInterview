import {useState,type ReactNode} from "react";
import {open} from "@tauri-apps/plugin-shell";

export type GuideSetup={
  local:boolean;blocked:boolean;modelConnected:boolean;modelControls:ReactNode;
  onBranch:(local:boolean)=>void;ollamaFound:boolean;ollamaConnected:boolean;
  ollamaChecking:boolean;ollamaStarting:boolean;ollamaError:string;
  onDetectOllama:()=>void;onStartOllama:()=>void;onOllamaPaths:()=>void;
  pullModel:string;onPullModelChange:(value:string)=>void;pulling:boolean;pullProgress:string;onPull:()=>void;
  speechModel:string;speechReady:boolean;speechDirectory:string;speechDownload:string;speechError:string;speechNotice:string;
  speechUrl:string;speechFilename:string;speechEngine:string;
  onSpeechModel:(value:string)=>void;onSpeechDownload:()=>void;onSpeechPath:()=>void;onSpeechDetect:()=>void;
  onProfile:()=>void;onAudio:()=>void;onOfflineTest?:()=>void;resumeName?:string;resumeAnalyzed?:boolean;analyzing?:boolean;onResume?:()=>void;onAnalyze?:()=>void;
};
type Completion={branch:boolean;skipSpeech:boolean;profile:boolean;tested:boolean};
function savedCompletion():Completion {try{return {branch:false,skipSpeech:false,profile:false,tested:false,...JSON.parse(localStorage.getItem("mockInterview.guideCompletion")||"{}")};}catch{return {branch:false,skipSpeech:false,profile:false,tested:false};}}
export function SetupGuide({setup,onSettings,onDismiss}:{setup:GuideSetup;onSettings?:()=>void;onDismiss:()=>void}) {
  const [error,setError]=useState("");const [done,setDone]=useState(savedCompletion);
  const complete=(patch:Partial<Completion>)=>{const next={...done,...patch};setDone(next);localStorage.setItem("mockInterview.guideCompletion",JSON.stringify(next));};
  const visit=async(url:string)=>{try{await open(url);setError("");}catch(cause){setError(`无法打开网页：${String(cause)}`);}};
  const heading=(text:string,ready:boolean)=><h4><span className={`guide-check ${ready?"complete":""}`} aria-label={ready?"已完成":"未完成"}>{ready?"✓":"○"}</span>{text}</h4>;
  return <section className="setup-guide" aria-label="首次使用指南">
    <span className="panel-kicker">开始前准备</span><h3>第一次使用，按这五步来</h3>
    <p>推荐：本地流式语音识别＋DeepSeek Flash API。API 分支无需安装、连接或启动 Ollama，简历分析也可直接使用 API。</p>
    <button className="start-btn" onClick={onSettings}>打开模型与服务</button>
    <ol>
      <li>{heading("选择生成模型方案",done.branch || setup.modelConnected)}
        <div className="guide-branches"><button className={!setup.local?"start-btn":"practice-secondary"} disabled={setup.blocked} aria-pressed={!setup.local} onClick={()=>{setup.onBranch(false);complete({branch:true});}}>使用 API（推荐）</button>
          <button className={setup.local?"start-btn":"practice-secondary"} disabled={setup.blocked} aria-pressed={setup.local} onClick={()=>{setup.onBranch(true);complete({branch:true});}}>使用本地 Ollama</button></div>
        <div className="guide-comparison"><p><strong>DeepSeek Flash API（推荐）</strong>：无需部署本地生成模型。预算参考：一场面试约 1 元 token 费用；实际费用随时长、请求频率、缓存命中和平台价格变化，以账单为准。</p>
          <p><strong>本地 Ollama</strong>：无 API 调用费，但需要下载模型并占用内存与算力，速度和回答质量取决于电脑与模型。语音模型下载与识别不依赖 Ollama。</p></div>
        {!setup.local?<><p>若选择使用 API（推荐），则无需 Ollama。在第 3 步填写 API 密钥并检测连接。</p>
          <p>网络：DeepSeek 官方平台与 API 通常可国内直连，无需 VPN；其他 API 的网络要求由服务商决定。</p>
          <button className="practice-secondary" onClick={()=>void visit("https://platform.deepseek.com/api_keys")}>获取 DeepSeek API 密钥</button></>:<>
          <p>下载并安装 Ollama，然后重新检测并启动服务。若已安装仍未检测到，在高级设置中选择实际的 ollama.exe 路径。</p>
          <p>网络：Ollama 安装包和生成模型来自境外官方站点/仓库，国内访问可能慢或失败，部分网络需 VPN/代理。本应用未提供它们的国内镜像；已经下载的本地模型无需联网推理。</p>
          <div className="setup-guide-actions"><button className="practice-secondary" onClick={()=>void visit("https://ollama.com/download/windows")}>下载 Ollama</button>
            <button className="practice-secondary" disabled={setup.blocked || setup.ollamaChecking} onClick={setup.onDetectOllama}>{setup.ollamaChecking?"检测中…":"重新检测 Ollama"}</button>
            <button className="practice-secondary" disabled={setup.blocked || setup.ollamaStarting || setup.ollamaConnected} onClick={setup.onStartOllama}>{setup.ollamaStarting?"启动中…":setup.ollamaConnected?"Ollama 已连接":"连接并启动 Ollama"}</button>
            <button className="practice-secondary" onClick={setup.onOllamaPaths}>高级设置：Ollama 路径</button></div>
          <p role="status">{setup.ollamaFound?"已找到 Ollama 程序":"尚未检测到 Ollama 程序"}{setup.ollamaConnected?" · 服务已连接":" · 服务未连接"}</p>
          {setup.ollamaError&&<p className="practice-reference-error" role="alert">{setup.ollamaError}</p>}
        </>}
      </li>
      <li>{heading("下载一个本地流式语音模型",setup.speechReady || done.skipSpeech)}
        <p>优先试 Paraformer（约 226 MB）；Zipformer（约 511 MB）也是推荐备选。选一个下载即可，等待校验和解压完成。此步骤无需 Ollama，具体识别效果请试听比较。</p>
        <p>{setup.speechEngine==="sherpa_bilingual"?"下载源：ModelScope 国内镜像，通常无需 VPN。优先直连，连接失败再尝试系统/环境代理；国内镜像也可能受校园/公司网络或服务故障影响。":"当前模型来自境外下载源，部分网络需要 VPN/代理。改选上述推荐流式模型可使用 ModelScope 国内镜像。"}</p>
        <label>本地流式语音模型<select aria-label="指南语音模型" value={setup.speechModel} disabled={setup.blocked || !!setup.speechDownload} onChange={e=>{setup.onSpeechModel(e.target.value);complete({skipSpeech:false});}}>
          {!['paraformer-zh-en','zipformer-zh-en'].includes(setup.speechModel)&&<option value={setup.speechModel}>当前模型；可改选推荐流式模型</option>}
          <option value="paraformer-zh-en">Paraformer 中英双语流式（约 226 MB）</option><option value="zipformer-zh-en">Zipformer 中英双语流式（约 511 MB）</option></select></label>
        <p>语音模型目录：{setup.speechDirectory || "正在读取…"}</p>
        <div className="setup-guide-actions"><button className="practice-secondary" disabled={setup.blocked || !!setup.speechDownload || setup.speechReady} onClick={setup.onSpeechDownload}>{setup.speechDownload || (setup.speechReady?"语音模型已就绪":"下载语音模型")}</button>
          <button className="practice-secondary" disabled={setup.blocked || !!setup.speechDownload} onClick={setup.onSpeechPath}>选择语音模型路径</button>
          <button className="practice-secondary" disabled={setup.blocked || !!setup.speechDownload} onClick={setup.onSpeechDetect}>重新检测语音模型</button></div>
        <p>路径请选择模型总目录，流式模型位于其中的 sherpa_bilingual 子文件夹；已有模型不会被移动。只用键盘作答可跳过此步。</p>
        <label className="guide-optional"><input type="checkbox" checked={done.skipSpeech} onChange={e=>complete({skipSpeech:e.target.checked})}/>只用键盘作答，暂时跳过语音模型</label>
        {setup.speechDownload&&<p role="status">{setup.speechDownload}</p>}{setup.speechNotice&&<p role="status">{setup.speechNotice}</p>}{setup.speechError&&<p className="practice-reference-error" role="alert">{setup.speechError}</p>}
        <details><summary>下载失败怎么办？也可使用浏览器下载</summary>
          <p>超时或代理错误：换网络后重试，检查代理是否已启动；国内镜像可先关闭失效的代理。写入或解压错误：选择当前用户可写的目录，并为压缩包和解压后的模型预留空间（推荐至少 2 GB）。失败后可直接重试，当前版本重新下载完整文件，暂不支持断点续传。</p>
          {setup.speechUrl&&<button className="practice-secondary" onClick={()=>void visit(setup.speechUrl)}>浏览器下载所选模型</button>}
          <p>浏览器下载后：{setup.speechEngine==="sherpa_bilingual"?<>解压 tar.bz2，将完整的 <code>{setup.speechFilename}</code> 文件夹放入 <code>{setup.speechDirectory || "模型总目录"}\sherpa_bilingual</code>，不要改名，也不要多套一层目录。</>:<>把下载文件放入模型总目录的 <code>{setup.speechEngine}</code> 子文件夹。</>} 再点“重新检测语音模型”。应用内下载会校验完整性；手动文件请只使用此处链接并核对来源。</p>
        </details>
      </li>
      <li>{heading("连接出题与评价模型",setup.modelConnected)}
        {setup.modelConnected&&<p>此配置已完成连接检测；可再次检测当前网络与服务状态。</p>}
        {setup.local?<><p>下载 qwen3:4b-instruct 或其他适合的本地模型，下载完成后检测聊天连接。仅安装 Ollama 程序还不能生成回答。</p>
          <label>本地生成模型<input value={setup.pullModel} disabled={setup.blocked || setup.pulling} onChange={e=>setup.onPullModelChange(e.target.value)}/></label>
          <button className="practice-secondary" disabled={setup.blocked || setup.pulling || !setup.pullModel.trim()} onClick={setup.onPull}>{setup.pulling?"本地模型下载中…":"下载本地生成模型"}</button>{setup.pullProgress&&<p role="status">{setup.pullProgress}</p>}
        </>:<p>注册 DeepSeek 官方 API 平台、按需充值并创建密钥。默认模型 ID 为 deepseek-flash；网页聊天账号不等于 API 已开通。其他服务可在下方选择，接口和模型可在高级设置中修改。</p>}
        {setup.modelControls}
      </li>
      <li>{heading("填写个性化资料",done.profile)}
        <p>按需填写岗位与关注主题、领域背景、自我介绍、回答要求，并上传个人简历。这些资料可选；简历分析沿用当前模型，使用 API 时每次发送前明确确认。分析结果仍需核对原文。</p>
        <div className="setup-guide-actions"><button className="practice-secondary" onClick={setup.onProfile}>填写个性化资料</button>
          <button className="practice-secondary" disabled={setup.blocked} onClick={setup.onResume}>{setup.resumeName?"重新上传个人简历":"上传个人简历"}</button>
          {setup.resumeName&&<button className="practice-secondary" disabled={setup.blocked || setup.analyzing} onClick={setup.onAnalyze}>{setup.analyzing?"简历分析中…":setup.resumeAnalyzed?"重新分析简历":"分析简历"}</button>}</div>
        {setup.resumeName&&<p>{setup.resumeName}{setup.resumeAnalyzed?" · 已保存分析":" · 尚未分析"}</p>}
        <button className="practice-secondary" onClick={()=>complete({profile:!done.profile})}>{done.profile?"重新检查资料":"资料已填写 / 暂时跳过"}</button>
      </li>
      <li>{heading("用视频或麦克风测试效果",done.tested)}
        <p>双击左上角图标可切换页面。搜索“模拟面试＋你的岗位”，播放短片段测试转录、问题理解和生成效果；在模拟练习页，也可暂停视频后自己回答，再提交并查看复盘与参考答案。重点核对术语、缩写和关键原理。耳机播放的音频从所选系统输出设备采集，麦克风作答则转写你说的话。</p>
        <p>也可选择“线下面试”，用麦克风自定义提问：选择提问麦克风，完成设置后点击“开始聆听”，依次核对实时转录、模型理解的问题和回答。可先介绍背景，再说“这种情况怎么解决”等追问。此模式只采集麦克风，不区分说话人；语音模型和生成模型复用现有设置。</p>
        <div className="setup-guide-actions"><button className="practice-secondary" onClick={()=>void visit("https://search.bilibili.com/all?keyword=%E6%A8%A1%E6%8B%9F%E9%9D%A2%E8%AF%95")}>查找 B 站模拟面试视频</button>
          {setup.onOfflineTest&&<button className="practice-secondary" disabled={setup.blocked} onClick={setup.onOfflineTest}>线下面试：麦克风测试</button>}
          <button className="practice-secondary" onClick={setup.onAudio}>选择音频设备</button><button className="practice-secondary" onClick={()=>complete({tested:!done.tested})}>{done.tested?"重新测试":"已完成效果测试"}</button></div>
      </li>
    </ol>
    <p>软件安装与更新来自 GitHub 境外站点，目前无国内镜像；国内下载可能较慢，部分网络需 VPN/代理。B 站测试素材通常可国内直连。VPN 不是所有用户的必需项，是否需要取决于下载来源与实际网络。</p>
    {error && <p className="practice-reference-error" role="alert">{error}</p>}
    <div className="setup-guide-actions"><button className="practice-secondary" onClick={onDismiss}>已了解，收起指南</button></div>
  </section>;
}
