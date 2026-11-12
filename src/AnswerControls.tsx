import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {register,unregister} from '@tauri-apps/plugin-global-shortcut';
import {AnswerDeck,type AnswerPage} from './answerDeck';
export type AnswerKeys={lock:string;previous:string;next:string;api:string};
export const DEFAULT_ANSWER_KEYS:AnswerKeys={lock:'F6',previous:'F7',next:'F9',api:'F4'};
export const FUNCTION_KEYS=Array.from({length:11},(_,i)=>'F'+(i+1));
export function normalizeAnswerKeys(old:Partial<AnswerKeys>|undefined,forbidden:string[]){
 const used=new Set(forbidden);const next={...DEFAULT_ANSWER_KEYS};
 for(const k of Object.keys(next) as (keyof AnswerKeys)[]){const wanted=old?.[k];const value=[wanted,DEFAULT_ANSWER_KEYS[k],...FUNCTION_KEYS].find(v=>!!v&&FUNCTION_KEYS.includes(v)&&!used.has(v))!;next[k]=value;used.add(value);}return next;
}
export function useAnswerDeck(live:AnswerPage,background:AnswerPage[]=[] ){
 const archive=useRef(new AnswerDeck());const current=useRef(live);current.current=live;
 const pinnedRef=useRef<AnswerPage|null>(null);const [pinned,setPinned]=useState<AnswerPage|null>(null);const [,refresh]=useState(0);
 useLayoutEffect(()=>{let changed=false;for(const page of [...background,live])changed=archive.current.observe(page)||changed;if(changed)refresh(n=>n+1);},[live.id,live.question,live.text,live.complete,live.source,live.detail,...background.map(p=>p.id+String(p.complete)+p.text+p.detail)]);
 const select=useCallback((page:AnswerPage|null)=>{const copy=page?{...page,terms:[...page.terms],keyTerms:[...page.keyTerms]}:null;pinnedRef.current=copy;setPinned(copy);},[]);
 const toggle=useCallback(()=>{if(pinnedRef.current)select(null);else if(current.current.text.trim())select(current.current);},[select]);
 const move=useCallback((direction:-1|1)=>{const page=archive.current.adjacent(pinnedRef.current||current.current,direction);if(page)select(page);},[select]);
 const previous=useCallback(()=>move(-1),[move]),next=useCallback(()=>move(1),[move]);
 return {pinned,pinnedRef,toggle,previous,next,resume:()=>select(null),count:archive.current.pages.length,
 canPrevious:!!archive.current.adjacent(pinned||live,-1),canNext:!!archive.current.adjacent(pinned||live,1)};
}
export function useAnswerKeys(keys:AnswerKeys,enabled:boolean,forbidden:string[],handlers:Record<keyof AnswerKeys,()=>void>){
 const callbacks=useRef(handlers);callbacks.current=handlers;const queue=useRef(Promise.resolve());const [error,setError]=useState('');
 useLayoutEffect(()=>{let active=true;const owned:string[]=[];
  queue.current=queue.current.then(async()=>{setError('');if(!enabled||!active)return;const errors:string[]=[];const used=new Set(forbidden);
   for(const [name,key] of Object.entries(keys) as [keyof AnswerKeys,string][]){if(!active)break;if(!FUNCTION_KEYS.includes(key)||used.has(key)){errors.push(key+' 已被其他操作占用');continue;}used.add(key);
    try{await register(key,e=>{if(active&&e.state==='Pressed')callbacks.current[name]();});if(!active)await unregister(key);else owned.push(key);}catch(e){errors.push(key+' 注册失败：'+String(e));}}
   if(active)setError(errors.join('；'));
  }).catch(e=>{if(active)setError(String(e));});
  return()=>{active=false;queue.current=queue.current.then(async()=>{for(const key of owned)await unregister(key).catch(()=>{});});};
 },[enabled,JSON.stringify(keys),forbidden.join('|')]);return error;
}
export function AnswerControls({deck,keys,onApi,apiLabel,notice}:{deck:ReturnType<typeof useAnswerDeck>;keys:AnswerKeys;onApi:()=>void;apiLabel:string;notice:string}){
 return <div className="answer-controls" aria-label="回答显示控制">
  <div className="key-actions"><button aria-pressed={!!deck.pinned} onClick={deck.toggle}>{deck.pinned?'解除显示锁定':'锁定当前显示'} · {keys.lock}</button><button disabled={!deck.canPrevious} onClick={deck.previous}>上一条答案 · {keys.previous}</button><button disabled={!deck.canNext} onClick={deck.next}>下一条答案 · {keys.next}</button>{deck.pinned&&<button onClick={deck.resume}>回到最新回答</button>}<button onClick={onApi}>切换 API · {keys.api}</button></div>
  <p role="status">{deck.pinned?'当前显示已固定，后台仍在正常处理。':'跟随最新回答。'} 已完成 {deck.count} 条 · {apiLabel}{notice?' · '+notice:''}</p>
 </div>;
}
export function AnswerKeySettings({value,forbidden,onChange,error}:{value:AnswerKeys;forbidden:string[];onChange:(keys:AnswerKeys)=>void;error:string}){
 return <div className="answer-key-settings"><p className="setting-help">以下均为单个 F 键，在其他窗口中也生效。锁定、上一条、下一条只改变显示，后台继续处理；切换 API 从后续请求生效，不重答当前问题。最多保留本窗口最近 100 条完整答案。</p>{(Object.entries({lock:'锁定 / 解除显示',previous:'上一条完整答案',next:'下一条完整答案',api:'切换主备 API'}) as [keyof AnswerKeys,string][]).map(([k,label])=><label key={k}>{label}<select aria-label={label+'快捷键'} value={value[k]} onChange={e=>onChange({...value,[k]:e.target.value})}>{FUNCTION_KEYS.map(key=><option key={key} value={key} disabled={forbidden.includes(key)||Object.entries(value).some(([other,v])=>other!==k&&v===key)}>{key}</option>)}</select></label>)}{error&&<p className="error-box">{error}</p>}</div>;
}
