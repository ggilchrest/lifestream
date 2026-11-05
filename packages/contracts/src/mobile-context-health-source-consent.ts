import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {healthPolicyCanonical as canonical,healthPolicyDigest as digest} from './mobile-context-policy-owner.ts';
import {healthSourceConsentPin} from './mobile-context-health-source-consent.pin.ts';
import type {HealthSourceConsentOriginal,HealthSourceConsentScope,HealthSourceConsentEnvelope,HealthSourceConsentResponse} from './mobile-context-health-source-consent.types.ts';
export {healthSourceConsentPin};export type * from './mobile-context-health-source-consent.types.ts';
export {canonical as healthSourceConsentCanonical,digest as healthSourceConsentDigest};
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-health-source-consent.schema.json',import.meta.url))).digest('hex')!==healthSourceConsentPin.digest)throw Error('health_source_consent_pin_mismatch');
const validator=createContractValidator();
function snapshot<T>(name:string,input:unknown,limit=131072):T|null{const v=unifiedDesktopSnapshot(input,limit);return v&&Buffer.byteLength(JSON.stringify(v))<=limit&&validator.validate(healthSourceConsentPin.schemaId+'#/$defs/'+name,v).valid?v as T:null;}
export const healthSourceConsentScope=(v:unknown)=>snapshot<HealthSourceConsentScope>('Scope',v);
export function healthSourceConsentOriginal(v:unknown):HealthSourceConsentOriginal|null{const r=snapshot<HealthSourceConsentOriginal>('Original',v);if(!r)return null;if(r.command==='approveSourceConsent'&&(r.operationId===r.request.operationId||r.expectedRevision!==r.request.expectedRevision||canonical(r.scope)!==canonical(r.request.scope)))return null;return r;}
export function healthSourceConsentEnvelope(v:unknown):HealthSourceConsentEnvelope|null{const r=snapshot<HealthSourceConsentEnvelope>('Envelope',v);return r&&canonical(r.producerPin)===canonical(healthSourceConsentPin)&&(r.operation==='inspect'||r.operation==='describe'||!!healthSourceConsentOriginal(r.payload))?r:null;}
export function healthSourceConsentResponse(v:unknown):HealthSourceConsentResponse|null{const r=snapshot<HealthSourceConsentResponse>('Response',v,524288);if(!r||canonical(r.producerPin)!==canonical(healthSourceConsentPin))return null;const t=r.result;if(t.kind==='reserved'||t.kind==='terminal'){if(!healthSourceConsentOriginal(t.original)||t.requestDigest!==digest(t.original))return null;const reservation=digest({requestDigest:t.requestDigest,state:'pending',attemptStarted:0,prepared:null,outcome:null});if(t.kind==='reserved'){if(t.reservationDigest!==reservation||t.confirmationDigest!==digest({requestDigest:t.requestDigest,sourceDigest:t.sourceDigest,reviewContextDigest:t.reviewContextDigest,reservationDigest:reservation}))return null;}else if(t.binding.reservationDigest!==reservation||t.receipt.requestDigest!==t.requestDigest||t.receipt.operationId!==t.original.operationId||t.receipt.scopeDigest!==digest(t.original.scope)||t.receipt.revision!==t.original.expectedRevision+1)return null;}return r;}
