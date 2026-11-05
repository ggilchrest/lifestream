import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {mobileControlRequest,mobileControlRequestDigest,mobileControlResponse,mobileControlSettlement} from './mobile-context-control.ts';
import {ordinaryControlPin} from './mobile-context-control-settlement.pin.ts';
import type {OrdinaryControlEnvelope,OrdinaryControlRequest,OrdinaryControlResponse} from './mobile-context-control-settlement.types.ts';
export {ordinaryControlPin};
export type * from './mobile-context-control-settlement.types.ts';
export const ordinaryControlLimits=Object.freeze({requestBytes:131072,responseBytes:524288});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-control-settlement.schema.json',import.meta.url))).digest('hex')!==ordinaryControlPin.digest)throw Error('ordinary_control_pin_mismatch');
const validator=createContractValidator();
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export function admitOrdinaryControlConsumer(pin:unknown):boolean {
 if(!pin||typeof pin!=='object')return false;const fields=Object.getOwnPropertyDescriptors(pin);
 return Reflect.ownKeys(fields).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>fields[k]&&'value'in fields[k]!&&fields[k]!.value===ordinaryControlPin[k]);
}
export function ordinaryControlRequest(input:unknown):OrdinaryControlRequest|null {
 const r=mobileControlRequest(input);return r&&['enroll','bindSource','configure'].includes(r.action.kind)?r as OrdinaryControlRequest:null;
}
export function ordinaryControlReservationDigest(input:unknown):string|null {
 const r=ordinaryControlRequest(input);return r?createHash('sha256').update(canonical({requestDigest:mobileControlRequestDigest(r),state:'pending',attemptStarted:0,selection:null,outcome:null})).digest('hex'):null;
}
export function ordinaryControlEnvelope(input:unknown):OrdinaryControlEnvelope|null {
 const v=unifiedDesktopSnapshot(input,ordinaryControlLimits.requestBytes) as OrdinaryControlEnvelope|undefined;
 return v&&Buffer.byteLength(JSON.stringify(v))<=ordinaryControlLimits.requestBytes&&validator.validate(ordinaryControlPin.schemaId+'#/$defs/Envelope',v).valid&&admitOrdinaryControlConsumer(v.producerPin)&&ordinaryControlRequest(v.payload)?v:null;
}
export function ordinaryControlResponse(input:unknown):OrdinaryControlResponse|null {
 const v=unifiedDesktopSnapshot(input,ordinaryControlLimits.responseBytes) as OrdinaryControlResponse|undefined;
 if(!v||Buffer.byteLength(JSON.stringify(v))>ordinaryControlLimits.responseBytes||!validator.validate(ordinaryControlPin.schemaId+'#/$defs/Response',v).valid||!admitOrdinaryControlConsumer(v.producerPin))return null;
 if(v.result.kind==='held')return v;
 const control=mobileControlResponse(v.result.control);if(!control||!ordinaryControlRequest(control.result.originalRequest))return null;
 if(v.result.kind==='terminal'){
  const outcome=control.result,b=v.result.binding;
  if(outcome.status!=='applied'&&outcome.status!=='rejected'||b.reservationDigest!==ordinaryControlReservationDigest(outcome.originalRequest)||(outcome.status==='applied')!==(b.preparedDigest!==undefined))return null;
 }
 return v;
}
/** Data-only stable per-operation identity. Context, authentication and the
 * independent producer phase owner must still be established by the caller. */
export function ordinaryControlTerminalIdentity(expected:unknown,input:unknown):string|null {
 const r=ordinaryControlRequest(expected),v=ordinaryControlResponse(input);if(!r||!v||v.result.kind!=='terminal'||mobileControlSettlement(r,v.result.control)==='held')return null;
 const o=v.result.control.result;if(o.status!=='applied'&&o.status!=='rejected')return null;
 return createHash('sha256').update(canonical({producerPin:ordinaryControlPin,binding:v.result.binding,original:o.originalRequest,requestDigest:o.requestDigest,status:o.status,receipt:o.receipt})).digest('hex');
}
export function ordinaryControlSettlement(expected:unknown,input:unknown):'applied'|'rejected'|'held' {
 const v=ordinaryControlResponse(input);return ordinaryControlTerminalIdentity(expected,v)&&v?.result.kind==='terminal'?mobileControlSettlement(expected,v.result.control):'held';
}
