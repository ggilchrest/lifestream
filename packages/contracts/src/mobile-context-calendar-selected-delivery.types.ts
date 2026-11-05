import type {CalendarSelectionIdentity,CalendarSyncRun} from './mobile-context-calendar-settings-control.types.ts';
import type {CalendarDeliveryItem,CalendarDeliveryReceipt} from './mobile-context-calendar-delivery.types.ts';
import type {calendarSelectedDeliveryPin} from './mobile-context-calendar-selected-delivery.pin.ts';
export type CalendarSelectedPayload={schemaVersion:'1.0.0';enrollmentId:string;run:CalendarSyncRun;selection:CalendarSelectionIdentity;items:CalendarDeliveryItem[]};
export type CalendarSelectedEnvelope={producerPin:typeof calendarSelectedDeliveryPin;operation:'ingestSelected';payload:CalendarSelectedPayload};
export type CalendarSelectedResponse={schemaVersion:'1.0.0';producerPin:typeof calendarSelectedDeliveryPin;result:{kind:'sync';receipts:CalendarDeliveryReceipt[]}};
