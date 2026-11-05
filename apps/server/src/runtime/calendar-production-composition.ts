import {types} from 'node:util';
import {unifiedDesktopSnapshot} from '@lifestream/contracts/unified-desktop-contracts';
import type {ServerOptions} from '../index.ts';
import type {HealthFiniteConfiguration} from './mobile-context-policy-owner.ts';
export type CalendarProductionProfile=Readonly<{environmentId:string;destinationId:string;maximumRecordsPerHuman:number;maximumControlOperationsPerHuman:number;finite?:HealthFiniteConfiguration}>;
function data(v:unknown,seen=new Set<object>()):boolean{if(v===null||typeof v!=='object')return ['string','number','boolean','undefined'].includes(typeof v)||v===null;if(types.isProxy(v)||seen.has(v))return false;seen.add(v);return Reflect.ownKeys(v).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,'value')&&data(d.value,seen));}
/** Trusted launcher selects availability and bounds, never grants or consent.
 * No authority/provider callbacks or client-supplied identity are accepted. */
export function calendarProductionBackendOptions(input:CalendarProductionProfile|undefined):NonNullable<ServerOptions['mobileContext']>|undefined{
 if(input===undefined)return undefined;
 if(!data(input))throw Error('calendar_production_profile');const p=unifiedDesktopSnapshot(input,8192) as CalendarProductionProfile|null;
 if(!p||Object.keys(p).some(k=>!['environmentId','destinationId','maximumRecordsPerHuman','maximumControlOperationsPerHuman','finite'].includes(k))||![p.environmentId,p.destinationId].every(s=>typeof s==='string'&&s.length>=1&&s.length<=256)||![p.maximumRecordsPerHuman,p.maximumControlOperationsPerHuman].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=100000))throw Error('calendar_production_profile');
 return Object.freeze({schemaPlan:'calendar-consent/1',calendarProduction:Object.freeze({environmentId:p.environmentId,destinationId:p.destinationId,...(p.finite?{finite:p.finite}:{})}),maximumRecordsPerHuman:p.maximumRecordsPerHuman,maximumControlOperationsPerHuman:p.maximumControlOperationsPerHuman,sourceSafetyInitialization:'requireExisting'});
}
