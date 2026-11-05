import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {mobileCalendarChoicesPin} from './mobile-context-calendar-choices.pin.ts';
import type {CalendarChoicesResponse} from './mobile-context-calendar-choices.types.ts';
export * from './mobile-context-calendar-choices.types.ts';
export {mobileCalendarChoicesPin};
export const calendarChoicesLimits=Object.freeze({requestBytes:8192,responseBytes:16384,candidates:128,choices:25});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar-choices.schema.json',import.meta.url))).digest('hex')!==mobileCalendarChoicesPin.digest)throw Error('calendar_choices_pin_mismatch');
const validator=createContractValidator();
export function admitCalendarChoicesConsumer(pin:unknown){if(!pin||typeof pin!=='object')return false;const d=Object.getOwnPropertyDescriptors(pin);return Reflect.ownKeys(d).length===3&&(['schemaId','schemaVersion','digest']as const).every(k=>d[k]&&'value'in d[k]!&&d[k]!.value===mobileCalendarChoicesPin[k]);}
export function calendarChoicesSnapshot<T>(kind:'CalendarChoicesQuery'|'CalendarChoicesResponse',input:unknown):T|null{
 const v=unifiedDesktopSnapshot(input,kind==='CalendarChoicesQuery'?calendarChoicesLimits.requestBytes:calendarChoicesLimits.responseBytes);
 if(!v||!validator.validate(mobileCalendarChoicesPin.schemaId+'#/$defs/'+kind,v).valid)return null;
 if(kind==='CalendarChoicesResponse'){const r=v as CalendarChoicesResponse;if(!admitCalendarChoicesConsumer(r.producerPin)||new Set(r.result.choices.map(c=>c.sourceNamespace)).size!==r.result.choices.length||new Set(r.result.choices.map(c=>c.enrollmentId)).size!==r.result.choices.length)return null;}
 return v as T;
}
