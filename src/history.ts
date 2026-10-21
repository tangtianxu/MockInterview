import {useMemo,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {UserCancelled} from './inAppActions.ts';
export type HistorySession={id:string;mode:"practice"|"live"|"manual";startedAt:string;endedAt:string|null;title:string};
export type HistoryEntry={id:string;kind:string;at:string;text:string;data:Record<string,any>};
export type HistoryRecord={session:HistorySession;entries:HistoryEntry[]};
export class HistoryRecorder {
  sessionId:string|null=null;private ready:Promise<boolean>|null=null;private queue:Promise<unknown>=Promise.resolve();private pending=new Map<string,{sessionId:string;entry:HistoryEntry;ready:Promise<boolean>}>();private timer:ReturnType<typeof setTimeout>|null=null;
  private report:(error:string)=>void;private transport:typeof invoke;
  constructor(report:(error:string)=>void,transport:typeof invoke=invoke){this.report=report;this.transport=transport;}
  private send(command:string,args:Record<string,unknown>,ready?:Promise<boolean>){const next=this.queue.catch(()=>{}).then(async()=>{if(ready&&!await ready)return;return this.transport(command,args);});this.queue=next;void next.catch(cause=>this.report(`历史保存失败：${String(cause)}`));return next;}
  begin(mode:HistorySession["mode"],title:string){if(this.sessionId)this.end();const id=crypto.randomUUID();this.sessionId=id;this.report("");this.ready=this.send("history_begin",{session:{id,mode,title:title.slice(0,160),startedAt:new Date().toISOString(),endedAt:null}}).then(()=>true,()=>false);return id;}
  ensure(mode:HistorySession["mode"],title:string){return this.sessionId || this.begin(mode,title);}
  record(kind:string,text:string,data:Record<string,any>={},id:string=crypto.randomUUID(),buffered=false){const sessionId=this.sessionId;const ready=this.ready;if(!sessionId||!ready)return;const entry={id,kind,text,at:new Date().toISOString(),data};
    if(buffered){this.pending.set(`${sessionId}:${id}`,{sessionId,entry,ready});if(!this.timer)this.timer=setTimeout(()=>this.drain(),300);}
    else {this.pending.delete(`${sessionId}:${id}`);void this.send("history_record",{sessionId,entry},ready);}
  }
  private drain(){if(this.timer)clearTimeout(this.timer);this.timer=null;for(const {sessionId,entry,ready} of this.pending.values())void this.send("history_record",{sessionId,entry},ready);this.pending.clear();}
  // Native retrieval/usage writes do not use the JS queue. Commit their parent
  // session before handing its ID to any native operation.
  async endpoint<T extends object>(endpoint:T,stage:string,isCurrent:()=>boolean=()=>true){const id=this.sessionId;const ready=this.ready;const started=id&&ready?await ready:false;if(id!==this.sessionId||!isCurrent())throw new UserCancelled('本轮操作已结束');return {...endpoint,historySessionId:started?id:null,usageStage:stage};}
  end(){const id=this.sessionId;const ready=this.ready;if(!id||!ready)return;this.drain();this.sessionId=null;this.ready=null;void this.send("history_end",{id,at:new Date().toISOString()},ready);}
  async flush(){this.drain();await this.queue;}
}
export function useHistoryRecorder(){const [error,setError]=useState("");const recorder=useMemo(()=>new HistoryRecorder(setError),[]);return {recorder,error};}
