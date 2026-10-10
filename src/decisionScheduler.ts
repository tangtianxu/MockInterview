export type DecisionTranscript = {text:string;sourceId:string;isFinal:boolean;receivedAt:number};
export type DecisionBatch = DecisionTranscript & {sourceIds:string[]};

export function decisionIntervalSeconds(value:unknown):number {
  return typeof value==="number" && Number.isFinite(value) ? Math.max(2,Math.min(30,value)) : 5;
}

/** Coalesce ASR revisions locally. Time and audio events never create model work. */
export class DecisionScheduler {
  private pending=new Map<string,DecisionTranscript>();
  private submitted=new Map<string,DecisionTranscript>();
  private changedAt=0;
  private lastStarted:number|null=null;
  private lastAudioAt:number|null=null;
  private lastSpeechAt:number|null=null;

  reset() {
    this.pending.clear();this.submitted.clear();this.changedAt=0;
    this.lastStarted=null;this.lastAudioAt=null;this.lastSpeechAt=null;
  }

  enqueue(input:DecisionTranscript):boolean {
    const text=input.text.trim().replace(/\s+/g," ");
    if(!text)return false;
    const previous=this.pending.get(input.sourceId) || this.submitted.get(input.sourceId);
    if(previous && (previous.isFinal && !input.isFinal ||
        previous.text===text && (previous.isFinal || !input.isFinal)))return false;
    this.pending.set(input.sourceId,{...input,text});
    // Bound unsubmitted speech if an endpoint never arrives or a request stalls.
    if(this.pending.size>24)this.pending.delete(this.pending.keys().next().value!);
    this.changedAt=input.receivedAt;
    return true;
  }

  audio(level:number,now:number) {
    if(!Number.isFinite(level))return;
    this.lastAudioAt=now;
    // This is captured signal energy, not the Windows speaker-volume setting.
    if(level>0.08)this.lastSpeechAt=now;
  }

  discard(sourceId:string) {this.pending.delete(sourceId);}

  nextDelay(now:number,intervalSeconds:number,finalOnly=false):number|null {
    const turns=[...this.pending.values()];const latest=turns[turns.length-1];
    if(!latest || finalOnly && !latest.isFinal)return null;
    const interval=decisionIntervalSeconds(intervalSeconds)*1000;
    const cooldown=this.lastStarted===null ? 0 : this.lastStarted+interval-now;
    // ASR endpoints are the primary signal. Briefly collect neighbouring final fragments.
    let readyAt=this.changedAt+(latest.isFinal?250:1200);
    if(!latest.isFinal && this.lastAudioAt!==null && now-this.lastAudioAt<1500 && this.lastSpeechAt!==null)
      readyAt=Math.max(readyAt,this.lastSpeechAt+800);
    return Math.max(0,cooldown,readyAt-now);
  }

  take(now:number,intervalSeconds:number,finalOnly=false):DecisionBatch|null {
    if(this.nextDelay(now,intervalSeconds,finalOnly)!==0)return null;
    const turns=[...this.pending.values()];
    const latest=turns[turns.length-1];
    for(const turn of turns){this.submitted.delete(turn.sourceId);this.submitted.set(turn.sourceId,turn);}
    while(this.submitted.size>80)this.submitted.delete(this.submitted.keys().next().value!);
    this.pending.clear();this.lastStarted=now;
    return {...latest,text:turns.map(turn=>turn.text).join("\n"),sourceIds:turns.map(turn=>turn.sourceId)};
  }
}
