import {performance} from 'node:perf_hooks';

const kinds=Object.freeze({owner_prepare:'preparation',native_prepare:'preparation',native_start:'preparation',model:'execution',controller:'execution',settle:'execution'});
// Generic host watchdog ceilings. The dedicated selection validator separately
// retains its reviewed model3000/controller500/settle5000 policy. Native input
// duration remains enforced by action contracts and the adapter, not these timers.
const caps=Object.freeze({owner_prepare:120000,native_prepare:120000,native_start:120000,model:120000,controller:120000,settle:60000});
const stopReasons=new Set(['cancelled','revoked','currentness_lost','shutdown','completed','operation_timeout','operation_failed','gameplay_budget_exhausted','invalid_clock']);
const positive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const error=reason=>Object.assign(Error('ct_lifecycle_'+reason),{code:'ct_lifecycle_'+reason});
const safe=fn=>{try{return fn()===true;}catch{return false;}};
const realClock=Object.freeze({now:()=>performance.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)});

/** Inert host-side timing only: no actor, grant, file, provider or native ports.
 * Main must place beginGameplay at the actual first planning boundary, and
 * supply independent original currentness/readiness/quiescence owners. The
 * helper and its snapshots cannot authorize an input or refresh a lease. */
export function createCtJobLifecycle(options){
 if(!options||Object.keys(options).some(k=>!['sessionLifetime','maximumGameplayMs','operationLimits','cleanupTimeoutMs','isCurrent','canExecute','isQuiescent','onStop','signal','clock','onStopCause'].includes(k)))throw error('invalid_options');
 const {sessionLifetime,maximumGameplayMs,operationLimits,cleanupTimeoutMs,isCurrent,canExecute,isQuiescent,onStop,signal,onStopCause,clock=realClock}=options;
 if(sessionLifetime!==undefined&&sessionLifetime!=='sessionScoped')throw error('invalid_limits');
 if(!positive(maximumGameplayMs,sessionLifetime==='sessionScoped'?28800000:300000)||!positive(cleanupTimeoutMs,120000)||!operationLimits||Object.keys(operationLimits).sort().join(',')!==Object.keys(kinds).sort().join(','))throw error('invalid_limits');
 for(const [name,max] of Object.entries(caps))if(!positive(operationLimits[name],max))throw error('invalid_limits');
 for(const fn of [isCurrent,canExecute,isQuiescent,onStop,clock.now,clock.setTimeout,clock.clearTimeout])if(typeof fn!=='function')throw error('missing_host_port');
 if(signal!==undefined&&!(signal instanceof AbortSignal))throw error('invalid_signal');
 if(onStopCause!==undefined&&typeof onStopCause!=='function')throw error('missing_host_port');
 const limits=Object.freeze({...operationLimits});
 const nowPort=clock.now.bind(clock),schedule=clock.setTimeout.bind(clock),clear=clock.clearTimeout.bind(clock);
 const abort=new AbortController();
 let state='preparing',reason=null,started=false,spent=0,activeSince=null,lastNow=nowPort();
 if(!Number.isFinite(lastNow)||lastNow<0)throw error('invalid_clock');
 let playTimer=null,operation=null,cleanupTimer=null,workPending=0,latePending=0,lateFailed=false;
 let cleanup='not_requested',stopHookDone=false,stopHookConfirmed=false,finished=false;
 let resolveCompletion;
 const completion=new Promise(resolve=>{resolveCompletion=resolve;});
 const clearPlay=()=>{if(playTimer!==null){clear(playTimer);playTimer=null;}};
 const elapsed=now=>spent+(activeSince===null?0:Math.max(0,now-activeSince));
 const describe=now=>Object.freeze({state,reason,gameplayStarted:started,maximumGameplayMs,activeGameplayMs:elapsed(now),remainingGameplayMs:Math.max(0,maximumGameplayMs-elapsed(now)),operation:operation?.name??null,workPending,lateCleanupPending:latePending,lateCleanupFailed:lateFailed,cleanup});
 const finishCleanup=confirmed=>{
  if(finished)return;
  finished=true;cleanup=confirmed?'confirmed':'unconfirmed';
  if(cleanupTimer!==null){clear(cleanupTimer);cleanupTimer=null;}
  resolveCompletion(describe(lastNow));
 };
 const maybeFinishCleanup=()=>{
  if(state!=='stopped'||finished||!stopHookDone)return;
  if(!stopHookConfirmed||lateFailed){finishCleanup(false);return;}
  if(workPending===0&&latePending===0)finishCleanup(true);
 };
 const stopAt=(why,now)=>{
  if(state==='stopped')return completion;
  spent=elapsed(now);activeSince=null;state='stopped';reason=why;clearPlay();
  // Capture the original first cause before abort listeners initiate cleanup.
  // This optional fixed-owner diagnostic cannot change a guard or stop result.
  try{onStopCause?.(why);}catch{}
  const pending=operation;operation=null;
  if(pending){clear(pending.timer);pending.reject(error(why));}
  signal?.removeEventListener('abort',externalAbort);
  abort.abort(error(why));
  cleanup='pending';
  // Cleanup is a separate bounded obligation, never free execution time.
  cleanupTimer=schedule(()=>finishCleanup(false),cleanupTimeoutMs);
  Promise.resolve().then(()=>onStop(describe(lastNow))).then(value=>{
   stopHookDone=true;stopHookConfirmed=value===true;maybeFinishCleanup();
  },()=>{stopHookDone=true;stopHookConfirmed=false;maybeFinishCleanup();});
  return completion;
 };
 const readNow=()=>{
  let now;try{now=nowPort();}catch{now=NaN;}
  if(!Number.isFinite(now)||now<lastNow){stopAt('invalid_clock',lastNow);throw error('invalid_clock');}
  lastNow=now;return now;
 };
 const guard=()=>{
  if(state==='stopped')throw error(reason);
  const now=readNow();
  if(state==='stopped')throw error(reason);
  const current=safe(isCurrent);
  if(state==='stopped')throw error(reason);
  if(!current){stopAt('currentness_lost',now);throw error('currentness_lost');}
  if(activeSince!==null&&elapsed(now)>=maximumGameplayMs){stopAt('gameplay_budget_exhausted',now);throw error('gameplay_budget_exhausted');}
  return now;
 };
 const check=()=>{try{guard();return true;}catch{return false;}};
 const armPlay=()=>{
  playTimer=schedule(()=>{
   playTimer=null;
   // Timers can fire slightly early; keep the remaining watchdog armed.
   if(check()&&state==='playing')armPlay();
  },Math.max(1,Math.ceil(maximumGameplayMs-elapsed(lastNow))));
 };
 const externalAbort=()=>{if(state!=='stopped'){let now=lastNow;try{now=readNow();}catch{}stopAt('revoked',now);}};
 const disposeLate=(value,dispose)=>{
  ++latePending;
  Promise.resolve().then(()=>typeof dispose==='function'?dispose(value):false).then(result=>{
   if(result!==true)lateFailed=true;
  },()=>{lateFailed=true;}).finally(()=>{--latePending;maybeFinishCleanup();});
 };
 const api=Object.freeze({
  signal:abort.signal,
  check,
  snapshot(){if(state!=='stopped')check();return describe(lastNow);},
  ready(){
   guard();if(state!=='preparing'||operation)throw error('invalid_transition');
   const quiet=safe(isQuiescent);guard();
   if(!quiet)throw error('not_quiescent');
   if(state!=='preparing'||operation)throw error('invalid_transition');
   state='ready';return describe(lastNow);
  },
  beginGameplay(){
   guard();
   if(!['ready','review'].includes(state)||operation)throw error('invalid_transition');
   const allowed=safe(canExecute);guard();
   if(!allowed)throw error('execution_not_ready');
   const quiet=safe(isQuiescent),now=guard();
   if(!quiet)throw error('not_quiescent');
   if(!['ready','review'].includes(state)||operation)throw error('invalid_transition');
   state='playing';started=true;activeSince=now;
   armPlay();
   return describe(now);
  },
  waitForReview(){
   guard();
   if(state!=='playing'||operation)throw error('invalid_transition');
   const quiet=safe(isQuiescent),now=guard();
   if(!quiet)throw error('not_quiescent');
   if(state!=='playing'||operation)throw error('invalid_transition');
   spent=elapsed(now);activeSince=null;clearPlay();state='review';return describe(now);
  },
  runOperation(name,work,{disposeLateResult}={}){
   guard();
   if(!Object.hasOwn(kinds,name)||typeof work!=='function'||disposeLateResult!==undefined&&typeof disposeLateResult!=='function')throw error('invalid_operation');
   if(operation)throw error('operation_in_flight');
   if(kinds[name]==='preparation'?(started||state!=='preparing'):state!=='playing')throw error('wrong_operation_phase');
   let resolve,reject;
   const result=new Promise((yes,no)=>{resolve=yes;reject=no;});
   const token={name,reject,timer:null};operation=token;++workPending;
   token.timer=schedule(()=>{
    if(operation!==token||state==='stopped')return;
    let now=lastNow;try{now=readNow();}catch{return;}
    stopAt('operation_timeout',now);
   },limits[name]);
   let pending;try{pending=work(Object.freeze({signal:abort.signal}));}catch{pending=Promise.reject(error('operation_failed'));}
   Promise.resolve(pending).then(value=>{
    --workPending;
    if(state!=='stopped'){
     try{
      guard();clear(token.timer);operation=null;resolve(value);return;
     }catch{/* The late value still belongs to its original cleanup owner. */}
    }
    disposeLate(value,disposeLateResult);maybeFinishCleanup();
   },()=>{
    --workPending;
    if(state!=='stopped'){
     clear(token.timer);operation=null;reject(error('operation_failed'));
     let now=lastNow;try{now=readNow();}catch{}
     stopAt('operation_failed',now);
    }
    maybeFinishCleanup();
   });
   return result;
  },
  stop(why='cancelled'){
   if(!stopReasons.has(why))throw error('invalid_stop_reason');
   if(state==='stopped')return completion;
   if(why==='completed'&&operation)throw error('operation_in_flight');
   let now=lastNow;try{now=readNow();}catch{}
   return stopAt(why,now);
  },
  completion:()=>completion
 });
 if(signal?.aborted)externalAbort();else signal?.addEventListener('abort',externalAbort,{once:true});
 // A selected preparation must still be current at construction, even with
 // no operation or gameplay countdown. Later idle revocation uses signal.
 if(state!=='stopped')check();
 return api;
}
