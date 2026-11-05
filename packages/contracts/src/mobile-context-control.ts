import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import{createContractValidator}from'./validator.ts';
import{unifiedDesktopSnapshot}from'./unified-desktop-contracts.ts';
import{mobileControlPin}from'./mobile-context-control.pin.ts';
import type{MobileControlRequest,MobileControlResponse,MobileControlOutcome}from'./mobile-context-control.types.ts';
export{mobileControlPin};export type * from'./mobile-context-control.types.ts';
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-control.schema.json',import.meta.url))).digest('hex')!==mobileControlPin.digest)throw Error('mobile_control_pin_mismatch');
const validator=createContractValidator(),uuid=(v:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
// Canonical digest encoding: UTF-8 JSON, lexicographic object keys, original
// array order, ordinary JSON string escaping, finite safe integers only here.
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export function admitMobileControlConsumer(pin:unknown):boolean{if(!pin||typeof pin!=='object')return false;const fields=Object.getOwnPropertyDescriptors(pin);return Reflect.ownKeys(fields).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>fields[k]&&'value'in fields[k]!&&fields[k]!.value===mobileControlPin[k]);}
function validRequest(r:MobileControlRequest):boolean{
 const t=r.target,a=r.action;
 if(a.kind==='enroll')return t.enrollmentId===null&&t.sourceNamespace===null&&t.expectedRevision===0;
 if(t.enrollmentId===null||t.expectedRevision<1)return false;
 if(a.kind==='bindSource')return t.sourceNamespace===null;
 if(a.kind==='configure'&&a.configuration.preferredSource!==undefined&&/[\uD800-\uDFFF]/u.test(a.configuration.preferredSource))return false;
 return t.sourceNamespace!==null&&t.expectedRevision<Number.MAX_SAFE_INTEGER;
}
export function mobileControlRequest(input:unknown):MobileControlRequest|null{
 const r=unifiedDesktopSnapshot(input,65536)as MobileControlRequest|undefined;
 return r&&Buffer.byteLength(JSON.stringify(r))<=65536&&validator.validate(mobileControlPin.schemaId+'#/$defs/MobileControlRequest',r).valid&&validRequest(r)?r:null;
}
export function mobileControlRequestDigest(input:unknown):string|null{const r=mobileControlRequest(input);return r?createHash('sha256').update(canonical(r),'utf8').digest('hex'):null;}
function validOutcome(o:MobileControlOutcome):boolean{
 const r=mobileControlRequest(o.originalRequest);if(!r||o.requestDigest!==mobileControlRequestDigest(r)||(o.current.state==='unavailable')!==(o.current.policyRevision===null))return false;
 if(o.status!=='applied')return true;
 const result=o.receipt.result,e=result.enrollment,t=r.target;
 if(e.configuration.preferredSource!==undefined&&/[\uD800-\uDFFF]/u.test(e.configuration.preferredSource))return false;
 if(result.kind!==r.action.kind||e.principalId!==t.principalId||e.endpointId!==t.endpointId||e.collector!==t.collector||!uuid(e.enrollmentId)||e.sourceNamespace!==null&&!uuid(e.sourceNamespace)||(e.state==='unbound')!==(e.sourceNamespace===null)||o.current.state==='current'&&o.current.policyRevision!==e.revision)return false;
 if(t.enrollmentId!==null&&e.enrollmentId!==t.enrollmentId)return false;
 switch(r.action.kind){
  case'enroll':return true; // May return an existing enrollment; never authority to activate it.
  case'bindSource':{const b=r.action.binding;return e.state==='disconnected'&&e.sourceNamespace!==null&&('sourceNamespace'in b?e.sourceNamespace===b.sourceNamespace&&e.revision===b.expectedSourceRevision:e.revision===t.expectedRevision);}
  case'configure':return e.sourceNamespace===t.sourceNamespace&&e.revision===t.expectedRevision+1&&e.state===r.action.state&&canonical(e.configuration)===canonical(r.action.configuration);
  case'remove':return result.kind==='remove'&&e.sourceNamespace===t.sourceNamespace&&e.revision===t.expectedRevision+1&&(result.removedCount===0||result.suppressionEpoch>0);
 }
}
export function mobileControlResponse(input:unknown):MobileControlResponse|null{
 const response=unifiedDesktopSnapshot(input,262144)as MobileControlResponse|undefined;
 return response&&Buffer.byteLength(JSON.stringify(response))<=262144&&validator.validate(mobileControlPin.schemaId+'#/$defs/MobileControlResponse',response).valid&&admitMobileControlConsumer(response.producerPin)&&validOutcome(response.result)?response:null;
}
/** A consumer may settle ONLY its exact original operation from a typed durable
 * terminal receipt. This predicate neither changes settings nor dispatches I/O.
 * A historical applied receipt never reinstates its old source permissions. */
export function mobileControlSettlement(expected:unknown,input:unknown):'applied'|'rejected'|'held'{
 const request=mobileControlRequest(expected),response=mobileControlResponse(input);if(!request||!response||canonical(request)!==canonical(response.result.originalRequest))return'held';
 return response.result.status==='applied'||response.result.status==='rejected'?response.result.status:'held';
}
