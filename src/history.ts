import {useMemo,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
export type HistorySession={id:string;mode:"practice"|"live"|"manual";startedAt:string;endedAt:string|null;title:string};
export type HistoryEntry={id:string;kind:string;at:string;text:string;data:Record<string,any>};
export type HistoryRecord={session:HistorySession;entries:HistoryEntry[]};
export class HistoryRecorder {
  sessionId:string|null=null;private queue:Promise<unknown>=Promise.resolve();private pending=new Map<string,{sessionId:string;entry:HistoryEntry}>();private timer:ReturnType<typeof setTimeout>|null=null;
  private report:(error:string)=>void;private transport:typeof invoke;
  constructor(report:(error:string)=>void,transport:typeof invoke=invoke){this.report=report;this.transport=transport;}
  private send(command:string,args:Record<string,unknown>){const next=this.queue.catch(()=>{}).then(()=>this.transport(command,args));this.queue=next;void next.catch(cause=>this.report(`历史保存失败：${String(cause)}`));return next;}
  begin(mode:HistorySession["mode"],title:string){if(this.sessionId)this.end();const id=crypto.randomUUID();this.sessionId=id;void this.send("history_begin",{session:{id,mode,title:title.slice(0,160),startedAt:new Date().toISOString(),endedAt:null}});return id;}
  ensure(mode:HistorySession["mode"],title:string){return this.sessionId || this.begin(mode,title);}
  record(kind:string,text:string,data:Record<string,any>={},id:string=crypto.randomUUID(),buffered=false){const sessionId=this.sessionId;if(!sessionId)return;const entry={id,kind,text,at:new Date().toISOString(),data};
    if(buffered){this.pending.set(`${sessionId}:${id}`,{sessionId,entry});if(!this.timer)this.timer=setTimeout(()=>this.drain(),300);}
    else {this.pending.delete(`${sessionId}:${id}`);void this.send("history_record",{sessionId,entry});}
  }
  private drain(){if(this.timer)clearTimeout(this.timer);this.timer=null;for(const item of this.pending.values())void this.send("history_record",item);this.pending.clear();}
  endpoint<T extends object>(endpoint:T,stage:string){return {...endpoint,historySessionId:this.sessionId,usageStage:stage};}
  end(){const id=this.sessionId;if(!id)return;this.drain();this.sessionId=null;void this.send("history_end",{id,at:new Date().toISOString()});}
  async flush(){this.drain();await this.queue;}
}
export function useHistoryRecorder(){const [error,setError]=useState("");const recorder=useMemo(()=>new HistoryRecorder(setError),[]);return {recorder,error};}
