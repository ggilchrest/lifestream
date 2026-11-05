import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator,type ValidationResult} from './validator.ts';
import {unifiedDesktopSnapshot,contractFailure,contractSuccess} from './unified-desktop-contracts.ts';
import {validateMobileLocation} from './mobile-context-location.ts';
import {mobileActivityPin} from './mobile-context-activity.pin.ts';
import type {ActivityObservation,ActivityAgeContext,ActivityAgeAssessment} from './mobile-context-activity.types.ts';
export type * from './mobile-context-activity.types.ts';
export {mobileActivityPin};
export const mobileActivityLimits=Object.freeze({bytes:65536,candidates:32,maximumAgeMs:Number.MAX_SAFE_INTEGER});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-activity.schema.json',import.meta.url))).digest('hex')!==mobileActivityPin.digest)throw Error('mobile_activity_producer_pin_mismatch');
const validator=createContractValidator();
type Kind='ActivityObservation'|'ActivityAgeContext'|'ActivityAgeAssessment';
// Inspect descriptors before copying. Proxies/accessors never execute at this boundary.
function snapshot(input:unknown,maxBytes:number=mobileActivityLimits.bytes):unknown|undefined {
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
export function admitMobileActivityConsumer(input:unknown):boolean {
 const p=snapshot(input,4096) as Record<string,unknown>|undefined;
 return !!p&&Object.keys(p).sort().join(',')==='digest,schemaId,schemaVersion'&&p.schemaId===mobileActivityPin.schemaId&&p.schemaVersion===mobileActivityPin.schemaVersion&&p.digest===mobileActivityPin.digest;
}
export function validateMobileActivity(kind:Kind,input:unknown):ValidationResult {
 const value=snapshot(input);
 if(value===undefined)return contractFailure('bounds','Bounded well-formed JSON required.');
 if(!['ActivityObservation','ActivityAgeContext','ActivityAgeAssessment'].includes(kind))return contractFailure('schema','Unknown activity record.');
 const result=validator.validate(mobileActivityPin.schemaId+'#/$defs/'+kind,value);
 if(!result.valid)return result;
 if(kind==='ActivityObservation'){
  const v=value as ActivityObservation;
  if(!instant(v.collectedAt)||v.observedAt!==null&&!instant(v.observedAt))return contractFailure('instant','Exact Gregorian UTC required.');
  if(v.observation.kind!=='unavailable'&&v.observation.kind!==v.source.collector)return contractFailure('source','Native representation must match collector.');
  if(v.observation.kind==='androidActivityRecognition'){
   const ids=v.observation.activities.map(a=>a.nativeType);
   if(new Set(ids).size!==ids.length)return contractFailure('duplicateType','One confidence per native activity type.');
  }
 }
 if(kind==='ActivityAgeContext'){
  const v=value as ActivityAgeContext;
  if(!validateMobileLocation('LocationAgeContext',v).valid)return contractFailure('ageContext','Exact reference and safe explicit age bound required.');
 }
 if(kind==='ActivityAgeAssessment'&&!validateMobileLocation('LocationAgeAssessment',value).valid)return contractFailure('age','Exact age label and safe explicit bound required.');
 return contractSuccess();
}
export function mobileActivitySnapshot<T extends ActivityObservation|ActivityAgeContext|ActivityAgeAssessment>(kind:Kind,input:unknown):T|null {
 const v=snapshot(input);return validateMobileActivity(kind,v).valid?v as T:null;
}
// UTC text already passed the frozen Location parser. BigInt retains all 9 digits.
function nanoseconds(v:string):bigint {
 const whole=v.slice(0,19),fraction=v.includes('.')?v.slice(20,-1):'';
 return BigInt(Date.parse(whole+'Z'))*1000000n+BigInt(fraction.padEnd(9,'0'));
}
export function assessMobileActivityAge(input:unknown,context:unknown):ActivityAgeAssessment|null {
 const v=mobileActivitySnapshot<ActivityObservation>('ActivityObservation',input),c=mobileActivitySnapshot<ActivityAgeContext>('ActivityAgeContext',context);
 if(!v||!c)return null;
 const unknown=(reason:'unavailable'|'futureObservation'|'futureCollection'|'observationAfterCollection'):ActivityAgeAssessment=>({state:'unknown',reason,ageNanoseconds:null,maximumAgeMs:c.maximumAgeMs,qualification:'observationAgeOnly'});
 if(v.observation.kind==='unavailable'||v.observedAt===null)return unknown('unavailable');
 const observed=nanoseconds(v.observedAt),collected=nanoseconds(v.collectedAt),reference=nanoseconds(c.referenceAt);
 if(observed>reference)return unknown('futureObservation');
 if(collected>reference)return unknown('futureCollection');
 if(observed>collected)return unknown('observationAfterCollection');
 const age=reference-observed;
 return {state:age<=BigInt(c.maximumAgeMs)*1000000n?'fresh':'stale',ageNanoseconds:age.toString(),maximumAgeMs:c.maximumAgeMs,qualification:'observationAgeOnly'};
}
export type ActivityCategory='stationary'|'walking'|'running'|'cycling'|'inVehicle'|'onFoot'|'tilting'|'unknown';
export type ActivityMeaning={kind:'classifications';categories:ActivityCategory[];unrecognizedNativeTypes:number[]}|{kind:'unavailable';reason:string};
// Report source claims, never pick a winner, infer availability, or combine confidences.
export function mobileActivityMeaning(input:unknown):ActivityMeaning|null {
 const v=mobileActivitySnapshot<ActivityObservation>('ActivityObservation',input);if(!v)return null;
 const o=v.observation;if(o.kind==='unavailable')return {kind:'unavailable',reason:o.reason};
 const categories=new Set<ActivityCategory>(),unrecognizedNativeTypes:number[]=[];
 if(o.kind==='coreMotion'){
  for(const name of ['stationary','walking','running','cycling','automotive','unknown'] as const)if(o.flags[name])categories.add(name==='automotive'?'inVehicle':name);
 }else{
  const labels:Record<number,ActivityCategory>={0:'inVehicle',1:'cycling',2:'onFoot',3:'stationary',4:'unknown',5:'tilting',7:'walking',8:'running'};
  for(const a of o.activities){const label=labels[a.nativeType];if(label)categories.add(label);else unrecognizedNativeTypes.push(a.nativeType);}
 }
 return {kind:'classifications',categories:[...categories].sort(),unrecognizedNativeTypes:unrecognizedNativeTypes.sort((a,b)=>a-b)};
}
