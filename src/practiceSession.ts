export type PracticeBackground = {
  scope:string; difficulty:string; role:string; topics:string; preferences:string;
  resumeText:string; resumeAnalysis:string;
};

export function practiceBackground(input:{scope:string;difficulty:string;role:string;topics:string;
  domain:string;local:boolean;personalization?:string;resume?:{text:string}|null;analysis?:unknown}):PracticeBackground {
  const includesResume=input.scope!=="technical" && !!input.resume;
  return {scope:input.scope,difficulty:input.difficulty,role:input.role,
    topics:[input.domain!=="general" ? input.domain==="ai" ? "人工智能" : "通信" : "",input.topics].filter(Boolean).join("；"),
    preferences:input.local ? input.personalization || "" : "",
    resumeText:includesResume ? input.resume!.text.slice(0,8000) : "",
    resumeAnalysis:includesResume && input.analysis ? JSON.stringify(input.analysis) : ""};
}

export function practiceHistory(turns:{question:string;answer:string}[]) {
  return {askedQuestions:turns.map(turn=>turn.question),
    history:turns.slice(-3).map(turn=>`题目：${turn.question}\n回答摘要：${turn.answer.slice(0,180)}`).join("\n")};
}

export function repeatedPracticeQuestion(question:string,previous:string[]) {
  const key=(text:string)=>[...text.toLowerCase()].filter(char=>/[\p{L}\p{N}]/u.test(char)).join("");
  const candidate=key(question);
  return Boolean(candidate) && previous.some(text=>key(text)===candidate);
}

// A synchronous guard prevents double clicks and ignores results from an ended session.
export class PracticeRequestGate {
  private revision=0;
  private pending:number|null=null;
  begin():number|null {
    if(this.pending!==null)return null;
    this.pending=++this.revision;return this.pending;
  }
  current(token:number):boolean {return this.pending===token;}
  finish(token:number):boolean {
    if(!this.current(token))return false;
    this.pending=null;return true;
  }
  reset() {this.revision++;this.pending=null;}
  get busy() {return this.pending!==null;}
}
