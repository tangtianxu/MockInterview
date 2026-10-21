import {invoke} from '@tauri-apps/api/core';
import {ask} from './inAppActions.ts';
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
export type KnowledgeLookup={enabled:boolean;exact:BankQuestion|null;questions:BankQuestion[];passages:KnowledgePassage[];projects:string[];ambiguous?:boolean};
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
// A saved verbatim answer never leaves this machine. Semantic matching and
// synthesis require fresh consent for the actual payload, not a stored toggle.
export async function knowledgeForQuestion(query:string,endpoint:KnowledgeEndpoint,stillCurrent:()=>boolean,conversation=''):Promise<{exact?:BankQuestion;context?:KnowledgeContext;missingProject?:boolean;missingEvidence?:boolean;cancelled?:boolean}>{
 const lookup=await invoke<KnowledgeLookup>('knowledge_lookup',{query,context:conversation,historySessionId:endpoint.historySessionId});
 if(!stillCurrent()||!lookup.enabled)return {};
 if(lookup.exact)return {exact:lookup.exact};
 let selected:BankQuestion[]=[];let passages=lookup.passages;
 {
  const plan=await invoke<KnowledgePlan>('knowledge_prepare',{endpoint,input:{action:'match',question:{...emptyQuestion(),question:query},dialogueContext:conversation}});
  if(!stillCurrent()){await invoke('knowledge_discard_plan',{token:plan.token});return {};}
  const agreed=endpoint.api==='ollama'||await ask(`本次语义检索将发送当前问题、最近对话，以及 ${lookup.questions.length} 条候选标题、别名和项目名称，不发送标准答案或原资料。\n目标：${plan.destination}\n模型：${plan.model}\n约 ${plan.characters} 字。仅本次授权，是否发送？`,{title:'确认本次题库匹配发送',kind:'warning',isCurrent:stillCurrent,okLabel:'发送本次内容',cancelLabel:'跳过本次'});
  if(!agreed){await invoke('knowledge_discard_plan',{token:plan.token});return {cancelled:true};}
  if(!stillCurrent()){await invoke('knowledge_discard_plan',{token:plan.token});return {};}
  const result=await invoke<KnowledgeResult>('knowledge_run',{token:plan.token,consent:true});if(!stillCurrent())return {};
  const relation=result.matches[0]?.relation;
  if(relation==='ambiguous')return {missingProject:true};
  selected=result.items.slice(0,5);
  if(relation==='same'&&selected[0]){
   const matched=selected[0];const fresh=await readKnowledgeSnapshot();if(!stillCurrent())return {};
   const current=fresh.questions.find(q=>q.id===matched.id&&q.status==='confirmed'&&q.question===matched.question&&q.project===matched.project&&q.task===matched.task&&q.answer===matched.answer&&q.explanation===matched.explanation);
   if(!current)throw Error('题库在匹配期间已更新，请重新提交问题。');return {exact:current};
  }
  if(relation==='new'){
   const needsEvidence=result.matches[0]?.needsPersonalEvidence;
   if(typeof needsEvidence!=='boolean')throw Error('语义检索未判断问题是否需要个人资料依据。');
   if(!needsEvidence)return {};
   if(!passages.length)return {missingEvidence:true};
   if(lookup.projects.length>1)return {missingProject:true};
  }
  const project=selected.find(q=>q.project)?.project;
  if(project){const scoped=await invoke<KnowledgeLookup>('knowledge_lookup',{query:`${project} ${query}`,context:'',historySessionId:endpoint.historySessionId});if(!stillCurrent())return {};passages=scoped.passages.filter(p=>p.project===project);}
 }
 if(!selected.length&&!passages.length)return {missingEvidence:true};
 const context={questions:selected,passages:passages.slice(0,5),consent:false};
 const preview=[...context.questions.map(q=>`已确认题目：${q.question}\n回答：${q.answer}\n展开：${q.explanation}`),...context.passages.map(p=>`${p.path} · ${p.locator}\n${p.text}`)].join('\n\n');
 const sources=[...context.questions.map(q=>`题库：${q.question}`),...context.passages.map(p=>`${p.path} · ${p.locator}`)].join('\n');
 const agreed=endpoint.api==='ollama'||await ask(`本次回答会发送当前问题、${context.questions.length} 条已确认问答及 ${context.passages.length} 段相关资料。\n目标：${endpoint.baseUrl}\n模型：${endpoint.model}\n资料范围：\n${sources}\n项目背景约 ${preview.length} 字。仅本次授权，是否发送？`,{title:'确认本次项目背景发送',kind:'warning',isCurrent:stillCurrent,okLabel:'发送本次内容',cancelLabel:'跳过本次'});
 if(!agreed)return {cancelled:true};if(!stillCurrent())return {};context.consent=true;return {context};
}
