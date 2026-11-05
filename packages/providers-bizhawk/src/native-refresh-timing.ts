import {performance} from 'node:perf_hooks';
import {types} from 'node:util';

const milliseconds=(value:number)=>Math.min(600001,Math.max(0,Math.round(value)));
export type NativeRefreshTiming=Readonly<{
 schemaVersion:'native-client-refresh-timing/1';startedAtMs:number;budgetMs:number;
 callbackEnteredAfterMs:number|null;callbackSettledAfterMs:number|null;elapsedMs:number;
 eventLoopActiveMs:number;eventLoopIdleMs:number;processUserCpuMs:number;processSystemCpuMs:number;
}>;
/** The private writer accepts only these diagnostic scalars, even if a trusted
 * caller accidentally passes a larger object. Getters/proxies are never read. */
export function captureNativeRefreshTiming(value:unknown):NativeRefreshTiming|null{
 try{
  if(!value||typeof value!=='object'||types.isProxy(value))return null;
  const keys=['schemaVersion','startedAtMs','budgetMs','callbackEnteredAfterMs','callbackSettledAfterMs','elapsedMs','eventLoopActiveMs','eventLoopIdleMs','processUserCpuMs','processSystemCpuMs'];
  const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(key=>typeof key!=='string'||!keys.includes(key)))return null;
  const fields:Record<string,unknown>={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))return null;fields[key]=descriptor.value;}
  if(fields.schemaVersion!=='native-client-refresh-timing/1'||!Number.isSafeInteger(fields.startedAtMs)||Number(fields.startedAtMs)<0||!Number.isSafeInteger(fields.budgetMs)||Number(fields.budgetMs)<1||Number(fields.budgetMs)>120000)return null;
  for(const key of keys.slice(3))if(fields[key]!==null||!key.startsWith('callback')){
   if(!Number.isSafeInteger(fields[key])||Number(fields[key])<0||Number(fields[key])>600001)return null;
  }
  return Object.freeze(fields) as NativeRefreshTiming;
 }catch{return null;}
}

/** Diagnostic clocks only. This neither supplies currentness nor changes an
 * existing timeout, inspection, lease, cancellation or operation. */
export function beginNativeRefreshTiming(budgetMs:number){
 const startedAtMs=Date.now(),started=performance.now(),loop=performance.eventLoopUtilization(),cpu=process.cpuUsage();
 let entered:number|null=null,settled:number|null=null;
 return Object.freeze({
  entered(){entered??=milliseconds(performance.now()-started);},
  settled(){settled??=milliseconds(performance.now()-started);},
  snapshot():NativeRefreshTiming{
   const elapsed=performance.now()-started,used=process.cpuUsage(cpu),activity=performance.eventLoopUtilization(loop);
   return Object.freeze({schemaVersion:'native-client-refresh-timing/1',startedAtMs,budgetMs,
    callbackEnteredAfterMs:entered,callbackSettledAfterMs:settled,elapsedMs:milliseconds(elapsed),
    eventLoopActiveMs:milliseconds(activity.active),eventLoopIdleMs:milliseconds(activity.idle),
    processUserCpuMs:milliseconds(used.user/1000),processSystemCpuMs:milliseconds(used.system/1000)});
  }
 });
}

export type NativeInspectionPhase='queued'|'owner-before'|'engine-read'|'owner-after'|'finished'|'failed';
export function createNativeInspectionTiming(now:()=>number=()=>performance.now()){
 let sequence=0,last:{sequence:number;started:number;changed:number;phase:NativeInspectionPhase;durations:Partial<Record<NativeInspectionPhase,number>>}|undefined;
 return Object.freeze({
  begin(){
   const started=now(),state={sequence:++sequence,started,changed:started,phase:'queued' as NativeInspectionPhase,durations:{} as Partial<Record<NativeInspectionPhase,number>>};last=state;
   return Object.freeze({phase(next:NativeInspectionPhase){
    const time=now();state.durations[state.phase]=(state.durations[state.phase]??0)+Math.max(0,time-state.changed);state.changed=time;state.phase=next;
   }});
  },
  snapshot(){
   if(!last)return null;const time=now(),durations={...last.durations};
   durations[last.phase]=(durations[last.phase]??0)+Math.max(0,time-last.changed);
   const complete=last.phase==='finished'||last.phase==='failed';
   return Object.freeze({sequence:last.sequence,phase:last.phase,elapsedMs:milliseconds((complete?last.changed:time)-last.started),completedAgeMs:complete?milliseconds(time-last.changed):null,
    queuedMs:milliseconds(durations.queued??0),ownerBeforeMs:milliseconds(durations['owner-before']??0),
    engineReadMs:milliseconds(durations['engine-read']??0),ownerAfterMs:milliseconds(durations['owner-after']??0)});
  }
 });
}
