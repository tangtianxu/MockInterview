// Presentation only: no model, audio, or recognition dependencies.
export type AnswerPage={id:string;kind:'voice'|'screen';question:string;text:string;complete:boolean;source:string;terms:string[];keyTerms:string[];detail:string;startedAt:number;asrAt:number|null};
export class AnswerDeck {
  pages:AnswerPage[]=[];
  observe(page:AnswerPage){
    if(!page.complete||!page.id||!page.text.trim()||page.source==='guide')return false;
    const i=this.pages.findIndex(p=>p.id===page.id),old=this.pages[i];
    if(old?.text===page.text&&old.question===page.question&&old.detail===page.detail)return false;
    const copy={...page,terms:[...page.terms],keyTerms:[...page.keyTerms]};
    if(i<0)this.pages.push(copy);else this.pages[i]=copy;
    this.pages.sort((a,b)=>a.startedAt-b.startedAt);this.pages=this.pages.slice(-100);return true;
  }
  adjacent(page:AnswerPage,direction:-1|1){
    const index=page.text.trim()&&page.source!=='guide'?this.pages.findIndex(p=>p.id===page.id):-1;
    if(index>=0)return this.pages[index+direction]||null;
    return direction===-1?this.pages.filter(p=>p.startedAt<=page.startedAt).slice(-1)[0]||null:this.pages.find(p=>p.startedAt>page.startedAt)||null;
  }
}
