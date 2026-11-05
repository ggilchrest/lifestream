import {UbuntuPresenceHost} from './ubuntu-presence-host-factory.ts';
import {createRequire} from 'node:module';
import {Database,AssistantProfileRepository} from '@lifestream/storage-sqlite';
import {canonicalAuthSessionCustody,type LocalAuthentication} from '../auth/local-auth.ts';
import {canonicalQualifiedPresenceProducerCustody,canonicalQualifiedPresenceProducerValidation} from './qualified-presence-producer.ts';
import {canonicalUbuntuPresenceRetentionCustody} from './ubuntu-presence-retention.ts';
import {createPresenceTerminalCustodyOwner,type PresenceTerminalCustodyOwners,type PresenceTerminalCustodyHandle} from './presence-terminal-custody.ts';
import type {PresenceAvailabilityPort,PresenceAvailabilitySelection,PresenceAvailabilityWindow} from './qualified-presence-source.ts';
type Epoch=ReturnType<typeof createPresenceTerminalCustodyOwner>;
const attachProfileFence=Object.getOwnPropertyDescriptor(AssistantProfileRepository,'attachPresenceConfigurationFence')?.value as unknown;
const configurationPublishers=new WeakMap<Database,()=>void>();
const configurations=new WeakMap<Database,{epoch:Epoch;closed:boolean}>();
/** Original writers call this after material evaluation, immediately before a
 * covered write. It always resolves the CURRENT actual database cohort. */
export function invalidateCanonicalPresenceConfiguration(db:Database):void{configurations.get(db)?.epoch.invalidate();}
export function closeCanonicalPresenceConfiguration(db:Database):void{const s=configurations.get(db);if(s){s.epoch.close();s.closed=true;}}
export function canonicalPresenceConfiguration(db:Database):PresenceTerminalCustodyHandle|null{const s=configurations.get(db);return s&&!s.closed?s.epoch.handle:null;}
export function registerCanonicalPresenceConfiguration(db:Database):PresenceTerminalCustodyHandle|null{
 if(!(db instanceof Database))return null;let s=configurations.get(db);if(!s||s.closed){s={epoch:createPresenceTerminalCustodyOwner('configuration'),closed:false};configurations.set(db,s);}
 let publisher=configurationPublishers.get(db);if(!publisher){publisher=()=>invalidateCanonicalPresenceConfiguration(db);configurationPublishers.set(db,publisher);}
 if(typeof attachProfileFence!=='function'||attachProfileFence.call(AssistantProfileRepository,db,publisher)!==true){s.epoch.close();s.closed=true;return null;}return s.epoch.handle;
}
const availabilityOwners=new WeakMap<object,{epoch:Epoch;closed:boolean}>();
/** Explicit internal affirmative writer. Construction publishes NO window and
 * never reads a clock, authentication, camera, identity, enrollment or policy. */
export class CanonicalPresenceAvailability implements PresenceAvailabilityPort{
 readonly revision=1;readonly signal:AbortSignal;readonly read:(s:PresenceAvailabilitySelection)=>PresenceAvailabilityWindow|null;readonly current:(s:PresenceAvailabilitySelection,w:PresenceAvailabilityWindow)=>boolean;
 #controller=new AbortController();#rows=new Map<string,PresenceAvailabilityWindow>();#closed=false;#generation=0;
 constructor(){availabilityOwners.set(this,{epoch:createPresenceTerminalCustodyOwner('availability'),closed:false});this.signal=this.#controller.signal;this.read=s=>{const generation=this.#generation,key=JSON.stringify(s),row=this.#rows.get(key),copy=row?structuredClone(row):null;return !this.#closed&&this.#generation===generation?copy:null;};this.current=(s,w)=>{const generation=this.#generation,same=JSON.stringify(this.#rows.get(JSON.stringify(s)))===JSON.stringify(w);return !this.#closed&&this.#generation===generation&&same;};for(const key of ['revision','signal','read','current'] as const)Object.defineProperty(this,key,{value:this[key],enumerable:true,writable:false,configurable:false});}
 publish(window:PresenceAvailabilityWindow):boolean{
  if(this.#closed)return false;const captured=availabilityOwners.get(this)!;const generation=this.#generation;
  // Closed original window data and material are evaluated before retirement.
  const copy=structuredClone(window),key=JSON.stringify(copy.selection),value=JSON.stringify(copy);
  if(!Number.isSafeInteger(copy.revision)||copy.revision<1||![copy.availableFrom,copy.expiresAt].every(Number.isFinite)||copy.expiresAt<=copy.availableFrom||copy.expiresAt>copy.availableFrom+600000||typeof copy.windowId!=='string'||!copy.windowId||typeof copy.evidenceRef!=='string'||!copy.evidenceRef||!copy.selection||this.#closed||this.#generation!==generation)return false;
  const old=this.#rows.get(key),same=old&&JSON.stringify(old)===value;if(this.#closed||this.#generation!==generation)return false;if(same)return true;if(old&&copy.revision<=old.revision||!old&&this.#rows.size>=8)return false;
  this.#generation++;captured.epoch.invalidate();this.#rows.set(key,copy);return true;
 }
 withdraw():void{if(this.#closed||!this.#rows.size)return;this.#generation++;availabilityOwners.get(this)!.epoch.invalidate();this.#rows.clear();}
 close():void{if(this.#closed)return;const s=availabilityOwners.get(this)!;this.#generation++;s.epoch.close();s.closed=true;this.#closed=true;this.#controller.abort();this.#rows.clear();}
}
export function canonicalAvailabilityCustody(owner:unknown):PresenceTerminalCustodyHandle|null{if(!owner||typeof owner!=='object')return null;const s=availabilityOwners.get(owner);return s&&!s.closed?s.epoch.handle:null;}
type Provider={capture:(owner:unknown)=>object|null;match:(owner:unknown,ticket:object)=>boolean;attach:(owner:unknown,publisher:()=>void)=>boolean};
let providers:{broker:Provider;enrollment:Provider}|null|undefined;
/** Fixed optional package only. Missing or duplicate registry identity denies;
 * no caller API table, path, current verdict or checkout-relative fallback. */
function fixedProviders(){if(providers!==undefined)return providers;try{const require=createRequire(import.meta.url),b=require('@assistant-platform/device-host/src/device-host-broker.js') as Record<string,unknown>,e=require('@assistant-platform/device-host/src/ubuntu-presence-enrollment-owner.js') as Record<string,unknown>;const table=(m:Record<string,unknown>,names:string[]):Provider=>{const [capture,match,attach]=names.map(n=>Object.getOwnPropertyDescriptor(m,n)?.value);if([capture,match,attach].some(v=>typeof v!=='function'))throw Error('Missing canonical provider');return Object.freeze({capture,match,attach}) as Provider;};providers={broker:table(b,['capturePrivatelyOwnedBrokerCustody','matchesPrivatelyOwnedBrokerCustody','attachPrivatelyOwnedBrokerCustodyFence']),enrollment:table(e,['captureUbuntuEnrollmentCustody','matchesUbuntuEnrollmentCustody','attachUbuntuEnrollmentCustodyFence'])};}catch{providers=null;}return providers;}
const canonicalProviders=fixedProviders();
/** Module/export readiness only; does not construct owners or inspect devices, keys or consent. */
export function canonicalPresenceDependenciesAvailable():boolean{return canonicalProviders!==null;}
const bridges=new WeakMap<object,{role:'enrollment'|'configuration';epoch:Epoch;provider:Provider;closed:boolean;configurations:Set<Database>}>();
function bridge(owner:unknown,role:'enrollment'|'configuration',provider:Provider,configuration?:Database):PresenceTerminalCustodyHandle|null{
 if(!owner||typeof owner!=='object'||!provider.capture(owner))return null;const existing=bridges.get(owner);if(existing){if(existing.role!==role||existing.closed)return null;if(configuration)existing.configurations.add(configuration);return existing.epoch.handle;}
 const epoch=createPresenceTerminalCustodyOwner(role),s={role,epoch,provider,closed:false,configurations:new Set<Database>(configuration?[configuration]:[])};bridges.set(owner,s);
 if(!provider.attach(owner,()=>{epoch.invalidate();for(const entry of s.configurations)invalidateCanonicalPresenceConfiguration(entry);if(!provider.capture(owner)){epoch.close();s.closed=true;}})){epoch.close();s.closed=true;return null;}return epoch.handle;
}
const assembledCanonicalMaps=new WeakSet<object>();
const canonicalMapProducerValidations=new WeakMap<object,()=>boolean>();
const canonicalMapProducers=new WeakMap<object,object>();
/** Actual assembled-map pairing only, not a supplied instance registration. */
export function canonicalPresenceProducer(owners:unknown):object|null{return !!owners&&typeof owners==='object'?canonicalMapProducers.get(owners)??null:null;}
/** Only the exact assembled map can retrieve its original constructor validator. */
export function canonicalPresenceProducerValidation(owners:unknown):(()=>boolean)|null{return !!owners&&typeof owners==='object'?canonicalMapProducerValidations.get(owners)??null:null;}
/** Identity only: no caller map/handle/Boolean is registered by this API. */
export function isAssembledCanonicalPresenceOwners(owners:unknown):boolean{return !!owners&&typeof owners==='object'&&assembledCanonicalMaps.has(owners);}
const hostEpochs=new WeakMap<object,Epoch>();
export function canonicalHostEpoch(host:object):Epoch{if(!(host instanceof UbuntuPresenceHost))throw Error('Actual canonical Host required');let e=hostEpochs.get(host);if(!e){e=createPresenceTerminalCustodyOwner('host');hostEpochs.set(host,e);}return e;}
/** Called only by the actual Host constructor with its ORIGINAL composition
 * objects before wrappers. Structural camera/enrollment ports remain legacy. */
export function assembleCanonicalPresenceOwners(host:object,db:Database,authentication:LocalAuthentication,producer:unknown,retention:unknown,broker:unknown,enrollment:unknown,availability:unknown):PresenceTerminalCustodyOwners|null{
 const validate=canonicalQualifiedPresenceProducerValidation(producer);if(!validate)return null;
 const auth=canonicalAuthSessionCustody(authentication,db),p=canonicalQualifiedPresenceProducerCustody(producer),r=canonicalUbuntuPresenceRetentionCustody(retention),a=canonicalAvailabilityCustody(availability),provider=canonicalProviders;if(!auth||!p||!r||!a||!provider)return null;const c=registerCanonicalPresenceConfiguration(db);if(!c)return null;
 const b=bridge(broker,'configuration',provider.broker,db),e=bridge(enrollment,'enrollment',provider.enrollment);if(!b||!e)return null;
 // Broker permission/lease/device changes retire the same configuration role;
 // include its independently source-owned epoch in the exact configuration
 // cohort via a fixed publisher rather than a caller protocol.
 // The actual database configuration handle is shared by all original writers.
 const owners=Object.freeze({availability:a,producer:p,retention:r,enrollment:e,authentication:auth.authentication,session:auth.session,configuration:c,host:canonicalHostEpoch(host).handle});assembledCanonicalMaps.add(owners);canonicalMapProducerValidations.set(owners,validate);canonicalMapProducers.set(owners,producer as object);return owners;
}
