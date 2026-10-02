import {performance} from 'node:perf_hooks';

const safe=fn=>{try{return fn()===true;}catch{return false;}};
const positive=(value,max)=>Number.isSafeInteger(value)&&value>=1&&value<=max;
const nativeNames=['resolveAttachment','bindingCurrent','controllerCurrent','sourceCurrent','sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease','usageFor','shutdownExactOldLease'];
const campaignNames=['selectPlanning','planningCurrent','terminalRef','publishDecision','prepareController','controllerCurrent','recordSettledStep'];

/** Trusted source composition only. The authenticated server supplies its own
 * runtime and coordinator; these callbacks cannot create authentication or consent. */
export function createSupervisedGameRuntime({native,campaign,createRepository,resolveApproval,memory,inferenceQualificationFor,maximumSteps,maximumRunMs,maximumCommandMs,onStatus=()=>{}}){
 for(const name of nativeNames)if(typeof native?.[name]!=='function')throw Error('Missing qualified native port: '+name);
 for(const name of campaignNames)if(typeof campaign?.[name]!=='function')throw Error('Missing campaign owner port: '+name);
 if(typeof createRepository!=='function'||typeof resolveApproval!=='function'||!positive(maximumSteps,64)||!positive(maximumRunMs,120000)||!positive(maximumCommandMs,5000))throw Error('Invalid finite game composition');
 const nativePins=Object.fromEntries(nativeNames.map(name=>[name,native[name]]));
 const campaignPins=Object.fromEntries(campaignNames.map(name=>[name,campaign[name]]));
 const unchanged=()=>nativeNames.every(name=>native[name]===nativePins[name])&&campaignNames.every(name=>campaign[name]===campaignPins[name]);
 const abort=new AbortController();
 let repository,join,used=false,stopped=false,running,timer,expires=0,lastWall=0,shutdownPromise;
 const report=value=>{try{onStatus(Object.freeze(value));}catch{}};
 const envelopeCurrent=()=>{
  if(stopped||abort.signal.aborted||!unchanged())return false;
  if(!join)return true;
  const now=Date.now();if(now<lastWall||performance.now()>=expires)return false;lastWall=now;return true;
 };
 const shutdown=()=>{
  if(!join)return Promise.resolve();
  if(!shutdownPromise)shutdownPromise=(async()=>{let confirmed=false;try{confirmed=await nativePins.shutdownExactOldLease(join)===true;}catch{}report({state:confirmed?'stopped':'requiresReconciliation',nativeShutdownConfirmed:confirmed});})();
  return shutdownPromise;
 };
 const retire=()=>{if(!stopped){stopped=true;abort.abort();clearTimeout(timer);join?.runtime.close();}return shutdown();};
 const current=()=>{if(!envelopeCurrent()||join&&!safe(join.runtime.isCurrent)){void retire();return false;}return true;};
 // The runtime itself invokes sourceCurrent while checking isCurrent. Keep the
 // outer lease/source predicate separate so that those checks cannot recurse.
 const gameRuntime=Object.freeze({resolveApproval,sourceCurrent:scope=>envelopeCurrent()&&safe(()=>nativePins.sourceCurrent(scope)),...(memory?{memory}:{}),...(inferenceQualificationFor?{inferenceQualificationFor}:{})});
 const gameHost=Object.freeze({maxAttachments:1,maxDurationMs:maximumCommandMs,
  createRepository:database=>{if(repository)throw Error('Second game repository refused');repository=createRepository(database);if(!repository)throw Error('Campaign repository unavailable');return repository;},
  resolveAttachment:(actor,metadata)=>current()?nativePins.resolveAttachment(actor,metadata):null,
  bindingCurrent:(actor,binding)=>current()&&safe(()=>nativePins.bindingCurrent(actor,binding)),
  controllerCurrent:(checkpoint,request)=>current()&&safe(()=>nativePins.controllerCurrent(checkpoint,request))&&safe(()=>campaignPins.controllerCurrent(checkpoint,request)),
  boundary:{sourceAvailable:(scope,pins)=>current()&&safe(()=>nativePins.sourceAvailable(scope,pins)),
   acceptObservation:(request,observation)=>current()&&safe(()=>nativePins.acceptObservation(request,observation)),
   acceptAction:(request,result)=>current()&&safe(()=>nativePins.acceptAction(request,result)),
   reconcileEffect:async(request,context)=>current()&&await nativePins.reconcileEffect(request,context)===true,
   admitRelease:async(request,context)=>current()&&await nativePins.admitRelease(request,context)===true},
  onAttached:value=>{
   if(used||!repository||!current()||!value?.runtime||!safe(value.runtime.isCurrent))throw Error('Authenticated game runtime unavailable');
   for(const name of ['preparePlanning','runPlanning','publishEpisode','isCurrent','controllerCurrent','close'])if(typeof value.runtime[name]!=='function')throw Error('Incomplete authenticated game runtime');
   used=true;join=value;lastWall=Date.now();expires=performance.now()+maximumRunMs;
   timer=setTimeout(retire,maximumRunMs);timer.unref();
   running=(async()=>{
    try{
     for(let index=0;index<maximumSteps&&current();index++){
      const selected=await campaignPins.selectPlanning(join,repository,abort.signal);
      if(!selected||!current())break;
      const step=join.runtime.preparePlanning(selected.selection,selected.bounds);
      const outcome=await join.runtime.runPlanning(step,{current:(scope,checkpoint)=>current()&&safe(()=>campaignPins.planningCurrent(scope,checkpoint)),terminalRef:result=>campaignPins.terminalRef(result,step),publishDecision:result=>current()&&safe(()=>campaignPins.publishDecision(result,step))});
      if(outcome.state!=='published'||!current()){report({state:'suppressed',reason:outcome.reason??outcome.state,index});break;}
      const controller=await campaignPins.prepareController(join,step,outcome,repository,abort.signal);
      if(controller===null){report({state:'modelNoAction',index});break;}
      if(!controller||!current()||!safe(join.runtime.controllerCurrent))throw Error('Current controller selection unavailable');
      const result=await join.runController(controller,{signal:abort.signal,current:(checkpoint,request)=>current()&&safe(()=>campaignPins.controllerCurrent(checkpoint,request)),usageFor:nativePins.usageFor});
      if(result.state!=='settled'){report({state:'requiresReconciliation',index});break;}
      // The campaign owner supplies actual committed journal/source evidence.
      // Memory publication remains subject to independent production consent.
      const recorded=await campaignPins.recordSettledStep(join,controller,result,repository,abort.signal);
      if(!recorded||recorded.journalCommitted!==true)throw Error('Durable campaign journal unavailable');
      if(recorded.episode&&current()){
       const memoryResult=join.runtime.publishEpisode(recorded.episode);
       report({state:'episodePublication',index,retained:memoryResult.state==='retained'});
      }
      report({state:'settled',index});
     }
    }catch{report({state:'suppressed',reason:'qualifiedCurrentPortsUnavailable'});}
    finally{await retire();}
   })();
  }
 });
 return Object.freeze({gameHost,gameRuntime,current,stop:async()=>{await retire();},completion:()=>running??Promise.resolve()});
}
