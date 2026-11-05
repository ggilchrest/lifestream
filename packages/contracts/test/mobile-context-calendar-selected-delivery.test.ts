import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calendarSelectedEnvelope,calendarSelectedDeliveryPin,calendarSelectedResponse} from '../src/mobile-context-calendar-selected-delivery.ts';
import {calendarSelectionDigest,calendarSettingsControlPin} from '../src/mobile-context-calendar-settings-control.ts';
import {calendarDeliveryItemDigest} from '../src/mobile-context-calendar-delivery.ts';
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function input(){
 const item=JSON.parse(readFileSync(new URL('./fixtures/mobile-context-calendar-delivery.json',import.meta.url),'utf8')).vectors[3].item;
 item.change.enrollmentId=uuid(3);item.change.expectedPolicyRevision=3;item.change.source.namespace=uuid(4);
 const selection={principalId:uuid(1),endpointId:uuid(2),enrollmentId:uuid(3),sourceNamespace:uuid(4),configurationRevision:3,collector:'eventKit',upstreamIdentityScope:'providerLocal',calendars:[{containerId:item.change.source.containerId,accountId:item.change.source.accountId}]};
 return {producerPin:calendarSelectedDeliveryPin,operation:'ingestSelected',payload:{schemaVersion:'1.0.0',enrollmentId:uuid(3),selection,run:{anchorAt:'2026-11-01T18:00:00.123Z',startAt:'2026-10-31T17:00:00.123Z',endAt:'2026-11-04T18:00:00.123Z',timeZone:'America/Chicago',configurationRevision:3,selectionDigest:calendarSelectionDigest(selection)},items:[item]}};
}
test('selected producer preserves original item identity and requires exact committed descriptor',()=>{
 const e=input(),digest=calendarDeliveryItemDigest(e.payload.items[0]);assert.ok(calendarSelectedEnvelope(e));assert.equal(calendarDeliveryItemDigest(calendarSelectedEnvelope(e)!.payload.items[0]),digest);
 const changed=structuredClone(e);changed.payload.selection.calendars[0]!.accountId='another account';assert.equal(calendarSelectedEnvelope(changed),null);
 const stale=structuredClone(e);stale.payload.selection.configurationRevision++;assert.equal(calendarSelectedEnvelope(stale),null);
 const duplicate=structuredClone(e);duplicate.payload.selection.calendars.push(duplicate.payload.selection.calendars[0]!);assert.equal(calendarSelectedEnvelope(duplicate),null);
 assert.equal(calendarSelectedEnvelope({...e,producerPin:calendarSettingsControlPin}),null);assert.equal(calendarSelectedEnvelope({...e,sdkProvenance:true}),null);
});
test('selected response keeps actual new producer and original durable receipt semantics',()=>{
 const e=input(),r={eventId:e.payload.items[0].change.eventId,outcome:'accepted',code:'applied',requestDigest:calendarDeliveryItemDigest(e.payload.items[0]),durability:'sqlCommit'},body={schemaVersion:'1.0.0',producerPin:calendarSelectedDeliveryPin,result:{kind:'sync',receipts:[r]}};
 assert.ok(calendarSelectedResponse(body));assert.equal(calendarSelectedResponse({...body,producerPin:calendarSettingsControlPin}),null);
 assert.equal(calendarSelectedResponse({...body,result:{kind:'sync',receipts:[{...r,durability:'observed'}]}}),null);
});
