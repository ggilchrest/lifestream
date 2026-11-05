import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fixture,wait} from './fixtures/personal-phone-host.mjs';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';
import {calendarSelectionDigest,calendarSettingsControlPin,calendarSettingsResponse} from '../../../packages/contracts/src/mobile-context-calendar-settings-control.ts';
import {mobileCalendarDeliveryPin,calendarDeliveryItemDigest} from '../../../packages/contracts/src/mobile-context-calendar-delivery.ts';
const route='/api/runtime/v1/mobile-context';
const sourceConfiguration={categories:['CalendarEvent'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true};
const syncWindow={schemaVersion:'1.0.0',lookBackDays:7,lookAheadDays:30,timeZone:'America/Chicago'};
async function setup(){
 const f=await fixture({endpointClass:'personalCompanion',personalPhoneAccess:{mode:'authenticatedSession',authenticatedAfterMs:0},mobileContext:{schemaPlan:'calendar-basic/1',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:20,sourceSafetyInitialization:'initializeEmpty',createCalendarGovernance:()=>({allowed:()=>true,retention:()=>({policyRef:'synthetic-retention',expiresAt:null}),invalidate(){},capturePolicy:(a:any,e:any)=>({binding:{schemaVersion:'1.0.0',policyRef:'synthetic-calendar',revision:1,digest:'a'.repeat(64),scope:{principalId:a.principalId,collector:e.collector,sourceNamespace:e.sourceNamespace},classificationRuleRef:'synthetic-classification',retentionPolicyRef:'synthetic-retention'},current:()=>a.current()}),captureSyncScope:(a:any,e:any,_s:any,run:any)=>({binding:{principalId:a.principalId,endpointId:a.endpointId,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,configurationRevision:e.revision,run},current:()=>a.current(),recordAllowed:(item:any)=>item.change.source.containerId==='synthetic-calendar'&&item.change.record?.time?.kind==='instantRange'&&Date.parse(item.change.record.time.start.at)<Date.parse(run.endAt)&&Date.parse(item.change.record.time.end.at)>Date.parse(run.startAt)})})}});
 await wait(()=>f.app.initiativeHost.maintenance.state()==='healthy');
 const call=(operation:string,payload:any,headers={})=>f.request(route,{producerPin:calendarSettingsControlPin,operation,payload},headers);
 const json=async(response:Response)=>{assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.ok(calendarSettingsResponse(body));return body.result;};
 const request=(e:any,action:any)=>({schemaVersion:'1.0.0',operationId:randomUUID(),target:{principalId:f.owner.principalId,endpointId:readSessionEndpoint(f.app.database,f.owner.sessionId).endpoint.endpointId,collector:'eventKit',enrollmentId:e?.enrollmentId??null,sourceNamespace:e?.sourceNamespace??null,expectedRevision:e?.revision??0},action});
 const apply=async(r:any)=>{const result=await json(await call('control',r));assert.equal(result.kind,'terminal');assert.equal(result.outcome.status,'applied');return result.outcome.enrollment;};
 const enroll=async()=>{let e=await apply(request(null,{kind:'enroll'}));e=await apply(request(e,{kind:'bindSource',binding:{createNew:true}}));return apply(request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration,syncWindow}}));};
 return {f,call,json,request,apply,enroll};
}
test('authenticated new producer returns original terminal receipt; inspect and reconcile perform no writes',async()=>{
 const x=await setup();try{
  const e=await x.enroll(),r=x.request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration,syncWindow:{...syncWindow,lookAheadDays:31}}}),first=await x.json(await x.call('control',r));
  const before=x.f.app.database.connection.prepare('SELECT total_changes() n').get().n,journal=readFileSync(x.f.app.admin.recovery.journal.directory+'/journal.json');
  assert.deepEqual(await x.json(await x.call('reconcile',r)),first);
  const settings=await x.json(await x.call('inspect',{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId}));assert.equal(settings.syncWindow.lookAheadDays,31);
  assert.equal(x.f.app.database.connection.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(readFileSync(x.f.app.admin.recovery.journal.directory+'/journal.json'),journal);
  assert.equal(x.f.app.database.connection.prepare('SELECT id FROM schema_migrations WHERE id=87').get(),undefined);assert.equal(x.f.app.database.connection.prepare('SELECT id FROM schema_migrations WHERE id=89').get().id,89);
 }finally{await x.f.close();}
});
test('new route keeps original Auth/CSRF and pin admission; scoped ingestion preserves original item and receipt digest',async t=>{
 const x=await setup();try{
  const r=x.request(null,{kind:'enroll'});assert.equal((await x.call('control',r,{'x-lifestream-csrf':'invalid'})).status,403);
  assert.equal((await x.f.request(route,{producerPin:mobileCalendarDeliveryPin,operation:'control',payload:r})).status,422);
  let e=await x.enroll();const fixtureWindow={...syncWindow,lookBackDays:1,lookAheadDays:3};e=await x.apply(x.request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration,syncWindow:fixtureWindow}}));const item=JSON.parse(readFileSync(new URL('../../../packages/contracts/test/fixtures/mobile-context-calendar-delivery.json',import.meta.url),'utf8')).vectors[3].item;
  item.change.eventId=randomUUID();item.change.enrollmentId=e.enrollmentId;item.change.expectedPolicyRevision=e.revision;item.change.source.namespace=e.sourceNamespace;
  const selectionIdentity={principalId:x.f.owner.principalId,endpointId:readSessionEndpoint(x.f.app.database,x.f.owner.sessionId).endpoint.endpointId,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,configurationRevision:e.revision,collector:'eventKit',upstreamIdentityScope:'providerLocal',calendars:[{containerId:'synthetic-calendar',accountId:null}]};const selectionDigest=calendarSelectionDigest(selectionIdentity)!;
  const payload={schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:{anchorAt:'2026-11-01T18:00:00Z',startAt:'2026-10-31T17:00:00Z',endAt:'2026-11-04T18:00:00Z',timeZone:syncWindow.timeZone,configurationRevision:e.revision,selectionDigest},items:[item]};
  const rounded={...payload,run:{...payload.run,startAt:'2026-10-31T05:00:00Z',endAt:'2026-11-04T06:00:00Z'}};assert.equal((await x.call('ingestScoped',rounded)).status,403);assert.equal(x.f.app.database.connection.prepare('SELECT count(*) n FROM mobile_context_records').get().n,0);
  const actualReply=await x.call('ingestScoped',payload),originalBody=await actualReply.clone().json();const result=await x.json(actualReply);t.diagnostic('SCOPED_RUNTIME_POSITIVE '+JSON.stringify({syntheticOnly:true,configuredWindow:fixtureWindow,selectionIdentity,request:{producerPin:calendarSettingsControlPin,operation:'ingestScoped',payload},response:originalBody,authority:'Actual disposable authenticated handler response with synthetic original policy/scope owner only; no installed authority.',selectionDigest:'Exact calendar-selection/1 canonical commitment from included synthetic original-owner identity. Not proof of SDK/store/session provenance.'}));assert.equal(result.receipts[0].outcome,'accepted');assert.equal(result.receipts[0].requestDigest,calendarDeliveryItemDigest(item));assert.equal(result.receipts[0].durability,'sqlCommit');
  assert.equal((await x.json(await x.call('ingestScoped',payload))).receipts[0].outcome,'duplicate');assert.equal(x.f.calls.inference+x.f.calls.stt+x.f.calls.tts,0);
 }finally{await x.f.close();}
});
