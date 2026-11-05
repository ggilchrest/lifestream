import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {calendarPolicyPin} from './mobile-context-calendar-policy-owner.pin.ts';
import type {CalendarPolicyOriginal,CalendarPolicyEnvelope,CalendarPolicyResponse,CalendarPolicyScope} from './mobile-context-calendar-policy-owner.types.ts';
export {calendarPolicyPin}; export type * from './mobile-context-calendar-policy-owner.types.ts';
export const calendarPolicyLimits=Object.freeze({requestBytes:131072,responseBytes:524288,preparedBytes:262144});
export function calendarPolicyCanonical(v:unknown):string{return Array.isArray(v)?'['+v.map(calendarPolicyCanonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+calendarPolicyCanonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);}
export const calendarPolicyDigest=(v:unknown)=>createHash('sha256').update(calendarPolicyCanonical(v)).digest('hex');
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar-policy-owner.schema.json',import.meta.url))).digest('hex')!==calendarPolicyPin.digest)throw Error('calendar_policy_pin_mismatch');
const validator=createContractValidator();
export function calendarPolicySnapshot<T>(name:string,input:unknown,limit:number=calendarPolicyLimits.requestBytes):T|null {const v=unifiedDesktopSnapshot(input,limit);return v&&Buffer.byteLength(JSON.stringify(v))<=limit&&validator.validate(calendarPolicyPin.schemaId+'#/$defs/'+name,v).valid?v as T:null;}
export const calendarPolicyOriginal=(v:unknown)=>calendarPolicySnapshot<CalendarPolicyOriginal>('Original',v);
export const calendarPolicyScope=(v:unknown)=>calendarPolicySnapshot<CalendarPolicyScope>('Scope',v);
export function calendarPolicyEnvelope(v:unknown):CalendarPolicyEnvelope|null {const r=calendarPolicySnapshot<CalendarPolicyEnvelope>('Envelope',v);return r&&calendarPolicyCanonical(r.producerPin)===calendarPolicyCanonical(calendarPolicyPin)?r:null;}
export function calendarPolicyResponse(v:unknown):CalendarPolicyResponse|null {const r=calendarPolicySnapshot<CalendarPolicyResponse>('Response',v,calendarPolicyLimits.responseBytes);if(!r||calendarPolicyCanonical(r.producerPin)!==calendarPolicyCanonical(calendarPolicyPin))return null;if(r.result.kind==='terminal'){const t=r.result,digest=calendarPolicyDigest(t.original);if(t.requestDigest!==digest||t.receipt.requestDigest!==digest||t.receipt.operationId!==t.original.operationId||t.receipt.scopeDigest!==calendarPolicyDigest(t.original.scope)||t.binding.reservationDigest!==calendarPolicyDigest({requestDigest:digest,state:'pending',attemptStarted:0,prepared:null,outcome:null}))return null;}return r;}
