type Turn = {id:string;text:string;speaker:string;timestamp_ms:number};

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
