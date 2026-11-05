import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator,type ValidationResult} from './validator.ts';
import {unifiedDesktopSnapshot,contractFailure,contractSuccess} from './unified-desktop-contracts.ts';
import {validateMobileLocation} from './mobile-context-location.ts';
import {mobileContextSignalPin} from './mobile-context-signal.pin.ts';
import type {ContextSignal,ContextSignalAgeContext,ContextSignalAgeAssessment,ContextSignalView} from './mobile-context-signal.types.ts';
export type * from './mobile-context-signal.types.ts';
export {mobileContextSignalPin};
export const contextSignalLimits=Object.freeze({bytes:65536,maximumAgeMs:Number.MAX_SAFE_INTEGER});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-signal.schema.json',import.meta.url))).digest('hex')!==mobileContextSignalPin.digest)throw Error('context_signal_producer_pin_mismatch');
const validator=createContractValidator();
type Kind='ContextSignal'|'ContextSignalAgeContext'|'ContextSignalAgeAssessment'|'ContextSignalView';
// Inspect descriptors before copying. Proxies/accessors never execute at this boundary.
function snapshot(input:unknown,maxBytes:number=contextSignalLimits.bytes):unknown|undefined {
 let nodes=0;const seen=new Set<object>();
 function safe(v:unknown,depth:number):boolean {
  if(++nodes>65536||depth>32)return false;
  if(typeof v==='string')return wellFormed(v);
  if(v===null||typeof v!=='object')return true;
  if(types.isProxy(v)||seen.has(v))return false;
  seen.add(v);
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(v))){
   if(!wellFormed(key)||!('value'in d)||!safe(d.value,depth+1))return false;
  }
  seen.delete(v);return true;
 }
 try{return safe(input,0)?unifiedDesktopSnapshot(input,maxBytes):undefined;}catch{return undefined;}
}
function wellFormed(v:string):boolean {
 for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=v.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}return true;
}
const instant=(v:string)=>validateMobileLocation('LocationAgeContext',{referenceAt:v,maximumAgeMs:0}).valid;
export function admitContextSignalConsumer(input:unknown):boolean {
 const p=snapshot(input,4096) as Record<string,unknown>|undefined;
 return !!p&&Object.keys(p).sort().join(',')==='digest,schemaId,schemaVersion'&&p.schemaId===mobileContextSignalPin.schemaId&&p.schemaVersion===mobileContextSignalPin.schemaVersion&&p.digest===mobileContextSignalPin.digest;
}
export function validateContextSignal(kind:Kind,input:unknown):ValidationResult {
 const value=snapshot(input);
 if(value===undefined)return contractFailure('bounds','Bounded well-formed JSON required.');
 if(!['ContextSignal','ContextSignalAgeContext','ContextSignalAgeAssessment','ContextSignalView'].includes(kind))return contractFailure('schema','Unknown context signal record.');
 const result=validator.validate(mobileContextSignalPin.schemaId+'#/$defs/'+kind,value);
 if(!result.valid)return result;
 if(kind==='ContextSignal'){
  const v=value as ContextSignal;
  if(!instant(v.collectedAt)||v.observedAt!==null&&!instant(v.observedAt))return contractFailure('instant','Exact Gregorian UTC required.');
 }
 if(kind==='ContextSignalAgeContext'){
  const v=value as ContextSignalAgeContext;
  if(!validateMobileLocation('LocationAgeContext',v).valid)return contractFailure('ageContext','Exact reference and safe explicit age bound required.');
 }
 if(kind==='ContextSignalAgeAssessment'&&!validateMobileLocation('LocationAgeAssessment',value).valid)return contractFailure('age','Exact age label and safe explicit bound required.');
 return contractSuccess();
}
export function contextSignalSnapshot<T extends ContextSignal|ContextSignalAgeContext|ContextSignalAgeAssessment|ContextSignalView>(kind:Kind,input:unknown):T|null {
 const v=snapshot(input);return validateContextSignal(kind,v).valid?v as T:null;
}
// UTC text already passed the frozen Location parser. BigInt retains all 9 digits.
function nanoseconds(v:string):bigint {
 const whole=v.slice(0,19),fraction=v.includes('.')?v.slice(20,-1):'';
 return BigInt(Date.parse(whole+'Z'))*1000000n+BigInt(fraction.padEnd(9,'0'));
}
export function assessContextSignalAge(input:unknown,context:unknown):ContextSignalAgeAssessment|null {
 const v=contextSignalSnapshot<ContextSignal>('ContextSignal',input),c=contextSignalSnapshot<ContextSignalAgeContext>('ContextSignalAgeContext',context);
 if(!v||!c)return null;
 const unknown=(reason:'unavailable'|'futureObservation'|'futureCollection'|'observationAfterCollection'):ContextSignalAgeAssessment=>({state:'unknown',reason,ageNanoseconds:null,maximumAgeMs:c.maximumAgeMs,qualification:'observationAgeOnly'});
 if(v.signal.kind==='unavailable'||v.observedAt===null)return unknown('unavailable');
 const observed=nanoseconds(v.observedAt),collected=nanoseconds(v.collectedAt),reference=nanoseconds(c.referenceAt);
 if(observed>reference)return unknown('futureObservation');
 if(collected>reference)return unknown('futureCollection');
 if(observed>collected)return unknown('observationAfterCollection');
 const age=reference-observed;
 return {state:age<=BigInt(c.maximumAgeMs)*1000000n?'fresh':'stale',ageNanoseconds:age.toString(),maximumAgeMs:c.maximumAgeMs,qualification:'observationAgeOnly'};
}
/** Quoted source declaration only. No current-state, authority or execution inference. */
export function contextSignalView(input:unknown):ContextSignalView|null {
 const v=contextSignalSnapshot<ContextSignal>('ContextSignal',input);
 return v?{qualification:'declaredSignalOnly',signal:v.signal}:null;
}
