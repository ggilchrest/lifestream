import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {calendarSettingsControlPin} from './mobile-context-calendar-settings-control.pin.ts';
import type {CalendarSyncRun,CalendarSelectionIdentity,CalendarControlRequest,CalendarControlOutcome,CalendarSyncWindow,CalendarSettingsEnvelope,CalendarSettingsResponse} from './mobile-context-calendar-settings-control.types.ts';
export {calendarSettingsControlPin};
export type * from './mobile-context-calendar-settings-control.types.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
if(sha(readFileSync(new URL('./schemas/mobile-context-calendar-settings-control.schema.json',import.meta.url),'utf8'))!==calendarSettingsControlPin.digest)throw Error('calendar_settings_pin_mismatch');
const validator=createContractValidator();
export function calendarSettingsCanonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(calendarSettingsCanonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+calendarSettingsCanonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
function snapshot<T>(kind:string,value:unknown):T|null {
 const safe=unifiedDesktopSnapshot(value,262144);
 return safe!==undefined&&validator.validate(calendarSettingsControlPin.schemaId+'#/$defs/'+kind,safe).valid?safe as T:null;
}
export function calendarSyncWindow(value:unknown):CalendarSyncWindow|null {
 const w=snapshot<CalendarSyncWindow>('CalendarSyncWindow',value);
 if(!w||!Number.isSafeInteger(w.lookBackDays)||!Number.isSafeInteger(w.lookAheadDays)||w.lookBackDays+w.lookAheadDays<1||w.lookBackDays+w.lookAheadDays>366||!/^\p{ASCII}+$/u.test(w.timeZone)||/[\x00-\x20]/.test(w.timeZone)||Buffer.byteLength(w.timeZone)>128||!/^[-A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(w.timeZone))return null;
 try{new Intl.DateTimeFormat('en',{timeZone:w.timeZone}).format(0);}catch{return null;}
 return w;
}
/** Commitment only: original SDK/store/session provenance must still be captured. */
export function calendarSelectionDigest(value:unknown):string|null {
 const identity=snapshot<CalendarSelectionIdentity>('CalendarSelectionIdentity',value);if(!identity)return null;
 if(new Set(identity.calendars.map(c=>c.containerId)).size!==identity.calendars.length)return null;
 const calendars=[...identity.calendars].sort((a,b)=>Buffer.compare(Buffer.from(calendarSettingsCanonical(a),'utf8'),Buffer.from(calendarSettingsCanonical(b),'utf8')));
 return sha('lifestream/calendar-selection/1\n'+calendarSettingsCanonical({...identity,calendars}));
}
/** Verify civil-day intent without moving/rounding the anchor. The original
 * scope owner still resolves DST folds/gaps and binds exact approved instants. */
export function calendarSyncRunMatchesSettings(settings:unknown,run:unknown):boolean {
 const w=calendarSyncWindow(settings),r=snapshot<CalendarSyncRun>('CalendarSyncRun',run);if(!w||!r||r.timeZone!==w.timeZone)return false;
 try{
  const format=new Intl.DateTimeFormat('en',{timeZone:w.timeZone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=(at:string)=>{const date=new Date(at);if(!Number.isFinite(date.getTime()))throw Error('instant');return Object.fromEntries(format.formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));};
  const anchor=parts(r.anchorAt),start=parts(r.startAt),end=parts(r.endAt);
  const fraction=(at:string)=>(at.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1]??'').replace(/0+$/,'');
  const matches=(actual:Record<string,string>,days:number,at:string)=>{
   const date=new Date(0);date.setUTCFullYear(Number(anchor.year),Number(anchor.month)-1,Number(anchor.day));date.setUTCDate(date.getUTCDate()+days);
   return Number(actual.year)===date.getUTCFullYear()&&Number(actual.month)===date.getUTCMonth()+1&&Number(actual.day)===date.getUTCDate()&&['hour','minute','second'].every(k=>actual[k]===anchor[k])&&fraction(at)===fraction(r.anchorAt);
  };
  return Date.parse(r.endAt)>Date.parse(r.startAt)&&matches(start,-w.lookBackDays,r.startAt)&&matches(end,w.lookAheadDays,r.endAt);
 }catch{return false;}
}
export function calendarControlRequest(value:unknown):CalendarControlRequest|null {
 const r=snapshot<CalendarControlRequest>('CalendarControlRequest',value);if(!r)return null;
 const t=r.target;
 if(r.action.kind==='enroll')return t.enrollmentId===null&&t.sourceNamespace===null&&t.expectedRevision===0?r:null;
 if(t.enrollmentId===null||t.expectedRevision<1)return null;
 if(r.action.kind==='bindSource')return t.sourceNamespace===null?r:null;
 const c=r.action.configuration;
 if(t.sourceNamespace===null||c.sourceConfiguration.categories.join()!=='CalendarEvent'||c.sourceConfiguration.uses.length||c.sourceConfiguration.assistantIds.length||!c.sourceConfiguration.usePaused||c.syncWindow!==undefined&&!calendarSyncWindow(c.syncWindow))return null;
 return r;
}
export function calendarControlRequestDigest(value:unknown):string|null {const r=calendarControlRequest(value);return r?sha('lifestream/calendar-control/request/1\n'+calendarSettingsCanonical(r)):null;}
export function calendarControlReservationDigest(value:unknown):string|null {const r=calendarControlRequest(value);return r?sha('lifestream/calendar-control/reservation/1\n'+calendarSettingsCanonical(r)):null;}
export type CalendarControlRow={request_digest:string;state:string;attempt_started:number;selection_json:string|null;outcome_json:string|null};
export function calendarControlProjection(r:CalendarControlRequest,row:CalendarControlRow):{phase:'reserved'|'prepared'|'terminal';digest:string} {
 if(row.request_digest!==calendarControlRequestDigest(r)||![0,1].includes(Number(row.attempt_started)))throw Error('calendar_control_projection');
 if(row.state==='pending'&&row.attempt_started===0&&row.selection_json===null&&row.outcome_json===null)return {phase:'reserved',digest:calendarControlReservationDigest(r)!};
 let selection:unknown=null;
 if(row.selection_json!==null){if(Buffer.byteLength(row.selection_json)>262144)throw Error('calendar_control_projection');selection=JSON.parse(row.selection_json);}
 if(row.state==='pending'&&row.attempt_started===1&&row.selection_json!==null&&row.outcome_json===null)return {phase:'prepared',digest:sha('lifestream/calendar-control/prepared/1\n'+calendarSettingsCanonical({request:r,selection}))};
 if(!['applied','rejected'].includes(row.state)||row.outcome_json===null||Buffer.byteLength(row.outcome_json)>262144||row.state==='applied'&&(row.attempt_started!==1||row.selection_json===null)||row.state==='rejected'&&row.attempt_started!==0)throw Error('calendar_control_projection');
 const outcome=snapshot<CalendarControlOutcome>('CalendarControlOutcome',JSON.parse(row.outcome_json));
 if(!outcome||outcome.status!==row.state||outcome.status==='applied'&&(outcome.receipt.operationId!==r.operationId||outcome.syncWindow!==null&&!calendarSyncWindow(outcome.syncWindow)))throw Error('calendar_control_projection');
 return {phase:'terminal',digest:sha('lifestream/calendar-control/terminal/1\n'+calendarSettingsCanonical({request:r,selection,outcome}))};
}
export function admitCalendarSettingsConsumer(pin:unknown):boolean {
 if(!pin||typeof pin!=='object')return false;const f=Object.getOwnPropertyDescriptors(pin);
 return Reflect.ownKeys(f).length===3&&(['schemaId','schemaVersion','digest'] as const).every(k=>f[k]&&'value'in f[k]!&&f[k]!.value===calendarSettingsControlPin[k]);
}
export function calendarSettingsEnvelope(value:unknown):CalendarSettingsEnvelope|null {
 const e=snapshot<CalendarSettingsEnvelope>('CalendarSettingsEnvelope',value);if(!e||!admitCalendarSettingsConsumer(e.producerPin))return null;
 if(e.operation==='control'||e.operation==='reconcile')return calendarControlRequest(e.payload)?e:null;
 if(e.operation==='ingestScoped'){
  const r=e.payload.run,start=Date.parse(r.startAt),end=Date.parse(r.endAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>367*86400000||!Number.isFinite(Date.parse(r.anchorAt))||!calendarSyncWindow({schemaVersion:'1.0.0',lookBackDays:0,lookAheadDays:1,timeZone:r.timeZone}))return null;
 }
 return e;
}
export function calendarSettingsResponse(value:unknown):CalendarSettingsResponse|null {
 const e=snapshot<CalendarSettingsResponse>('CalendarSettingsResponse',value);if(!e||!admitCalendarSettingsConsumer(e.producerPin))return null;const r=e.result;
 if(r.kind==='settings')return r.syncWindow===null||calendarSyncWindow(r.syncWindow)?e:null;
 if(r.kind==='observed'||r.kind==='terminal'){
  if(!calendarControlRequest(r.originalRequest)||r.requestDigest!==calendarControlRequestDigest(r.originalRequest))return null;
  if(r.outcome.status==='applied'){
   if(r.outcome.receipt.operationId!==r.originalRequest.operationId||r.outcome.syncWindow!==null&&!calendarSyncWindow(r.outcome.syncWindow))return null;
   const target=r.originalRequest.target,enrollment=r.outcome.enrollment,action=r.originalRequest.action;
   if(enrollment.principalId!==target.principalId||enrollment.endpointId!==target.endpointId||enrollment.collector!==target.collector||action.kind!=='enroll'&&enrollment.enrollmentId!==target.enrollmentId)return null;
   if(action.kind==='configure'&&(enrollment.sourceNamespace!==target.sourceNamespace||enrollment.state!==action.state||calendarSettingsCanonical(enrollment.configuration)!==calendarSettingsCanonical(action.configuration.sourceConfiguration)||action.configuration.syncWindow!==undefined&&calendarSettingsCanonical(r.outcome.syncWindow)!==calendarSettingsCanonical(action.configuration.syncWindow)))return null;
   if(r.originalRequest.action.kind==='configure'&&(r.outcome.enrollment.enrollmentId!==r.originalRequest.target.enrollmentId||r.outcome.enrollment.revision!==r.originalRequest.target.expectedRevision+1))return null;
  }
  if(r.kind==='terminal'&&((r.outcome.status==='applied')!==(r.binding.preparedDigest!==undefined)))return null;
 }
 return e;
}
