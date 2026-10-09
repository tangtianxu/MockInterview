import {readablePreview} from "./answerDisplay.ts";

export type AnswerSource = "local" | "api";
type Branch = {id:string;source:AnswerSource;text:string;done:boolean;error:string;firstMs:number|null;completeMs:number|null};

/** One question owns its streams. Keep the first usable stream until API succeeds. */
export class AnswerRace {
  readonly branches: Branch[];
  private selected: Branch | null = null;
  constructor(requests:{id:string;source:AnswerSource}[]) {
    this.branches=requests.map(request=>({...request,text:"",done:false,error:"",firstMs:null,completeMs:null}));
  }
  token(id:string,text:string,elapsed:number) {
    const branch=this.branches.find(item=>item.id===id);
    if(!branch || branch.done || !text)return false;
    if(branch.firstMs===null)branch.firstMs=elapsed;
    branch.text+=text;
    if((!this.selected || this.selected.error) && readablePreview(branch.text))this.selected=branch;
    return true;
  }
  finish(id:string,error?:string,elapsed=0) {
    const branch=this.branches.find(item=>item.id===id);
    if(!branch || branch.done)return false;
    branch.done=true;branch.completeMs=elapsed;
    branch.error=error || (!branch.text.trim() ? "回答接口没有返回可显示的内容" : "");
    if(!branch.error && (!this.selected || this.selected.error))this.selected=branch;
    if(this.finished){
      const api=this.branches.find(item=>item.source==="api"&&!item.error);
      if(api)this.selected=api;
    }
    if(this.finished && !this.selected)this.selected=this.branches.find(item=>item.text.trim()) || null;
    return true;
  }
  get finished(){return this.branches.every(item=>item.done);}
  get pendingApi(){return this.branches.length>1 && this.branches.some(item=>item.source==="api"&&!item.done);}
  get failure(){return this.finished && !this.branches.some(item=>item.done&&!item.error)
    ? this.branches.map(item=>`${item.source==="local"?"本地":"API"}：${item.error}`).join("；") : "";}
  get snapshot(){
    if(!this.selected)return null;
    const text=this.selected.done ? this.selected.text.trim() : readablePreview(this.selected.text);
    return text ? {text,source:this.selected.source,done:this.selected.done,
      complete:this.selected.done&&!this.selected.error,firstMs:this.selected.firstMs,completeMs:this.selected.completeMs} : null;
  }
}

/** Questions provide conversational reference, never generated answers as evidence. */
export function rememberQuestion(history:string[],question:string) {
  const previous=history.filter(item=>item!==question).slice(-3);
  return {previous,history:[...previous,question]};
}
