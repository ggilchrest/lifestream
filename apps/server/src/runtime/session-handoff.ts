import {createHash,randomUUID} from 'node:crypto';
import type {Database} from '@lifestream/storage-sqlite';
import {createContractValidator} from '@lifestream/contracts';
import type {HandoffRequest,HandoffResponse} from '@lifestream/contracts/provider-messages';
import type {LocalContext} from '../auth/local-auth.ts';
import {ConversationHistory,type ConversationScope,type ConversationTransfer} from './conversation.ts';

export type HandoffScope={scope:ConversationScope;endpointId:string;revision:number;mode:'message'|'voiceCall';current:()=>boolean;dialogueCurrent:()=>boolean};
type Ready={id:string;context:LocalContext;scope:HandoffScope;expires:number};
type Plan={id:string;context:LocalContext;source:HandoffScope;ready:Ready;dialogue:ConversationTransfer|undefined;request:HandoffRequest;expires:number};
const canonical=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(canonical(v))])):value);
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const reference='https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/';
const validator=createContractValidator();
export class HandoffError extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
export const handoffLimits={readiness:32,plans:8,planBytes:524288,ttlMs:120000,receipts:1024} as const;

/** Local domain transition only. No capability grants, credentials, capture consent,
 * persistent transcript or physical-world identity are created by this service. */
export class AuthenticatedSessionHandoff {
 private timer:ReturnType<typeof setTimeout>|undefined;
 private readonly ready=new Map<string,Ready>();private readonly plans=new Map<string,Plan>();
 private readonly database:Database;private readonly history:ConversationHistory;private readonly environmentId:string;
 private readonly scope:(context:LocalContext,assistantId:string,relationshipId?:string)=>HandoffScope;
 private readonly authorized:(context:LocalContext,assistantId:string)=>boolean;private readonly busy:(sessionId:string)=>boolean;private readonly now:()=>number;
 constructor(input:{database:Database;history:ConversationHistory;environmentId:string;scope:AuthenticatedSessionHandoff['scope'];busy:AuthenticatedSessionHandoff['busy'];authorized:AuthenticatedSessionHandoff['authorized'];now?:()=>number}){this.authorized=input.authorized;this.database=input.database;this.history=input.history;this.environmentId=input.environmentId;this.scope=input.scope;this.busy=input.busy;this.now=input.now??Date.now;}
 close():void{clearTimeout(this.timer);this.timer=undefined;this.ready.clear();this.plans.clear();}
 private current(scope:HandoffScope):boolean{try{return scope.current()&&!this.busy(scope.scope.sessionId);}catch{return false;}}
 private unused(sessionId:string):boolean{return !this.database.connection.prepare('SELECT 1 FROM session_handoff_usage WHERE session_id=?').get(sessionId);}
 prune():void{const now=this.now();for(const [id,r] of this.ready)if(r.expires<=now||!this.current(r.scope)||!this.unused(r.context.sessionId))this.ready.delete(id);for(const [id,p] of this.plans){if(p.expires+handoffLimits.ttlMs<=now){this.plans.delete(id);continue;}if(p.expires<=now||!this.current(p.source)||this.ready.get(p.ready.id)!==p.ready||!p.dialogue||!this.history.transferCurrent(p.dialogue))p.dialogue=undefined;}this.schedule();}
 private schedule():void{clearTimeout(this.timer);this.timer=undefined;const expiry=Math.min(Infinity,...[...this.ready.values()].map(r=>r.expires),...[...this.plans.values()].map(p=>p.dialogue?p.expires:p.expires+handoffLimits.ttlMs));if(Number.isFinite(expiry)){this.timer=setTimeout(()=>this.prune(),Math.max(1,expiry-this.now()));this.timer.unref();}}
 inspect(context:LocalContext,assistantId:string,relationshipId?:string){
  this.prune();const records=this.database.connection.prepare('SELECT response_json FROM session_handoff_records WHERE principal_id=? AND assistant_id=? ORDER BY occurred_at DESC LIMIT 20').all(context.principalId,assistantId) as Array<{response_json:string}>;
  if(this.database.connection.prepare("SELECT 1 FROM sessions WHERE id=? AND status!='active'").get(context.sessionId))return {sessionId:context.sessionId,ended:true,endpointId:null,canReceive:false,ready:null,destinations:[],records:records.map(r=>JSON.parse(r.response_json) as HandoffResponse),grantsTransferred:false};
  const current=this.scope(context,assistantId,relationshipId),same=(r:Ready)=>r.context.principalId===context.principalId&&r.scope.scope.assistantId===assistantId&&r.scope.scope.relationshipId===current.scope.relationshipId;
  const destinations=[...this.ready.values()].filter(r=>same(r)&&r.context.sessionId!==context.sessionId&&r.scope.endpointId!==current.endpointId).map(r=>({readinessId:r.id,sessionId:r.context.sessionId,endpointId:r.scope.endpointId,expiresAt:new Date(r.expires).toISOString()}));
  const own=[...this.ready.values()].find(r=>r.context.sessionId===context.sessionId&&same(r));
  return {sessionId:context.sessionId,endpointId:current.endpointId,canReceive:this.unused(context.sessionId)&&this.current(current),ready:own?{readinessId:own.id,expiresAt:new Date(own.expires).toISOString()}:null,destinations,records:records.map(r=>JSON.parse(r.response_json) as HandoffResponse),scope:'betweenTurnsLinkedSession',dialogueRetention:'volatileOriginalExpiry',grantsTransferred:false};
 }
 receive(context:LocalContext,assistantId:string,relationshipId?:string){
  this.prune();const scope=this.scope(context,assistantId,relationshipId);
  if(!this.current(scope)||!this.unused(context.sessionId))throw new HandoffError(409,'Use a fresh unused sign-in, choose private disclosure and Only me, and close its microphone and output before marking it ready.');
  this.cancel(context);if(this.ready.size>=handoffLimits.readiness)throw new HandoffError(429,'Handoff readiness is full. Wait for an existing readiness to expire.');
  const id=randomUUID(),expires=Math.min(this.now()+handoffLimits.ttlMs,Date.parse(context.expiresAt));this.ready.set(id,{id,context,scope,expires});this.schedule();return {readinessId:id,expiresAt:new Date(expires).toISOString()};
 }
 cancel(context:LocalContext):void{for(const [id,r] of this.ready)if(r.context.sessionId===context.sessionId&&r.context.principalId===context.principalId)this.ready.delete(id);this.prune();}
 prepare(context:LocalContext,assistantId:string,relationshipId:string|undefined,destinationReadinessId:string){
  this.prune();const source=this.scope(context,assistantId,relationshipId),ready=this.ready.get(destinationReadinessId);
  if(!this.current(source)||!ready||ready.context.principalId!==context.principalId||ready.context.sessionId===context.sessionId||ready.scope.endpointId===source.endpointId||ready.scope.scope.assistantId!==assistantId||ready.scope.scope.relationshipId!==source.scope.relationshipId)throw new HandoffError(409,'The source or destination is no longer ready for this Assistant and relationship. Refresh both endpoints.');
  for(const [id,p] of this.plans)if(p.context.sessionId===context.sessionId)this.plans.delete(id);
  const dialogue=this.history.prepareTransfer(source.scope);
  if(this.plans.size>=handoffLimits.plans||[...this.plans.values()].reduce((n,p)=>n+Buffer.byteLength(p.dialogue?.content??''),Buffer.byteLength(dialogue.content))>handoffLimits.planBytes)throw new HandoffError(429,'Handoff review capacity is full. Wait for a review to expire.');
  const id=randomUUID(),expires=Math.min(ready.expires,this.now()+handoffLimits.ttlMs,Date.parse(context.expiresAt),dialogue.expiresAt);
  const contextBoundary={reference:'lifestream:handoff-review:'+id,sha256:digest([source.scope,dialogue.content]),mediaType:'application/json',schemaRef:'lifestream:volatile-conversation-boundary:1',byteLength:Buffer.byteLength(dialogue.content)};
  const request:HandoffRequest={schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload:{sessionId:context.sessionId,expectedRevision:source.revision,destinationEndpointId:ready.scope.endpointId,contextBoundary,reason:{code:'reviewed_between_turn_handoff',summary:'Continue bounded dialogue at the independently ready destination; end source conversation. No authority or capture consent transfers.'}}};
  this.plans.set(id,{id,context,source,ready,dialogue,request,expires});this.schedule();
  return {reviewId:id,request,expiresAt:new Date(expires).toISOString(),destinationSessionId:ready.context.sessionId,dialogueEntries:dialogue.entries,dialogueBytes:contextBoundary.byteLength,grantsTransferred:false,sourceEnds:true,retention:'Original volatile dialogue expiry is preserved. Restart does not restore the transcript.'};
 }
 execute(context:LocalContext,sessionId:string,body:unknown):{status:number;body:HandoffResponse;replayed?:boolean}{
  if(!validator.validate(reference+'HandoffRequest',body).valid)throw new HandoffError(422,'A closed, reviewed HandoffRequest is required.');
  const request=body as HandoffRequest,inputDigest=digest(request);
  if(request.payload.sessionId!==sessionId||sessionId!==context.sessionId)throw new HandoffError(403,'Handoff must originate at the reviewed source sign-in.');
  const saved=this.database.connection.prepare('SELECT input_digest,response_json,assistant_id FROM session_handoff_records WHERE principal_id=? AND idempotency_key=?').get(context.principalId,request.idempotencyKey) as {input_digest:string;response_json:string;assistant_id:string}|undefined;
  if(saved){if(!this.authorized(context,saved.assistant_id))throw new HandoffError(403,'Current private administration scope is required to inspect this receipt.');if(saved.input_digest!==inputDigest)throw new HandoffError(409,'Handoff idempotency key conflicts with the recorded request.');const value=JSON.parse(saved.response_json) as HandoffResponse;return {status:value.status==='succeeded'?200:409,body:value,replayed:true};}
  const plan=[...this.plans.values()].find(p=>p.context.sessionId===context.sessionId&&p.context.principalId===context.principalId&&digest(p.request)===inputDigest);
  if(!plan)throw new HandoffError(409,'Review the current source boundary before committing a handoff.');
  if(!this.authorized(context,plan.source.scope.assistantId))throw new HandoffError(403,'Current private administration scope is required.');
  const count=this.database.connection.prepare('SELECT count(*) AS n FROM session_handoff_records').get() as {n:number};if(count.n>=handoffLimits.receipts)throw new HandoffError(507,'Handoff audit capacity is full. No session changed.');
  const occurredAt=new Date(this.now()).toISOString(),handoffId=randomUUID();
  const save=(value:HandoffResponse)=>this.database.connection.prepare('INSERT INTO session_handoff_records VALUES(?,?,?,?,?,?,?,?,?)').run(handoffId,context.principalId,plan.source.scope.assistantId,sessionId,plan.ready.context.sessionId,request.idempotencyKey,inputDigest,JSON.stringify(value),occurredAt);
  try{
   this.prune();if(!plan.dialogue||this.plans.get(plan.id)!==plan||!this.current(plan.source)||!this.current(plan.ready.scope)||!this.unused(plan.ready.context.sessionId))throw Error('Handoff scope changed');
   const destinationScope={...plan.source.scope,sessionId:plan.ready.context.sessionId};
   let result:HandoffResponse|undefined;
   this.history.withTransfer(plan.dialogue,destinationScope,Date.parse(plan.ready.context.expiresAt),install=>this.database.transaction(tx=>{
    if(!this.current(plan.source)||!this.current(plan.ready.scope)||!this.unused(plan.ready.context.sessionId))throw Error('Handoff scope changed');
    tx.run("UPDATE sessions SET status='ended',revision=revision+1 WHERE id=? AND revision=? AND status='active'",sessionId,plan.source.revision);
    if(tx.get<{n:number}>('SELECT changes() AS n')?.n!==1)throw Error('Source revision changed');
    tx.run("UPDATE sessions SET conversation_id=?,revision=revision+1,interaction_id=? WHERE id=? AND revision=? AND status='active'",plan.source.scope.conversationId,randomUUID(),plan.ready.context.sessionId,plan.ready.scope.revision);
    if(tx.get<{n:number}>('SELECT changes() AS n')?.n!==1)throw Error('Destination revision changed');
    tx.run('INSERT OR IGNORE INTO session_handoff_usage VALUES(?,?)',plan.ready.context.sessionId,occurredAt);
    const destination=this.scope(plan.ready.context,plan.source.scope.assistantId,plan.source.scope.relationshipId??undefined);install(destination.dialogueCurrent);
    result={schemaVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,status:'succeeded',sourceRevision:{providerRef:'lifestream:local-session',revision:String(plan.source.revision+1),highWaterMark:handoffId},error:null,result:{handoffId,sourceSessionId:sessionId,destinationSession:{sessionId:destination.scope.sessionId,conversationId:destination.scope.conversationId,assistantId:destination.scope.assistantId,endpointId:destination.endpointId,environmentId:this.environmentId,revision:destination.revision,mode:destination.mode,state:'active',authorityContextRef:null,audioOwnerEndpointId:null,createdAt:occurredAt,endedAt:null},sourceEndpointId:plan.source.endpointId,destinationEndpointId:destination.endpointId,initiatorRef:context.principalId,authorization:{schemaVersion:'1.0.0',kind:'authenticatedSessionHandoff',disposition:'authorized',grantsTransferred:false,decisionId:randomUUID(),principalId:context.principalId,assistantId:destination.scope.assistantId,sourceSessionId:sessionId,destinationSessionId:destination.scope.sessionId,sourceEndpointId:plan.source.endpointId,destinationEndpointId:destination.endpointId,sourceReviewId:plan.id,destinationReadinessId:plan.ready.id,sourceRevision:plan.source.revision,destinationRevision:plan.ready.scope.revision,inputDigest,scopeDigest:digest([plan.source.scope,plan.ready.scope.scope,plan.source.revision,plan.ready.scope.revision]),evaluatedAt:occurredAt},contextBoundary:request.payload.contextBoundary,redactedReferences:[],oldLeaseId:null,newLease:null,occurredAt,outcome:'completed',reason:request.payload.reason}};
    if(!validator.validate(reference+'HandoffResponse',result).valid)throw Error('Invalid handoff result');save(result);
   }));
   this.plans.delete(plan.id);this.ready.delete(plan.ready.id);this.prune();return {status:200,body:result!};
  }catch{
   const committed=this.database.connection.prepare('SELECT response_json FROM session_handoff_records WHERE principal_id=? AND idempotency_key=? AND input_digest=?').get(context.principalId,request.idempotencyKey,inputDigest) as {response_json:string}|undefined;
   if(committed){const value=JSON.parse(committed.response_json) as HandoffResponse;return {status:value.status==='succeeded'?200:409,body:value};}
   const value:HandoffResponse={schemaVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,status:'failed',sourceRevision:null,result:null,error:{code:'handoff_not_committed',message:'The handoff was not committed. Refresh both endpoints and review again; the source session remains unchanged.',retryable:false,correlationId:request.correlationId,details:[]}};
   // If audit persistence itself fails, report an infrastructure failure, never a
   // durable outcome. The transaction and volatile-history rollback already ran.
   try{save(value);}catch{throw new HandoffError(503,'Handoff persistence could not be confirmed. Inspect receipts before retrying.');}finally{this.plans.delete(plan.id);}
   return {status:409,body:value};
  }
 }
}
