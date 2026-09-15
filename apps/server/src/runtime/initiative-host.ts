import {createHash,randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {InitiativeDeliveryRepository,type Database,type InitiativeScope,type InitiativeOpportunity,type InitiativeDeliveryRecord} from '@lifestream/storage-sqlite';
import type {InferenceProvider} from '@lifestream/runtime/inference';
import type {EndpointProfile} from '@lifestream/runtime/endpoints/registry';
import {resolveInitiativePolicy,type InitiativeFacts,type InitiativeTemporaryMode} from '../admin/initiative-policy.ts';
import {extensionError} from '../relationship-extensions.ts';
import {InitiativeCandidateGenerator} from './initiative.ts';
import type {HostRuntimeInput} from './inference.ts';

export type InitiativeOwner={scope:InitiativeScope;configuration?:Record<string,unknown>;profile?:Record<string,unknown>;boundary:string;consentCurrent:boolean;evidenceRefs:string[]};
export type InitiativeSession={sessionId:string;conversationId:string;revision:number;endpoint:EndpointProfile};
/** Only supplied by an explicitly enabled test host, never decoded from HTTP facts. */
export type InitiativeSimulationEvent={userId:string;sessionId:string;sourceEventId:string;kind:InitiativeOpportunity['kind'];topicRef:string|null;observedAt:number;expiresAt:number;context:InitiativeFacts['context'];modality:'text'|'speech';dwellSeconds?:number;absenceSeconds?:number;unfinishedEvidenceCurrent?:boolean};
export type InitiativeSimulation={resolve:(scope:InitiativeScope,sessionId:string,sourceEventId:string)=>InitiativeSimulationEvent|undefined};
type Result={status:number;body:Record<string,unknown>};
type Context={owner:()=>InitiativeOwner|undefined;session:()=>InitiativeSession|undefined;authorized:()=>boolean;prepare:()=>HostRuntimeInput;provider:InferenceProvider|undefined;signal:AbortSignal;emit:(prefix:string,suffix:()=>string)=>void};
type Job={scope:InitiativeScope;sessionId:string;controller:AbortController;current:()=>boolean;reason:string};
const validator=createContractValidator(),api='https://lifestream.dev/contracts/initiative-api/1.0.0';
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(value);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const key=(scope:InitiativeScope,sessionId:string)=>hash([scope,sessionId]);
const active=new Set(['pending','eligible','generated','queued','emitted']);

/** Session-scoped orchestration. Candidate payloads only live on the in-flight call;
 * inspection and idempotent retries return metadata, never replayable output. */
export class InitiativeHost {
 readonly ledger:InitiativeDeliveryRepository;
 private readonly generator=new InitiativeCandidateGenerator();
 private readonly readiness=new Map<string,{revision:number;endpointId:string;text:boolean;speech:boolean}>();
 private readonly modes=new Map<string,InitiativeTemporaryMode>();
 private readonly jobs=new Map<string,Job>();
 private foreground=0;
 private closed=false;
 private readonly database:Database;
 private readonly simulation:InitiativeSimulation|undefined;
 constructor(database:Database,simulation?:InitiativeSimulation){this.database=database;this.simulation=simulation;this.ledger=new InitiativeDeliveryRepository(database);this.ledger.recover();}
 records(scope:InitiativeScope):unknown[]{return this.ledger.list(scope).slice(0,63).flatMap(r=>[r.opportunity,r.outcome]);}
 private response(owner:InitiativeOwner,operation:string,explanations:Array<{code:string;summary:string;sourceRefs:string[]}>=[],changed=false):Result {
  return {status:200,body:{schemaVersion:'1.0.0',relationshipId:owner.scope.relationshipId,operation,activeConfigurationId:owner.configuration?.configurationId??null,records:[...(owner.configuration?[owner.configuration]:[]),...this.records(owner.scope)].slice(0,128),explanations:[{code:'bounded_runtime_history',summary:'Current configuration and at most 63 recent opportunities and outcomes. Simulation is synthetic; emission, endpoint acceptance and playback completion are separate. No microphone capture is started.',sourceRefs:[]},...explanations],activeStateChanged:changed,executionMode:this.simulation?'simulation':'live',nextCursor:null,delivery:null}};
 }
 expressionWarmth(owner:InitiativeOwner|undefined,sessionId:string,endpointId:string):number|undefined {
  if(!owner?.configuration)return undefined;
  const temporary=this.mode(owner.scope,sessionId),now=Date.now();
  return resolveInitiativePolicy({scope:owner.scope,configuration:owner.configuration,profile:owner.profile,...(temporary?{temporary}:{}),now,facts:{sessionId,endpointId,modality:'text',kind:'availableCheckIn',context:'unknown',authorized:true,identityQualified:false,privateAudience:false,consentCurrent:owner.consentCurrent,sourceQualified:false,sourceExpiresAt:now,outputReady:false,leaseAvailable:false}}).expressionWarmth;
 }
 private mode(scope:InitiativeScope,sessionId:string):InitiativeTemporaryMode|undefined {
  const k=key(scope,sessionId),mode=this.modes.get(k);if(mode?.expiresAt!==null&&mode&&mode.expiresAt<=Date.now()){this.modes.delete(k);return undefined;}return mode;
 }
 invalidate(reason='configurationChanged'):void {
  for(const job of this.jobs.values())if(this.closed||this.foreground>0||!job.current()){job.reason=this.foreground>0?'userTurn':reason;job.controller.abort();}
 }
 foregroundStarted(engagement?:{scope:InitiativeScope;sessionId:string}):()=>void {
  this.foreground++;this.invalidate('userTurn');
  if(engagement){const {scope,sessionId}=engagement;this.ledger.resetSessionTopics(scope,sessionId);const prior=this.ledger.list(scope).find(r=>r.opportunity.sessionId===sessionId&&['emitted','acknowledged'].includes(r.outcome.lastDeliveryStage)&&['notObserved','noResponse'].includes(r.outcome.response));if(prior)this.ledger.transition(scope,prior.opportunity.opportunityId,prior.version,{type:'respond',sessionId,response:'replied'});}
  let released=false;return ()=>{if(!released){released=true;this.foreground--;}};
 }
 close():void{this.closed=true;this.invalidate('cancelled');this.readiness.clear();this.modes.clear();}
 private retry(scope:InitiativeScope,request:Record<string,unknown>):'new'|'same'|'conflict'{
  const row=this.database.connection.prepare('SELECT relationship_id,operation FROM assistant_relationship_idempotency WHERE idempotency_key=?').get(String(request.idempotencyKey)) as {relationship_id:string;operation:string}|undefined;
  return !row?'new':row.relationship_id===scope.relationshipId&&row.operation===`initiative-runtime:${hash([scope,request])}`?'same':'conflict';
 }
 private saveRetry(scope:InitiativeScope,request:Record<string,unknown>):void {
  this.database.connection.prepare('INSERT INTO assistant_relationship_idempotency (idempotency_key,relationship_id,operation,response_json) VALUES (?,?,?,?)').run(String(request.idempotencyKey),scope.relationshipId,`initiative-runtime:${hash([scope,request])}`,JSON.stringify({runtimeMetadataOnly:true}));
 }
 async handle(raw:Record<string,unknown>,context:Context):Promise<Result|undefined>{
  if(!validator.validate(`${api}#/$defs/Request`,raw).valid)return extensionError(422,'invalid_extension_request','Unsupported version, operation or fields.');
  const owner=context.owner(),session=context.session(),operation=String(raw.operation);
  if(this.closed||!context.authorized()||!owner||!session||raw.sessionId!==session.sessionId)return extensionError(409,'initiative_session_scope','Use the current authenticated session and bind its audience in Conversation first.');
  const scope=owner.scope,k=key(scope,session.sessionId),now=Date.now();
  this.ledger.expirePending();this.invalidate();
  if(raw.idempotencyKey){const retry=this.retry(scope,raw);if(retry==='conflict')return extensionError(409,'idempotency_conflict','This retry key identifies a different request.');if(retry==='same')return this.response(owner,operation,[{code:'already_processed',summary:'This request was already processed. Current metadata is shown; output and temporary modes are never replayed.',sourceRefs:[]}]);}
  if(operation==='outputReadiness'){
   if(this.readiness.size>=256&&!this.readiness.has(k))return extensionError(409,'initiative_capacity','Session readiness capacity is full.');
   const old=this.readiness.get(k),entry=old?.revision===session.revision?old:{revision:session.revision,endpointId:session.endpoint.endpointId,text:false,speech:false};
   entry[raw.modality as 'text'|'speech']=raw.ready===true;this.readiness.set(k,entry);this.invalidate('endpointUnavailable');
   return this.response(owner,operation,[{code:'output_readiness',summary:`${raw.modality} output is ${raw.ready?'ready':'not ready'} for this session. This grants no consent or input capture.`,sourceRefs:[session.endpoint.endpointId]}]);
  }
  if(operation==='temporaryMode'){
   const mode=String(raw.mode),expiry=raw.endsAt===null?null:Date.parse(String(raw.endsAt));
   if(mode==='clear'&&(raw.endsAt!==null||raw.dimensions!==null)||mode==='quiet'&&raw.dimensions!==null||expiry!==null&&expiry<=now)return extensionError(422,'temporary_mode_invalid','Clear has no dimensions or expiry; quiet has no dimensions; a finite expiry must be in the future.');
   if(mode==='companionship'){
    if(!owner.configuration||!owner.profile||!owner.consentCurrent||!(owner.configuration.consentRefs as string[]).length||!(owner.configuration.endpointIds as string[]).includes(session.endpoint.endpointId)||!(owner.configuration.allowedModalities as string[]).length||expiry===null||expiry-now<300000||expiry-now>28800000||!raw.dimensions)return extensionError(409,'companionship_scope','Companionship needs current opt-in, reviewed settings and an expiry 5 minutes–8 hours ahead.');
    const temporary:InitiativeTemporaryMode={kind:'companionship',sessionId:session.sessionId,configurationId:String(owner.configuration.configurationId),createdAt:now,expiresAt:expiry,dimensions:raw.dimensions as NonNullable<InitiativeTemporaryMode['dimensions']>};
    const p=resolveInitiativePolicy({scope,configuration:owner.configuration,profile:owner.profile,temporary,now,facts:{sessionId:session.sessionId,endpointId:session.endpoint.endpointId,modality:'text',kind:'availableCheckIn',context:'unknown',authorized:true,identityQualified:false,privateAudience:false,consentCurrent:owner.consentCurrent,sourceQualified:false,sourceExpiresAt:now,outputReady:false,leaseAvailable:false}});
    if(p.reasons.some(reason=>['invalidScope','notOptedIn','consentRevoked','configurationChanged'].includes(reason))||p.limitations.some(s=>s.startsWith('Selected '))||Object.entries(temporary.dimensions!).some(([dimension,value])=>!p.sources.some(s=>s.dimension===dimension&&s.sourceRef.startsWith('temporary-companionship:')&&s.value===value)))return extensionError(409,'companionship_bounds','The temporary dimensions exceed the Assistant’s protected bounds.');
   }
   if(this.modes.size>=256&&!this.modes.has(k))return extensionError(409,'initiative_capacity','Temporary-mode capacity is full.');
   this.saveRetry(scope,raw);
   if(mode==='clear')this.modes.delete(k);else this.modes.set(k,{kind:mode as 'quiet'|'companionship',sessionId:session.sessionId,configurationId:String(owner.configuration?.configurationId??''),createdAt:now,expiresAt:expiry,...(raw.dimensions?{dimensions:raw.dimensions as NonNullable<InitiativeTemporaryMode['dimensions']>}: {})});
   this.invalidate(mode==='quiet'?'quiet':'configurationChanged');return this.response(owner,operation,[{code:'temporary_mode',summary:mode==='clear'?'Temporary mode cleared. Old opportunities will not resume.':`${mode==='quiet'?'Quiet':'Companionship'} applies only to this session ${expiry===null?'until cleared':`until ${new Date(expiry).toISOString()}`}. It ends on restart. Durable settings are unchanged.`,sourceRefs:[]}],true);
  }
  if(['acknowledge','dismiss','cancel'].includes(operation)){
   const r=this.ledger.get(scope,String(raw.opportunityId));if(!r||r.opportunity.sessionId!==session.sessionId)return extensionError(404,'initiative_not_found','No opportunity in this session.');
   if(operation==='acknowledge'&&raw.kind==='playbackCompleted')return extensionError(409,'playback_not_available','This text output path cannot report speech playback completion.');
   try{
    if(operation==='acknowledge')this.ledger.transition(scope,r.opportunity.opportunityId,r.version,{type:'acknowledge',sessionId:session.sessionId,receiptId:String(raw.receiptId),kind:raw.kind as 'endpointAccepted'|'playbackCompleted'});
    else {
     if(operation==='dismiss')this.ledger.transition(scope,r.opportunity.opportunityId,r.version,{type:'respond',sessionId:session.sessionId,response:'dismissed'},()=>this.saveRetry(scope,raw));
     else if(active.has(r.outcome.state))this.ledger.transition(scope,r.opportunity.opportunityId,r.version,{type:'finish',state:'cancelled',reasons:['cancelled']},()=>this.saveRetry(scope,raw));
     else return extensionError(409,'initiative_terminal','The opportunity is already terminal.');
     const job=this.jobs.get(r.opportunity.opportunityId);if(job){job.reason='cancelled';job.controller.abort();}
    }
    return this.response(owner,operation);
   }catch{return extensionError(409,'initiative_stage_conflict','The session, receipt or observed delivery stage does not permit this operation.');}
  }
  if(operation!=='simulate')return extensionError(409,'operation_unavailable','This runtime operation is not yet available.');
  if(!this.simulation)return extensionError(409,'simulation_not_enabled','Synthetic Initiative ingress must be enabled and bound by the test host.');
  const resolved=this.simulation.resolve(scope,session.sessionId,String(raw.sourceEventId)),event=resolved?structuredClone(resolved):undefined;
  if(!event||event.userId!==scope.userId||event.sessionId!==session.sessionId||event.sourceEventId!==raw.sourceEventId||event.kind!==raw.kind||event.topicRef!==raw.topicRef||!Number.isFinite(event.observedAt)||!Number.isFinite(event.expiresAt)||event.observedAt>now||event.expiresAt<=now)return extensionError(409,'synthetic_source_unavailable','The test host has no matching current synthetic source for this subject and session.');
  if(!owner.configuration)return extensionError(409,'initiative_not_configured','Review and activate Initiative settings first.');
  const config=owner.configuration,tuning=config.tuning as Record<string,number>,mode=this.mode(scope,session.sessionId),ttl=event.kind==='arrivalReturn'?tuning.arrivalTtlSeconds:event.kind==='availableCheckIn'?tuning.checkInTtlSeconds:tuning.followUpTtlSeconds;
  const expires=Math.min(event.expiresAt,event.observedAt+ttl!*1000,mode?.expiresAt??Infinity),id=randomUUID();
  const facts=():InitiativeFacts=>{const s=context.session(),o=context.owner(),ready=this.readiness.get(k);return {sessionId:session.sessionId,endpointId:session.endpoint.endpointId,modality:event.modality,kind:event.kind,context:event.context,authorized:context.authorized()&&!!s&&s.revision===session.revision,identityQualified:true,privateAudience:s?.endpoint.privacyClass==='personal',consentCurrent:o?.consentCurrent===true,sourceQualified:hash(this.simulation!.resolve(scope,session.sessionId,event.sourceEventId)??null)===hash(event),sourceExpiresAt:expires,outputReady:event.modality==='text'&&!!s&&ready?.revision===s.revision&&ready.endpointId===s.endpoint.endpointId&&ready.text&&s.endpoint.outputModalities.includes('text'),leaseAvailable:this.foreground===0&&!this.closed,...(event.dwellSeconds===undefined?{}:{dwellSeconds:event.dwellSeconds}),...(event.absenceSeconds===undefined?{}:{absenceSeconds:event.absenceSeconds}),unfinishedEvidenceCurrent:event.unfinishedEvidenceCurrent===true&&event.topicRef!==null&&!!o?.evidenceRefs.includes(event.topicRef)};};
  const policy=()=>{const o=context.owner();return resolveInitiativePolicy({scope,...(o?.configuration?{configuration:o.configuration}:{}),profile:o?.profile,facts:facts(),...(this.mode(scope,session.sessionId)?{temporary:this.mode(scope,session.sessionId)!}:{}),now:Date.now()});};
  const selected=policy();
  const opportunity:InitiativeOpportunity={...scope,schemaVersion:'1.0.0',recordType:'opportunity',opportunityId:id,correlationId:randomUUID(),conversationId:session.conversationId,sessionId:session.sessionId,endpointId:session.endpoint.endpointId,configurationId:String(config.configurationId),configurationRevision:Number(config.revision),policyRevision:selected.revision,kind:event.kind,category:'social',urgency:'low',sourceKind:'simulatedBrowser',sourceRefs:[`synthetic-event:${event.sourceEventId}`,...(event.topicRef?[event.topicRef]:[])],executionMode:'simulation',observedAt:new Date(event.observedAt).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),dedupKey:hash([scope,session.sessionId,event.sourceEventId]),topicKey:event.topicRef??`social:${event.kind}`};
  let row:InitiativeDeliveryRecord;
  try{row=this.ledger.admit(scope,opportunity,()=>{if(!context.authorized()||context.owner()?.boundary!==owner.boundary)return false;this.saveRetry(scope,raw);return true;},{perRelationship:tuning.pendingPerRelationship!,perRuntime:tuning.pendingPerRuntime!});}
  catch(error){return extensionError(409,'initiative_admission_denied',error instanceof Error?error.message:'Opportunity was not admitted.');}
  if(!selected.allowed){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:selected.reasons});return this.response(owner,operation,[{code:'initiative_suppressed',summary:`Opening suppressed: ${selected.reasons.join(', ')}.`,sourceRefs:[]}]);}
  if(!context.provider){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:['endpointUnavailable']});return this.response(owner,operation);}
  const opening=this.ledger.openingRestriction(scope,{perHour:tuning.openingsPerHour!,perDay:tuning.openingsPerDay!,minimumGapMs:tuning.minimumGapSeconds!*1000}),usage=this.ledger.inferenceUsage(scope);
  const resourceReason=opening??(usage.active||usage.relationshipHour>=tuning.inferenceCallsPerRelationshipHour!||usage.runtimeHour>=tuning.inferenceCallsPerRuntimeHour!?'inferenceBudget':undefined);
  if(resourceReason){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:[resourceReason]});return this.response(owner,operation);}
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,context.signal]);
  let prepared:HostRuntimeInput|undefined,preparedViewId:string,preparedCurrent=()=>true;
  const current=()=>!signal.aborted&&context.authorized()&&context.owner()?.boundary===owner.boundary&&policy().allowed&&policy().revision===selected.revision&&preparedCurrent();
  const job:Job={scope,sessionId:session.sessionId,controller,current,reason:'cancelled'};this.jobs.set(id,job);
  const expiry=setTimeout(()=>{job.reason='expired';controller.abort();},Math.max(1,expires-Date.now()));
  try{
   if(!current())throw new Error('boundary changed');
   row=this.ledger.transition(scope,id,row.version,{type:'eligible'});prepared=context.prepare();preparedCurrent=prepared.isCurrent;prepared={...prepared,isCurrent:current};preparedViewId=randomUUID();
   const candidate=await this.generator.generateDurably(context.provider,{opportunity,prepared,interactionId:randomUUID(),dimensions:selected.dimensions,maximumOutputTokens:tuning.generationMaxTokens!,deadlineMs:tuning.generationDeadlineSeconds!*1000,conversation:'',voiceMode:false,signal},{ledger:this.ledger,expectedVersion:row.version,limits:{perRelationshipHour:tuning.inferenceCallsPerRelationshipHour!,perRuntimeHour:tuning.inferenceCallsPerRuntimeHour!},current});
   if(candidate.status==='noCandidate'){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:['noCandidate']});return this.response(owner,operation);}
   row=this.ledger.transition(scope,id,row.version,{type:'generated',preparedViewId,preparedDigest:candidate.request.sections.find(s=>s.kind==='preparedMemory')!.contentDigest,interactionId:candidate.request.scope.interactionId});
   row=this.ledger.transition(scope,id,row.version,{type:'queue',limits:{perHour:tuning.openingsPerHour!,perDay:tuning.openingsPerDay!,minimumGapMs:tuning.minimumGapSeconds!*1000},current});
   const receiptId=randomUUID();row=this.ledger.transition(scope,id,row.version,{type:'beginEmission',receiptId,current});
   const delivery={opportunityId:id,sessionId:session.sessionId,interactionId:candidate.request.scope.interactionId,modality:'text',text:candidate.text,expiresAt:opportunity.expiresAt,captureEnabled:false};
   // Write the payload prefix before recording emission. Endpoint acceptance still
   // requires its subsequent authenticated acknowledgment of the completed JSON.
   context.emit(`{"delivery":${JSON.stringify(delivery)},`,()=>{
    row=this.ledger.transition(scope,id,row.version,{type:'emitted',receiptId});
    const result=this.response(owner,operation,[{code:'synthetic_output',summary:'Synthetic text opening emitted. Endpoint acceptance and playback have not been observed.',sourceRefs:[receiptId]}]);delete result.body.delivery;
    return JSON.stringify(result.body).slice(1);
   });
   return undefined;
  }catch{
   const latest=this.ledger.get(scope,id)!;
   if(active.has(latest.outcome.state)){
    const restrictions=policy().reasons,state=signal.aborted?'cancelled':latest.outcome.state==='emitted'?'failed':restrictions.length?'suppressed':latest.outcome.state==='eligible'||latest.outcome.state==='queued'?'failed':'suppressed';
    this.ledger.transition(scope,id,latest.version,{type:'finish',state,reasons:signal.aborted?[job.reason]:restrictions.length?restrictions:[latest.outcome.state==='eligible'?'generationFailed':'outputFailed']});
   }
   if(!context.authorized())return extensionError(403,'initiative_scope_changed','Current session authorization no longer permits this operation.');
   return this.response(context.owner()??owner,operation,[{code:'initiative_stopped',summary:'The opening stopped before confirmed endpoint acceptance. Inspect its retained outcome; it will not retry.',sourceRefs:[]}]);
  }finally{clearTimeout(expiry);this.jobs.delete(id);}
 }
}
