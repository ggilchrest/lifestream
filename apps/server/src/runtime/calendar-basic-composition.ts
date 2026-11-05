import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import type {HealthFiniteConfiguration} from './mobile-context-policy-owner.ts';
import {types} from 'node:util';
import type {Database} from '@lifestream/storage-sqlite';
import type {LocalAuthentication} from '../auth/local-auth.ts';
import type {ServerOptions} from '../index.ts';
import type {CalendarSourcePolicy} from './mobile-context-source-safety.ts';

function configurationData(value:unknown,seen=new Set<object>()):boolean {
 if(value===null||typeof value!=='object')return ['string','number','boolean','undefined'].includes(typeof value)||value===null;
 if(types.isProxy(value)||seen.has(value))return false;seen.add(value);
 return Reflect.ownKeys(value).every(key=>typeof key==='string')&&Object.values(Object.getOwnPropertyDescriptors(value)).every(field=>Object.hasOwn(field,'value')&&configurationData(field.value,seen));
}

export type CalendarBasicBackendProfile=Readonly<{
 policyOwner?:Readonly<{finite?:HealthFiniteConfiguration}>;
 maximumRecordsPerHuman:number;
 maximumControlOperationsPerHuman:number;
 createGovernance?:(database:Database,authentication:LocalAuthentication)=>CalendarSourcePolicy|null;
}>;

/** Capture only actual original methods. Mutation revokes this binding forever;
 * neither a profile nor a schema selection creates policy/retention authority. */
function captureOriginal(value:unknown):CalendarSourcePolicy|null {
 if(!value||typeof value!=='object'||types.isProxy(value))return null;
 const names=['capturePolicy','allowed','retention','invalidate','recordCurrent','captureSyncScope','acceptedRecord'] as const;
 const fields=Object.getOwnPropertyDescriptors(value);
 if(names.some(name=>fields[name]&&(!Object.hasOwn(fields[name]!,'value')||typeof fields[name]!.value!=='function'))||['capturePolicy','allowed','retention','invalidate'].some(name=>typeof fields[name]?.value!=='function'))return null;
 let revoked=false;
 const current=()=>{
  if(revoked)return false;const now=Object.getOwnPropertyDescriptors(value);
  revoked=names.some(name=>fields[name]? !now[name]||now[name]!.value!==fields[name]!.value||now[name]!.get!==undefined||now[name]!.set!==undefined||now[name]!.writable!==fields[name]!.writable||now[name]!.configurable!==fields[name]!.configurable||now[name]!.enumerable!==fields[name]!.enumerable : now[name]!==undefined);
  return !revoked;
 };
 const invoke=(name:typeof names[number],args:unknown[],fallback:unknown)=>{
  if(!current()||!fields[name])return fallback;
  try{const result=fields[name]!.value.apply(value,args);return current()?result:fallback;}catch{return fallback;}
 };
 return Object.freeze({
  allowed:(...args:Parameters<CalendarSourcePolicy['allowed']>)=>invoke('allowed',args,false)===true,
  retention:(...args:Parameters<CalendarSourcePolicy['retention']>)=>invoke('retention',args,null) as ReturnType<CalendarSourcePolicy['retention']>,
  capturePolicy:(...args:Parameters<CalendarSourcePolicy['capturePolicy']>)=>invoke('capturePolicy',args,null) as ReturnType<CalendarSourcePolicy['capturePolicy']>,
  recordCurrent:(...args:Parameters<NonNullable<CalendarSourcePolicy['recordCurrent']>>)=>invoke('recordCurrent',args,false)===true,
  invalidate:(...args:Parameters<CalendarSourcePolicy['invalidate']>)=>{
   if(!current())throw Error('calendar_original_owner_unavailable');
   fields.invalidate!.value.apply(value,args);
   if(!current())throw Error('calendar_original_owner_unavailable');
  },
  ...(fields.acceptedRecord?{acceptedRecord:(...args:Parameters<NonNullable<CalendarSourcePolicy['acceptedRecord']>>)=>{if(!current())throw Error('calendar_import_owner_unavailable');fields.acceptedRecord!.value.apply(value,args);if(!current())throw Error('calendar_import_owner_changed');}}:{}),
  ...(fields.captureSyncScope?{captureSyncScope:(...args:unknown[])=>invoke('captureSyncScope',args,null)}:{})
 }) as CalendarSourcePolicy;
}

export function calendarBasicBackendOptions(profile:CalendarBasicBackendProfile|undefined):NonNullable<ServerOptions['mobileContext']>|undefined {
 if(profile===undefined)return undefined;
 if(!profile||typeof profile!=='object'||types.isProxy(profile)||![Object.prototype,null].includes(Object.getPrototypeOf(profile)))throw Error('calendar_basic_profile_invalid');
 const fields=Object.getOwnPropertyDescriptors(profile);
 if(Reflect.ownKeys(fields).some(k=>typeof k!=='string'||!['maximumRecordsPerHuman','maximumControlOperationsPerHuman','createGovernance','policyOwner'].includes(k)||!Object.hasOwn(fields[k]!,'value')))throw Error('calendar_basic_profile_invalid');
 if(fields.createGovernance?.value===undefined)return undefined;
 const originalOwner=fields.policyOwner?.value;if(originalOwner!==undefined&&!configurationData(originalOwner))throw Error('calendar_basic_profile_invalid');const owner=originalOwner===undefined?undefined:unifiedDesktopSnapshot(originalOwner,8192);if(originalOwner!==undefined&&(!owner||typeof owner!=='object'||Array.isArray(owner)||Object.keys(owner).some(k=>k!=='finite')))throw Error('calendar_basic_profile_invalid');
 const factory=fields.createGovernance.value,records=fields.maximumRecordsPerHuman?.value,operations=fields.maximumControlOperationsPerHuman?.value;
 if(typeof factory!=='function'||typeof records!=='number'||typeof operations!=='number'||![records,operations].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=100000))throw Error('calendar_basic_profile_invalid');
 return Object.freeze({schemaPlan:owner?'calendar-policy/1' as const:'calendar-basic/1' as const,...(owner?{calendarPolicyOwner:owner as {finite?:HealthFiniteConfiguration}}:{}),maximumRecordsPerHuman:records,maximumControlOperationsPerHuman:operations,sourceSafetyInitialization:'requireExisting' as const,
  createCalendarGovernance(database:Database,authentication:LocalAuthentication){try{return captureOriginal(factory(database,authentication));}catch{return null;}}
 });
}
