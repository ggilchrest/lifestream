import {isCanonicalQualifiedPresenceGuard,canonicalQualifiedPresenceGuardValidation} from './qualified-presence-source.ts';
import {InitiativeTiming,waitForInitiativeTiming} from './initiative-timing.ts';
import {InitiativeMaintenance} from './initiative-maintenance.ts';
import {createHash,randomUUID} from 'node:crypto';
import {createContractValidator} from '@lifestream/contracts';
import {InitiativeExpressionRepository,type InitiativeExpression,InitiativeDeliveryRepository,type Database,type InitiativeScope,type InitiativeOpportunity,type InitiativeDeliveryRecord} from '@lifestream/storage-sqlite';
import type {InferenceProvider} from '@lifestream/runtime/inference';
import type {EndpointProfile} from '@lifestream/runtime/endpoints/registry';
import {resolveInitiativePolicy,type InitiativeFacts,type InitiativeTemporaryMode} from '../admin/initiative-policy.ts';
import {extensionError} from '../relationship-extensions.ts';
import {InitiativeCandidateGenerator} from './initiative.ts';
import {prepareHostMemory,type HostRuntimeInput} from './inference.ts';
import type {OutputOnlySpeech} from './audio.ts';

export type InitiativeOwner={scope:InitiativeScope;configuration?:Record<string,unknown>;profile?:Record<string,unknown>;boundary:string;consentCurrent:boolean;evidenceRefs:string[]};
export type InitiativeSession={sessionId:string;conversationId:string;revision:number;endpoint:EndpointProfile};
/** Only supplied by an explicitly enabled test host, never decoded from HTTP facts. */
export type InitiativeSimulationEvent={userId:string;sessionId:string;sourceEventId:string;kind:InitiativeOpportunity['kind'];topicRef:string|null;observedAt:number;expiresAt:number;context:InitiativeFacts['context'];modality:'text'|'speech';dwellSeconds?:number;absenceSeconds?:number;unfinishedEvidenceCurrent?:boolean};
export type InitiativeSimulation={list?:(scope:InitiativeScope,sessionId:string)=>readonly string[];resolve:(scope:InitiativeScope,sessionId:string,sourceEventId:string)=>InitiativeSimulationEvent|undefined};
/** Trusted configured host port, never HTTP/device/scene identity authority. */
export type QualifiedInitiativeEvent=InitiativeSimulationEvent&{scope:InitiativeScope;endpointId:string;sourceId:string;sourceRevision:number;evidenceRef:string;identityQualified:boolean;privateAudience:boolean};
export type QualifiedInitiativeSource={sourceId:string;resolve:(scope:InitiativeScope,sessionId:string,sourceEventId:string)=>QualifiedInitiativeEvent|undefined};
type Result={status:number;body:Record<string,unknown>};
type Speech={identity:object;available:()=>boolean;current:()=>boolean;speak:(input:OutputOnlySpeech)=>Promise<unknown>};
type Context={readonly audienceAdmissionCurrent?:()=>boolean;custodyCurrent?:()=>boolean;speech?:Speech;owner:()=>InitiativeOwner|undefined;session:()=>InitiativeSession|undefined;authorized:()=>boolean;prepare:()=>HostRuntimeInput;provider:InferenceProvider|undefined;signal:AbortSignal;emit:(prefix:string,suffix:()=>string,custody?:()=>boolean)=>void};
type Job={speech?:{synthesized:boolean;complete:()=>void};scope:InitiativeScope;sessionId:string;controller:AbortController;current:()=>boolean;reason:string};
const validator=createContractValidator(),api='https://lifestream.dev/contracts/initiative-api/1.0.0';
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`:JSON.stringify(value);
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const key=(scope:InitiativeScope,sessionId:string)=>hash([scope,sessionId]);
const active=new Set(['pending','eligible','generated','queued','emitted']);

/** Session-scoped orchestration. Candidate payloads only live on the in-flight call;
 * inspection and idempotent retries return metadata, never replayable output. */
export class InitiativeHost {
 readonly ledger:InitiativeDeliveryRepository;private readonly expressions:InitiativeExpressionRepository;
 private readonly timing:InitiativeTiming;private readonly generator:InitiativeCandidateGenerator;private readonly now:()=>number;private readonly maintenance:InitiativeMaintenance;
 private readonly readiness=new Map<string,{revision:number;endpointId:string;text:boolean;speech:boolean;transport?:object}>();
 private readonly modes=new Map<string,InitiativeTemporaryMode>();
 private readonly jobs=new Map<string,Job>();
 private foreground=0;
 private closed=false;
 private readonly database:Database;
 private readonly simulation:InitiativeSimulation|undefined;
 private readonly qualifiedSource:QualifiedInitiativeSource|undefined;
 constructor(database:Database,simulation?:InitiativeSimulation,now:()=>number=()=>Date.now(),qualifiedSource?:QualifiedInitiativeSource){if(simulation&&qualifiedSource)throw new Error('Synthetic and qualified Initiative sources require separate hosts');if(qualifiedSource&&(typeof qualifiedSource.sourceId!=='string'||!qualifiedSource.sourceId||qualifiedSource.sourceId.length>80))throw new Error('Invalid configured Initiative source');this.qualifiedSource=qualifiedSource;this.now=now;this.timing=new InitiativeTiming(now);this.generator=new InitiativeCandidateGenerator(now);this.database=database;this.expressions=new InitiativeExpressionRepository(database,now);this.simulation=simulation;this.ledger=new InitiativeDeliveryRepository(database,now);this.ledger.recover();this.maintenance=new InitiativeMaintenance(()=>{this.timing.prune();return this.ledger.prune();});}
 runtimeExplanations(owner?:InitiativeOwner,sessionId?:string){
  const explanations=[{code:this.simulation?'synthetic_ingress_enabled':'synthetic_ingress_disabled',summary:this.simulation?'This test host accepts only its prepared synthetic occurrences for the bound subject and session.':'Synthetic ingress is disabled on this host.',sourceRefs:[] as string[]}];
  explanations.push({code:'initiative_retention',summary:this.maintenance.state()==='degraded'?'Automatic metadata cleanup is temporarily unavailable. Records and replay protections are retained; cleanup will retry.':'Automatic metadata cleanup is scheduled after the 24-hour eligibility horizon, in bounded batches. Active work, pending playback and replay fences remain protected.',sourceRefs:[]});
  if(owner&&sessionId){const plan=this.timing.peek(key(owner.scope,sessionId),owner.boundary,owner.configuration?.adaptation);if(plan)explanations.push({code:'initiative_timing_feedback',summary:`Your explicit dismissal may defer the next eligible fresh opportunity by ${plan.delayMs/1000} seconds under the selected adaptation setting. This hint is used once; an ordinary reply or clearing temporary mode removes it. It changes no preference, budget or channel.`,sourceRefs:[plan.sourceRef]});}
  if(!this.simulation?.list||!owner||!sessionId)return explanations;
  explanations.push({code:'synthetic_catalog_enabled',summary:'Choose a host-prepared synthetic case. Listing neither enables output nor creates or replays an event. Refresh after the host prepares new cases.',sourceRefs:[]});
  const catalogStart=explanations.length;
  try{
   const ids=this.simulation.list(owner.scope,sessionId),now=this.now(),seen=new Set<string>(),used=new Set(this.ledger.list(owner.scope).filter(r=>r.opportunity.sessionId===sessionId).flatMap(r=>r.opportunity.sourceRefs));
   let count=0;
   for(const id of ids.slice(0,64)){
    if(count>=16)break;
    if(typeof id!=='string'||!id||id.length>200||seen.has(id)||used.has(`synthetic-event:${id}`))continue;seen.add(id);
    const event=this.simulation.resolve(owner.scope,sessionId,id);
    if(!event||event.userId!==owner.scope.userId||event.sessionId!==sessionId||event.sourceEventId!==id||!['arrivalReturn','availableCheckIn','groundedFollowUp'].includes(event.kind)||!['text','speech'].includes(event.modality)||!Number.isFinite(event.observedAt)||!Number.isFinite(event.expiresAt)||event.observedAt>now||event.expiresAt<=now||event.expiresAt>8640000000000000||event.topicRef!==null&&(typeof event.topicRef!=='string'||!event.topicRef||event.topicRef.length>200||event.topicRef===id))continue;
    const label={arrivalReturn:'Arrival or return',availableCheckIn:'Available check-in',groundedFollowUp:'Grounded follow-up'}[event.kind];
    explanations.push({code:`synthetic_occurrence_${event.kind}_${event.modality}`,summary:`${label} · ${event.modality==='speech'?'Speech and transcript':'Text'} · expires ${new Date(event.expiresAt).toISOString()}`,sourceRefs:[id,...(event.topicRef?[event.topicRef]:[])]});count++;
   }
   if(!count)explanations.push({code:'synthetic_catalog_empty',summary:'No current prepared cases are available for this subject and session. Ask the test host operator to prepare a case, then refresh. No output was requested.',sourceRefs:[]});
  }catch{explanations.splice(catalogStart);explanations.push({code:'synthetic_catalog_unavailable',summary:'The test host could not list prepared cases. Refresh to retry inspection; no output was requested.',sourceRefs:[]});}
  return explanations;
 }

 private expressionExplanation(scope:InitiativeScope,id:string){
  const observed=this.expressions.get(scope,id);if(!observed)return {code:'initiative_expression',summary:'Observation: No expression metadata was recorded for this historical opportunity.',sourceRefs:[id]};
  const r=observed.report,labels=[`Requested wording warmth: ${Math.round(r.requestedWarmth*100)}% (a setting, not a measured response)`,`Wording output: ${r.wording==='emitted'?'Text emitted; style quality unverified':'No text emission observed'}`,`Speech stage: ${r.speechStage}`,`Prosodic warmth: ${r.modality==='speech'?'Unsupported by the current speech mapping':'Not requested for text output'}`,`Renderer cues: Unsupported; no renderer mapping configured`,`Provider disposition: ${r.disposition} (provider report, not audible verification)`,`Applied controls: ${Object.entries(r.appliedDelivery).map(([k,v])=>`${k} = ${v}`).join(', ')||'Not observed'}`,`Degraded dimensions: ${r.degradedDimensions.join(', ')||'None reported; absence is not proof of support'}`,`Mapping: ${r.mappingRevision??'Not observed'}`,`Observed: ${observed.observedAt}`];
  const plan=this.ledger.get(scope,id)?.opportunity.sourceRefs.find(ref=>ref.startsWith('timing-plan:'));if(plan)labels.push(`Timing: one-use deferral plan of ${plan.split(':').at(-1)} seconds after explicit dismissal; current stage records whether the opportunity stopped or emitted.`);
  return {code:'initiative_expression',summary:labels.join('\n'),sourceRefs:[id,`initiative-expression:${id}:${observed.revision}`]};
 }
 private snapshot(owner:InitiativeOwner,baseRecords:unknown[],explanations:Array<{code:string;summary:string;sourceRefs:string[]}>){
  const notes=explanations.slice(0,64),items=this.ledger.list(owner.scope).slice(0,Math.min(63,64-notes.length));
  const room=128-items.length*2,configs=[...(owner.configuration?[owner.configuration]:[]),...baseRecords.filter(r=>(r as Record<string,unknown>).configurationId!==owner.configuration?.configurationId)].slice(0,room);
  return {records:[...configs,...items.flatMap(r=>[r.opportunity,r.outcome])],explanations:[...notes,...items.map(r=>this.expressionExplanation(owner.scope,r.opportunity.opportunityId))]};
 }
 augmentInspection(owner:InitiativeOwner,sessionId:string,body:Record<string,unknown>):void{
  Object.assign(body,this.snapshot(owner,body.records as unknown[],[...body.explanations as Array<{code:string;summary:string;sourceRefs:string[]}>,...this.runtimeExplanations(owner,sessionId)]));
 }
 records(scope:InitiativeScope):unknown[]{return this.ledger.list(scope).slice(0,63).flatMap(r=>[r.opportunity,r.outcome]);}
 private response(owner:InitiativeOwner,operation:string,explanations:Array<{code:string;summary:string;sourceRefs:string[]}>=[],changed=false):Result {
  return {status:200,body:{schemaVersion:'1.0.0',relationshipId:owner.scope.relationshipId,operation,activeConfigurationId:owner.configuration?.configurationId??null,...this.snapshot(owner,[],[{code:'bounded_runtime_history',summary:'Current configuration and recent opportunities within the response metadata limit. Expression observations, emission, endpoint acceptance and playback are separate. No microphone capture is started.',sourceRefs:[]},...explanations]),activeStateChanged:changed,executionMode:this.simulation?'simulation':'live',nextCursor:null,delivery:null}};
 }
 expressionWarmth(owner:InitiativeOwner|undefined,sessionId:string,endpointId:string):number|undefined {
  if(!owner?.configuration)return undefined;
  const temporary=this.mode(owner.scope,sessionId),now=this.now();
  return resolveInitiativePolicy({scope:owner.scope,configuration:owner.configuration,profile:owner.profile,...(temporary?{temporary}:{}),now,facts:{sessionId,endpointId,modality:'text',kind:'availableCheckIn',context:'unknown',authorized:true,identityQualified:false,privateAudience:false,consentCurrent:owner.consentCurrent,sourceQualified:false,sourceExpiresAt:now,outputReady:false,leaseAvailable:false}}).expressionWarmth;
 }
 private mode(scope:InitiativeScope,sessionId:string):InitiativeTemporaryMode|undefined {
  const k=key(scope,sessionId),mode=this.modes.get(k);if(mode?.expiresAt!==null&&mode&&mode.expiresAt<=this.now()){this.modes.delete(k);return undefined;}return mode;
 }
 invalidate(reason='configurationChanged'):void {
  for(const job of this.jobs.values())if(this.closed||this.foreground>0||!job.current()){job.reason=this.foreground>0?'userTurn':reason;job.controller.abort();}
 }
 quietForSession(sessionId:string):boolean{return [...this.modes.values()].some(mode=>mode.sessionId===sessionId&&mode.kind==='quiet'&&(mode.expiresAt===null||mode.expiresAt>this.now()));}
 interruptSession(sessionId:string,reason='cancelled'):void{for(const job of this.jobs.values())if(job.sessionId===sessionId){job.reason=reason;job.controller.abort();}}
 busy(sessionId:string):boolean{return [...this.jobs.values()].some(job=>job.sessionId===sessionId);}
 foregroundStarted(engagement?:{scope:InitiativeScope;sessionId:string}):()=>void {
  this.foreground++;this.invalidate('userTurn');
  if(engagement){const {scope,sessionId}=engagement;this.timing.clear(key(scope,sessionId));this.ledger.resetSessionTopics(scope,sessionId);const prior=this.ledger.list(scope).find(r=>r.opportunity.sessionId===sessionId&&['emitted','acknowledged'].includes(r.outcome.lastDeliveryStage)&&['notObserved','noResponse'].includes(r.outcome.response));if(prior)this.ledger.transition(scope,prior.opportunity.opportunityId,prior.version,{type:'respond',sessionId,response:'replied'});}
  let released=false;return ()=>{if(!released){released=true;this.foreground--;}};
 }
 close():void{this.closed=true;this.maintenance.close();this.invalidate('cancelled');this.readiness.clear();this.modes.clear();this.timing.clear();}
 /** SELECT-only lookup in the existing runtime idempotency owner. A marker is
  * NOT a historical success receipt: saveRetry precedes the synchronous mode
  * update. The separate fresh current-mode snapshot is the only state claim.
  * Missing/legacy/unverifiable markers never admit retry or reconstruct output.
  */
 inspectAttentionReceipt(raw:Record<string,unknown>,context:Pick<Context,'owner'|'session'|'authorized'>):Result {
  const schema='https://lifestream.dev/contracts/initiative-attention-receipt/1.0.0';
  if(!validator.validate(schema+'#/$defs/Request',raw).valid)return extensionError(422,'invalid_attention_receipt_request','Unsupported attention receipt fields.');
  const owner=context.owner(),session=context.session();
  if(this.closed||!context.authorized()||!owner||!session||raw.sessionId!==session.sessionId||raw.endpointId!==session.endpoint.endpointId||raw.endpointRevision!==session.endpoint.configurationRevision||raw.sessionRevision!==session.revision)return extensionError(409,'initiative_session_scope','Use the original current session and endpoint revision.');
  const original={schemaVersion:'1.0.0',operation:'temporaryMode',idempotencyKey:raw.idempotencyKey,sessionId:raw.sessionId,mode:raw.mode,endsAt:null,dimensions:null};
  const row=this.database.connection.prepare('SELECT operation,response_json AS response FROM assistant_relationship_idempotency WHERE idempotency_key=? AND relationship_id=?').get(String(raw.idempotencyKey),owner.scope.relationshipId) as {operation:string;response:string}|undefined;
  let state='unknown';
  if(row){state='unavailable';try{const marker=JSON.parse(row.response);const expected={schemaVersion:'1.0.0',sessionId:raw.sessionId,endpointId:raw.endpointId,endpointRevision:raw.endpointRevision,sessionRevision:raw.sessionRevision};if(row.operation===`initiative-runtime:${hash([owner.scope,original])}`&&marker&&Object.keys(marker).sort().join(',')==='attentionScope,runtimeMetadataOnly'&&marker.runtimeMetadataOnly===true&&canonical(marker.attentionScope)===canonical(expected))state='recorded';}catch{/* Never infer an unverifiable historical result. */}}
  const temporary=this.modes.get(key(owner.scope,session.sessionId)),current=temporary&&(temporary.expiresAt===null||temporary.expiresAt>this.now())?temporary:undefined;
  const latest=context.owner(),lastSession=context.session();
  if(!context.authorized()||!latest||hash(latest.scope)!==hash(owner.scope)||latest.boundary!==owner.boundary||!lastSession||lastSession.sessionId!==session.sessionId||lastSession.revision!==session.revision||lastSession.endpoint.endpointId!==session.endpoint.endpointId||lastSession.endpoint.configurationRevision!==session.endpoint.configurationRevision)return extensionError(409,'current_scope_required','Attention owner changed.');
  const body={schemaVersion:'1.0.0',relationshipId:owner.scope.relationshipId,sessionId:session.sessionId,endpointId:session.endpoint.endpointId,endpointRevision:session.endpoint.configurationRevision,sessionRevision:session.revision,idempotencyKey:raw.idempotencyKey,mode:raw.mode,state,currentMode:current?.kind??'clear',endsAt:current?.expiresAt===null||current?.expiresAt===undefined?null:new Date(current.expiresAt).toISOString(),mutationDispatched:false};
  if(!validator.validate(schema+'#/$defs/Response',body).valid)return extensionError(409,'attention_receipt_unavailable','Attention snapshot is unavailable.');
  return {status:200,body};
 }
 private retry(scope:InitiativeScope,request:Record<string,unknown>):'new'|'same'|'conflict'{
  const row=this.database.connection.prepare('SELECT relationship_id,operation FROM assistant_relationship_idempotency WHERE idempotency_key=?').get(String(request.idempotencyKey)) as {relationship_id:string;operation:string}|undefined;
  return !row?'new':row.relationship_id===scope.relationshipId&&row.operation===`initiative-runtime:${hash([scope,request])}`?'same':'conflict';
 }
 private saveRetry(scope:InitiativeScope,request:Record<string,unknown>,session?:InitiativeSession):void {
  this.database.connection.prepare('INSERT INTO assistant_relationship_idempotency (idempotency_key,relationship_id,operation,response_json) VALUES (?,?,?,?)').run(String(request.idempotencyKey),scope.relationshipId,`initiative-runtime:${hash([scope,request])}`,JSON.stringify({runtimeMetadataOnly:true,...(session&&request.operation==='temporaryMode'&&['quiet','clear'].includes(String(request.mode))?{attentionScope:{schemaVersion:'1.0.0',sessionId:session.sessionId,endpointId:session.endpoint.endpointId,endpointRevision:session.endpoint.configurationRevision,sessionRevision:session.revision}}:{})}));
 }
 async handle(raw:Record<string,unknown>,context:Context):Promise<Result|undefined>{
  if(!validator.validate(`${api}#/$defs/Request`,raw).valid)return extensionError(422,'invalid_extension_request','Unsupported version, operation or fields.');
  const owner=context.owner(),session=context.session(),operation=String(raw.operation);
  if(this.closed||!context.authorized()||!owner||!session||raw.sessionId!==session.sessionId)return extensionError(409,'initiative_session_scope','Use the current authenticated session and bind its audience in Conversation first.');
  const scope=owner.scope,k=key(scope,session.sessionId),now=this.now();
  this.ledger.expirePending();this.invalidate();
  if(raw.idempotencyKey){const retry=this.retry(scope,raw);if(retry==='conflict')return extensionError(409,'idempotency_conflict','This retry key identifies a different request.');if(retry==='same')return this.response(owner,operation,[{code:'already_processed',summary:'This request was already processed. Current metadata is shown; output and temporary modes are never replayed.',sourceRefs:[]}]);}
  if(operation==='outputReadiness'){
   if(this.readiness.size>=256&&!this.readiness.has(k))return extensionError(409,'initiative_capacity','Session readiness capacity is full.');
   if(raw.modality==='speech'&&raw.ready===true&&(!context.speech?.available()||!session.endpoint.outputModalities.includes('audio')))return extensionError(409,'speech_transport_unavailable','Connect one idle output transport for this session before enabling speech readiness. This does not start the microphone.');
   const old=this.readiness.get(k),entry=old?.revision===session.revision?old:{revision:session.revision,endpointId:session.endpoint.endpointId,text:false,speech:false};
   if(raw.modality==='speech'){if(raw.ready===true&&context.speech)entry.transport=context.speech.identity;else delete entry.transport;}
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
   this.saveRetry(scope,raw,session);if(mode==='quiet'||mode==='clear')this.timing.clear(k);
   if(mode==='clear')this.modes.delete(k);else this.modes.set(k,{kind:mode as 'quiet'|'companionship',sessionId:session.sessionId,configurationId:String(owner.configuration?.configurationId??''),createdAt:now,expiresAt:expiry,...(raw.dimensions?{dimensions:raw.dimensions as NonNullable<InitiativeTemporaryMode['dimensions']>}: {})});
   this.invalidate(mode==='quiet'?'quiet':'configurationChanged');return this.response(owner,operation,[{code:'temporary_mode',summary:mode==='clear'?'Temporary mode cleared. Old opportunities will not resume.':`${mode==='quiet'?'Quiet':'Companionship'} applies only to this session ${expiry===null?'until cleared':`until ${new Date(expiry).toISOString()}`}. It ends on restart. Durable settings are unchanged.`,sourceRefs:[]}],true);
  }
  if(['acknowledge','dismiss','cancel'].includes(operation)){
   const r=this.ledger.get(scope,String(raw.opportunityId));if(!r||r.opportunity.sessionId!==session.sessionId)return extensionError(404,'initiative_not_found','No opportunity in this session.');
   const job=this.jobs.get(r.opportunity.opportunityId);
   if(operation==='acknowledge'&&job?.speech&&!job.current())return extensionError(409,'playback_scope_changed','The original speech output session is no longer current.');
   if(operation==='acknowledge'&&raw.kind==='playbackCompleted'&&!(job?.speech?.synthesized||r.outcome.state==='acknowledged'&&r.outcome.acknowledgmentKind==='playbackCompleted'))return extensionError(409,'playback_not_available','Playback acknowledgment requires successful synthesis on this original speech delivery.');
   try{
    if(operation==='acknowledge'){this.ledger.transition(scope,r.opportunity.opportunityId,r.version,{type:'acknowledge',sessionId:session.sessionId,receiptId:String(raw.receiptId),kind:raw.kind as 'endpointAccepted'|'playbackCompleted'});if(raw.kind==='playbackCompleted')job?.speech?.complete();}
    else {
     if(operation==='dismiss')this.ledger.transition(scope,r.opportunity.opportunityId,r.version,{type:'respond',sessionId:session.sessionId,response:'dismissed'},()=>this.saveRetry(scope,raw));
     else if(active.has(r.outcome.state)||job?.speech&&r.outcome.state==='acknowledged'&&r.outcome.acknowledgmentKind==='endpointAccepted')this.ledger.transition(scope,r.opportunity.opportunityId,r.version,{type:'finish',state:'cancelled',reasons:['cancelled']},()=>this.saveRetry(scope,raw));
     else return extensionError(409,'initiative_terminal','The opportunity is already terminal.');
     if(operation==='dismiss'&&(owner.configuration?.adaptation as {enabled?:boolean}|undefined)?.enabled===true)this.timing.note(k,owner.boundary,r.opportunity.opportunityId);
     if(job){job.reason='cancelled';job.controller.abort();}
    }
    return this.response(owner,operation);
   }catch{return extensionError(409,'initiative_stage_conflict','The session, receipt or observed delivery stage does not permit this operation.');}
  }
  if(operation!=='simulate')return extensionError(409,'operation_unavailable','This runtime operation is not yet available.');
  if(!this.simulation)return extensionError(409,'simulation_not_enabled','Synthetic Initiative ingress must be enabled and bound by the test host.');
  const resolved=this.simulation.resolve(scope,session.sessionId,String(raw.sourceEventId)),event=resolved?structuredClone(resolved):undefined;
  if(!event||event.userId!==scope.userId||event.sessionId!==session.sessionId||event.sourceEventId!==raw.sourceEventId||event.kind!==raw.kind||event.topicRef!==raw.topicRef||!Number.isFinite(event.observedAt)||!Number.isFinite(event.expiresAt)||event.observedAt>now||event.expiresAt<=now)return extensionError(409,'synthetic_source_unavailable','The test host has no matching current synthetic source for this subject and session.');
  return this.deliver(event,context,owner,session,operation,()=>{try{return hash(this.simulation!.resolve(scope,session.sessionId,event.sourceEventId)??null)===hash(event);}catch{return false;}},'simulatedBrowser','simulation',[`synthetic-event:${event.sourceEventId}`],raw);
 }
 /** Host-only ingress with current qualified evidence; there is no HTTP operation. */
 async receiveQualified(sourceEventId:string,context:Context):Promise<Result|undefined>{
  const owner=context.owner(),session=context.session(),source=this.qualifiedSource,now=this.now();
  if(this.closed||context.signal.aborted||!context.authorized()||!owner||!session)return extensionError(409,'initiative_session_scope','No current authorized Initiative session.');
  if(!source||typeof sourceEventId!=='string'||!sourceEventId||sourceEventId.length>200)return extensionError(409,'qualified_source_unavailable','No configured qualified occurrence.');
  const resolve=()=>{try{return source.resolve(owner.scope,session.sessionId,sourceEventId);}catch{return undefined;}};
  let event:QualifiedInitiativeEvent;
  try{const value=resolve();if(!value)return extensionError(409,'qualified_source_unavailable','No current qualified occurrence.');event=structuredClone(value);}catch{return extensionError(409,'qualified_source_unavailable','Source evidence is unavailable.');}
  const valid=Number.isFinite(now)&&event.sourceId===source.sourceId&&Number.isSafeInteger(event.sourceRevision)&&event.sourceRevision>0&&typeof event.evidenceRef==='string'&&event.evidenceRef.length>0&&event.evidenceRef.length<=80&&!!event.scope&&hash(event.scope)===hash(owner.scope)&&event.userId===owner.scope.userId&&event.sessionId===session.sessionId&&event.endpointId===session.endpoint.endpointId&&event.sourceEventId===sourceEventId&&['arrivalReturn','availableCheckIn','groundedFollowUp'].includes(event.kind)&&['text','speech'].includes(event.modality)&&['privateAvailable','shared','focused','quiet','unavailable','unknown'].includes(event.context)&&typeof event.identityQualified==='boolean'&&typeof event.privateAudience==='boolean'&&Number.isFinite(event.observedAt)&&event.observedAt<=now&&Number.isFinite(event.expiresAt)&&event.expiresAt>now&&event.expiresAt<=8640000000000000&&(event.topicRef===null||typeof event.topicRef==='string'&&event.topicRef.length>0&&event.topicRef.length<=200)&&[event.dwellSeconds,event.absenceSeconds].every(n=>n===undefined||Number.isFinite(n)&&n>=0);
  if(!valid)return extensionError(409,'qualified_source_unavailable','Source evidence does not match current subject, session and endpoint.');
  const original=hash(event),current=()=>{try{const value=resolve(),s=context.session(),o=context.owner();return source.sourceId===event.sourceId&&!!s&&s.sessionId===session.sessionId&&s.revision===session.revision&&s.endpoint.endpointId===event.endpointId&&!!o&&hash(o.scope)===hash(owner.scope)&&!!value&&hash(value)===original;}catch{return false;}};
  this.ledger.expirePending();this.invalidate();
  return this.deliver(event,context,owner,session,'inspect',current,'qualifiedProvider','normal',[`qualified-provider:${event.sourceId}:${event.sourceRevision}:${event.evidenceRef}`]);
 }
 private async deliver(event:InitiativeSimulationEvent|QualifiedInitiativeEvent,context:Context,owner:InitiativeOwner,session:InitiativeSession,operation:string,sourceCurrent:()=>boolean,sourceKind:InitiativeOpportunity['sourceKind'],executionMode:InitiativeOpportunity['executionMode'],sourceRefs:string[],raw?:Record<string,unknown>):Promise<Result|undefined>{
  const scope=owner.scope,k=key(scope,session.sessionId),now=this.now();
  if(!owner.configuration)return extensionError(409,'initiative_not_configured','Review and activate Initiative settings first.');
  const config=owner.configuration,tuning=config.tuning as Record<string,number>,mode=this.mode(scope,session.sessionId),ttl=event.kind==='arrivalReturn'?tuning.arrivalTtlSeconds:event.kind==='availableCheckIn'?tuning.checkInTtlSeconds:tuning.followUpTtlSeconds;
  const expires=Math.min(event.expiresAt,event.observedAt+ttl!*1000,mode?.expiresAt??Infinity),id=randomUUID();
  let speechActive=false;
  const facts=():InitiativeFacts=>{const s=context.session(),o=context.owner(),ready=this.readiness.get(k);return {sessionId:session.sessionId,endpointId:session.endpoint.endpointId,modality:event.modality,kind:event.kind,context:event.context,authorized:context.authorized()&&!!s&&s.revision===session.revision,identityQualified:sourceKind==='qualifiedProvider'?(event as QualifiedInitiativeEvent).identityQualified:true,privateAudience:s?.endpoint.privacyClass==='personal'&&(sourceKind!=='qualifiedProvider'||(event as QualifiedInitiativeEvent).privateAudience===true),consentCurrent:o?.consentCurrent===true,sourceQualified:sourceCurrent(),sourceExpiresAt:expires,outputReady:!!s&&ready?.revision===s.revision&&ready.endpointId===s.endpoint.endpointId&&(event.modality==='text'?ready.text&&s.endpoint.outputModalities.includes('text'):ready.speech&&s.endpoint.outputModalities.includes('audio')&&ready.transport===context.speech?.identity&&!!context.speech?.current()&&(speechActive||context.speech.available())),leaseAvailable:this.foreground===0&&!this.closed,...(event.dwellSeconds===undefined?{}:{dwellSeconds:event.dwellSeconds}),...(event.absenceSeconds===undefined?{}:{absenceSeconds:event.absenceSeconds}),unfinishedEvidenceCurrent:event.unfinishedEvidenceCurrent===true&&event.topicRef!==null&&!!o?.evidenceRefs.includes(event.topicRef)};};
  const policy=()=>{const o=context.owner();return resolveInitiativePolicy({scope,...(o?.configuration?{configuration:o.configuration}:{}),profile:o?.profile,facts:facts(),...(this.mode(scope,session.sessionId)?{temporary:this.mode(scope,session.sessionId)!}:{}),now:this.now()});};
  const selected=policy(),timingPlan=selected.allowed?this.timing.peek(k,owner.boundary,config.adaptation):undefined;
  const opportunity:InitiativeOpportunity={...scope,schemaVersion:'1.0.0',recordType:'opportunity',opportunityId:id,correlationId:randomUUID(),conversationId:session.conversationId,sessionId:session.sessionId,endpointId:session.endpoint.endpointId,configurationId:String(config.configurationId),configurationRevision:Number(config.revision),policyRevision:selected.revision,kind:event.kind,category:'social',urgency:'low',sourceKind,sourceRefs:[...sourceRefs,...(event.topicRef?[event.topicRef]:[]),...(timingPlan?[timingPlan.sourceRef]:[])],executionMode,observedAt:new Date(event.observedAt).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),dedupKey:hash([scope,session.sessionId,event.sourceEventId]),topicKey:event.topicRef??`social:${event.kind}`};
  let row:InitiativeDeliveryRecord;
  try{row=this.ledger.admit(scope,opportunity,()=>{if(!context.authorized()||context.owner()?.boundary!==owner.boundary)return false;if(raw)this.saveRetry(scope,raw);return context.custodyCurrent?.()??true;},{perRelationship:tuning.pendingPerRelationship!,perRuntime:tuning.pendingPerRuntime!});}
  catch(error){return extensionError(409,'initiative_admission_denied',error instanceof Error?error.message:'Opportunity was not admitted.');}
  let expression:InitiativeExpression={requestedWarmth:selected.expressionWarmth,modality:event.modality,wording:'requested',speechStage:event.modality==='speech'?'notObserved':'notRequested',mappingRevision:null,disposition:'notObserved',degradedDimensions:[],appliedDelivery:{}};
  const expressionCurrent=()=>context.authorized()&&context.owner()?.boundary===owner.boundary&&(context.custodyCurrent?.()??true);
  this.expressions.note(scope,id,expression,expressionCurrent);
  if(!selected.allowed){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:selected.reasons});return this.response(owner,operation,[{code:'initiative_suppressed',summary:`Opening suppressed: ${selected.reasons.join(', ')}.`,sourceRefs:[]}]);}
  if(!context.provider){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:['endpointUnavailable']});return this.response(owner,operation);}
  const resourceRestriction=()=>{const opening=this.ledger.openingRestriction(scope,{perHour:tuning.openingsPerHour!,perDay:tuning.openingsPerDay!,minimumGapMs:tuning.minimumGapSeconds!*1000}),usage=this.ledger.inferenceUsage(scope);return opening??(usage.active||usage.relationshipHour>=tuning.inferenceCallsPerRelationshipHour!||usage.runtimeHour>=tuning.inferenceCallsPerRuntimeHour!?'inferenceBudget':undefined);};
  const resourceReason=resourceRestriction();
  if(resourceReason){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:[resourceReason]});return this.response(owner,operation);}
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,context.signal]);
  let prepared:HostRuntimeInput|undefined,preparedViewId:string,preparedCurrent=()=>true;
  let canonicalGuard:(()=>boolean)|undefined,canonicalValidation:(()=>boolean)|undefined;
  try{const descriptor=Object.getOwnPropertyDescriptor(context,'custodyCurrent');if(descriptor&&Object.hasOwn(descriptor,'value')&&descriptor.writable===false&&descriptor.configurable===false&&isCanonicalQualifiedPresenceGuard(descriptor.value,this.qualifiedSource,event.sourceEventId)){canonicalValidation=canonicalQualifiedPresenceGuardValidation(descriptor.value,this.qualifiedSource,event.sourceEventId)??undefined;if(canonicalValidation)canonicalGuard=descriptor.value;}}catch{/* Legacy metadata faults use the original path. */}
  const canonicalOrigin=!!canonicalGuard;
  const audienceAdmitted=()=>context.audienceAdmissionCurrent?.()??true;
  // Capture the original pure accepted-revision predicate; later owner callbacks cannot replace it.
  const terminalAudienceAdmission=context.audienceAdmissionCurrent;
  const current=()=>{
   if(!canonicalOrigin)return !signal.aborted&&context.authorized()&&context.owner()?.boundary===owner.boundary&&policy().allowed&&policy().revision===selected.revision&&preparedCurrent()&&(context.custodyCurrent?.()??true)&&audienceAdmitted();
   // This result belongs only to this current() invocation. Preserve denial and
   // prepared-callback order; final custody is the original source entry ticket.
   if(signal.aborted||!context.authorized()||context.owner()?.boundary!==owner.boundary||!canonicalGuard!())return false;
   const fresh=policy();
   return fresh.allowed&&fresh.revision===selected.revision&&preparedCurrent()&&canonicalValidation!()&&audienceAdmitted()&&!signal.aborted&&canonicalGuard!();
  };
  const job:Job={scope,sessionId:session.sessionId,controller,current,reason:'cancelled'};this.jobs.set(id,job);
  const expiry=setTimeout(()=>{job.reason=job.speech?'ackTimeout':'expired';controller.abort();},Math.max(1,expires-this.now()));
  try{
   if(!current())throw new Error('boundary changed');
   const deferral=this.timing.take(k,owner.boundary,config.adaptation);
   if(deferral){
    if(this.now()+deferral.delayMs>=expires){this.ledger.transition(scope,id,row.version,{type:'finish',state:'expired',reasons:['expired']});return this.response(owner,operation,[{code:'initiative_timing_expired',summary:'The fresh opportunity would expire during its configured timing delay, so it was discarded without generation.',sourceRefs:[deferral.sourceRef]}]);}
    await waitForInitiativeTiming(deferral.delayMs,signal);if(!current())throw new Error('boundary changed');
    const restriction=resourceRestriction();if(restriction){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:[restriction]});return this.response(owner,operation);}
   }
   row=this.ledger.transition(scope,id,row.version,{type:'eligible'});prepared=context.prepare();preparedCurrent=prepared.isCurrent;
   // Preparation can replace the context and install a source-currentness lease.
   // Await it on the original owner before copying either into this opportunity.
   await prepareHostMemory(prepared,signal);preparedCurrent=prepared.isCurrent;
   if(!current())throw new Error('boundary changed');
   prepared={...prepared,isCurrent:current};preparedViewId=randomUUID();
   const candidate=await this.generator.generateDurably(context.provider,{opportunity,prepared,interactionId:randomUUID(),dimensions:selected.dimensions,maximumOutputTokens:tuning.generationMaxTokens!,deadlineMs:tuning.generationDeadlineSeconds!*1000,conversation:prepared.conversation?.read()??'',voiceMode:event.modality==='speech',signal},{ledger:this.ledger,expectedVersion:row.version,limits:{perRelationshipHour:tuning.inferenceCallsPerRelationshipHour!,perRuntimeHour:tuning.inferenceCallsPerRuntimeHour!},current});
   if(candidate.status==='noCandidate'){this.ledger.transition(scope,id,row.version,{type:'finish',state:'suppressed',reasons:['noCandidate']});return this.response(owner,operation);}
   row=this.ledger.transition(scope,id,row.version,{type:'generated',preparedViewId,preparedDigest:candidate.request.sections.find(s=>s.kind==='preparedMemory')!.contentDigest,interactionId:candidate.request.scope.interactionId});
   row=this.ledger.transition(scope,id,row.version,{type:'queue',limits:{perHour:tuning.openingsPerHour!,perDay:tuning.openingsPerDay!,minimumGapMs:tuning.minimumGapSeconds!*1000},current});
   const receiptId=randomUUID();
   const delivery={opportunityId:id,sessionId:session.sessionId,interactionId:candidate.request.scope.interactionId,modality:event.modality,text:candidate.text,expiresAt:opportunity.expiresAt,captureEnabled:false};
   const issued=()=>{
    row=this.ledger.transition(scope,id,row.version,{type:'emitted',receiptId});expression={...expression,wording:'emitted'};this.expressions.note(scope,id,expression,current);prepared!.conversation?.remember({interactionId:candidate.request.scope.interactionId,role:'assistant',text:candidate.text,opportunityId:id,observation:'emitted'});
    const result=this.response(owner,operation,[{code:executionMode==='simulation'?'synthetic_output':'qualified_output',summary:`${executionMode==='simulation'?'Synthetic':'Qualified-source'} ${event.modality} opening emitted. Endpoint acceptance and playback are separate. ${event.modality==='speech'?'Prosodic warmth is unsupported by the current speech mapping.':''}`,sourceRefs:[receiptId]}]);delete result.body.delivery;
    return JSON.stringify(result.body).slice(1);
   };
   if(event.modality==='speech'){
    if(!context.speech?.available())throw new Error('Speech transport unavailable');
    speechActive=true;
    let complete:()=>void=()=>{};const played=new Promise<void>(resolve=>{complete=resolve;});job.speech={synthesized:false,complete};
    await context.speech.speak({expressionObserved:observation=>{expression={...expression,...observation};this.expressions.note(scope,id,expression,current);},text:candidate.text,interactionId:candidate.request.scope.interactionId,endpointId:session.endpoint.endpointId,deadlineAt:opportunity.expiresAt,warmth:selected.expressionWarmth,signal,current,...(terminalAudienceAdmission?{terminalAdmission:terminalAudienceAdmission}:{}),
     beforeEmission:()=>{row=this.ledger.transition(scope,id,row.version,{type:'beginEmission',receiptId,awaitPlayback:true,current});},
     // Speech has already issued output here; preserve its receipt before later metadata guards.
     emitted:()=>{const suffix=issued(),prefix=`{"delivery":${JSON.stringify(delivery)},`;if(!(context.custodyCurrent?.()??true))throw Error('Source custody changed');if(!audienceAdmitted())throw Error('Audience admission changed');if(context.custodyCurrent)context.emit(prefix,()=>suffix,context.custodyCurrent);else context.emit(prefix,()=>suffix);},
     synthesized:async playbackSignal=>{job.speech!.synthesized=true;await new Promise<void>((resolve,reject)=>{const abort=()=>reject(new Error('Playback stopped'));if(playbackSignal.aborted)return abort();playbackSignal.addEventListener('abort',abort,{once:true});void played.then(()=>{playbackSignal.removeEventListener('abort',abort);resolve();});});},
     interrupted:reason=>{if(reason==='expired')job.reason='ackTimeout';controller.abort();}
    });
   }else{
    row=this.ledger.transition(scope,id,row.version,{type:'beginEmission',receiptId,current});
    // Prefix issuance is the observed output; metadata never replays its payload.
    const prefix=`{"delivery":${JSON.stringify(delivery)},`;if(!(context.custodyCurrent?.()??true))throw Error('Source custody changed');if(!audienceAdmitted())throw Error('Audience admission changed');if(context.custodyCurrent)context.emit(prefix,issued,context.custodyCurrent);else context.emit(prefix,issued);
   }
   return undefined;
  }catch{
   const latest=this.ledger.get(scope,id)!;
   if(active.has(latest.outcome.state)||job.speech&&latest.outcome.state==='acknowledged'&&latest.outcome.acknowledgmentKind==='endpointAccepted'){
    const restrictions=policy().reasons,state=signal.aborted?(job.reason==='ackTimeout'&&['emitted','acknowledged'].includes(latest.outcome.lastDeliveryStage)?'unknown':'cancelled'):['emitted','acknowledged'].includes(latest.outcome.state)?'failed':restrictions.length?'suppressed':latest.outcome.state==='eligible'||latest.outcome.state==='queued'?'failed':'suppressed';
    this.ledger.transition(scope,id,latest.version,{type:'finish',state,reasons:signal.aborted?[job.reason]:restrictions.length?restrictions:[latest.outcome.state==='eligible'?'generationFailed':'outputFailed']});
   }
   if(!context.authorized())return extensionError(403,'initiative_scope_changed','Current session authorization no longer permits this operation.');
   return this.response(context.owner()??owner,operation,[{code:'initiative_stopped',summary:'The opening stopped before confirmed endpoint acceptance. Inspect its retained outcome; it will not retry.',sourceRefs:[]}]);
  }finally{clearTimeout(expiry);this.jobs.delete(id);}
 }
}
