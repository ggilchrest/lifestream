import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator,type ValidationResult} from './validator.ts';
import {unifiedDesktopSnapshot,contractFailure,contractSuccess} from './unified-desktop-contracts.ts';
import {mobileCalendarPin} from './mobile-context-calendar.pin.ts';
import type {CalendarChange,CalendarBatch,CalendarEvent,Task,CalendarInstant,CalendarZone,CalendarPoint,CalendarRecurrence} from './mobile-context-calendar.types.ts';
export type * from './mobile-context-calendar.types.ts';
export {mobileCalendarPin};
export const mobileCalendarLimits=Object.freeze({bytes:262144,batchItems:64,recurrenceRules:16,attendees:64,alarms:64});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar.schema.json',import.meta.url))).digest('hex')!==mobileCalendarPin.digest)throw Error('mobile_calendar_producer_pin_mismatch');
const validator=createContractValidator();
const civil=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number(s.slice(0,4))>0&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const local=(s:string)=>{const [date,time]=s.split('T');return !!date&&civil(date)&&!!time&&/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/.test(time);};
const instant=(s:string)=>s.endsWith('Z')&&local(s.slice(0,-1))&&Number.isFinite(Date.parse(s));
const zone=(z:CalendarZone)=>{if(z.kind==='unknown')return true;try{new Intl.DateTimeFormat('en',{timeZone:z.identifier});return true;}catch{return false;}};
const at=(i:CalendarInstant)=>instant(i.at)&&zone(i.timeZone);
const point=(p:CalendarPoint)=>p.kind==='date'?civil(p.date):p.kind==='floating'?local(p.local):at(p.value);
const recurrence=(r:CalendarRecurrence)=>r.kind!=='rules'||zone(r.timeZone)&&r.rules.every(rule=>{
 if(rule.end.kind==='until'&&!point(rule.end.value))return false;
 for(const values of [rule.monthDays,rule.yearDays,rule.weekNumbers,rule.months,rule.setPositions])if(values.includes(0)||new Set(values).size!==values.length)return false;
 return new Set(rule.days.map(day=>day.day+':'+String(day.ordinal))).size===rule.days.length&&rule.days.every(day=>day.ordinal!==0&&(day.ordinal===null||rule.frequency==='monthly'||rule.frequency==='yearly'));
});
function event(e:CalendarEvent):boolean{
 const t=e.time;
 if(t.kind==='allDay'&&(!civil(t.startDate)||!civil(t.endDateExclusive)||t.endDateExclusive<=t.startDate||!zone(t.timeZone)))return false;
 if(t.kind==='instantRange'&&(!at(t.start)||!at(t.end)||Date.parse(t.end.at)<=Date.parse(t.start.at)))return false;
 // Appending Z is used only to compare supplied wall components, never to emit or infer an instant/zone.
 if(t.kind==='floatingRange'&&(!local(t.startLocal)||!local(t.endLocal)||Date.parse(t.endLocal+'Z')<=Date.parse(t.startLocal+'Z')))return false;
 return recurrence(e.recurrence)&&(e.occurrence.originalStart===null||point(e.occurrence.originalStart))&&(e.occurrence.state!=='none'||e.occurrence.originalStart===null&&e.occurrence.seriesUpstreamId===null)&&(e.alarms===null||e.alarms.every(a=>a.kind!=='absolute'||at(a.value)));
}
function task(t:Task):boolean{
 const d=t.due;
 if(d.kind==='date'||d.kind==='instant'||d.kind==='floating'){if(!point(d))return false;}
 if(d.kind==='components'){
  if(!zone(d.timeZone))return false;const v=d.values;
  if(d.calendarIdentifier==='gregorian'||d.calendarIdentifier==='iso8601'){if(v.month!==undefined&&v.month>12)return false;if(v.month!==undefined&&v.day!==undefined&&!civil(String(v.year??2000).padStart(4,'0')+'-'+String(v.month).padStart(2,'0')+'-'+String(v.day).padStart(2,'0')))return false;}
 }
 return recurrence(t.recurrence)&&(t.completion.state!=='completed'||t.completion.completedAt===null||at(t.completion.completedAt));
}
/** Semantic data only. A structurally valid enrollment/revision/namespace does not authorize ingestion or any use. */
export function validateMobileCalendar(kind:'CalendarChange'|'CalendarBatch'|'CalendarEvent'|'Task'|'CalendarPoint',input:unknown):ValidationResult{
 const v=unifiedDesktopSnapshot(input,mobileCalendarLimits.bytes);if(v===undefined)return contractFailure('bounds','Bounded detached data required.');
 const checked=validator.validate(mobileCalendarPin.schemaId+'#/$defs/'+kind,v);if(!checked.valid)return checked;
 if(kind==='CalendarBatch'){const changes=(v as CalendarBatch).changes;if(new Set(changes.map(c=>c.eventId)).size!==changes.length)return contractFailure('identity','Distinct delivery IDs required within a batch.');for(const c of changes){const result=validateMobileCalendar('CalendarChange',c);if(!result.valid)return result;}return contractSuccess();}
 if(kind==='CalendarPoint')return point(v as CalendarPoint)?contractSuccess():contractFailure('temporal','Exact valid source point required.');
 if(kind==='CalendarEvent')return event(v as CalendarEvent)?contractSuccess():contractFailure('temporal','Preserve valid complete temporal and recurrence semantics.');
 if(kind==='Task')return task(v as Task)?contractSuccess():contractFailure('temporal','Preserve valid due/completion/recurrence semantics.');
 const c=v as CalendarChange,s=c.source;
 if(s.containerKind!==(c.recordType==='Task'?'taskList':'calendar')||s.collector==='androidCalendar'&&c.recordType!=='CalendarEvent'||s.collector==='googleTasks'&&c.recordType!=='Task')return contractFailure('source','Calendar alarms are not tasks; preserve the actual source domain.');
 if(c.operation==='delete')return contractSuccess();
 if(c.recordType==='Task'&&s.collector==='googleTasks'&&(!['none','unknown','date'].includes(c.record.due.kind)||c.record.recurrence.kind!=='unavailable'))return contractFailure('meaning','Google Tasks due is date-only; unsupported recurrence is not known absent.');
 return validateMobileCalendar(c.recordType,c.record);
}
export function mobileCalendarSnapshot<T extends CalendarChange|CalendarBatch|CalendarEvent|Task|CalendarPoint>(kind:'CalendarChange'|'CalendarBatch'|'CalendarEvent'|'Task'|'CalendarPoint',input:unknown):T|null{const v=unifiedDesktopSnapshot(input,mobileCalendarLimits.bytes);return validateMobileCalendar(kind,v).valid?v as T:null;}
export function admitMobileCalendarConsumer(pin:unknown):boolean{if(!pin||typeof pin!=='object')return false;const descriptors=Object.getOwnPropertyDescriptors(pin);return Reflect.ownKeys(descriptors).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>descriptors[k]&&'value'in descriptors[k]!&&descriptors[k]!.value===mobileCalendarPin[k]);}
