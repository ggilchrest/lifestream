import {types} from 'node:util';
import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import {loadCalendarBasicMigrations,assertCalendarMigrationInventory,assertHealthConsentMigrationInventory,type Database} from '@lifestream/storage-sqlite';
import type {ServerOptions} from '../index.ts';
import {healthProductionBackendOptions,type HealthProductionProfile} from './health-production-composition.ts';
import {calendarProductionBackendOptions,type CalendarProductionProfile} from './calendar-production-composition.ts';

export type MobileSourceProductionProfile=Readonly<{health:HealthProductionProfile;calendar:CalendarProductionProfile}>;
/** Discriminate the nested plan without reading extensible properties. This
 * runs before the constructor's plan-selection and mismatch guards. Old plain
 * callback-bearing options retain their own data plan and are not deep-copied. */
export function readMobileSourceSchemaPlan(input:ServerOptions['mobileContext']):string|undefined{
 if(input===undefined||input===null)return undefined;
 if(typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('mobile_source_production_profile');
 const descriptor=Object.getOwnPropertyDescriptor(input,'schemaPlan');
 if(descriptor&&!Object.hasOwn(descriptor,'value'))throw Error('mobile_source_production_profile');
 if(descriptor?.value!==undefined&&typeof descriptor.value!=='string')throw Error('mobile_source_production_profile');
 return descriptor?.value;
}
function data(value:unknown,seen=new Set<object>()):boolean{
 if(value===null||typeof value!=='object')return value===null||['string','number','boolean','undefined'].includes(typeof value);
 if(types.isProxy(value)||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 seen.add(value);return Reflect.ownKeys(value).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>Object.hasOwn(d,'value')&&data(d.value,seen));
}
function snapshot(value:unknown){if(!data(value))throw Error('mobile_source_production_profile');const p=unifiedDesktopSnapshot(value,16384);if(!p||typeof p!=='object'||Array.isArray(p))throw Error('mobile_source_production_profile');return p as Record<string,any>;}
/** Select availability only. Original independent owners remain the sole
 * authorities; no source, policy decision, SDK witness or consent is created. */
export function mobileSourceProductionBackendOptions(input:MobileSourceProductionProfile|undefined):NonNullable<ServerOptions['mobileContext']>|undefined{
 if(input===undefined)return undefined;const p=snapshot(input);
 if(Object.keys(p).sort().join(',')!=='calendar,health')throw Error('mobile_source_production_profile');
 const health=healthProductionBackendOptions(p.health),calendar=calendarProductionBackendOptions(p.calendar);
 if(!health?.healthProduction||!calendar?.calendarProduction||health.maximumControlOperationsPerHuman===undefined)throw Error('mobile_source_production_profile');
 // The existing owners share one repository and its operational bounds.
 for(const key of ['environmentId','destinationId','maximumRecordsPerHuman','maximumControlOperationsPerHuman'])if(p.health[key]!==p.calendar[key])throw Error('mobile_source_production_scope');
 // Calendar finite availability uses the same original finite definition;
 // validate before opening a database, without choosing any retention value.
 healthProductionBackendOptions(p.calendar);
 return Object.freeze({schemaPlan:'mobile-source-consent/1',healthProduction:health.healthProduction,calendarProduction:calendar.calendarProduction,maximumRecordsPerHuman:health.maximumRecordsPerHuman,maximumControlOperationsPerHuman:health.maximumControlOperationsPerHuman,sourceSafetyInitialization:'requireExisting'});
}
/** Capture the trusted factory's explicit combined selection before callbacks.
 * Combined profiles cannot carry injected governance, owner or setup ports. */
export function captureMobileSourceProductionOptions(input:NonNullable<ServerOptions['mobileContext']>,environmentId:string|undefined):NonNullable<ServerOptions['mobileContext']>{
 const p=snapshot(input);
 if(Object.keys(p).sort().join(',')!=='calendarProduction,healthProduction,maximumControlOperationsPerHuman,maximumRecordsPerHuman,schemaPlan,sourceSafetyInitialization'||p.schemaPlan!=='mobile-source-consent/1'||p.sourceSafetyInitialization!=='requireExisting')throw Error('mobile_source_production_profile');
 for(const key of ['healthProduction','calendarProduction'])if(!p[key]||typeof p[key]!=='object'||Array.isArray(p[key])||Object.keys(p[key]).some(k=>!['environmentId','destinationId','finite'].includes(k)))throw Error('mobile_source_production_profile');
 const common={maximumRecordsPerHuman:p.maximumRecordsPerHuman,maximumControlOperationsPerHuman:p.maximumControlOperationsPerHuman};
 const selected=mobileSourceProductionBackendOptions({health:{...p.healthProduction,...common},calendar:{...p.calendarProduction,...common}})!;
 if(!environmentId||selected.healthProduction!.environmentId!==environmentId||selected.calendarProduction!.environmentId!==environmentId)throw Error('mobile_source_production_environment');
 return selected;
}
/** Reuse exactly the existing Calendar consent SQL, without changing either
 * historical strict helper or the default migration catalog. */
export const loadMobileSourceConsentMigrations=():ReturnType<typeof loadCalendarBasicMigrations>=>loadCalendarBasicMigrations(true,true);
export function assertMobileSourceConsentMigrationInventory(database:Database):void{
 const objects=database.connection.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
 if(!objects.length)return;
 if(!objects.some(r=>r.name==='schema_migrations'))throw Error('mobile_source_consent_inventory');
 const rows=database.connection.prepare('SELECT id FROM schema_migrations ORDER BY id').all();
 // Choose the original validator from the inventory, never catch a refusal
 // and retry through a more permissive path. Partial/unknown cohorts refuse.
 if(rows.some(r=>r.id===86||r.id===89))assertCalendarMigrationInventory(database,true,true);
 else assertHealthConsentMigrationInventory(database);
}

/** Explicit control metadata availability, never enrollment or policy authority. */
export function mobileSourceControlProductionBackendOptions(input:MobileSourceProductionProfile|undefined):NonNullable<ServerOptions['mobileContext']>|undefined{
 const selected=mobileSourceProductionBackendOptions(input);
 return selected===undefined?undefined:Object.freeze({...selected,schemaPlan:'mobile-source-control/1'});
}
export function captureMobileSourceControlProductionOptions(input:NonNullable<ServerOptions['mobileContext']>,environmentId:string|undefined):NonNullable<ServerOptions['mobileContext']>{
 const p=snapshot(input);
 if(p.schemaPlan!=='mobile-source-control/1')throw Error('mobile_source_control_profile');
 const selected=captureMobileSourceProductionOptions({...p,schemaPlan:'mobile-source-consent/1'} as NonNullable<ServerOptions['mobileContext']>,environmentId);
 return Object.freeze({...selected,schemaPlan:'mobile-source-control/1'});
}
