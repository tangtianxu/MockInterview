import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {currentAction,finishAction,subscribeActions,type PendingAction} from './inAppActions';
import './in-app-actions.css';
type FileEntry={name:string;path:string;directory:boolean};
type Location={path:string;parent:string|null;entries:FileEntry[];places:{name:string;path:string}[];truncated:boolean};
function FileSelection({action}:{action:PendingAction}){
 const options=action.options;
 const [location,setLocation]=useState<Location|null>(null);const [path,setPath]=useState('');
 const [name,setName]=useState('');const [selected,setSelected]=useState<string[]>([]);
 const [filter,setFilter]=useState(0);const [search,setSearch]=useState('');const [overwrite,setOverwrite]=useState(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const epoch=useRef(0);
 const extensions=options.filters?.[filter]?.extensions||[];
 const browse=async(target:string|null,query='')=>{
  const turn=++epoch.current;setBusy(true);setError('');
  try{const value=await invoke<Location>('action_browse_files',{path:target,extensions,directoriesOnly:!!options.directory,query});if(turn!==epoch.current)return;setLocation(value);setPath(value.path);setSelected([]);setOverwrite(false);}
  catch(cause){if(turn===epoch.current)setError(String(cause));}finally{if(turn===epoch.current)setBusy(false);}
 };
 useEffect(()=>{const initial=options.defaultPath||'';const split=Math.max(initial.lastIndexOf('\\'),initial.lastIndexOf('/'));if(action.kind==='save'){setName(split<0?initial:initial.slice(split+1));void browse(split<0?null:initial.slice(0,split+1));}else void browse(initial||null);return()=>{epoch.current++;};},[]);
 useEffect(()=>{if(location)void browse(location.path,search);},[filter]);
 const choose=async()=>{
  if(!location)return;setBusy(true);setError('');
  try{
   const paths=action.kind==='save'?[location.path.replace(/[\\/]$/,'')+'/'+name.trim()]:options.directory?[location.path]:selected;
   const resolved=await invoke<string[]>('action_resolve_paths',{paths,save:action.kind==='save',directory:!!options.directory,multiple:!!options.multiple,extensions,overwrite});
   finishAction(action.id,options.multiple&&action.kind!=='save'?resolved:resolved[0]);
  }catch(cause){setError(String(cause));}finally{setBusy(false);}
 };
 return <div className="in-app-file-selection">
  <div className="action-path-row"><label>文件夹路径<input aria-label="文件夹路径" value={path} onChange={e=>setPath(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void browse(path,search);}}/></label><button disabled={busy} onClick={()=>void browse(path,search)}>前往</button><button disabled={busy||!location?.parent} onClick={()=>void browse(location!.parent)}>上一级</button></div>
  <div className="action-places">{location?.places.map(place=><button key={place.path} disabled={busy} onClick={()=>void browse(place.path)}>{place.name}</button>)}</div>
  <div className="action-path-row"><label>筛选名称<input aria-label="筛选文件名称" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void browse(location?.path||path,search);}}/></label><button disabled={busy} onClick={()=>void browse(location?.path||path,search)}>筛选</button>{!!options.filters?.length&&<label>文件类型<select value={filter} onChange={e=>{const next=Number(e.target.value);setFilter(next);setSelected([]);setOverwrite(false);const ext=options.filters?.[next]?.extensions[0];if(action.kind==='save'&&ext)setName(value=>value.replace(/\.[^./\\]+$/,'')+'.'+ext);}}>{options.filters.map((f,i)=><option key={f.name} value={i}>{f.name}（{f.extensions.join('、')}）</option>)}</select></label>}</div>
  <div className="action-file-list" aria-label="当前文件夹内容">{location?.entries.filter(entry=>entry.directory||!extensions.length||extensions.some(ext=>entry.name.toLowerCase().endsWith('.'+ext.toLowerCase()))).map(entry=><div className="action-file-entry" key={entry.path}>{entry.directory?<button disabled={busy} onClick={()=>{setSearch('');void browse(entry.path);}}>📁 {entry.name}</button>:<label><input type="checkbox" checked={selected.includes(entry.path)} onChange={e=>{setSelected(current=>e.target.checked?(options.multiple?[...current,entry.path]:[entry.path]):current.filter(p=>p!==entry.path));if(action.kind==='save')setName(entry.name);setOverwrite(false);}}/> {entry.name}</label>}</div>)}{location&&!location.entries.length&&<p>此文件夹中没有符合条件的内容。</p>}</div>
  {location?.truncated&&<p>条目较多，请筛选名称后再选择。</p>}
  {action.kind==='save'&&<><label>文件名<input aria-label="保存文件名" value={name} onChange={e=>{setName(e.target.value);setOverwrite(false);}}/></label><label><input type="checkbox" checked={overwrite} onChange={e=>setOverwrite(e.target.checked)}/> 允许覆盖同名文件</label></>}
  {error&&<p className="error-box" role="alert">{error}</p>}
  <div className="action-buttons"><span>{busy?'正在读取…':options.multiple?`已选 ${selected.length} 个文件`:''}</span><button onClick={()=>finishAction(action.id,null)}>取消</button><button className="start-btn" disabled={busy||!location||(action.kind==='save'?!name.trim():!options.directory&&!selected.length)} onClick={()=>void choose()}>{action.kind==='save'?'保存到此位置':options.directory?'使用此文件夹':'使用所选文件'}</button></div>
 </div>;
}
export function InAppActions(){
 const action=useSyncExternalStore(subscribeActions,currentAction,currentAction);
 useEffect(()=>{if(!action?.options.isCurrent)return;const timer=setInterval(()=>{if(action.options.isCurrent?.()===false)finishAction(action.id,action.kind==='confirm'?false:null);},200);return()=>clearInterval(timer);},[action]);
 if(!action)return null;
 return <section className="in-app-actions" aria-label="窗口内待确认操作"><div className="action-heading"><strong>{action.options.title||(action.kind==='save'?'选择保存位置':action.kind==='open'?'选择文件或文件夹':'确认操作')}</strong><small>仅在本窗口内显示</small></div>
  {action.kind==='confirm'?<><p className="action-message">{action.message}</p><div className="action-buttons"><button onClick={()=>finishAction(action.id,false)}>{action.options.cancelLabel||'取消'}</button><button className="start-btn" onClick={()=>finishAction(action.id,true)}>{action.options.okLabel||'确认继续'}</button></div></>:<FileSelection key={action.id} action={action}/>}
 </section>;
}
