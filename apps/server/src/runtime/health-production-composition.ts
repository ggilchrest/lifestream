import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import {types} from 'node:util';
import type {ServerOptions} from '../index.ts';
import type {HealthFiniteConfiguration} from './mobile-context-policy-owner.ts';
export type HealthProductionProfile=Readonly<{environmentId:string;destinationId:string;maximumRecordsPerHuman:number;maximumControlOperationsPerHuman:number;finite?:HealthFiniteConfiguration}>;
/** Trusted explicit selection only: original owners receive identity from host.
 * No policy issuer, Auth callback, consent, retention or source is seeded here. */
export function healthProductionBackendOptions(profile:HealthProductionProfile|undefined):NonNullable<ServerOptions['mobileContext']>|undefined{
 if(profile===undefined)return undefined;
 if(!profile||typeof profile!=='object'||types.isProxy(profile)||![Object.prototype,null].includes(Object.getPrototypeOf(profile)))throw Error('health_production_profile');
 const d=Object.getOwnPropertyDescriptors(profile);if(Reflect.ownKeys(d).some(k=>typeof k!=='string'||!['environmentId','destinationId','maximumRecordsPerHuman','maximumControlOperationsPerHuman','finite'].includes(k)||!Object.hasOwn(d[k]!,'value')))throw Error('health_production_profile');
 const p=unifiedDesktopSnapshot(profile,8192) as HealthProductionProfile|undefined;if(!p)throw Error('health_production_profile');if(![p.environmentId,p.destinationId].every(v=>typeof v==='string'&&v.length>=1&&v.length<=256)||![p.maximumRecordsPerHuman,p.maximumControlOperationsPerHuman].every(v=>Number.isSafeInteger(v)&&v>=1&&v<=100000))throw Error('health_production_profile');
 if(p.finite){const f=p.finite;if(Object.keys(f).sort().join(',')!=='allowedAnchors,allowedDurationDays'||!Array.isArray(f.allowedDurationDays)||!f.allowedDurationDays.length||new Set(f.allowedDurationDays).size!==f.allowedDurationDays.length||f.allowedDurationDays.some(v=>!Number.isSafeInteger(v)||v<=0)||!Array.isArray(f.allowedAnchors)||!f.allowedAnchors.length||new Set(f.allowedAnchors).size!==f.allowedAnchors.length||f.allowedAnchors.some(v=>!['sourceEnd','firstAuthoritativeImport'].includes(v)))throw Error('health_production_finite');}
 return Object.freeze({schemaPlan:'health-consent/1',healthProduction:Object.freeze({environmentId:p.environmentId,destinationId:p.destinationId,...(p.finite?{finite:p.finite}:{})}),maximumRecordsPerHuman:p.maximumRecordsPerHuman,maximumControlOperationsPerHuman:p.maximumControlOperationsPerHuman,sourceSafetyInitialization:'requireExisting'});
}
