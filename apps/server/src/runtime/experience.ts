import {queueExperientialDreaming} from '@lifestream/runtime/dreaming/run';
import {createHash,randomUUID} from 'node:crypto';
import {ExperienceRepository,type Database} from '@lifestream/storage-sqlite';
import {dimensions,experienceBounds,type ExperienceScope,type ExperiencePolicy,type Source,type Job,type Item} from '@lifestream/contracts/experience';
import {selectExperience,experienceDigest} from '@lifestream/runtime/experience/selection';
import {reflectExperience} from '@lifestream/runtime/experience/reflection';
import type {BackgroundWork,BackgroundResult} from '@lifestream/runtime/understanding/coordinator';
import type {InferenceProvider} from '@lifestream/runtime/inference';
type Host={policy:(scope:ExperienceScope)=>ExperiencePolicy;sources:(scope:ExperienceScope)=>Source[];provider:()=>{provider:InferenceProvider;revision:string;preemptionBoundMs?:number;slotReleaseBoundMs?:number};run:<T>(work:BackgroundWork<T>)=>Promise<BackgroundResult>;idle:()=>boolean;changed:()=>void;now?:()=>number};
const key=(s:ExperienceScope)=>experienceDigest([s.principalId,s.assistantId,s.relationshipId]);
export class ExperientialLearning{
 readonly repository:ExperienceRepository;private timer:ReturnType<typeof setInterval>|undefined;private busy=false;private closed=false;private foregroundAt=0;private controller:AbortController|undefined;
 private dependencies=new Map<string,string>();
 private database:Database;private host:Host;
 constructor(database:Database,host:Host){this.database=database;this.host=host;this.repository=new ExperienceRepository(database,host.now);this.repository.recover();}
 private now(){return this.host.now?.()??Date.now();}
 start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick().catch(()=>{if(!this.closed)this.repository.fault();}),1000);this.timer.unref();}
 async close(){this.closed=true;clearInterval(this.timer);this.controller?.abort();while(this.busy)await new Promise(r=>setTimeout(r,5));}
 foreground(){this.foregroundAt=this.now();this.controller?.abort('foreground');}
 reconcile(scope:ExperienceScope){const sources=this.host.sources(scope),policy=this.host.policy(scope),fingerprint=experienceDigest([sources.map(s=>[s.id,s.revision,s.digest]),policy]);if(this.dependencies.get(key(scope))===fingerprint)return;this.repository.reconcile(scope,sources,policy);this.dependencies.set(key(scope),fingerprint);}
 reconcileAll(){for(const scope of this.repository.scopes())this.reconcile(scope);}
 completed(scope:ExperienceScope,turnId:string){const state=this.repository.read(scope);if(!state.configuration.enabled||state.configuration.frozen||!this.host.policy(scope).allowed)return;this.database.connection.prepare('INSERT OR IGNORE INTO experience_turns VALUES (?,?,?)').run(key(scope),turnId,this.now());this.database.connection.prepare('DELETE FROM experience_turns WHERE created_ms<?').run(this.now()-30*86400000);}
 inspect(scope:ExperienceScope){this.reconcile(scope);return {schemaVersion:'1.0.0',state:this.repository.read(scope),jobs:this.repository.jobs(scope),lineage:this.repository.lineage(scope),selections:this.repository.selections(scope),limitations:['Uses only retained attributable owner memory with current processing consent; source correction/forgetting removes dependent use.','Six reference attention dimensions may be allowlisted by the active Assistant profile; no Core Persona, weights or authority change.','No private chain-of-thought, research, camera, outside contact or effects. Origin ledger stays in administration.','A selected next step and an observed reply are recorded separately; inclusion alone does not establish relational quality.']};}
 boundary(scope:ExperienceScope){const s=this.repository.read(scope);return experienceDigest([s.epoch,s.configuration,s.items,s.imprints]);}
 select(scope:ExperienceScope,input:string,audiencePrivate:boolean):{id:string;item:Item|null;boundary:string}{
  const started=performance.now(),initial=this.repository.read(scope),none=()=>({id:'',item:null,boundary:this.boundary(scope)});
  if(!initial.configuration.enabled||initial.configuration.frozen||!audiencePrivate)return none();
  this.reconcile(scope);const state=this.repository.read(scope);
  const missed=()=>{this.repository.noteSelectionDeadline(scope);return none();};
  if(performance.now()-started>=10)return missed();
  const selected=selectExperience(state,input,audiencePrivate,this.now(),randomUUID());
  if(performance.now()-started>=10)return missed();
  this.repository.recordSelection(scope,selected.receipt);
  if(performance.now()-started>=10)return missed();
  return {id:selected.receipt.id,item:selected.item,boundary:this.boundary(scope)};
 }

 observe(scope:ExperienceScope,id:string){if(id)this.repository.observe(scope,id);}
 private collect(scope:ExperienceScope){const sources=this.host.sources(scope),byTurn=new Map<string,Source[]>();for(const source of sources){if(!source.family.startsWith('turn:'))continue;const turn=source.family.slice(5);if(!this.database.connection.prepare('SELECT 1 FROM experience_turns WHERE scope_key=? AND turn_id=?').get(key(scope),turn))continue;const rows=byTurn.get(turn)??[];rows.push(source);byTurn.set(turn,rows);}
  for(const rows of byTurn.values()){const text=rows.map(r=>r.content).join(' ');const reason=/\b(correction|instead|changed my mind|no longer)\b/i.test(text)?'correction':/\b(projects?|building|working|grow|gardening|garden|reading|read|music|cooking|cook|games?|astronomy)\b/i.test(text)?'project':/\b(prefer|enjoy(?:ed|ing)?|interested|like|love)\b/i.test(text)?'interest':null;if(reason)this.repository.enqueue(scope,rows.slice(0,16),reason,this.host.policy(scope));}
 }
 async tick():Promise<void>{if(this.closed||this.busy)return;this.busy=true;try{
  for(const scope of this.repository.scopes()){if(this.closed)break;this.reconcile(scope);this.collect(scope);this.consolidate(scope);if(!this.host.idle()||this.now()-this.foregroundAt<experienceBounds.idleMs)continue;const job=this.repository.jobs(scope).filter(j=>j.state==='queued'&&Date.parse(j.eligibleAt)<=this.now()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];if(job){await this.run(job);break;}}
 }finally{this.busy=false;}}
 // Dreaming and ordinary work deliberately share this admission/publication seam.
 consolidate(scope:ExperienceScope):Job|null{return queueExperientialDreaming(scope,{reconcile:s=>this.reconcile(s),enqueue:s=>this.repository.enqueueConsolidation(s,this.host.policy(s))});}
 private async run(job:Job){const state=this.repository.read(job.scope),policy=this.host.policy(job.scope),runtime=this.host.provider(),controller=this.controller=new AbortController(),started=this.now();let failure:string|undefined;let metrics:{inputTokens:number;outputTokens:number;elapsedMs:number}|undefined;
  const current=()=>!this.closed&&!controller.signal.aborted&&this.repository.current(job)&&this.host.policy(job.scope).revision===policy.revision&&this.host.policy(job.scope).allowed;
  const allSources=this.host.sources(job.scope),episodes=this.repository.episodes(job.scope).filter(e=>e.state==='retained').sort((a,b)=>Number(job.episodeRefs.includes(b.id))-Number(job.episodeRefs.includes(a.id))).slice(0,16),wanted=new Set([...episodes.flatMap(e=>e.sourceRefs),...state.items.flatMap(i=>i.sourceRefs)]),sources=allSources.filter(s=>wanted.has(s.id)).slice(0,32),providedEpisodes=episodes.filter(e=>e.sourceRefs.every(id=>sources.some(s=>s.id===id))),sourceBoundary=createHash('sha256').update(JSON.stringify(allSources.map(s=>[s.id,s.revision,s.digest]))).digest('hex');const sameSources=()=>sourceBoundary===createHash('sha256').update(JSON.stringify(this.host.sources(job.scope).map(s=>[s.id,s.revision,s.digest]))).digest('hex');
  const result=await this.host.run({key:'experience:'+job.id,deadlineAt:this.now()+experienceBounds.deadlineMs,current:()=>current()&&sameSources(),admitOnce:()=>this.repository.admit(job,runtime.revision),sharedInference:true,...(runtime.preemptionBoundMs===undefined?{}:{providerPreemptionBoundMs:runtime.preemptionBoundMs}),...(runtime.slotReleaseBoundMs===undefined?{}:{providerSlotReleaseBoundMs:runtime.slotReleaseBoundMs}),priority:'P2',steps:[async signal=>{try{const value=await reflectExperience({state,episodes:providedEpisodes,sources,allowedDimensions:dimensions.filter(d=>policy.dimensions[d]),jobId:job.id,provider:runtime.provider,signal:AbortSignal.any([signal,controller.signal]),deadlineAt:this.now()+experienceBounds.deadlineMs,onCall:()=>this.repository.called(job.scope)});metrics={inputTokens:value.inputTokens,outputTokens:value.outputTokens,elapsedMs:this.now()-started};return value.result;}catch(error){const message=error instanceof Error?error.message:'';failure=/^(reflection_[a-z_]+|selected_tokenizer_unavailable)$/.test(message)?message:'reflection_provider_or_validation_failure';throw error;}}],publish:value=>{if(!current()||!sameSources())return false;this.repository.publish(job,value,policy,sources);this.repository.finish(job,value.decision==='noChange'?'noChange':'published',metrics);return true;}});
  if(result.state!=='published'&&job.attempts>0&&this.repository.current(job))this.repository.finish(job,failure??result.reason,metrics);else if(result.state==='suppressed'&&job.attempts===0)this.repository.defer(job,result.reason);if(this.controller===controller)this.controller=undefined;this.host.changed();
 }
}
