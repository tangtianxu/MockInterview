// All prompts and file selection stay in the launcher's webview. Never open an
// OS dialog: it would outlive the app's visibility/capture settings.
export type FileFilter={name:string;extensions:string[]};
export type ActionOptions={title?:string;kind?:string;okLabel?:string;cancelLabel?:string;isCurrent?:()=>boolean;signal?:AbortSignal};
export type FileOptions=ActionOptions&{defaultPath?:string;directory?:boolean;multiple?:boolean;filters?:FileFilter[]};
type Result=boolean|string|string[]|null;
export type PendingAction={id:number;kind:'confirm'|'open'|'save';message:string;options:FileOptions;resolve:(value:Result)=>void};
let sequence=0;
let queue:PendingAction[]=[];
const listeners=new Set<()=>void>();
export const subscribeActions=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const currentAction=()=>queue[0]||null;
function changed(){for(const listener of listeners)listener();}
export function finishAction(id:number,result:Result){const entry=queue.find(item=>item.id===id);if(!entry)return;queue=queue.filter(item=>item!==entry);entry.resolve(result);changed();}
function request<T extends Result>(kind:PendingAction['kind'],message:string,options:FileOptions):Promise<T>{
 if(options.signal?.aborted||options.isCurrent?.()===false)return Promise.resolve((kind==='confirm'?false:null) as T);
 return new Promise<T>(resolve=>{
  const id=++sequence;
  const cancel=()=>finishAction(id,kind==='confirm'?false:null);
  queue.push({id,kind,message,options,resolve:value=>{options.signal?.removeEventListener('abort',cancel);resolve(value as T);}});
  options.signal?.addEventListener('abort',cancel,{once:true});changed();
 });
}
export const ask=(message:string,options:ActionOptions={})=>request<boolean>('confirm',message,options);
export const open=(options:FileOptions={})=>request<string|string[]|null>('open','',options);
export const save=(options:FileOptions={})=>request<string|null>('save','',options);
export class UserCancelled extends Error {constructor(message='已取消本次操作'){super(message);this.name='UserCancelled';}}
export const isUserCancelled=(cause:unknown)=>cause instanceof UserCancelled;
