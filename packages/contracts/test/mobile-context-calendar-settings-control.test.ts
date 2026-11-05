import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {calendarSyncWindow,calendarControlRequest,calendarControlRequestDigest,calendarControlProjection,calendarControlReservationDigest,calendarSettingsEnvelope,calendarSettingsResponse,calendarSettingsControlPin} from '../src/mobile-context-calendar-settings-control.ts';
import {mobileCalendarDeliveryPin,validateCalendarDelivery} from '../src/mobile-context-calendar-delivery.ts';
const window={schemaVersion:'1.0.0',lookBackDays:7,lookAheadDays:30,timeZone:'America/Chicago'};
const configuration={categories:['CalendarEvent'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true};
function request(){return {schemaVersion:'1.0.0',operationId:randomUUID(),target:{principalId:randomUUID(),endpointId:randomUUID(),collector:'eventKit',enrollmentId:randomUUID(),sourceNamespace:randomUUID(),expectedRevision:3},action:{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration,syncWindow:window}}};}
test('optional versioned windows are bounded intent, not defaults or old v1 fields',()=>{
 assert.equal(mobileCalendarDeliveryPin.digest,'91dd3ae326706285babde6b31649f3f4d9687826df05fc9a524941301e5a212c');
 assert.equal(validateCalendarDelivery('CalendarConfiguration',configuration).valid,true);
 assert.equal(validateCalendarDelivery('CalendarConfiguration',{...configuration,syncWindow:window}).valid,false);
 assert.deepEqual(calendarSyncWindow(window),window);
 assert.ok(calendarSyncWindow({...window,lookBackDays:0,lookAheadDays:366,timeZone:'UTC'}));
 for(const change of [{lookBackDays:-1},{lookAheadDays:1.5},{lookBackDays:0,lookAheadDays:0},{lookBackDays:337},{timeZone:'made/up'},{timeZone:'America/Chicago\n'},{schemaVersion:'2.0.0'},{extra:true}])assert.equal(calendarSyncWindow({...window,...change}),null,JSON.stringify(change));
 const old=request();delete (old.action.configuration as any).syncWindow;assert.ok(calendarControlRequest(old));assert.equal((calendarControlRequest(old)!.action as any).configuration.syncWindow,undefined);
});
test('new exact producer and target bindings cannot be borrowed by legacy or unknown messages',()=>{
 const r=request(),good={producerPin:calendarSettingsControlPin,operation:'control',payload:r};assert.ok(calendarSettingsEnvelope(good));
 assert.equal(calendarSettingsEnvelope({...good,producerPin:mobileCalendarDeliveryPin}),null);
 assert.equal(calendarSettingsEnvelope({...good,producerPin:{...calendarSettingsControlPin,digest:'a'.repeat(64)}}),null);
 assert.equal(calendarSettingsEnvelope({...good,extra:true}),null);
 assert.equal(calendarControlRequest({...r,target:{...r.target,enrollmentId:null}}),null);
 assert.equal(calendarControlRequest({...r,action:{...r.action,configuration:{...r.action.configuration,sourceConfiguration:{...configuration,uses:['answers']}}}}),null);
 const accessor=Object.defineProperty({},'schemaVersion',{get(){throw Error('must not invoke');}});assert.equal(calendarControlRequest(accessor),null);
});
test('terminal configure receipt preserves exact original identities, changed revision and requested setting',()=>{
 const input=request(),r=calendarControlRequest(input)!,target=r.target;
 const enrollment={enrollmentId:target.enrollmentId,principalId:target.principalId,endpointId:target.endpointId,collector:'eventKit',sourceNamespace:target.sourceNamespace,revision:4,state:'active',configuration};
 const result={kind:'terminal',originalRequest:r,requestDigest:calendarControlRequestDigest(r),outcome:{status:'applied',receipt:{operationId:r.operationId,committedAt:'2026-11-01T00:00:00.000Z'},enrollment,syncWindow:window},current:true,binding:{family:'calendarControl',reservationDigest:'a'.repeat(64),preparedDigest:'b'.repeat(64),terminalDigest:'c'.repeat(64)}};
 const response=()=>({schemaVersion:'1.0.0',producerPin:calendarSettingsControlPin,result:structuredClone(result)});
 assert.ok(calendarSettingsResponse(response()));
 for(const mutate of [(v:any)=>v.result.outcome.enrollment.revision=3,(v:any)=>v.result.outcome.enrollment.endpointId=randomUUID(),(v:any)=>v.result.outcome.enrollment.sourceNamespace=randomUUID(),(v:any)=>v.result.outcome.syncWindow.lookAheadDays=31,(v:any)=>delete v.result.binding.preparedDigest,(v:any)=>v.result.requestDigest='d'.repeat(64)]){const value=response();mutate(value);assert.equal(calendarSettingsResponse(value),null);}
});
test('original control phase evidence distinguishes reservation, attempted preparation and committed outcome',()=>{
 const r=calendarControlRequest(request())!,request_digest=calendarControlRequestDigest(r)!;
 const row={request_digest,state:'pending',attempt_started:0,selection_json:null as string|null,outcome_json:null as string|null};
 assert.deepEqual(calendarControlProjection(r,row),{phase:'reserved',digest:calendarControlReservationDigest(r)});
 row.attempt_started=1;assert.throws(()=>calendarControlProjection(r,row));row.selection_json=JSON.stringify({before:null});
 assert.equal(calendarControlProjection(r,row).phase,'prepared');
 const changed={...row,request_digest:'a'.repeat(64)};assert.throws(()=>calendarControlProjection(r,changed));
 assert.notEqual(calendarControlRequestDigest(r),calendarControlRequestDigest({...r,operationId:randomUUID()}));
});

test('selection commitment has canonical UTF8 ordering, explicit identity and no borrowed provenance',async()=>{
 const {calendarSelectionDigest,calendarSettingsCanonical}=await import('../src/mobile-context-calendar-settings-control.ts');
 const {createHash}=await import('node:crypto');
 const r=request(),identity={principalId:r.target.principalId,endpointId:r.target.endpointId,enrollmentId:r.target.enrollmentId,sourceNamespace:r.target.sourceNamespace,configurationRevision:4,collector:'eventKit',upstreamIdentityScope:'providerLocal',calendars:[{containerId:'z',accountId:null},{containerId:'é',accountId:'local-source'}]};
 const sorted=[...identity.calendars].sort((a,b)=>Buffer.compare(Buffer.from(calendarSettingsCanonical(a)),Buffer.from(calendarSettingsCanonical(b))));
 const exact=createHash('sha256').update('lifestream/calendar-selection/1\n'+calendarSettingsCanonical({...identity,calendars:sorted}),'utf8').digest('hex');
 assert.equal(calendarSelectionDigest(identity),exact);assert.equal(calendarSelectionDigest({...identity,calendars:[...identity.calendars].reverse()}),exact);
 assert.notEqual(calendarSelectionDigest({...identity,endpointId:randomUUID()}),exact);assert.notEqual(calendarSelectionDigest({...identity,configurationRevision:5}),exact);
 assert.equal(calendarSelectionDigest({...identity,calendars:[identity.calendars[0],identity.calendars[0]]}),null);
 assert.equal(calendarSelectionDigest({...identity,ownership:'shared'}),null);
});
test('scoped envelope binds full fixed union and admits retained items across bounded SDK subscans',()=>{
 const run={anchorAt:'2026-11-01T18:00:00Z',startAt:'2026-10-25T05:00:00Z',endAt:'2026-12-01T06:00:00Z',timeZone:'America/Chicago',configurationRevision:1,selectionDigest:'a'.repeat(64)};
 const payload={schemaVersion:'1.0.0',enrollmentId:randomUUID(),run,items:[ ]};
 // Nonempty item validation remains independent; the full union is not capped at a subscan's31days.
 const fixture=JSON.parse(requireFixture());payload.items.push(fixture.vectors[3].item as never);
 assert.ok(calendarSettingsEnvelope({producerPin:calendarSettingsControlPin,operation:'ingestScoped',payload}));
 assert.equal(calendarSettingsEnvelope({producerPin:calendarSettingsControlPin,operation:'ingestScoped',payload:{...payload,run:{...run,endAt:'2028-01-01T00:00:00Z'}}}),null);
});
function requireFixture(){return readFileSync(new URL('./fixtures/mobile-context-calendar-delivery.json',import.meta.url),'utf8');}
test('full run preserves exact anchor wall-clock/fraction across DST and rejects rounded or widened boundaries',async()=>{
 const {calendarSyncRunMatchesSettings}=await import('../src/mobile-context-calendar-settings-control.ts');
 const settings={schemaVersion:'1.0.0',lookBackDays:1,lookAheadDays:3,timeZone:'America/Chicago'};
 const run={anchorAt:'2026-11-01T18:00:00.123Z',startAt:'2026-10-31T17:00:00.123Z',endAt:'2026-11-04T18:00:00.123Z',timeZone:settings.timeZone,configurationRevision:3,selectionDigest:'a'.repeat(64)};
 assert.equal(calendarSyncRunMatchesSettings(settings,run),true);
 for(const change of [{startAt:'2026-10-31T05:00:00.123Z'},{endAt:'2026-11-04T06:00:00.123Z'},{startAt:'2026-10-31T18:00:00.123Z'},{anchorAt:'2026-11-01T18:00:00.124Z'}])assert.equal(calendarSyncRunMatchesSettings(settings,{...run,...change}),false);
});
