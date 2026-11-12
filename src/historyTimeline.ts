import type {HistoryEntry} from './history';
export function eventSeconds(entry:HistoryEntry,startMs:number){
 const timestamp=entry.kind==='transcript'?Number(entry.data.timestampMs):NaN;
 const ms=timestamp>1e12?timestamp:Date.parse(entry.at);
 return Math.max(0,Number.isFinite(ms)?(ms-startMs)/1000:0);
}
export function clock(seconds:number){const s=Math.max(0,Math.floor(seconds));return `${Math.floor(s/3600)?Math.floor(s/3600)+':':''}${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
export function timelineAt(entries:HistoryEntry[],startMs:number,seconds:number){
 const sorted=entries.map(entry=>({entry,time:eventSeconds(entry,startMs)})).sort((a,b)=>a.time-b.time);
 const past=sorted.filter(row=>row.time<=seconds+0.15);
 const latest=(kind:string)=>past.filter(row=>row.entry.kind===kind).slice(-1)[0]?.entry||null;
 const visibility=latest('visibility');
 const generated=latest('answer');
 // Visibility is recorded independently. Never describe a completed historical
 // answer as having been fully visible at its first token's timestamp.
 const answer=visibility&&typeof visibility.data.displayText==='string'?{...visibility,kind:'answer',text:visibility.data.displayText}:visibility?entries.filter(e=>e.kind==='answer'&&((e.data.question||'')===visibility.text||e.id===visibility.data.requestId||e.id.startsWith(visibility.data.requestId+'-'))).slice(-1)[0]||null:generated;
 return {transcript:latest('transcript'),question:latest('question'),answer,visibility};
}
