import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_LIMITS,gameHostMessage,gameHostDigest,gameHostCompletionMatches} from '@lifestream/contracts/game-host';
import type * as H from '@lifestream/contracts/game-host';
import type * as G from '@lifestream/contracts/game-activity';
import {guardGameActivityAdapter} from '@lifestream/providers-bizhawk';
import type {GameActivityAdapter,GameCallContext,GameAdapterBoundaryOptions} from '@lifestream/providers-bizhawk';
import {GameHostDispatchRepository} from '@lifestream/storage-sqlite';
import type {Database,ActivityCheckpointRepository} from '@lifestream/storage-sqlite';
import {runCheckpointedGameController} from './game-activity.ts';
import type {CheckpointedGameControllerPorts} from './game-activity.ts';
import type {AuthenticatedGameRuntime} from './game-host-runtime.ts';

export class GameHostError extends Error{readonly status:number;readonly code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;}}
export type GameHostActor={principalId:string;sessionId:string;isCurrent:(scope:G.ActivityScope)=>boolean;runtimeFor?:(scope:G.ActivityScope,repository:ActivityCheckpointRepository)=>AuthenticatedGameRuntime|null};
export type GameHostBinding=Omit<H.GameHostAttach,'protocol'>;
export type GameHostOptions={
 maxAttachments:number;maxDurationMs:number;createRepository:(database:Database)=>ActivityCheckpointRepository;
 /** Independent source/installation/display/authority qualification. Client metadata cannot grant this. */
 resolveAttachment:(actor:GameHostActor,metadata:Readonly<H.GameHostAttach>)=>GameHostBinding|null;
 bindingCurrent:(actor:GameHostActor,binding:Readonly<GameHostBinding>)=>boolean;
 controllerCurrent:(checkpoint:G.ActivityCheckpoint,request:G.GameActionRequest)=>boolean;
 boundary:Pick<GameAdapterBoundaryOptions,'sourceAvailable'|'acceptObservation'|'acceptAction'|'reconcileEffect'|'admitRelease'>;
 onAttached?:(join:GameHostJoin)=>void;
};
type Pending={command:H.GameHostCommand;context:GameCallContext;identity:H.GameHostAdmit&{hostId:string;sourceRevision:string};resolve:(result:H.GameHostResult)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;abort:()=>void;deadline:number;delivered:boolean;entered:boolean};
type Attachment={id:string;actor:GameHostActor;binding:Readonly<GameHostBinding>;expires:number;monotonicExpiry:number;lastPoll:number;pending:Pending|null;poll:(()=>void)|null;cancel:H.GameHostCancel|null;closed:boolean;effectUnresolved:boolean;controller:AbortController;adapter:GameActivityAdapter;runtime?:AuthenticatedGameRuntime};
const owner=(scope:G.ActivityScope)=>({assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:scope.relationshipId});
function fail(status:number,code:string):never{throw new GameHostError(status,code);}
const safe=(check:()=>boolean)=>{try{return check()===true;}catch{return false;}};
/** A trusted source-only handle; attachment never starts an activity or grants authority. */
export type GameHostJoin={attachmentId:string;scope:Readonly<G.ActivityScope>;adapter:GameActivityAdapter;runtime?:AuthenticatedGameRuntime;
 runController:(input:Parameters<typeof runCheckpointedGameController>[0],ports:Pick<CheckpointedGameControllerPorts,'signal'|'current'|'usageFor'>)=>ReturnType<typeof runCheckpointedGameController>};

export class GameHostPort{
 private readonly attachments=new Map<string,Attachment>();
 private readonly dispatch:GameHostDispatchRepository;
 private readonly repository:ActivityCheckpointRepository;
 private readonly options:Readonly<GameHostOptions>;
 private readonly sweepTimer:NodeJS.Timeout;
 private closed=false;
 constructor(database:Database,options:GameHostOptions){
  if(!Number.isSafeInteger(options.maxAttachments)||options.maxAttachments<1||options.maxAttachments>16||!Number.isSafeInteger(options.maxDurationMs)||options.maxDurationMs<1||options.maxDurationMs>120000||typeof options.resolveAttachment!=='function'||typeof options.bindingCurrent!=='function'||typeof options.controllerCurrent!=='function'||typeof options.boundary?.sourceAvailable!=='function')throw new Error('invalid_game_host_options');
  this.options=Object.freeze({...options,boundary:Object.freeze({...options.boundary})});
  this.repository=options.createRepository(database);this.dispatch=new GameHostDispatchRepository(database,this.repository);
  this.sweepTimer=setInterval(()=>this.sweep(),250);this.sweepTimer.unref();
 }
 private current(a:Attachment,scope=a.binding.scope){
  return !this.closed&&!a.closed&&(!a.runtime||safe(a.runtime.isCurrent))&&Date.now()<a.expires&&performance.now()<a.monotonicExpiry&&performance.now()-a.lastPoll<GAME_HOST_LIMITS.idleMs&&isDeepStrictEqual(scope,a.binding.scope)&&a.actor.principalId===scope.principalId&&a.actor.sessionId===scope.contextBinding.sessionId&&safe(()=>a.actor.isCurrent(scope))&&safe(()=>this.options.bindingCurrent(a.actor,a.binding))&&safe(()=>this.options.boundary.sourceAvailable(scope,a.binding.pinsDigest));
 }
 private attachment(actor:GameHostActor,id:string):Attachment{
  const a=this.attachments.get(id);if(!a)fail(410,'game_host_expired');
  if(a.actor.principalId!==actor.principalId||a.actor.sessionId!==actor.sessionId||!safe(()=>actor.isCurrent(a.binding.scope)))fail(403,'game_host_scope_denied');
  if(!this.current(a)){this.fence(a,'scopeChanged');fail(410,'game_host_expired');}return a;
 }
 attach(actor:GameHostActor,raw:unknown):H.GameHostAttachment{
  const metadata=gameHostMessage('attach',raw);if(!metadata)fail(400,'invalid_game_host_message');
  if(this.closed)fail(503,'game_host_unavailable');this.sweep();
  if(metadata.scope.principalId!==actor.principalId||metadata.scope.contextBinding.sessionId!==actor.sessionId||!safe(()=>actor.isCurrent(metadata.scope)))fail(403,'game_host_scope_denied');
  let candidate:GameHostBinding|null=null;try{candidate=this.options.resolveAttachment(actor,metadata);}catch{fail(503,'game_host_unavailable');}
  const checked=gameHostMessage('attach',candidate?{protocol,...candidate}:null);
  if(!checked||!isDeepStrictEqual(checked,metadata))fail(503,'game_host_unavailable');
  for(const a of this.attachments.values())if(a.binding.hostId===metadata.hostId||a.binding.scope.runId===metadata.scope.runId)fail(409,'game_host_conflict');
  if(this.attachments.size>=this.options.maxAttachments)fail(503,'game_host_unavailable');
  const {protocol:_,...binding}=checked,id=randomUUID(),expires=Date.now()+GAME_HOST_LIMITS.attachmentMs;
  const actorSnapshot=Object.freeze({principalId:actor.principalId,sessionId:actor.sessionId,isCurrent:actor.isCurrent,...(actor.runtimeFor?{runtimeFor:actor.runtimeFor}:{})});
  const a={id,actor:actorSnapshot,binding:Object.freeze(binding),expires,monotonicExpiry:performance.now()+GAME_HOST_LIMITS.attachmentMs,lastPoll:performance.now(),pending:null,poll:null,cancel:null,closed:false,effectUnresolved:false,controller:new AbortController()} as Attachment;
  const invoke=<R extends H.GameHostResult>(request:H.GameHostRequest,context:GameCallContext)=>this.invoke(a,request,context) as Promise<R>;
  const rawAdapter:GameActivityAdapter={observe:(r,c)=>invoke<G.GameObserveResult>(r,c),applyController:(r,c)=>invoke<G.GameActionResult>(r,c),releaseControls:(r,c)=>invoke<G.GameReleaseResult>(r,c),controlSave:async()=>fail(503,'game_host_unavailable')};
  const boundary=this.options.boundary;
  a.adapter=Object.freeze(guardGameActivityAdapter(rawAdapter,{providerRef:binding.providerRef,maxDurationMs:this.options.maxDurationMs,
   sourceAvailable:(scope,pins)=>pins===binding.pinsDigest&&this.current(a,scope),
   ...(boundary.acceptObservation?{acceptObservation:(r:G.GameObserveRequest,o:G.GameObservation)=>this.current(a,r.scope)&&safe(()=>boundary.acceptObservation!(r,o))}:{}),
   ...(boundary.acceptAction?{acceptAction:(r:G.GameActionRequest,result:G.GameActionResult)=>this.current(a,r.scope)&&safe(()=>boundary.acceptAction!(r,result))}:{}),
   claimEffect:async(r,c)=>r.operation==='GameActivityAdapter.applyController'&&this.claim(a,r,c),
   ...(boundary.reconcileEffect?{reconcileEffect:async(r:G.GameActionRequest|G.GameSaveRequest,c:GameCallContext)=>this.current(a,r.scope)&&await boundary.reconcileEffect!(r,c)===true}:{}),
   ...(boundary.admitRelease?{admitRelease:async(r:G.GameReleaseRequest,c:GameCallContext)=>this.current(a,r.scope)&&await boundary.admitRelease!(r,c)===true}:{}),
  }));
  if(actorSnapshot.runtimeFor){const runtime=actorSnapshot.runtimeFor(a.binding.scope,this.repository);if(!runtime)fail(503,'game_host_unavailable');a.runtime=runtime;}
  if(!this.current(a))fail(503,'game_host_unavailable');this.attachments.set(id,a);
  const adapter=a.adapter,repository=this.repository;
  const join:GameHostJoin=Object.freeze({attachmentId:id,scope:a.binding.scope,adapter,...(a.runtime?{runtime:a.runtime}:{}),runController:(input,ports)=>{
   const {signal,current,usageFor}=ports;
   return runCheckpointedGameController(input,{repository,adapter,signal:AbortSignal.any([signal,a.controller.signal]),usageFor,current:(cp,r)=>ports.signal===signal&&ports.current===current&&ports.usageFor===usageFor&&this.current(a,r.scope)&&(!a.runtime||safe(a.runtime.controllerCurrent))&&safe(()=>this.options.controllerCurrent(cp,r))&&safe(()=>current(cp,r))});
  }});
  try{this.options.onAttached?.(join);}catch{this.fence(a,'detached');fail(503,'game_host_unavailable');}
  return {protocol,attachmentId:id,expiresAt:new Date(expires).toISOString(),pollMs:1000,maxMessageBytes:131072};
 }
 private claims=new WeakMap<Attachment,{requestDigest:string;identity:Pending['identity']}>();
 private claim(a:Attachment,r:G.GameActionRequest,c:GameCallContext):boolean{
  if(a.effectUnresolved||a.pending||this.claims.has(a)||c.signal.aborted||a.runtime&&!safe(a.runtime.controllerCurrent)||!this.current(a,r.scope)||!safe(()=>c.isCurrent(r.scope)))return false;
  const identity={protocol,attachmentId:a.id,hostId:a.binding.hostId,sourceRevision:a.binding.sourceRevision,commandId:randomUUID(),requestDigest:gameHostDigest(r)};
  const {protocol:_,...durableIdentity}=identity;
  if(!this.dispatch.claim(owner(r.scope),r,durableIdentity,(cp,request)=>this.current(a,request.scope)&&!c.signal.aborted&&safe(()=>c.isCurrent(request.scope))&&safe(()=>this.options.controllerCurrent(cp,request))))return false;
  this.claims.set(a,{requestDigest:identity.requestDigest,identity});return true;
 }
 private invoke(a:Attachment,r:H.GameHostRequest,c:GameCallContext):Promise<H.GameHostResult>{
  if(r.executionMode!=='normal'||a.pending||a.cancel||c.signal.aborted||!this.current(a,r.scope)||!safe(()=>c.isCurrent(r.scope)))return Promise.reject(new GameHostError(409,'game_host_conflict'));
  const requestDigest=gameHostDigest(r),claim=this.claims.get(a);let identity:Pending['identity'];
  if(r.operation==='GameActivityAdapter.applyController'){
   if(!claim||claim.requestDigest!==requestDigest)return Promise.reject(new GameHostError(409,'game_host_conflict'));identity=claim.identity;this.claims.delete(a);
  }else identity={protocol,attachmentId:a.id,hostId:a.binding.hostId,sourceRevision:a.binding.sourceRevision,commandId:randomUUID(),requestDigest};
  const expires=Math.min(a.expires,Date.now()+this.options.maxDurationMs,Date.parse(r.deadlineAt),r.operation==='GameActivityAdapter.applyController'?Date.parse(r.payload.admission.expiresAt):Infinity);
  if(expires<=Date.now()){if(r.operation==='GameActivityAdapter.applyController')this.dispatch.unresolved(identity);return Promise.reject(new GameHostError(410,'game_host_expired'));}
  const event=gameHostMessage('event',{protocol,kind:'command',attachmentId:a.id,commandId:identity.commandId,requestDigest,expiresAt:new Date(expires).toISOString(),request:r});
  if(!event||event.kind!=='command'){if(r.operation==='GameActivityAdapter.applyController')this.dispatch.unresolved(identity);return Promise.reject(new GameHostError(400,'invalid_game_host_message'));}
  const command=event;
  return new Promise((resolve,reject)=>{
   const abort=()=>this.cancel(a,'cancelled'),timer=setTimeout(()=>this.cancel(a,'deadline'),expires-Date.now());timer.unref();
   a.pending={command,context:c,identity,resolve,reject,timer,abort,deadline:performance.now()+expires-Date.now(),delivered:false,entered:false};
   c.signal.addEventListener('abort',abort,{once:true});if(c.signal.aborted)abort();a.poll?.();
  });
 }
 async next(actor:GameHostActor,raw:unknown,signal:AbortSignal):Promise<H.GameHostEvent>{
  const message=gameHostMessage('next',raw);if(!message)fail(400,'invalid_game_host_message');const a=this.attachment(actor,message.attachmentId);
  if(a.poll)fail(409,'game_host_conflict');if(signal.aborted){this.fence(a,'detached');fail(410,'game_host_expired');}
  a.lastPoll=performance.now();a.expires=Date.now()+GAME_HOST_LIMITS.attachmentMs;a.monotonicExpiry=performance.now()+GAME_HOST_LIMITS.attachmentMs;
  return new Promise((resolve,reject)=>{
   const finish=()=>{cleanup();try{if(!this.current(a))fail(410,'game_host_expired');if(a.cancel){const event=a.cancel;a.cancel=null;resolve(event);return;}const pending=a.pending;if(pending&&!pending.delivered){pending.delivered=true;resolve(pending.command);return;}resolve({protocol,kind:'idle',attachmentId:a.id,expiresAt:new Date(a.expires).toISOString()});}catch(error){this.fence(a,'scopeChanged');reject(error);}};
   const aborted=()=>{cleanup();this.fence(a,'detached');reject(new GameHostError(410,'game_host_expired'));};
   const timer=setTimeout(finish,GAME_HOST_LIMITS.pollMs);const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);if(a.poll===finish)a.poll=null;};
   a.poll=finish;signal.addEventListener('abort',aborted,{once:true});if(a.cancel||a.pending&&!a.pending.delivered)finish();
  });
 }
 admit(actor:GameHostActor,raw:unknown):H.GameHostAdmission{
  const message=gameHostMessage('admit',raw);if(!message)fail(400,'invalid_game_host_message');const a=this.attachment(actor,message.attachmentId),p=a.pending;
  if(!p||!p.delivered||p.entered||p.command.commandId!==message.commandId||p.command.requestDigest!==message.requestDigest)fail(409,'game_host_conflict');
  if(!this.pendingCurrent(a,p)){this.cancel(a,'scopeChanged');fail(410,'game_host_expired');}
  if(p.command.request.operation==='GameActivityAdapter.applyController'){
   const {protocol:_,...identity}=p.identity;
   if(!this.dispatch.enter(owner(p.command.request.scope),p.command.request,identity,(cp,r)=>this.pendingCurrent(a,p)&&safe(()=>this.options.controllerCurrent(cp,r)))){this.cancel(a,'scopeChanged');fail(409,'game_host_conflict');}
  }
  if(!this.pendingCurrent(a,p)){this.cancel(a,'scopeChanged');fail(410,'game_host_expired');}p.entered=true;
  return {...message,admitted:true,expiresAt:p.command.expiresAt};
 }
 complete(actor:GameHostActor,raw:unknown):H.GameHostAccepted{
  const completion=gameHostMessage('completion',raw);if(!completion)fail(400,'invalid_game_host_message');const a=this.attachment(actor,completion.attachmentId),p=a.pending;
  if(!p||!p.entered||!this.pendingCurrent(a,p)||!gameHostCompletionMatches(p.command,completion)||completion.result.providerRef!==a.binding.providerRef)fail(409,'game_host_conflict');
  if(p.command.request.operation==='GameActivityAdapter.applyController'&&!this.dispatch.receipt(p.identity,completion.resultDigest))fail(409,'game_host_conflict');
  if(!this.pendingCurrent(a,p)){this.cancel(a,'scopeChanged');fail(410,'game_host_expired');}
  this.clear(a,p);p.resolve(completion.result);
  return {protocol,attachmentId:a.id,commandId:completion.commandId,resultDigest:completion.resultDigest,accepted:true};
 }
 detach(actor:GameHostActor,raw:unknown):H.GameHostDetached{
  const message=gameHostMessage('detach',raw);if(!message)fail(400,'invalid_game_host_message');const a=this.attachment(actor,message.attachmentId);this.fence(a,'detached');return {...message,fenced:true};
 }
 private pendingCurrent(a:Attachment,p:Pending){return a.pending===p&&this.current(a,p.command.request.scope)&&Date.now()<Date.parse(p.command.expiresAt)&&performance.now()<p.deadline&&!p.context.signal.aborted&&safe(()=>p.context.isCurrent(p.command.request.scope));}
 private clear(a:Attachment,p:Pending){clearTimeout(p.timer);p.context.signal.removeEventListener('abort',p.abort);if(a.pending===p)a.pending=null;}
 private cancel(a:Attachment,reason:H.GameHostCancel['reason']){
  const p=a.pending;if(!p)return;this.clear(a,p);
  if(p.command.request.operation==='GameActivityAdapter.applyController'){a.effectUnresolved=true;try{this.dispatch.unresolved(p.identity);}catch{/* durable reservation/claim still prevents replay */}}
  a.cancel={protocol,kind:'cancel',attachmentId:a.id,commandId:p.command.commandId,requestDigest:p.command.requestDigest,cancellationId:p.command.request.cancellationId,reason};p.reject(new GameHostError(410,'game_host_expired'));a.poll?.();
 }
 private fence(a:Attachment,reason:H.GameHostCancel['reason']){
  if(a.closed)return;a.closed=true;a.runtime?.close();this.cancel(a,reason);a.controller.abort();const claim=this.claims.get(a);if(claim){try{this.dispatch.unresolved(claim.identity);}catch{}this.claims.delete(a);}this.attachments.delete(a.id);a.poll?.();
 }
 private sweep(){for(const a of this.attachments.values())if(!this.current(a))this.fence(a,'scopeChanged');}
 close(){if(this.closed)return;this.closed=true;clearInterval(this.sweepTimer);for(const a of this.attachments.values())this.fence(a,'shutdown');}
}
