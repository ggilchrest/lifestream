import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {CapabilityResolver,capabilityInputDigest,type AuthorityDispatcher} from '@lifestream/runtime/capabilities/resolver';
import type {CapabilityProvider,CapabilityScope,CapabilityCallContext,CapabilityInvocationResult} from '@lifestream/runtime/capabilities/ports';
import type {CapabilitySchemaStore} from '@lifestream/runtime/capabilities/schema-artifacts';
import type {PwceConditionClient,PwceConditionIdentity,PwceCondition} from '@lifestream/providers-pwce';
import {UrgentAwayRepository,urgentAttentionScopeKey,type Database,type UrgentAwayRecord,type UrgentAwayOutcome} from '@lifestream/storage-sqlite';
import type {UrgentAttentionRuntime,UrgentAttentionFacts,UrgentAttentionScope,UrgentAttentionDelivery} from './urgent-attention.ts';

export type UrgentAwaySource=Pick<PwceConditionClient,'snapshot'|'changes'>;
export const URGENT_AWAY_NOTICE='A critical condition needs your attention. Open your authenticated Assistant to review.';
export const URGENT_AWAY_SIMULATION_NOTICE='Simulation. '+URGENT_AWAY_NOTICE;
/** Explicit provider-neutral notice contract. A provider acceptance is not a
 * recipient receipt, evidence-access grant, or Human acknowledgment. */
export const URGENT_AWAY_INPUT_SCHEMA={type:'object',additionalProperties:false,required:['schemaVersion','destinationRef','notificationRef','conditionRef','expiresAt','message','evidenceRefs'],properties:{schemaVersion:{const:'1.0.0'},destinationRef:{type:'string',minLength:1,maxLength:128},notificationRef:{type:'string',minLength:1,maxLength:128},conditionRef:{type:'string',minLength:1,maxLength:128},expiresAt:{type:'string',format:'date-time'},message:{enum:[URGENT_AWAY_NOTICE,URGENT_AWAY_SIMULATION_NOTICE]},evidenceRefs:{type:'array',maxItems:16,uniqueItems:true,items:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]*$'}}}};
export const URGENT_AWAY_OUTPUT_SCHEMA={type:'object',additionalProperties:false,required:['schemaVersion','accepted','receiptRef'],properties:{schemaVersion:{const:'1.0.0'},accepted:{type:'boolean'},receiptRef:{anyOf:[{type:'null'},{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9._:/-]*$'}]}}};
export type UrgentAwayDestination={
 destinationRef:string;revision:number;scope:UrgentAttentionScope;identity:PwceConditionIdentity;
 capabilityScope:CapabilityScope;capabilityId:string;capabilityVersion:string;capabilityRoute:string;
 provider:CapabilityProvider;dispatch:AuthorityDispatcher;schemaStore?:CapabilitySchemaStore;
 facts:()=>UrgentAttentionFacts;current:()=>boolean;evidenceReferencesAllowed?:()=>boolean;
};
export type UrgentAwayOptions={runtime:UrgentAttentionRuntime;source:UrgentAwaySource;destinations:UrgentAwayDestination[];now?:()=>Date;pollIntervalMs?:number};
type Destination={binding:UrgentAwayDestination;bindingDigest:string;lastDispatchReason:string|null;cursor:number|null;boundary:string|null;settingsRevision:number|null;connected:boolean;reason:string;busy:boolean;controller:AbortController;blocked:boolean};
type Job={destination:Destination;delivery:UrgentAttentionDelivery;priorUncertain:boolean;record:UrgentAwayRecord;controller:AbortController;boundary:string;includesEvidence:boolean};
const opaque=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const deepFreeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;};
deepFreeze(URGENT_AWAY_INPUT_SCHEMA);deepFreeze(URGENT_AWAY_OUTPUT_SCHEMA);
const sameScope=(a:UrgentAttentionScope,b:UrgentAttentionScope)=>urgentAttentionScopeKey(a)===urgentAttentionScopeKey(b);
const privateError=()=>new Error('Away delivery unavailable');
const shape=(facts:UrgentAttentionFacts)=>JSON.stringify([facts.scope,facts.sessionId,facts.sessionRevision,facts.audienceRevision,facts.authorizationRevision]);

/** Host-controlled polling and effectful delivery, independent of a browser.
 * The caller supplies an already legitimate message-session scope and current
 * authority. This class creates no session, grant, provider, or live source. */
export class UrgentAwayRuntime{
 private readonly runtime:UrgentAttentionRuntime;
 private readonly source:UrgentAwaySource;
 private readonly repository:UrgentAwayRepository;
 private readonly destinations:Destination[];
 private readonly now:()=>Date;
 private readonly interval:number;
 private readonly jobs=new Map<string,Job>();
 private timer:ReturnType<typeof setInterval>|undefined;
 private guard:ReturnType<typeof setInterval>|undefined;
 private running=false;
 private closed=false;
 constructor(database:Database,options:UrgentAwayOptions){
  if(!options||!options.runtime||!options.source||!Array.isArray(options.destinations)||options.destinations.length>8)throw privateError();
  this.runtime=options.runtime;this.source=options.source;this.now=options.now??(()=>new Date());this.interval=options.pollIntervalMs??1000;
  if(!Number.isInteger(this.interval)||this.interval<250||this.interval>30000)throw privateError();
  const scopes=new Set<string>(),refs=new Set<string>();
  this.destinations=options.destinations.map(value=>{
   const key=urgentAttentionScopeKey(value.scope),cap=value.capabilityScope;
   if(![value.destinationRef,value.capabilityId,value.capabilityVersion,value.capabilityRoute].every(opaque)||!Number.isSafeInteger(value.revision)||value.revision<1||scopes.has(key)||refs.has(value.destinationRef)
     ||!cap||!opaque(cap.sessionId)||!opaque(cap.environment)||cap.assistantId!==value.scope.assistantId||cap.endpointId!==value.scope.endpointId||!cap.authorityContextRef||!opaque(cap.authorityContextRef.providerRef)||!opaque(cap.authorityContextRef.contextId)||!Number.isSafeInteger(cap.authorityContextRef.revision)||cap.authorityContextRef.revision<0
     ||value.identity?.assistantRef!==value.scope.assistantId||value.identity.endpointRef!==value.scope.endpointId||!Array.isArray(value.identity.participantRefs)||!value.identity.participantRefs.includes(value.scope.principalId)||!opaque(value.identity.audienceRef)
     ||typeof value.current!=='function'||typeof value.facts!=='function'||typeof value.dispatch!=='function'||!value.provider||['getSnapshot','getInvocation','invoke'].some(name=>typeof value.provider[name as keyof CapabilityProvider]!=='function'))throw privateError();
   scopes.add(key);refs.add(value.destinationRef);
   const binding={...value,scope:structuredClone(value.scope),identity:structuredClone(value.identity),capabilityScope:structuredClone(cap)};
   const bindingDigest=capabilityInputDigest({scope:binding.scope,destinationRef:binding.destinationRef,revision:binding.revision,capabilityScope:binding.capabilityScope,capabilityId:binding.capabilityId,capabilityVersion:binding.capabilityVersion,capabilityRoute:binding.capabilityRoute,identity:binding.identity});
   return {binding,bindingDigest,lastDispatchReason:null,cursor:null,boundary:null,settingsRevision:null,connected:false,reason:'disabled',busy:false,controller:new AbortController(),blocked:false};
  });
  this.repository=new UrgentAwayRepository(database);this.repository.recover(this.time(),this.destinations.map(d=>d.binding.scope));
  for(const destination of this.destinations){
   const scope=destination.binding.scope;
   if(this.repository.destinationBinding(scope)?.bindingDigest!==destination.bindingDigest){
    const settings=this.runtime.settings(scope);
    if(settings.rules.some(rule=>rule.enabled||rule.bypassQuietHours)||settings.snoozedUntil!==null)this.runtime.control(scope,{action:'disable',expectedRevision:settings.revision});
    this.repository.bindDestination(scope,destination.bindingDigest,this.time());
   }
  }
 }
 private time(){const value=this.now();if(!(value instanceof Date)||!Number.isFinite(value.valueOf()))throw privateError();return value.toISOString();}
 private facts(destination:Destination):UrgentAttentionFacts|undefined{
  const d=destination.binding;
  try{
   if(this.closed||!d.current()||this.repository.destinationBinding(d.scope)?.bindingDigest!==destination.bindingDigest)return undefined;
   const f=d.facts();
   if(!f||!sameScope(f.scope,d.scope)||f.sessionId!==d.capabilityScope.sessionId||!f.authorized||!f.privateAudience||!f.attentionSuitable||!f.outputReady)return undefined;
   return f;
  }catch{return undefined;}
 }
 private enabled(destination:Destination){const settings=this.runtime.settings(destination.binding.scope);return settings.modality==='text'&&settings.rules.some(rule=>rule.enabled);}
 start():void{
  if(this.closed)throw privateError();if(this.running)return;this.running=true;
  this.timer=setInterval(()=>void this.tick(),this.interval);this.timer.unref();
  this.guard=setInterval(()=>this.reconcile(),100);this.guard.unref();void this.tick();
 }
 async tick():Promise<void>{
  if(!this.running||this.closed)return;
  await Promise.all(this.destinations.map(destination=>this.poll(destination)));
 }
 private reset(destination:Destination,reason:string){
  if(['scope_changed','scope_unavailable','settings_changed'].includes(reason))destination.blocked=false;
  if(destination.boundary===null&&destination.cursor===null&&!destination.connected&&destination.reason===reason&&!this.jobsFor(destination))return;
  destination.controller.abort();destination.controller=new AbortController();destination.cursor=null;destination.boundary=null;destination.connected=false;destination.reason=reason;
  try{this.runtime.invalidate(destination.binding.scope,'away_'+reason);}catch{/* A stopped scope never authorizes further effects. */}
  for(const job of this.jobs.values())if(job.destination===destination)job.controller.abort();
 }
 private jobsFor(destination:Destination){return [...this.jobs.values()].some(job=>job.destination===destination);}
 private async poll(destination:Destination):Promise<void>{
  if(destination.busy||this.closed||!this.running)return;
  const settings=this.runtime.settings(destination.binding.scope);
  if(destination.settingsRevision!==settings.revision){this.reset(destination,'settings_changed');destination.settingsRevision=settings.revision;destination.blocked=false;}
  if(!this.enabled(destination)){this.reset(destination,'disabled');return;}
  const initial=this.facts(destination);if(!initial){this.reset(destination,'scope_unavailable');return;}
  if(destination.blocked)return;
  if(destination.boundary!==shape(initial)){this.reset(destination,'scope_changed');destination.boundary=shape(initial);}
  const boundary=destination.boundary,signal=destination.controller.signal;
  const current=()=>{const fresh=this.facts(destination);return this.running&&!this.closed&&!signal.aborted&&!!fresh&&shape(fresh)===boundary&&this.runtime.settings(destination.binding.scope).revision===settings.revision&&this.enabled(destination);};
  destination.busy=true;
  try{
   const baseline=destination.cursor===null;
   const result=baseline?await this.source.snapshot(destination.binding.identity,current,signal):await this.source.changes(destination.cursor!,destination.binding.identity,current,signal);
   if(!current())throw privateError();
   if(result.status==='resyncRequired'){this.reset(destination,'source_resync_required');destination.blocked=true;return;}
   for(const condition of result.conditions){
    if(!current())throw privateError();
    const facts=this.facts(destination)!;
    const admitted=this.runtime.ingest(destination.binding.scope,condition,{...facts,outputReady:facts.outputReady&&this.jobs.size<8},{baseline});
    if(admitted.admitted&&admitted.delivery){
     if(this.repository.find(destination.binding.scope,destination.binding.destinationRef,condition.conditionRef))this.retire(admitted.delivery,'away_already_recorded');
     else void this.deliver(destination,admitted.delivery,condition,boundary!,result.replay);
    }
   }
   destination.cursor=result.nextCursor;destination.connected=true;destination.reason='connected';this.reconcile();
  }catch{
   if(!this.closed&&!signal.aborted){const sourceFailed=current();this.reset(destination,sourceFailed?'source_unavailable':'scope_changed');destination.blocked=sourceFailed;}
  }
  finally{destination.busy=false;}
 }
 private current(job:Job):boolean{
  if(!this.running||this.closed||job.controller.signal.aborted)return false;
  const facts=this.facts(job.destination);
  if(!facts||shape(facts)!==job.boundary||!this.enabled(job.destination))return false;
  if(job.includesEvidence){try{if(job.destination.binding.evidenceReferencesAllowed?.()!==true)return false;}catch{return false;}}
  try{const result=this.runtime.current(job.delivery.id,facts);if(result.delivery)job.delivery=result.delivery;return result.current;}catch{return false;}
 }
 private retire(delivery:UrgentAttentionDelivery,reason:string){try{this.runtime.cancel(delivery.id,delivery.revision,reason);}catch{/* Existing terminal state remains authoritative. */}}
 private async deliver(destination:Destination,delivery:UrgentAttentionDelivery,condition:PwceCondition,boundary:string,replay:boolean):Promise<void>{
  const binding=destination.binding;let job:Job|undefined;
  try{
   let refsAllowed=false;try{refsAllowed=binding.evidenceReferencesAllowed?.()===true;}catch{/* No disclosure by default. */}
   const input={schemaVersion:'1.0.0',destinationRef:binding.destinationRef,notificationRef:delivery.id,conditionRef:condition.conditionRef,expiresAt:delivery.expiresAt,message:replay||condition.basis==='synthetic'?URGENT_AWAY_SIMULATION_NOTICE:URGENT_AWAY_NOTICE,evidenceRefs:refsAllowed?[...condition.qualification.evidenceRefs]:[]};
   const reserved=this.repository.reserve({scope:binding.scope,destinationRef:binding.destinationRef,destinationRevision:binding.revision,conditionRef:condition.conditionRef,conditionRevision:condition.revision,sourceRef:condition.sourceRef,eventClass:condition.eventClass,capabilityId:binding.capabilityId,capabilityVersion:binding.capabilityVersion,capabilityRoute:binding.capabilityRoute,capabilityScopeDigest:capabilityInputDigest(binding.capabilityScope),invocationId:delivery.id,inputDigest:capabilityInputDigest(input),expiresAt:delivery.expiresAt},this.time());
   if(!reserved.created){this.retire(delivery,'away_already_recorded');return;}
   destination.lastDispatchReason=null;
   job={destination,delivery,priorUncertain:false,record:reserved.record,controller:new AbortController(),boundary,includesEvidence:input.evidenceRefs.length>0};
   const active=job;this.jobs.set(delivery.id,active);
   const provider:CapabilityProvider={
    getSnapshot:binding.provider.getSnapshot.bind(binding.provider),
    getInvocation:async(request,context)=>{const existing=await binding.provider.getInvocation(request,context);if(existing&&active.record.attemptedAt===null){active.priorUncertain=['started','succeeded','outcomeUnknown'].includes(existing.lifecycle);throw privateError();}return existing;},
    invoke:async(request,capability,context)=>{
     if(!this.current(active)||active.record.state!=='reserved')throw privateError();
     active.delivery=this.runtime.transition(active.delivery.id,active.delivery.revision,'started');
     active.record=this.repository.markAttempted(active.record.id,active.record.revision,this.time());
     if(!this.current(active))throw privateError();
     return binding.provider.invoke(request,capability,context);
    }
   };
   const resolver=new CapabilityResolver(provider,undefined,binding.dispatch,()=>this.time(),binding.schemaStore);
   const call:CapabilityCallContext={requestId:delivery.id,correlationId:delivery.id,deadlineAt:new Date(Math.min(Date.parse(delivery.expiresAt),Date.now()+10000)).toISOString(),executionMode:'live',signal:active.controller.signal,isCurrent:()=>this.current(active)};
   const snapshot=await resolver.snapshot(binding.capabilityScope,call);
   const capability=snapshot.capabilities.find(c=>c.id===binding.capabilityId&&c.version===binding.capabilityVersion&&c.route===binding.capabilityRoute);
   if(!capability||capability.authorization!=='required'||!['reversible','irreversible'].includes(capability.sideEffect)||capability.idempotency!=='idempotent'||!isDeepStrictEqual(capability.inputSchema,URGENT_AWAY_INPUT_SCHEMA)||!isDeepStrictEqual(capability.outputSchema,URGENT_AWAY_OUTPUT_SCHEMA)){
    this.settle(active,{state:'failed',reason:'delivery_contract_invalid'});return;
   }
   const result=await resolver.invoke({...binding.capabilityScope,invocationId:delivery.id,interactionId:delivery.id,capabilityId:binding.capabilityId,capabilityVersion:binding.capabilityVersion,snapshotId:snapshot.snapshotId,snapshotRevision:snapshot.revision,input,idempotencyKey:delivery.id},call);
   this.settle(active,this.outcome(active,result));
  }catch{
   if(!job)destination.lastDispatchReason='journal_unavailable';
   if(job)try{this.settle(job,{state:job.record.attemptedAt?'unknown':'failed',reason:job.record.attemptedAt?'provider_unknown':'capability_unavailable'});}catch{/* Failed custody is never permission to invoke or resend. */}
  }finally{
   if(job){job.controller.abort();this.jobs.delete(delivery.id);this.retire(job.delivery,job.record.state==='unknown'?'away_unknown':'away_settled');}
   else this.retire(delivery,'away_unavailable');
  }
 }
 private outcome(job:Job,result:CapabilityInvocationResult):UrgentAwayOutcome{
  if(job.priorUncertain)return {state:'unknown',reason:'admission_uncertain'};
  if(result.lifecycle==='succeeded'){
   const output=result.output as {schemaVersion:string;accepted:boolean;receiptRef:string|null};
   if(!job.record.attemptedAt)return {state:'failed',reason:'delivery_contract_invalid'};
   return output.accepted?{state:'accepted',reason:'provider_accepted',...(output.receiptRef?{receiptDigest:createHash('sha256').update(output.receiptRef).digest('hex')}:{})}:{state:'denied',reason:'provider_denied'};
  }
  if(job.record.attemptedAt){
   if(result.lifecycle==='failed')return {state:'failed',reason:'provider_failed'};
   if(result.lifecycle==='denied')return {state:'denied',reason:'provider_denied'};
   return {state:'unknown',reason:'provider_unknown'};
  }
  if(result.lifecycle==='outcomeUnknown'&&result.reason==='prior_dispatch_requires_reconciliation')return {state:'unknown',reason:'admission_uncertain'};
  return result.lifecycle==='approvalRequired'?{state:'approvalRequired',reason:'approval_required'}:result.lifecycle==='denied'?{state:'denied',reason:'admission_denied'}:{state:'failed',reason:'capability_unavailable'};
 }
 private settle(job:Job,outcome:UrgentAwayOutcome){
  const current=this.repository.get(job.record.id);if(!current)throw privateError();job.record=current;
  if(!['reserved','attempted'].includes(current.state))return;
  job.record=this.repository.settle(current.id,current.revision,outcome,this.time());
 }
 reconcile():void{
  if(this.closed)return;
  for(const destination of this.destinations){
   const f=this.facts(destination);
   const settings=this.runtime.settings(destination.binding.scope);
   if(destination.settingsRevision!==null&&settings.revision!==destination.settingsRevision){this.reset(destination,'settings_changed');destination.settingsRevision=settings.revision;destination.blocked=false;}
   if(!f||!this.enabled(destination)||destination.boundary!==null&&shape(f)!==destination.boundary)this.reset(destination,!f?'scope_unavailable':!this.enabled(destination)?'disabled':'scope_changed');
  }
  for(const job of this.jobs.values())if(!this.current(job))job.controller.abort();
 }
 inspect(scope:UrgentAttentionScope){
  urgentAttentionScopeKey(scope);
  const selected=this.destinations.filter(d=>sameScope(d.binding.scope,scope));
  return {configured:selected.length>0,running:this.running&&!this.closed,destinations:selected.map(d=>({destinationRef:d.binding.destinationRef,revision:d.binding.revision,endpointId:d.binding.scope.endpointId,connected:d.connected,reason:d.reason,lastDispatchReason:d.lastDispatchReason})),deliveries:selected.flatMap(d=>this.repository.inspect(d.binding.scope)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100),humanAcceptance:false as const};
 }
 acknowledge(scope:UrgentAttentionScope,id:string,expectedRevision:number){return this.repository.acknowledge(scope,id,expectedRevision,this.time());}
 close():void{
  if(this.closed)return;this.running=false;
  if(this.timer)clearInterval(this.timer);if(this.guard)clearInterval(this.guard);
  for(const destination of this.destinations)this.reset(destination,'host_stopped');this.closed=true;
 }
}
