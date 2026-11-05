import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {mobileControlRequest,mobileControlResponse,mobileControlRequestDigest} from './mobile-context-control.ts';
import {mobileInterpretationPin} from './mobile-context-interpretation.pin.ts';
import type {MobileInterpretationRequest,MobileInterpretationPreviewRequest,MobileInterpretationMutationRequest,MobileInterpretationMetadata,MobileInterpretationResponse,MobileInterpretationSummary} from './mobile-context-interpretation.types.ts';
export {mobileInterpretationPin};
export type * from './mobile-context-interpretation.types.ts';
export const mobileInterpretationLimits=Object.freeze({records:128,candidates:16,queryPages:2,windowMs:31*86400000,responseBytes:262144,controlResponseBytes:65536,metadataBytes:32768});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-interpretation.schema.json',import.meta.url))).digest('hex')!==mobileInterpretationPin.digest)throw Error('mobile_interpretation_pin_mismatch');
const validator=createContractValidator();
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
/** Content binding only. Authentication and policy remain with their actual owners. */
export const mobileInterpretationDigest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export function admitMobileInterpretationConsumer(pin:unknown):boolean{
 if(!pin||typeof pin!=='object')return false;const fields=Object.getOwnPropertyDescriptors(pin);
 return Reflect.ownKeys(fields).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>fields[k]&&'value'in fields[k]!&&fields[k]!.value===mobileInterpretationPin[k]);
}
function snapshot<T>(kind:string,input:unknown,limit:number):T|null{
 const value=unifiedDesktopSnapshot(input,limit);return value&&Buffer.byteLength(JSON.stringify(value))<=limit&&validator.validate(mobileInterpretationPin.schemaId+'#/$defs/'+kind,value).valid?value as T:null;
}
const windowValid=(query:{startAt:string;endAt:string})=>{const start=Date.parse(query.startAt),end=Date.parse(query.endAt);return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=mobileInterpretationLimits.windowMs;};
export function mobileInterpretationRequest(input:unknown):MobileInterpretationRequest|null{
 const r=snapshot<MobileInterpretationRequest>('MobileInterpretationRequest',input,mobileInterpretationLimits.responseBytes);if(!r)return null;
 if(r.operation==='reconcile')return mobileControlRequest(r.controlOriginal)?.action.kind==='configure'?r:null;
 if(!windowValid(r.query))return null;if(r.operation==='inspect')return r;
 if(r.expectedSourceRevision>=Number.MAX_SAFE_INTEGER||r.expectedInterpretationRevision>=Number.MAX_SAFE_INTEGER)return null;
 if(r.operation==='preview')return r;
 if((r.operation==='reverse')!==(r.change.kind==='reverse'))return null;
 const original=mobileControlRequest(r.controlOriginal);if(!original||original.action.kind!=='configure'||original.operationId!==r.operationId||original.target.enrollmentId!==r.query.enrollmentId||original.target.expectedRevision!==r.expectedSourceRevision||!original.action.configuration.assistantIds.includes(r.query.assistantId))return null;
 return r;
}
export function mobileInterpretationIntentDigest(r:MobileInterpretationPreviewRequest|MobileInterpretationMutationRequest):string{
 return mobileInterpretationDigest({operationId:r.operationId,query:r.query,expectedSourceRevision:r.expectedSourceRevision,expectedInterpretationRevision:r.expectedInterpretationRevision,change:r.change});
}
export function mobileInterpretationMetadata(input:unknown):MobileInterpretationMetadata|null{
 const m=snapshot<MobileInterpretationMetadata>('MobileInterpretationMetadata',input,mobileInterpretationLimits.metadataBytes);
 if(!m||!windowValid(m.query)||m.previousRevision>=Number.MAX_SAFE_INTEGER||m.revision!==m.previousRevision+1||m.baseSourceRevision>=Number.MAX_SAFE_INTEGER)return null;
 if([m.beforePreference,m.afterPreference].some(s=>s!==null&&/[\uD800-\uDFFF]/u.test(s)))return null;
 const intent=mobileInterpretationIntentDigest({schemaVersion:'1.0.0',operation:'preview',operationId:m.operationId,query:m.query,expectedSourceRevision:m.baseSourceRevision,expectedInterpretationRevision:m.previousRevision,change:m.change});
 return m.intentDigest===intent?m:null;
}
function validSummary(s:MobileInterpretationSummary):boolean{
 const known=s.sessions.filter(x=>x.asleepMs!==null),total=known.length?known.reduce((n,x)=>n+x.asleepMs!,0):null;
 return s.totalAsleepMs===total&&s.sessions.every(x=>windowValid(x)&&[x.inBedMs,x.asleepMs,x.awakeMs,x.gapMs,...Object.values(x.stageMs)].every(v=>v===null||v!<=Date.parse(x.endAt)-Date.parse(x.startAt)));
}
export function mobileInterpretationResponse(input:unknown):MobileInterpretationResponse|null{
 const response=snapshot<MobileInterpretationResponse>('MobileInterpretationResponse',input,mobileInterpretationLimits.responseBytes);if(!response||!admitMobileInterpretationConsumer(response.producerPin))return null;
 const result=response.result;
 if(result.state==='mutation'){
  if(Buffer.byteLength(JSON.stringify(result.controlResponse))>mobileInterpretationLimits.controlResponseBytes)return null;const control=mobileControlResponse(result.controlResponse);if(!control||control.result.originalRequest.operationId!==result.operationId)return null;
  if(result.interpretationStatus==='applied'&&(control.result.status!=='applied'||result.interpretationRevision===null)||result.interpretationStatus!=='applied'&&result.interpretationRevision!==null)return null;
 }else if(result.state==='inspected'){
  if(!windowValid(result.query)||!validSummary(result.summary)||new Set(result.candidates.map(c=>c.choiceDigest)).size!==result.candidates.length||new Set(result.provenance.records.map(r=>r.recordId)).size!==result.provenance.records.length)return null;
 }else if(result.state==='ready'){
  if(!windowValid(result.query)||!validSummary(result.before)||!validSummary(result.after)||result.nextInterpretationRevision!==result.interpretationRevision+1)return null;
  const original=mobileControlRequest(result.controlOriginal);if(!original||original.action.kind!=='configure'||original.operationId!==result.operationId||original.target.enrollmentId!==result.query.enrollmentId||original.target.expectedRevision!==result.sourceRevision||!mobileControlRequestDigest(original))return null;
 }
 return response;
}
