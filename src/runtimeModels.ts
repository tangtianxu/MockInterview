import type {ModelConfig} from './modelProviders.ts';
type Endpoint=ModelConfig&{credentialSlot:string};
type Config={answer:ModelConfig;decision:ModelConfig;sharedModelConnection:boolean;backup:{enabled:boolean;model:ModelConfig}};
const bind=(config:ModelConfig,stage:string):Endpoint=>({...config,credentialSlot:`interview_cue_${stage}@${config.baseUrl.trim().replace(/\/+$/, '')}`});
export function runtimeModels(settings:Config,preferBackup:boolean){
 const answer=bind(settings.answer,'answer'),decision=bind(settings.decision,settings.sharedModelConnection?'answer':'decision');
 const backup=settings.backup.enabled&&settings.backup.model.baseUrl.trim()&&settings.backup.model.model.trim()?bind(settings.backup.model,'fallback'):null;
 return preferBackup&&backup?{answer:backup,decision:backup,backup:answer.api==='ollama'?null:answer,decisionBackup:decision,usingBackup:true}:{answer,decision,backup,decisionBackup:backup,usingBackup:false};
}
