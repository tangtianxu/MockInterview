type Turn = {id:string;text:string;speaker:string;timestamp_ms:number};
export type TaskTurn={id:string;text:string;channel:'system'|'microphone'|'mixed';current:boolean;isFinal:boolean;timestampMs:number};

/** Channels are transport hints, never a claim that the speaker was diarized. */
export function taskWindow(turns:Turn[],partials:(Turn|null)[],current:{sourceId:string;text:string;isFinal:boolean}[],mode:string):TaskTurn[]{
  const byId=new Map(turns.map(t=>[t.id,t]));
  for(const t of partials)if(t)byId.set(t.id,t);
  const ids=new Set(current.map(t=>t.sourceId));
  const bounded=(text:string)=>text.length<=1000?text:`${text.slice(0,350)}\n[…]\n${text.slice(-650)}`;
  const convert=(t:Turn):TaskTurn=>({id:t.id,text:bounded(t.text),channel:mode==='live'?(t.speaker==='User'?'microphone':'system'):'mixed',current:ids.has(t.id),isFinal:true,timestampMs:t.timestamp_ms});
  const history=[...byId.values()].filter(t=>!ids.has(t.id)&&t.text.trim()).sort((a,b)=>a.timestamp_ms-b.timestamp_ms);
  // Drop only near-simultaneous exact cross-channel echoes, never a different reply.
  const norm=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const clean=history.filter(t=>t.speaker!=='User'||!history.some(other=>other.speaker!=='User'&&Math.abs(other.timestamp_ms-t.timestamp_ms)<2500&&norm(t.text).length>=12&&norm(t.text)===norm(other.text)));
  const selected:TaskTurn[]=[];let budget=3000;
  for(const t of clean.slice(-12).reverse()){const next=convert(t);if(next.text.length>budget)continue;selected.unshift(next);budget-=next.text.length;}
  const live=current.slice(-24).map(t=>({...convert(byId.get(t.sourceId)||{id:t.sourceId,text:t.text,speaker:'Them',timestamp_ms:0}),text:bounded(t.text),isFinal:t.isFinal,current:true}));
  return [...selected,...live];
}

/** Keep speakers explicit, including an unfinished reply when a follow-up arrives. */
export function dialogueContext(turns:Turn[],partials:(Turn|null)[],currentId:string|string[],video:boolean) {
  const excluded=new Set(Array.isArray(currentId)?currentId:[currentId]);
  const byId=new Map(turns.map(turn=>[turn.id,turn]));
  for(const turn of partials)if(turn)byId.set(turn.id,turn);
  const recent=[...byId.values()].filter(turn=>!excluded.has(turn.id)&&turn.text.trim())
    .sort((a,b)=>a.timestamp_ms-b.timestamp_ms).slice(-12);
  const bounded=(text:string)=>text.length<=800 ? text : `${text.slice(0,300)}[…背景截短…]${text.slice(-500)}`;
  const lines=recent.map(turn=>`${turn.speaker==="User" ? "候选人" : video ? "视频音频（可能包含双方）" : "面试官"}：${bounded(turn.text)}`);
  const selected:string[]=[];let length=0;
  for(const line of lines.reverse()){
    if(length+line.length>2800)break;
    selected.unshift(line);length+=line.length+1;
  }
  return selected.join("\n");
}
