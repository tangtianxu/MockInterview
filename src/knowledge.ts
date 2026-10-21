import {invoke} from '@tauri-apps/api/core';
export type KnowledgeEndpoint={api:string;baseUrl:string;model:string;credentialSlot?:string;historySessionId?:string|null;usageStage?:string};
export type KnowledgeSource={id:string;path:string;relativePath:string;project:string;hash:string;modified:number;characters:number;status:string;note:string};
export type KnowledgeReference={sourceId:string;hash:string;quote:string};
export type KnowledgeOrigin={sessionId:string;entryId:string;at:string;original:string};
export type BankQuestion={id:string;category:string;project:string;question:string;task:string;aliases:string[];tags:string[];answer:string;explanation:string;followUps:string[];status:string;answerSource:string;priority:number;priorityReason:string;missing:string[];references:KnowledgeReference[];origins:KnowledgeOrigin[];updatedAt:string};
export type ProjectProposal={sourceId:string;hash:string;project:string;reason:string};
export type KnowledgeLibrary={enabled:boolean;activeProject:string;buildModel:string;folders:string[];sources:KnowledgeSource[];organizationMode?:'auto'|'organized';projectProposals?:ProjectProposal[]};
export type KnowledgeInbox={items:BankQuestion[];matches:KnowledgeMatch[];drafts:KnowledgeResult[];editor:BankQuestion|null;cursor:{signature:string;next:number;total:number;project?:string;sourceIds?:string[];kind?:'build'}|null};
export type KnowledgeSnapshot={diagnosticId?:string;root:string;library:KnowledgeLibrary;questions:BankQuestion[];errors:string[];inbox?:KnowledgeInbox};
export type KnowledgeMatch={questionId:string;duplicateId:string;relation:string;reason:string;needsPersonalEvidence?:boolean};
export type KnowledgeResult={items:BankQuestion[];matches:KnowledgeMatch[];warnings:string[];model:string;elapsedMs:number;usage:any;organization?:ProjectProposal[]};
export type KnowledgePassage={sourceId:string;hash:string;project:string;path:string;locator:string;text:string};
export type KnowledgeLookup={enabled:boolean;exact:BankQuestion|null;questions:BankQuestion[];passages:KnowledgePassage[];projects:string[];ambiguous?:boolean;note?:string};
export type KnowledgeContext={questions:BankQuestion[];passages:KnowledgePassage[];consent:boolean};
export type KnowledgePlan={token:string;action:string;model:string;destination:string;characters:number;files:string[];preview:string;batch:number;totalBatches:number};
export type KnowledgeBuildPlan={plans:KnowledgePlan[];characters:number;files:string[];preview:string;model:string;destination:string};
export async function readKnowledgeSnapshot():Promise<KnowledgeSnapshot>{
 const value=await invoke<KnowledgeSnapshot>('knowledge_snapshot',{}, {headers:{'Cache-Control':'no-cache, no-store','Pragma':'no-cache'}});
 if(value.diagnosticId)void invoke('knowledge_record_read',{diagnosticId:value.diagnosticId,phase:'received',sources:value.library.sources.length,items:value.inbox?.items.length||0,buildModel:value.library.buildModel||'current'}).catch(()=>{});
 return value;
}
export const bankCategories=['项目问题','技术基础','开放型问题','行为与经历','个人介绍与求职'];
export function emptyQuestion(project=''):BankQuestion {return {id:crypto.randomUUID(),category:'项目问题',project,question:'',task:'',aliases:[],tags:[],answer:'',explanation:'',followUps:[],status:'draft',answerSource:'user',priority:2,priorityReason:'',missing:[],references:[],origins:[],updatedAt:''};}
export function effectiveExports(items:BankQuestion[],matches:KnowledgeMatch[],bank:BankQuestion[]):BankQuestion[]{
 const merged=new Map<string,BankQuestion>();
 const canonical=(id:string)=>{const seen=new Set<string>();let current=id;while(!seen.has(current)){seen.add(current);const next=matches.find(m=>m.questionId===current&&m.relation==='same')?.duplicateId;if(!next||next===current)break;current=next;}return current;};
 for(const q of items){const id=canonical(q.id);const target=bank.find(p=>p.id===id)||items.find(p=>p.id===id);const key=target?.id||q.id;const p=merged.get(key)||{...(target||q),aliases:[...(target||q).aliases],origins:[...(target||q).origins]};
  if(q.question!==p.question&&!p.aliases.includes(q.question))p.aliases.push(q.question);
  for(const o of q.origins)if(!p.origins.some(a=>a.sessionId===o.sessionId&&a.entryId===o.entryId))p.origins.push(o);
  merged.set(key,p);
 }return [...merged.values()];
}
// Retrieval supplies evidence; it never decides whether an accepted task deserves
// an answer. One answer request reasons over the current task and this bounded
// context, without a separate API equivalence/permission gate.
export function answerEvidence(lookup:KnowledgeLookup):KnowledgeContext|undefined {
 const eligible=lookup.questions.filter(q=>q.status==='confirmed'&&q.answer.trim());
 const ordered=eligible.slice(0,3);
 const projects=new Set(ordered.map(q=>q.project));
 for(const q of eligible){if(ordered.length>=5)break;if(!projects.has(q.project)){ordered.push(q);projects.add(q.project);}}
 for(const q of eligible){if(ordered.length>=5)break;if(!ordered.some(v=>v.id===q.id))ordered.push(q);}
 let remaining=38000;
 const withinBudget=<T,>(values:T[])=>values.filter(value=>{const size=[...JSON.stringify(value)].length;if(size>remaining)return false;remaining-=size;return true;});
 const questions=withinBudget(ordered),passages=withinBudget(lookup.passages.slice(0,5));
 return questions.length||passages.length?{questions,passages,consent:true}:undefined;
}
export const RETRIEVAL_DEADLINE_MS=1200;
export async function knowledgeForQuestion(query:string,endpoint:KnowledgeEndpoint,stillCurrent:()=>boolean,conversation=''):Promise<{exact?:BankQuestion;context?:KnowledgeContext;note?:string}>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const lookup=await Promise.race([
   invoke<KnowledgeLookup>('knowledge_lookup',{query,context:conversation,historySessionId:endpoint.historySessionId}),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('本地资料读取超时')),RETRIEVAL_DEADLINE_MS);})
  ]);
  if(!stillCurrent()||!lookup.enabled)return {};
  if(lookup.exact?.status==='confirmed'&&lookup.exact.answer.trim())return {exact:lookup.exact};
  return {context:answerEvidence(lookup),note:lookup.note||undefined};
 }catch(cause){return stillCurrent()?{note:`资料增强暂不可用，继续生成回答：${String(cause)}`}:{};}
 finally{if(timer)clearTimeout(timer);}
}
