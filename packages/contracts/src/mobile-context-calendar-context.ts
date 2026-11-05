import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {validateMobileCalendar} from './mobile-context-calendar.ts';
import {validateCalendarDelivery} from './mobile-context-calendar-delivery.ts';
import {mobileCalendarContextPin} from './mobile-context-calendar-context.pin.ts';
import type {CalendarContextQuery,CalendarContextResponse,CalendarContextPage,CalendarContextRecord,CalendarContextWindow} from './mobile-context-calendar-context.types.ts';
import type {CalendarEvent,Task,CalendarPoint} from './mobile-context-calendar.types.ts';
export * from './mobile-context-calendar-context.types.ts';
export {mobileCalendarContextPin};
export const calendarContextLimits=Object.freeze({requestBytes:8192,responseBytes:262144,recordBytes:131072,sourceBytes:32768,cursorBytes:2048,cursorDecodedBytes:1024,pageSize:25,windowMs:31*86400000});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar-context.schema.json',import.meta.url))).digest('hex')!==mobileCalendarContextPin.digest)throw Error('calendar_context_pin_mismatch');
const validator=createContractValidator();
export function admitCalendarContextConsumer(pin:unknown){if(!pin||typeof pin!=='object')return false;const d=Object.getOwnPropertyDescriptors(pin);return Reflect.ownKeys(d).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>d[k]&&'value'in d[k]!&&d[k]!.value===mobileCalendarContextPin[k]);}
const point=(kind:string,value:string):CalendarPoint=>kind==='date'?{kind:'date',date:value}:kind==='floating'?{kind:'floating',local:value}:{kind:'instant',value:{at:value,timeZone:{kind:'unknown'},offset:{kind:'unknown'}}};
const clock=(kind:string,value:string)=>Date.parse(kind==='date'?value+'T00:00:00Z':kind==='floating'?value+'Z':value);
export function calendarContextWindowBounds(w:CalendarContextWindow){const start=w.kind==='date'?w.startDate:w.kind==='floating'?w.startLocal:w.startAt,end=w.kind==='date'?w.endDateExclusive:w.kind==='floating'?w.endLocal:w.endAt;return {start:clock(w.kind,start),end:clock(w.kind,end)};}
function validWindow(w:CalendarContextWindow){const start=w.kind==='date'?w.startDate:w.kind==='floating'?w.startLocal:w.startAt,end=w.kind==='date'?w.endDateExclusive:w.kind==='floating'?w.endLocal:w.endAt;if(!validateMobileCalendar('CalendarPoint',point(w.kind,start)).valid||!validateMobileCalendar('CalendarPoint',point(w.kind,end)).valid)return false;const b=calendarContextWindowBounds(w);return b.end>b.start&&b.end-b.start<=calendarContextLimits.windowMs;}
function validRecord(r:CalendarContextRecord){
 // Reuse the producing item's semantic validator. Fixed envelope metadata is
 // validation scaffolding only: never emitted, stored, or called provenance.
 const envelope={change:{schemaVersion:'1.0.0',eventId:'00000000-0000-4000-8000-000000000001',enrollmentId:'00000000-0000-4000-8000-000000000002',expectedPolicyRevision:1,source:r.source,collectedAt:'2000-01-01T00:00:00.000Z',mappingVersion:'1.0.0',operation:'upsert',recordType:r.recordType,record:r.record},locator:r.locator};
 return validateCalendarDelivery('CalendarDeliveryItem',envelope).valid&&r.recordId===r.lineage.sourceKey&&(r.match==='inWindow'?r.reason==='timeWithinWindow':r.reason!=='timeWithinWindow');
}
export function calendarContextSnapshot<T extends CalendarContextQuery|CalendarContextResponse|CalendarContextPage>(kind:'CalendarContextQuery'|'CalendarContextResponse'|'CalendarContextPage',input:unknown):T|null{
 const v=unifiedDesktopSnapshot(input,kind==='CalendarContextQuery'?calendarContextLimits.requestBytes:calendarContextLimits.responseBytes);if(v===undefined||!validator.validate(mobileCalendarContextPin.schemaId+'#/$defs/'+kind,v).valid)return null;
 if(kind==='CalendarContextQuery')return validWindow((v as CalendarContextQuery).window)?v as T:null;
 const page=kind==='CalendarContextResponse'?(v as CalendarContextResponse).result:v as CalendarContextPage;if(!validateMobileCalendar('CalendarPoint',point('instant',page.asOf)).valid||!page.records.every(validRecord)||new Set(page.records.map(r=>r.recordId)).size!==page.records.length)return null;
 if(kind==='CalendarContextResponse'&&!admitCalendarContextConsumer((v as CalendarContextResponse).producerPin))return null;return v as T;
}
/** Compare only the supplied clock representation. Appending Z is civil arithmetic,
 * never an inferred timezone or a returned conversion. No recurrence expansion. */
export function calendarContextMatch(type:'CalendarEvent'|'Task',record:CalendarEvent|Task,w:CalendarContextWindow):Pick<CalendarContextRecord,'match'|'reason'>|null{
 const b=calendarContextWindowBounds(w);let kind:string,start:string|undefined,end:string|undefined,recurring=false;
 if(type==='CalendarEvent'){const e=record as CalendarEvent,t=e.time;kind=t.kind==='allDay'?'date':t.kind==='instantRange'?'instant':'floating';start=t.kind==='allDay'?t.startDate:t.kind==='instantRange'?t.start.at:t.startLocal;end=t.kind==='allDay'?t.endDateExclusive:t.kind==='instantRange'?t.end.at:t.endLocal;recurring=!['occurrence','detached'].includes(e.occurrence.state)&&e.recurrence.kind!=='none';}
 else{const t=record as Task,d=t.due;recurring=t.recurrence.kind!=='none';if(d.kind==='none'||d.kind==='unknown'||d.kind==='components')return {match:'undetermined',reason:'unknownDue'};kind=d.kind;start=d.kind==='date'?d.date:d.kind==='instant'?d.value.at:d.local;}
 if(kind!==w.kind)return {match:'undetermined',reason:'incomparableClock'};const a=clock(kind,start!),z=end===undefined?a:clock(kind,end);if(end===undefined?a>=b.start&&a<b.end:a<b.end&&z>b.start)return {match:'inWindow',reason:'timeWithinWindow'};return recurring?{match:'undetermined',reason:'recurrenceNotExpanded'}:null;
}
export function freezeCalendarContext<T>(v:T):T{if(v&&typeof v==='object'){for(const value of Object.values(v))freezeCalendarContext(value);Object.freeze(v);}return v;}
