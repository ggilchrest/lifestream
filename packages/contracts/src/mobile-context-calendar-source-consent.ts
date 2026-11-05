import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {calendarPolicyCanonical as canonical,calendarPolicyDigest as digest} from './mobile-context-calendar-policy-owner.ts';
import {calendarSourceConsentPin} from './mobile-context-calendar-source-consent.pin.ts';
import type {CalendarSourceConsentOriginal,CalendarSourceConsentScope,CalendarSourceConsentEnvelope,CalendarSourceConsentResponse} from './mobile-context-calendar-source-consent.types.ts';
export {calendarSourceConsentPin};export type * from './mobile-context-calendar-source-consent.types.ts';
export {canonical as calendarSourceConsentCanonical,digest as calendarSourceConsentDigest};
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar-source-consent.schema.json',import.meta.url))).digest('hex')!==calendarSourceConsentPin.digest)throw Error('calendar_source_consent_pin_mismatch');
const validator=createContractValidator();
function snapshot<T>(name:string,input:unknown,limit=131072):T|null{const v=unifiedDesktopSnapshot(input,limit);return v&&Buffer.byteLength(JSON.stringify(v))<=limit&&validator.validate(calendarSourceConsentPin.schemaId+'#/$defs/'+name,v).valid?v as T:null;}
export const calendarSourceConsentScope=(v:unknown)=>snapshot<CalendarSourceConsentScope>('Scope',v);
export function calendarSourceConsentOriginal(v:unknown):CalendarSourceConsentOriginal|null{const r=snapshot<CalendarSourceConsentOriginal>('Original',v);if(!r)return null;if(r.command==='approveSourceConsent'&&(r.operationId===r.request.operationId||r.expectedRevision!==r.request.expectedRevision||canonical(r.scope)!==canonical(r.request.scope)))return null;return r;}
export function calendarSourceConsentEnvelope(v:unknown):CalendarSourceConsentEnvelope|null{const r=snapshot<CalendarSourceConsentEnvelope>('Envelope',v);return r&&canonical(r.producerPin)===canonical(calendarSourceConsentPin)&&(r.operation==='inspect'||r.operation==='describe'||!!calendarSourceConsentOriginal(r.payload))?r:null;}
export function calendarSourceConsentResponse(v:unknown):CalendarSourceConsentResponse|null{const r=snapshot<CalendarSourceConsentResponse>('Response',v,524288);if(!r||canonical(r.producerPin)!==canonical(calendarSourceConsentPin))return null;const t=r.result;if(t.kind==='reserved'||t.kind==='terminal'){if(!calendarSourceConsentOriginal(t.original)||t.requestDigest!==digest(t.original))return null;const reservation=digest({requestDigest:t.requestDigest,state:'pending',attemptStarted:0,prepared:null,outcome:null});if(t.kind==='reserved'){if(t.reservationDigest!==reservation||t.confirmationDigest!==digest({requestDigest:t.requestDigest,sourceDigest:t.sourceDigest,reviewContextDigest:t.reviewContextDigest,reservationDigest:reservation}))return null;}else if(t.binding.reservationDigest!==reservation||t.receipt.requestDigest!==t.requestDigest||t.receipt.operationId!==t.original.operationId||t.receipt.scopeDigest!==digest(t.original.scope)||t.receipt.revision!==t.original.expectedRevision+1)return null;}return r;}
