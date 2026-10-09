import {useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {RefreshCw} from "lucide-react";

type UpdateInfo={version:string;body?:string|null};
type Progress={downloaded:number;total?:number|null};
type Phase="idle"|"checking"|"latest"|"available"|"downloading"|"ready"|"installing";

// Lives in Main so switching settings tabs does not interrupt an update.
export function useSoftwareUpdate(blocked:boolean,beforeInstall:()=>Promise<void>){
  const [phase,setPhase]=useState<Phase>("idle");
  const [update,setUpdate]=useState<UpdateInfo|null>(null);
  const [error,setError]=useState("");
  const [progress,setProgress]=useState<Progress>({downloaded:0});
  const operation=useRef(false);
  const latest=useRef({blocked,beforeInstall});latest.current={blocked,beforeInstall};
  const check=async()=>{
    if(operation.current)return;
    operation.current=true;setPhase("checking");setError("");setUpdate(null);
    try{const next=await invoke<UpdateInfo|null>("check_for_update");setUpdate(next);setPhase(next?"available":"latest");}
    catch(cause){setError(String(cause));setPhase("idle");}
    finally{operation.current=false;}
  };
  const install=async()=>{
    if(operation.current||!update)return;
    if(latest.current.blocked){setError("请先结束练习、转录或其他正在进行的操作，再更新。");return;}
    operation.current=true;setError("");let downloaded=phase==="ready";
    let unlisten:(()=>void)|undefined;
    try{
      if(!downloaded){
        setPhase("downloading");setProgress({downloaded:0});
        unlisten=await listen<Progress>("update_download_progress",event=>setProgress(event.payload));
        await invoke("download_update");downloaded=true;setPhase("ready");
      }
      if(latest.current.blocked)throw new Error("更新已下载，请结束当前操作后点击安装。");
      await latest.current.beforeInstall();
      if(latest.current.blocked)throw new Error("更新已下载，请结束当前操作后点击安装。");
      setPhase("installing");
      await invoke("install_downloaded_update");
    }catch(cause){setError(String(cause));setPhase(downloaded?"ready":"available");}
    finally{unlisten?.();operation.current=false;}
  };
  return {phase,update,error,progress,check,install,busy:["checking","downloading","installing"].includes(phase)};
}

export function SoftwareUpdate({version,blocked,updater}:{version:string;blocked:boolean;updater:ReturnType<typeof useSoftwareUpdate>}){
  const {phase,update,error,progress,busy}=updater;
  const percent=progress.total?Math.min(100,Math.round(progress.downloaded/progress.total*100)):null;
  return <div className="setting-group software-update">
    <div className="setting-heading"><RefreshCw size={18}/> 软件更新</div>
    <p className="setting-help">当前版本：{version?`v${version}`:"正在读取…"}。更新会保留现有模型设置、个人资料和本地模型路径。</p>
    <div className="setup-actions">
      <button className="download-btn" disabled={busy} onClick={()=>void updater.check()}>{phase==="checking"?"正在检查…":"检查更新"}</button>
      {update && <button className="download-btn" disabled={busy||blocked} onClick={()=>void updater.install()}>
        {phase==="downloading"?"正在下载…":phase==="installing"?"正在安装…":phase==="ready"?"安装已下载的更新":"下载并安装"}</button>}
    </div>
    <p className="setting-help update-network-note">更新包来自 GitHub，下载速度受访问 GitHub 的网络情况影响；检查或下载失败时可重试。</p>
    {blocked && update && <p className="setting-help">请先结束练习、转录或其他正在进行的操作，再安装更新。</p>}
    {phase==="latest" && <p className="setting-help" role="status">已是最新版本。</p>}
    {update && <><p className="setting-help" role="status">发现新版本 v{update.version}</p>
      {update.body && <div className="update-notes">{update.body}</div>}</>}
    {phase==="downloading" && <div className="update-progress" role="status">
      <progress aria-label="更新下载进度" max={100} value={percent??undefined}/>
      <span>已下载 {(progress.downloaded/1048576).toFixed(1)} MB{progress.total?` / ${(progress.total/1048576).toFixed(1)} MB · ${percent}%`:""}</span>
    </div>}
    {phase==="installing" && <p className="setting-help" role="status">正在启动安装，程序将关闭并重新启动，请稍候。</p>}
    {error && <div className="error-box" role="alert">{error}</div>}
    <p className="setting-help">下载后先验证发布签名，再覆盖安装。点击“下载并安装”后将自动关闭并重启程序；下载失败不会改动当前安装。检查更新只访问发布信息，不发送个人资料或模型密钥。</p>
  </div>;
}
