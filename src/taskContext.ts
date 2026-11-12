// One current screen attachment, with provenance distinct from audio evidence.
// Model output is a prior answer, never proof of what the interviewer said.
export type TaskAttachment={id:string;kind:"screen_code";text:string;language:string;answer:string;complete:boolean};
export function recognitionAttachment(value:TaskAttachment|null):TaskAttachment|null{
 if(!value)return null;
 const bound=(s:string,n:number)=>s.length<=n?s:s.slice(0,n*0.6)+"\n…中间省略…\n"+s.slice(-n*0.4);
 return {...value,text:bound(value.text,12000),answer:bound(value.answer,8000)};
}
