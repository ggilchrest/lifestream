import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContractValidator} from './validator.ts';
import {unifiedDesktopSnapshot} from './unified-desktop-contracts.ts';
import {calendarContextSnapshot} from './mobile-context-calendar-context.ts';
import {mobileCalendarConversationPin} from './mobile-context-calendar-conversation.pin.ts';
import type {CalendarConversationAttachment} from './mobile-context-calendar-conversation.types.ts';
export * from './mobile-context-calendar-conversation.types.ts';
export {mobileCalendarConversationPin};
export const calendarConversationLimits=Object.freeze({requestBytes:8192,promptBytes:4096,rawRecords:100,intentMs:1800000});
if(createHash('sha256').update(readFileSync(new URL('./schemas/mobile-context-calendar-conversation.schema.json',import.meta.url))).digest('hex')!==mobileCalendarConversationPin.digest)throw Error('calendar_conversation_pin_mismatch');
const validator=createContractValidator();
export function calendarConversationAttachment(input:unknown,now=Date.now()):CalendarConversationAttachment|null{
 const v=unifiedDesktopSnapshot(input,calendarConversationLimits.requestBytes)as CalendarConversationAttachment|undefined;
 if(!v||!validator.validate(mobileCalendarConversationPin.schemaId+'#/$defs/CalendarConversationAttachment',v).valid||Object.keys(mobileCalendarConversationPin).some(k=>(v.producerPin as any)[k]!== (mobileCalendarConversationPin as any)[k]))return null;
 const i=v.intent,expiry=Date.parse(i.expiresAt);if(!Number.isFinite(now)||expiry<=now||expiry>now+calendarConversationLimits.intentMs||!calendarContextSnapshot('CalendarContextQuery',{schemaVersion:'1.0.0',assistantId:i.assistantId,enrollmentId:i.enrollmentId,window:i.window}))return null;return v;
}
