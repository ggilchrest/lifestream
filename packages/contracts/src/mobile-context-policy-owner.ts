import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {healthPolicyPin} from './mobile-context-policy-owner.pin.ts';
import type {HealthPolicyOriginal,HealthPolicyEnvelope,HealthPolicyResponse,HealthPolicyScope} from './mobile-context-policy-owner.types.ts';
export {healthPolicyPin}; export type * from './mobile-context-policy-owner.types.ts';
export const healthPolicyLimits=Object.freeze({requestBytes:131072,responseBytes:524288,preparedBytes:262144});
export function healthPolicyCanonical(v:unknown):string{return Array.isArray(v)?'['+v.map(healthPolicyCanonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+healthPolicyCanonical((v as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(v);}
export const healthPolicyDigest=(v:unknown)=>createHash('sha256').update(healthPolicyCanonical(v)).digest('hex');
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-policy-owner.schema.json',import.meta.url))).digest('hex')!==healthPolicyPin.digest)throw Error('health_policy_pin_mismatch');
const validator=createContractValidator();
export function healthPolicySnapshot<T>(name:string,input:unknown,limit:number=healthPolicyLimits.requestBytes):T|null {const v=unifiedDesktopSnapshot(input,limit);return v&&Buffer.byteLength(JSON.stringify(v))<=limit&&validator.validate(healthPolicyPin.schemaId+'#/$defs/'+name,v).valid?v as T:null;}
export const healthPolicyOriginal=(v:unknown)=>healthPolicySnapshot<HealthPolicyOriginal>('Original',v);
export const healthPolicyScope=(v:unknown)=>healthPolicySnapshot<HealthPolicyScope>('Scope',v);
export function healthPolicyEnvelope(v:unknown):HealthPolicyEnvelope|null {const r=healthPolicySnapshot<HealthPolicyEnvelope>('Envelope',v);return r&&healthPolicyCanonical(r.producerPin)===healthPolicyCanonical(healthPolicyPin)?r:null;}
export function healthPolicyResponse(v:unknown):HealthPolicyResponse|null {const r=healthPolicySnapshot<HealthPolicyResponse>('Response',v,healthPolicyLimits.responseBytes);if(!r||healthPolicyCanonical(r.producerPin)!==healthPolicyCanonical(healthPolicyPin))return null;if(r.result.kind==='terminal'){const t=r.result,digest=healthPolicyDigest(t.original);if(t.requestDigest!==digest||t.receipt.requestDigest!==digest||t.receipt.operationId!==t.original.operationId||t.receipt.scopeDigest!==healthPolicyDigest(t.original.scope)||t.binding.reservationDigest!==healthPolicyDigest({requestDigest:digest,state:'pending',attemptStarted:0,prepared:null,outcome:null}))return null;}return r;}
