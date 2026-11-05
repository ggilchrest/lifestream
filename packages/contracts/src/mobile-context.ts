import{createHash}from'node:crypto';
import{readFileSync}from'node:fs';
import {createContractValidator,type ValidationResult} from './validator.ts';
import {unifiedDesktopSnapshot,contractFailure,contractSuccess} from './unified-desktop-contracts.ts';
import {mobileContextPin} from './mobile-context.pin.ts';
import type {MobileChange,IngestBatch,ContextQuery} from './mobile-context.types.ts';
export type * from './mobile-context.types.ts';
export {mobileContextPin};
export const mobileContextLimits=Object.freeze({batchItems:64,batchBytes:262144,queryWindowMs:31*86400000,pageSize:100,samples:256});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context.schema.json',import.meta.url))).digest('hex')!==mobileContextPin.digest)throw Error('mobile_producer_pin_mismatch');
const validator=createContractValidator();
/** Delivery snapshots are data, never caller policy or identity authority. */
export function validateMobileContext(kind:'MobileChange'|'IngestBatch'|'ContextQuery'|'SyncResponse'|'PolicyResponse'|'MobileSourceConfiguration',input:unknown):ValidationResult{
 const value=unifiedDesktopSnapshot(input,mobileContextLimits.batchBytes);
 if(value===undefined||Buffer.byteLength(JSON.stringify(value))>mobileContextLimits.batchBytes)return contractFailure('bounds','Bounded JSON required.');
 const result=validator.validate(mobileContextPin.schemaId+'#/$defs/'+kind,value);if(!result.valid)return result;
 if(kind==='MobileSourceConfiguration')return contractSuccess();
 if(kind==='SyncResponse'||kind==='PolicyResponse'){const response=value as {producerPin:unknown;result:any};if(!admitMobileContextConsumer(response.producerPin))return contractFailure('producerPin','Current producing schema required.');if(kind==='SyncResponse'&&response.result.some((r:any)=>(r.outcome==='accepted'||r.outcome==='duplicate')&&(!r.eventId||!['applied','deleted'].includes(r.code))))return contractFailure('receipt','Durable acknowledgment requires its delivery identity.');if(kind==='PolicyResponse'){const e=response.result.enrollment,p=response.result.effective;if((e.state==='unbound')!==(e.sourceNamespace===null)||p.policyRevision!==e.revision||p.sourceNamespace!==e.sourceNamespace||p.sourceBound!==(e.sourceNamespace!==null)||p.collectionAllowed&&(!p.sourceBound||e.state!=='active')||p.categories.some((v:string)=>!e.configuration.categories.includes(v))||p.uses.some((v:string)=>!e.configuration.uses.includes(v))||p.assistantIds.some((v:string)=>!e.configuration.assistantIds.includes(v)))return contractFailure('policy','Effective policy must agree with its source binding and selected scope.');}return contractSuccess();}
 const v=value as MobileChange|IngestBatch|ContextQuery;
 if(kind==='IngestBatch'){
  const ids=new Set<string>();for(const change of (v as IngestBatch).changes){if(ids.has(change.eventId))return contractFailure('identity','Distinct delivery identities required within one batch.');ids.add(change.eventId);const r=validateMobileContext('MobileChange',change);if(!r.valid)return r;}return contractSuccess();
 }
 if(kind==='ContextQuery'){const q=v as ContextQuery,span=Date.parse(q.endAt)-Date.parse(q.startAt);return span>0&&span<=mobileContextLimits.queryWindowMs?contractSuccess():contractFailure('window','Use bounded paginated query windows; this is not a retention limit.');}
 const change=v as MobileChange;
 if(![change.eventId,change.enrollmentId].every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))return contractFailure('identity','Canonical UUID required.');
 if(change.operation==='delete')return contractSuccess();
 const record=change.record,start=Date.parse(record.startAt),end=record.endAt===undefined?undefined:Date.parse(record.endAt);
 if(end!==undefined&&end<=start)return contractFailure('time','Positive source interval required.');
 if(change.recordType==='SleepSegment')return change.record.stage!=='unknown'||typeof change.record.nativeValue==='string'?contractSuccess():contractFailure('nativeValue','Unknown stages must preserve the native value.');
 const h=change.record,unit=h.measure==='heartRate'||h.measure==='restingHeartRate'?'beatsPerMinute':h.measure==='respiratoryRate'?'breathsPerMinute':'milliseconds';
 if(h.unit!==unit)return contractFailure('unit','Measure and unit must agree.');
 if(h.representation==='point')return h.value!==undefined&&h.samples===undefined&&end===undefined?contractSuccess():contractFailure('representation','A point has one value and instant.');
 if(end===undefined)return contractFailure('representation','Interval and series require an end.');
 if(h.representation==='interval')return h.value!==undefined&&h.samples===undefined?contractSuccess():contractFailure('representation','An interval has one source summary value.');
 if(h.value!==undefined||!h.samples)return contractFailure('representation','A series has samples instead of a summary value.');
 let previous=-Infinity;for(const sample of h.samples){const at=Date.parse(sample.at);if(at<start||at>=end||at<=previous)return contractFailure('samples','Series samples must be ordered distinct instants in the source interval.');previous=at;}
 return contractSuccess();
}
export function mobileContextSnapshot<T extends MobileChange|IngestBatch|ContextQuery>(kind:'MobileChange'|'IngestBatch'|'ContextQuery'|'SyncResponse'|'PolicyResponse'|'MobileSourceConfiguration',input:unknown):T|null{
 const snapshot=unifiedDesktopSnapshot(input,mobileContextLimits.batchBytes);return validateMobileContext(kind,snapshot).valid?snapshot as T:null;
}
export function admitMobileContextConsumer(pin:unknown):boolean{
 if(!pin||typeof pin!=='object')return false;const keys=Object.getOwnPropertyDescriptors(pin);return Reflect.ownKeys(keys).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>keys[k]&&'value'in keys[k]!&&keys[k]!.value===mobileContextPin[k]);
}
