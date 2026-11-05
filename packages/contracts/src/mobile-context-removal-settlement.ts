import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {mobileControlRequest,mobileControlRequestDigest,mobileControlResponse,mobileControlSettlement} from './mobile-context-control.ts';
import {removalControlPin} from './mobile-context-removal-settlement.pin.ts';
import type {RemovalControlEnvelope,RemovalControlRequest,RemovalControlResponse} from './mobile-context-removal-settlement.types.ts';
export {removalControlPin};
export type * from './mobile-context-removal-settlement.types.ts';
export const removalControlLimits=Object.freeze({requestBytes:131072,responseBytes:524288});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-removal-settlement.schema.json',import.meta.url))).digest('hex')!==removalControlPin.digest)throw Error('removal_control_pin_mismatch');
const validator=createContractValidator();
const canonical=(v:unknown):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);
export function admitRemovalControlConsumer(pin:unknown):boolean {
 if(!pin||typeof pin!=='object')return false;const fields=Object.getOwnPropertyDescriptors(pin);
 return Reflect.ownKeys(fields).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>fields[k]&&'value'in fields[k]!&&fields[k]!.value===removalControlPin[k]);
}
export function removalControlRequest(input:unknown):RemovalControlRequest|null {
 const r=mobileControlRequest(input);return r&&r.action.kind==='remove'?r as RemovalControlRequest:null;
}
export function removalControlReservationDigest(input:unknown):string|null {
 const r=removalControlRequest(input);return r?createHash('sha256').update(canonical({family:'sourceRemovalControl',requestDigest:mobileControlRequestDigest(r),state:'pending',attemptStarted:0,selection:null,outcome:null})).digest('hex'):null;
}
export function removalControlEnvelope(input:unknown):RemovalControlEnvelope|null {
 const v=unifiedDesktopSnapshot(input,removalControlLimits.requestBytes) as RemovalControlEnvelope|undefined;
 return v&&Buffer.byteLength(JSON.stringify(v))<=removalControlLimits.requestBytes&&validator.validate(removalControlPin.schemaId+'#/$defs/Envelope',v).valid&&admitRemovalControlConsumer(v.producerPin)&&removalControlRequest(v.payload)?v:null;
}
export function removalControlResponse(input:unknown):RemovalControlResponse|null {
 const v=unifiedDesktopSnapshot(input,removalControlLimits.responseBytes) as RemovalControlResponse|undefined;
 if(!v||Buffer.byteLength(JSON.stringify(v))>removalControlLimits.responseBytes||!validator.validate(removalControlPin.schemaId+'#/$defs/Response',v).valid||!admitRemovalControlConsumer(v.producerPin))return null;
 if(v.result.kind==='held')return v;
 const control=mobileControlResponse(v.result.control);if(!control||!removalControlRequest(control.result.originalRequest))return null;
 if(v.result.kind==='terminal'){
  const outcome=control.result,b=v.result.binding;
  if(outcome.status!=='applied'||outcome.receipt.result.kind!=='remove'||b.reservationDigest!==removalControlReservationDigest(outcome.originalRequest)||!b.preparedDigest)return null;
 }
 return v;
}
/** Data-only stable per-operation identity. Context, authentication and the
 * independent producer phase owner must still be established by the caller. */
export function removalControlTerminalIdentity(expected:unknown,input:unknown):string|null {
 const r=removalControlRequest(expected),v=removalControlResponse(input);if(!r||!v||v.result.kind!=='terminal'||mobileControlSettlement(r,v.result.control)==='held')return null;
 const o=v.result.control.result;if(o.status!=='applied'||o.receipt.result.kind!=='remove')return null;
 return createHash('sha256').update(canonical({producerPin:removalControlPin,binding:v.result.binding,original:o.originalRequest,requestDigest:o.requestDigest,status:o.status,receipt:o.receipt})).digest('hex');
}
export function removalControlSettlement(expected:unknown,input:unknown):'applied'|'held' {
 const v=removalControlResponse(input);return removalControlTerminalIdentity(expected,v)&&v?.result.kind==='terminal'?'applied':'held';
}
