import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {captureNativeSource,nativeSourceException,type NativeSourceCapture} from './native-source-witness.ts';
/** Fixed owner construction only. This opaque handle conveys timing/currentness,
 * never an execution grant, pairing credential or native launch permission. */
declare const brand:unique symbol;
export type NativeExecutionLifetime={readonly [brand]:true};
type OriginalLifecycle={readonly signal:AbortSignal;check():boolean};
type Captured={lifecycle:OriginalLifecycle;check:OriginalLifecycle['check'];signal:AbortSignal;expiresAt:string;wall:number;mono:number;lastWall:number;lastMono:number;retired:boolean;sessionScoped:boolean};
const captures=new WeakMap<object,Captured>();
const unavailable=()=>Error('Original native execution lifetime unavailable');
function state(value:NativeExecutionLifetime):Captured{
 const c=captures.get(value);if(!c)throw unavailable();return c;
}
export function nativeExecutionLifetimeCurrent(value:NativeExecutionLifetime,capture?:NativeSourceCapture):boolean{
 let stage='lifetime-pre',checking='state_lookup';const bad=(value:boolean,predicate:string)=>{if(value)captureNativeSource(capture,{stage,predicate});return value;};
 try{
  const c=state(value),wall=(checking='wall_clock_read',Date.now()),mono=(checking='monotonic_clock_read',performance.now());
  if(bad((checking='not_retired',c.retired),'not_retired'))return false;
  if(bad((checking='wall_finite',!Number.isFinite(wall)),'wall_finite')||bad((checking='monotonic_finite',!Number.isFinite(mono)),'monotonic_finite')||bad((checking='wall_not_regressed',wall<c.lastWall),'wall_not_regressed')||bad((checking='monotonic_not_regressed',mono<c.lastMono),'monotonic_not_regressed')||bad((checking='wall_before_expiry',wall>=c.wall),'wall_before_expiry')||bad((checking='monotonic_before_expiry',mono>=c.mono),'monotonic_before_expiry')||bad((checking='check_identity_matches',c.lifecycle.check!==c.check),'check_identity_matches')||bad((checking='signal_identity_matches',c.lifecycle.signal!==c.signal),'signal_identity_matches')||bad((checking='signal_not_aborted',c.signal.aborted),'signal_not_aborted')||bad((checking='check_returned_true',c.check.call(c.lifecycle)!==true),'check_returned_true')){c.retired=true;return false;}
  // Original check may synchronously abort or spend the last authority time.
  stage='lifetime-post';const afterWall=(checking='wall_clock_read',Date.now()),afterMono=(checking='monotonic_clock_read',performance.now());
  if(bad((checking='not_retired',c.retired),'not_retired')||bad((checking='wall_finite',!Number.isFinite(afterWall)),'wall_finite')||bad((checking='monotonic_finite',!Number.isFinite(afterMono)),'monotonic_finite')||bad((checking='wall_not_regressed',afterWall<wall),'wall_not_regressed')||bad((checking='monotonic_not_regressed',afterMono<mono),'monotonic_not_regressed')||bad((checking='wall_before_expiry',afterWall>=c.wall),'wall_before_expiry')||bad((checking='monotonic_before_expiry',afterMono>=c.mono),'monotonic_before_expiry')||bad((checking='check_identity_matches',c.lifecycle.check!==c.check),'check_identity_matches')||bad((checking='signal_identity_matches',c.lifecycle.signal!==c.signal),'signal_identity_matches')||bad((checking='signal_not_aborted',c.signal.aborted),'signal_not_aborted')){c.retired=true;return false;}
  c.lastWall=afterWall;c.lastMono=afterMono;return true;
 }catch(error){const c=captures.get(value);captureNativeSource(capture,{stage,predicate:checking,exceptionClass:nativeSourceException(error)});if(c)c.retired=true;return false;}
}
export function createNativeExecutionLifetime(lifecycle:OriginalLifecycle,originalExpiresAt:string,sessionLifetime?:'sessionScoped'):NativeExecutionLifetime{
 // Main first verifies the original launcher's lifecycle brand and exact policy.
 // Capture value descriptors once; never invoke replacement/getter-selected ports.
 const check=Object.getOwnPropertyDescriptor(lifecycle,'check'),signal=Object.getOwnPropertyDescriptor(lifecycle,'signal');
 const wall=Date.parse(originalExpiresAt),now=Date.now(),mono=performance.now(),remaining=wall-now;
 if(!Object.isFrozen(lifecycle)||typeof check?.value!=='function'||!(signal?.value instanceof AbortSignal)||typeof originalExpiresAt!=='string'||!Number.isFinite(wall)||!Number.isFinite(mono)||remaining<=0||remaining>(sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:300000)||sessionLifetime!==undefined&&sessionLifetime!=='sessionScoped')throw unavailable();
 const value=Object.freeze({}) as NativeExecutionLifetime;
 captures.set(value,{lifecycle,check:check.value,signal:signal.value,expiresAt:originalExpiresAt,wall,mono:mono+remaining,lastWall:now,lastMono:mono,retired:false,sessionScoped:sessionLifetime==='sessionScoped'});
 if(!nativeExecutionLifetimeCurrent(value))throw unavailable();return value;
}
export function nativeExecutionLifetimeSignal(value:NativeExecutionLifetime):AbortSignal{
 if(!nativeExecutionLifetimeCurrent(value))throw unavailable();return state(value).signal;
}
/** Serializable custody only. It cannot start/pause/reset gameplay or refresh
 * the original absolute authority deadline. Never serialize the opaque handle. */
export function nativeExecutionCustodyBounds(value:NativeExecutionLifetime){
 if(!nativeExecutionLifetimeCurrent(value))throw unavailable();const c=state(value);
 const remainingMs=Math.floor(Math.min(c.wall-Date.now(),c.mono-performance.now()));
 if(remainingMs<1)throw unavailable();
 return Object.freeze({schemaVersion:c.sessionScoped?'ct-native-session-authority-lifetime/1' as const:'ct-native-authority-lifetime/1' as const,expiresAt:c.expiresAt,remainingMs});
}

export function nativeExecutionSessionScoped(value:NativeExecutionLifetime):boolean{
 return nativeExecutionLifetimeCurrent(value)&&state(value).sessionScoped;
}
