import {requestForFinalizedTurn,type FinalizedTurn,type PreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
/** Host composition adapter for an EXISTING local-only route restriction.
 * Custody comes only from the deployment owner, never request/import metadata.
 * This is not admission, a scheduler, a fallback selector or GPU release proof. */
export const continuityPurposes = ['inference','retrieval','rewrite','evaluation','fallback'] as const;
export type ContinuityPurpose = typeof continuityPurposes[number];
export type ProviderCustody = Readonly<{
 deploymentId:string; providerId:string; runtimeRevision:string; modelRevision:string;
 custodyRevision:string; execution:'local'|'cloud'|'hybrid'|'unknown';
 dataEgress:'local'|'cloud'|'hybrid'|'unknown'; closure:'complete'|'unknown';
 purposes:readonly ContinuityPurpose[]; dependencies:readonly object[]; expiresAtMs:number;
}>;
export type ContinuityRouteReceipt=Readonly<{
 purpose:ContinuityPurpose; deploymentId:string; providers:readonly Readonly<{providerId:string;runtimeRevision:string;modelRevision:string;custodyRevision:string}>[];
 status:'blocked'|'completed'|'failed'|'cancelled'|'timedOut'; reason:string;
 providerStarted:boolean; providerCompletionObserved:boolean;
 /** No capacity, GPU quiescence, actual offline restore or deployment claim. */
 qualification:'callBoundaryOnly';
}>;
export class ContinuityRouteError extends Error {
 constructor(readonly reason:string){super('Continuity route '+reason);}
}
type Lease={provider:object; original:ProviderCustody; snapshot:ProviderCustody};
export type ContinuityRouteHost={deploymentId:string;resolveCustody:(provider:object,purpose:ContinuityPurpose)=>ProviderCustody|null;
 isCurrent:(provider:object,custody:ProviderCustody)=>boolean;receipt?:(receipt:ContinuityRouteReceipt)=>void;
 /** Optional existing host configuration bound; omission retains original call deadline. */
 maximumDurationMs?:number;maximumChunks?:number};
const id=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=256;
function fail(reason:string):never{throw new ContinuityRouteError(reason);}
export class ContinuityRouteBoundary {
 private readonly host:Readonly<ContinuityRouteHost>;
 constructor(host:ContinuityRouteHost){
  if(!id(host.deploymentId)||typeof host.resolveCustody!=='function'||typeof host.isCurrent!=='function'||host.maximumDurationMs!==undefined&&(!Number.isSafeInteger(host.maximumDurationMs)||host.maximumDurationMs<1)||!Number.isSafeInteger(host.maximumChunks??1024)||(host.maximumChunks??1024)<1||(host.maximumChunks??1024)>4096)throw Error('Invalid continuity route host');
  this.host=Object.freeze({...host});
 }
 private begin(provider:object,purpose:ContinuityPurpose,call:{deadlineAt:string;signal:AbortSignal}){
  const leases:Lease[]=[],visiting=new Set<object>(),seen=new Set<object>();
  let started=false,completed=false,settled=false,timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController(),signal=AbortSignal.any([call.signal,controller.signal]);
  const wall=Date.now(),mono=performance.now(),deadline=Date.parse(call.deadlineAt);let lastWall=wall;
  const abortReason=()=>controller.signal.aborted?(controller.signal.reason==='custodyExpired'?'custodyExpired':'deadline'):'cancelled';
  const unchanged=({original:o,snapshot:s}:Lease)=>{
   for(const key of ['deploymentId','providerId','runtimeRevision','modelRevision','custodyRevision','execution','dataEgress','closure','expiresAtMs']as const)if(o[key]!==s[key])return false;
   return Array.isArray(o.purposes)&&o.purposes.length===s.purposes.length&&o.purposes.every((value,index)=>value===s.purposes[index])&&Array.isArray(o.dependencies)&&o.dependencies.length===s.dependencies.length&&o.dependencies.every((value,index)=>value===s.dependencies[index]);
  };
  const receipt=(status:ContinuityRouteReceipt['status'],reason:string)=>{
   if(settled)return;settled=true;if(timer)clearTimeout(timer);
   const record:ContinuityRouteReceipt=Object.freeze({purpose,deploymentId:this.host.deploymentId,providers:Object.freeze(leases.map(({snapshot:s})=>Object.freeze({providerId:s.providerId,runtimeRevision:s.runtimeRevision,modelRevision:s.modelRevision,custodyRevision:s.custodyRevision}))),status,reason,providerStarted:started,providerCompletionObserved:completed,qualification:'callBoundaryOnly'});
   try{this.host.receipt?.(record);}catch{/* Receipt failure cannot grant a route. */}
  };
  const visit=(p:object)=>{
   if(!p||typeof p!=='object')fail('custodyUnavailable');if(visiting.has(p))fail('dependencyCycle');if(seen.has(p))return;if(leases.length>=32)fail('dependencyBound');
   const raw=this.host.resolveCustody(p,purpose);if(!raw)fail('custodyUnavailable');
   if(![raw.deploymentId,raw.providerId,raw.runtimeRevision,raw.modelRevision,raw.custodyRevision].every(id)||raw.deploymentId!==this.host.deploymentId||raw.execution!=='local'||raw.dataEgress!=='local'||raw.closure!=='complete'||!Array.isArray(raw.purposes)||raw.purposes.length>5||!raw.purposes.includes(purpose)||!Array.isArray(raw.dependencies)||raw.dependencies.length>32||!Number.isFinite(raw.expiresAtMs))fail('localCustodyRequired');
   if(raw.expiresAtMs<=wall)fail('custodyExpired');
   const snapshot:ProviderCustody=Object.freeze({...raw,purposes:Object.freeze([...raw.purposes]),dependencies:Object.freeze([...raw.dependencies])});
   leases.push({provider:p,original:raw,snapshot});visiting.add(p);for(const child of snapshot.dependencies)visit(child);visiting.delete(p);seen.add(p);
  };
  const check=()=>{
   const now=Date.now();if(now<lastWall)fail('clockChanged');lastWall=now;
   if(now>=deadline||performance.now()-mono>=deadline-wall)fail('deadline');
   if(signal.aborted)fail(abortReason());
   for(const lease of leases){
    const {provider:p,original,snapshot:s}=lease;
    if(!unchanged(lease))fail('custodyChanged');
    if(now>=s.expiresAtMs)fail('custodyExpired');
    // Host currency must include provider binding, dependency closure and original
    // custody revision; no callback supplied by data being processed is accepted.
    if(this.host.isCurrent(p,original)!==true)fail('custodyChanged');
   }
   if(leases.some(lease=>!unchanged(lease)))fail('custodyChanged');
  };
  const reason=(e:unknown)=>e instanceof ContinuityRouteError?e.reason:'providerFailure';
  const finishError=(e:unknown)=>{const r=reason(e);receipt(r==='deadline'?'timedOut':r==='cancelled'?'cancelled':started?'failed':'blocked',r);};
  try{
   if(!continuityPurposes.includes(purpose)||!Number.isFinite(deadline)||this.host.maximumDurationMs!==undefined&&deadline-wall>this.host.maximumDurationMs)fail('invalidCallBound');
   check();visit(provider);check();
   const expiry=Math.min(deadline,...leases.map(l=>l.snapshot.expiresAtMs));
   // Only an alarm for the original call/owner expiry; never refresh custody.
   // Long timer delays are segmented solely to avoid Node's 32-bit timer overflow.
   const expiryReason=expiry<deadline?'custodyExpired':'deadline',alarmDeadline=mono+expiry-wall;
   const alarm=()=>{const remaining=Math.min(expiry-Date.now(),alarmDeadline-performance.now());if(remaining<=0){controller.abort(expiryReason);return;}timer=setTimeout(alarm,Math.min(remaining,2147483647));};
   alarm();
  }catch(e){finishError(e);throw e;}
  const wait=async<T>(action:()=>Promise<T>):Promise<T>=>{
   check();let abort=()=>{};
   try{return await Promise.race([new Promise<never>((_,reject)=>{abort=()=>reject(new ContinuityRouteError(abortReason()));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}),Promise.resolve().then(()=>{check();return action();})]);}
   finally{signal.removeEventListener('abort',abort);}
  };
  return{signal,check,wait,start:()=>{check();started=true;},complete:()=>{completed=true;},success:()=>receipt('completed','providerCompleted'),error:finishError,close:()=>{if(timer)clearTimeout(timer);controller.abort();}};
 }
 async call<T>(provider:object,purpose:ContinuityPurpose,call:{deadlineAt:string;signal:AbortSignal},invoke:(provider:object,signal:AbortSignal)=>Promise<T>):Promise<T>{
  const operation=this.begin(provider,purpose,call);
  try{const result=await operation.wait(()=>{operation.start();return invoke(provider,operation.signal).then(value=>{operation.complete();return value;});});operation.check();operation.success();return result;}
  catch(e){operation.error(e);throw e;}finally{operation.close();}
 }
 async *stream<T>(provider:object,purpose:ContinuityPurpose,call:{deadlineAt:string;signal:AbortSignal},invoke:(provider:object,signal:AbortSignal)=>AsyncIterable<T>):AsyncIterable<T>{
  const operation=this.begin(provider,purpose,call);let iterator:AsyncIterator<T>|undefined,count=0,finished=false;
  try{
   operation.start();iterator=invoke(provider,operation.signal)[Symbol.asyncIterator]();
   for(;;){const next=await operation.wait(()=>iterator!.next());operation.check();if(next.done){finished=true;operation.complete();operation.success();return;}if(++count>(this.host.maximumChunks??1024))fail('chunkBound');yield next.value;}
  }catch(e){operation.error(e);throw e;}finally{
   if(!finished)operation.error(new ContinuityRouteError('consumerClosed'));operation.close();
   // Uncooperative provider cleanup must not extend the original caller deadline.
   // Merely requesting return/abort never asserts completion or slot release.
   if(iterator?.return&&!finished)try{void Promise.resolve(iterator.return()).catch(()=>{});}catch{/* no release claim */}
  }
 }
}

/** Metadata from the authentic existing prepared turn, not a reconstructed prompt
 * or a new source-use grant. Consumers must recheck the original owner at use. */
export function continuityTurnReferences(turn:FinalizedTurn,binding:PreparedTurnBinding,current:()=>boolean){
 const request=requestForFinalizedTurn(turn,binding,current),view=turn.preparedContext;
 if(!view||turn.binding!==binding)throw new ContinuityRouteError('preparedContextUnavailable');
 return Object.freeze({viewId:view.viewId,revision:view.revision,invalidationKey:view.invalidationKey,
  originalDeadlineAt:request.deadlineAt,freshUntil:view.freshUntil,
  sourceRevisions:turn.sourceRevisions,sections:turn.sections});
}
