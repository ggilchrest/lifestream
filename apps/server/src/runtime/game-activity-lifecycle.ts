import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import {boundedGameDataSnapshot} from '@lifestream/contracts/game-journal';
import type * as G from '@lifestream/contracts/game-activity';
import type {DiscoveryAdministration} from '../admin/understanding.ts';
export type GameInterruptionInput={request:G.GameReleaseRequest;planningKey:string|null;epochAfterFence:number};
type Status='pauseConfirmed'|'stopConfirmed'|'successorPreserved'|'unconfirmed';
type Reason='confirmed'|'fenceDenied'|'releaseUnavailable'|'invalidResponse'|'unqualifiedEvidence'|'staleBoundary'|'persistenceFailed';
export type GameShutdownReport=Readonly<{scope:G.ActivityScope;executionMode:G.GameReleaseRequest['executionMode'];requestId:string;idempotencyKey:string;targetInputOwnerLeaseId:string;epochAfterFence:number|null;status:Status;reason:Reason;receiptRef:string|null;resultDigest:string|null;resumeAuthority:false;replayAllowed:false}>;
export type GameInterruptionPorts={
 background:Pick<DiscoveryAdministration,'cancelBackground'>;
 providerRef:string;maximumReleaseWaitMs:number;
 /** Synchronously disable new effects/fence current plans AND durably claim
  * this exact old-lease shutdown identity once. A model cannot supply this. */
 fenceAndClaim:(input:Readonly<GameInterruptionInput>)=>boolean;
 /** Exact old-lease shutdown intent, independent of withdrawn game permission.
  * Successor ownership cannot become permission to control the successor. */
 shutdownCurrent:(input:Readonly<GameInterruptionInput>)=>boolean;
 /** Host delegates only to the governed adapter release port. No launch,
  * action, save, model or ordinary gameplay authority is supplied here. */
 release:(request:G.GameReleaseRequest,context:{signal:AbortSignal;isCurrent:(scope:G.ActivityScope)=>boolean})=>Promise<G.GameReleaseResult>;
 /** Independently qualified pinned native source/old-lease evidence. Shape,
  * stationary samples or a socket response alone cannot qualify native pause. */
 qualifyWithdrawal:(request:G.GameReleaseRequest,result:G.GameReleaseResult)=>string|null;
 /** Durable current lifecycle/trace CAS; failure cannot be called safely stopped. */
 persist:(report:GameShutdownReport)=>boolean;
 now?:()=>number;
};
const validator=createContractValidator(),schema='https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/';
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const checked=(fn:()=>boolean)=>{try{return fn()===true;}catch{return false;}};
/** One bounded shutdown, outside the inference slot. It awaits actual native
 * acknowledgment instead of equating absent commands to pause. No retry/resume. */
export async function interruptGameRun(raw:GameInterruptionInput,ports:GameInterruptionPorts):Promise<GameShutdownReport&{metadataPersisted:boolean;observedPauseConfirmed:boolean}> {
 const input=boundedGameDataSnapshot(raw) as GameInterruptionInput|null;
 if(!input||Object.keys(input).sort().join(',')!=='epochAfterFence,planningKey,request'||!validator.validate(schema+'GameReleaseRequest',input.request).valid||!Number.isSafeInteger(input.epochAfterFence)||input.epochAfterFence<=input.request.scope.activityEpoch||input.epochAfterFence>2147483647||input.planningKey!==null&&(typeof input.planningKey!=='string'||!/^game-decision:[a-f0-9-]{36}:[1-9][0-9]*$/u.test(input.planningKey)||input.planningKey.length>200)||typeof ports.providerRef!=='string'||!ports.providerRef.trim()||ports.providerRef.length>500||!Number.isSafeInteger(ports.maximumReleaseWaitMs)||ports.maximumReleaseWaitMs<1||ports.maximumReleaseWaitMs>120000)throw new Error('Game interruption input is unavailable');
 freeze(input);const {request}=input,providerRef=ports.providerRef,clock=ports.now??Date.now,started=clock(),deadline=Date.parse(request.deadlineAt),remaining=Math.min(ports.maximumReleaseWaitMs,deadline-started);
 if(!Number.isSafeInteger(started)||started<0||!Number.isFinite(new Date(started).getTime()))throw new Error('Game interruption clock is unavailable');
 const controller=new AbortController(),monoDeadline=performance.now()+Math.max(0,remaining);let lastNow=started,status:Status='unconfirmed',reason:Reason='fenceDenied',receiptRef:string|null=null,resultDigest:string|null=null;
 const current=()=>{try{const now=clock();if(!Number.isSafeInteger(now)||now<lastNow||now>=deadline||performance.now()>=monoDeadline||controller.signal.aborted||ports.providerRef!==providerRef||ports.shutdownCurrent(input)!==true)return false;lastNow=now;return true;}catch{return false;}};
 const record=():GameShutdownReport=>freeze({scope:request.scope,executionMode:request.executionMode,requestId:request.requestId,idempotencyKey:request.idempotencyKey,targetInputOwnerLeaseId:request.payload.targetInputOwnerLeaseId,epochAfterFence:claimed?input.epochAfterFence:null,status,reason,receiptRef,resultDigest,resumeAuthority:false,replayAllowed:false});
 // The synchronous fence precedes both cancellation and the first async I/O.
 const claimed=checked(()=>ports.fenceAndClaim(input));
 if(claimed){
  if(input.planningKey!==null){try{ports.background.cancelBackground(input.planningKey,'scopeInvalidated');}catch{/* The synchronous source fence still forbids late work. */}}
  reason='releaseUnavailable';
  if(remaining>0&&current()){
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort('deadline');reject(new Error('Game release deadline'));},remaining);});
    const context={signal:controller.signal,isCurrent:(scope:G.ActivityScope)=>isDeepStrictEqual(scope,request.scope)&&current()};
    const reply=await Promise.race([Promise.resolve().then(()=>{if(!current())throw new Error('Game shutdown changed');return ports.release(request,context);}),timeout]);
    if(!current()){reason='staleBoundary';}else{
     const result=boundedGameDataSnapshot(reply,131072) as G.GameReleaseResult|null;
     if(!result||!validator.validate(schema+'GameReleaseResult',result).valid||result.requestId!==request.requestId||result.correlationId!==request.correlationId||result.operation!==request.operation||result.providerRef!==providerRef||Date.parse(result.completedAt)<started||Date.parse(result.completedAt)>lastNow||result.outcome.status!=='succeeded'||result.outcome.payload!.targetInputOwnerLeaseId!==request.payload.targetInputOwnerLeaseId){reason='invalidResponse';}
     else{
      freeze(result);resultDigest=createHash('sha256').update(JSON.stringify(result)).digest('hex');const payload=result.outcome.payload!;
      const paused=payload.disposition==='neutralizedAndPaused'&&payload.emulatorPaused===true&&payload.buttonsNeutralized===true&&payload.confirmationSource==='adapterObserved'&&payload.pauseFrameNumber===payload.verifiedFrameNumber&&payload.pauseConfirmedMonotonicMs!==null&&payload.verifiedMonotonicMs!==null&&payload.verifiedMonotonicMs>payload.pauseConfirmedMonotonicMs&&payload.activityEpochAfterFence===input.epochAfterFence&&payload.confirmedAt!==null&&Date.parse(payload.confirmedAt)>=started&&Date.parse(payload.confirmedAt)<=Date.parse(result.completedAt);
      if(!paused&&payload.disposition!=='successorPreserved')reason='invalidResponse';
      else{let ref:string|null=null;try{ref=ports.qualifyWithdrawal(request,result);}catch{}if(typeof ref!=='string'||!ref.trim()||Buffer.byteLength(ref)>2048){reason='unqualifiedEvidence';}else if(!current()){reason='staleBoundary';}else{receiptRef=ref;status=paused?(request.payload.reason==='stop'?'stopConfirmed':'pauseConfirmed'):'successorPreserved';reason='confirmed';}}
     }
    }
   }catch{reason=controller.signal.aborted?'staleBoundary':'releaseUnavailable';}
   finally{if(timer!==undefined)clearTimeout(timer);}
  }else reason='staleBoundary';
 }
 const observedPauseConfirmed=status==='pauseConfirmed'||status==='stopConfirmed',metadataPersisted=claimed&&checked(()=>ports.persist(record()));
 if(claimed&&!metadataPersisted){status='unconfirmed';reason='persistenceFailed';}
 else if(status!=='unconfirmed'&&!current()){status='unconfirmed';reason='staleBoundary';}
 controller.abort('settled');
 return freeze({...record(),metadataPersisted,observedPauseConfirmed});
}
