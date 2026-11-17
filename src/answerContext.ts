type SpeechTurn={id:string;text:string;speaker:string;timestamp_ms:number};
export type AnswerTurn={id:string;text:string;channel:'system'|'microphone'|'mixed';isFinal:boolean;timestampMs:number};

// Snapshot speech, not generated answers. The snapshot belongs to one request;
// later ASR updates must not silently change an in-flight answer's evidence.
export function answerConversation(turns:SpeechTurn[],partials:(SpeechTurn|null)[],mode:string):AnswerTurn[]{
 const byId=new Map(turns.map(turn=>[turn.id,turn]));
 const partialIds=new Set<string>();
 for(const turn of partials)if(turn){byId.set(turn.id,turn);partialIds.add(turn.id);}
 const recent=[...byId.values()].filter(t=>t.text.trim()).sort((a,b)=>a.timestamp_ms-b.timestamp_ms).slice(-12);
 const selected:AnswerTurn[]=[];let budget=3600;
 for(const turn of recent.reverse()){
  const text=turn.text.length<=900?turn.text:turn.text.slice(0,350)+'\n[…]\n'+turn.text.slice(-540);
  if(text.length>budget)break;
  selected.unshift({id:turn.id,text,channel:mode==='live'?(turn.speaker==='User'?'microphone':'system'):'mixed',isFinal:!partialIds.has(turn.id),timestampMs:turn.timestamp_ms});
  budget-=text.length;
 }
 return selected;
}
