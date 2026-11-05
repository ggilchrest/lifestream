import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {calendarSettingsCanonical,calendarSelectionDigest,calendarSettingsEnvelope,calendarSettingsControlPin} from './mobile-context-calendar-settings-control.ts';
import {validateCalendarDelivery} from './mobile-context-calendar-delivery.ts';
import {calendarSelectedDeliveryPin} from './mobile-context-calendar-selected-delivery.pin.ts';
import type {CalendarSelectedEnvelope,CalendarSelectedResponse} from './mobile-context-calendar-selected-delivery.types.ts';
export {calendarSelectedDeliveryPin};
export type * from './mobile-context-calendar-selected-delivery.types.ts';
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar-selected-delivery.schema.json',import.meta.url))).digest('hex')!==calendarSelectedDeliveryPin.digest)throw Error('calendar_selected_pin_mismatch');
const validator=createContractValidator();
export function admitCalendarSelectedConsumer(pin:unknown):boolean {
 const safe=unifiedDesktopSnapshot(pin,1024);
 return !!safe&&calendarSettingsCanonical(safe)===calendarSettingsCanonical(calendarSelectedDeliveryPin);
}
function snapshot<T>(kind:string,input:unknown):T|null {
 const safe=unifiedDesktopSnapshot(input,262144);
 return safe!==undefined&&validator.validate(calendarSelectedDeliveryPin.schemaId+'#/$defs/'+kind,safe).valid?safe as T:null;
}
/** The selection is an application narrowing commitment, never SDK evidence. */
export function calendarSelectedEnvelope(input:unknown):CalendarSelectedEnvelope|null {
 const e=snapshot<CalendarSelectedEnvelope>('SelectedDeliveryEnvelope',input);
 if(!e||!admitCalendarSelectedConsumer(e.producerPin))return null;
 const p=e.payload,selection=p.selection;
 if(p.enrollmentId!==selection.enrollmentId||p.run.configurationRevision!==selection.configurationRevision||p.run.selectionDigest!==calendarSelectionDigest(selection))return null;
 if(!calendarSettingsEnvelope({producerPin:calendarSettingsControlPin,operation:'ingestScoped',payload:{schemaVersion:p.schemaVersion,enrollmentId:p.enrollmentId,run:p.run,items:p.items}}))return null;
 return validateCalendarDelivery('CalendarDeliveryBatch',{schemaVersion:'1.0.0',items:p.items}).valid?e:null;
}
export function calendarSelectedResponse(input:unknown):CalendarSelectedResponse|null {
 const e=snapshot<CalendarSelectedResponse>('SelectedDeliveryResponse',input);
 return e&&admitCalendarSelectedConsumer(e.producerPin)&&new Set(e.result.receipts.filter(r=>r.eventId!==null).map(r=>r.eventId)).size===e.result.receipts.filter(r=>r.eventId!==null).length&&e.result.receipts.every(r=>validateCalendarDelivery('CalendarDeliveryReceipt',r).valid)?e:null;
}
