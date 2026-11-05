import {types} from 'node:util';
import {nativeSourceException} from './native-source-witness.ts';

/** Non-authorizing metadata from the first ORIGINAL owner failure, before cleanup.
 * The caller supplies its already-evaluated predicate; this helper evaluates no
 * clock, source, process, channel, currentness or authority guard. */
export const nativeOwnerFailureStages=Object.freeze(['inspect-poll','readback','transport-disconnect','wrapper-exit','wrapper-error','wrapper-stdin'] as const);
export const nativeOwnerFailurePredicates=Object.freeze(['clock_current','owner_closed','signal_current','child_pid','child_running','cid_current','verified_running','native_monotonic_current','native_wall_current','installation_current','inspection_rejected','inspect_clock_current','inspect_fresh','readback_current','readback_deadline','source_available','transport_closed','wrapper_ended','wrapper_stdin_error'] as const);
export const nativeOwnerTransportCodes=Object.freeze(['invalidFrame','authenticationFailed','disconnected','closed','capacity','invalidResponse','scopeChanged','cancelled','timedOut'] as const);
export type NativeOwnerTransportCode=typeof nativeOwnerTransportCodes[number];
export type NativeOwnerFailureStage=typeof nativeOwnerFailureStages[number];
export type NativeOwnerFailurePredicate=typeof nativeOwnerFailurePredicates[number];
export type NativeOwnerFailureWitness=Readonly<{
 stage:NativeOwnerFailureStage;predicate:NativeOwnerFailurePredicate;exceptionClass:string;
 errno?:string;exitCode?:number;transportCode?:NativeOwnerTransportCode;
}>;
const errnos=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOTDIR','ELOOP','ENOSPC','EMFILE','ENFILE','EPIPE','ECONNREFUSED','ECONNRESET','EADDRINUSE','ETIMEDOUT','EIO']);
const stages:ReadonlySet<string>=new Set(nativeOwnerFailureStages),predicates:ReadonlySet<string>=new Set(nativeOwnerFailurePredicates);
export function createNativeOwnerFailureWitness(stage:NativeOwnerFailureStage,predicate:NativeOwnerFailurePredicate,error?:unknown,transportCode?:unknown):NativeOwnerFailureWitness|undefined{
 try{
  if(!stages.has(stage)||!predicates.has(predicate))return;
  const witness:{stage:NativeOwnerFailureStage;predicate:NativeOwnerFailurePredicate;exceptionClass:string;errno?:string;exitCode?:number;transportCode?:NativeOwnerTransportCode}={stage,predicate,exceptionClass:nativeSourceException(error)};
  if(error&&typeof error==='object'&&!types.isProxy(error)){
   const descriptor=Object.getOwnPropertyDescriptor(error,'code');
   if(descriptor&&Object.hasOwn(descriptor,'value')){
    const code=descriptor.value;
    if(typeof code==='string'&&errnos.has(code))witness.errno=code;
    else if(Number.isSafeInteger(code)&&code>=0&&code<=255)witness.exitCode=code;
   }
  }
  if(stage==='transport-disconnect'&&typeof transportCode==='string'&&(nativeOwnerTransportCodes as readonly string[]).includes(transportCode))witness.transportCode=transportCode as NativeOwnerTransportCode;
  return Object.freeze(witness);
 }catch{return;}
}
/** Optional diagnostics cannot replace the original rejection or cleanup. */
export function captureNativeOwnerFailure(capture:((witness:NativeOwnerFailureWitness)=>void)|undefined,stage:NativeOwnerFailureStage,predicate:NativeOwnerFailurePredicate,error?:unknown,transportCode?:unknown):void{
 if(!capture)return;
 try{const witness=createNativeOwnerFailureWitness(stage,predicate,error,transportCode);if(witness)capture(witness);}catch{}
}
