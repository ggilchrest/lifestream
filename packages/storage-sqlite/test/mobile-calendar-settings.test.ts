import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {loadCalendarBasicMigrations} from '../src/mobile-calendar-migrations.ts';
import {MobileContextRepository} from '../src/mobile-context.ts';
import {RecoveryJournal} from '../../../apps/server/src/admin/recovery-journal.ts';
import {mobileSourceGovernance,mobileCalendarSourceGovernance} from '../../../apps/server/src/runtime/mobile-context-source-safety.ts';
import {calendarSelectionDigest,calendarSettingsResponse,calendarSettingsControlPin} from '../../contracts/src/mobile-context-calendar-settings-control.ts';
const configuration={categories:['CalendarEvent'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true};
const syncWindow={schemaVersion:'1.0.0',lookBackDays:7,lookAheadDays:30,timeZone:'America/Chicago'};
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'calendar-settings-')),path=join(root,'synthetic.sqlite');
 let db:Database,journal:RecoveryJournal,repo:MobileContextRepository,auth=true,allow=true,scope=true,hook=()=>{},lastCapture:any,scopeHook=()=>{},clock=Date.now(),expiresAt:string|null=null;
 const a={principalId:randomUUID(),endpointId:randomUUID(),current:()=>auth};
 const policy={allowed:()=>allow,retention:()=>({policyRef:'synthetic-retention',expiresAt}),recordCurrent:()=>true,invalidate:()=>hook(),capturePolicy:(actor:any,e:any)=>({binding:{schemaVersion:'1.0.0',policyRef:'synthetic-policy',revision:1,digest:'a'.repeat(64),scope:{principalId:actor.principalId,collector:e.collector,sourceNamespace:e.sourceNamespace},classificationRuleRef:'synthetic-rule',retentionPolicyRef:'synthetic-retention'},current:()=>auth&&allow}),captureSyncScope:(actor:any,e:any,_settings:any,run:any)=>scope&&run.selectionDigest===calendarSelectionDigest({principalId:actor.principalId,endpointId:actor.endpointId,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,configurationRevision:e.revision,collector:'eventKit',upstreamIdentityScope:'providerLocal',calendars:[{containerId:'synthetic-calendar',accountId:null}]})?lastCapture={binding:{principalId:actor.principalId,endpointId:actor.endpointId,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,configurationRevision:e.revision,run:structuredClone(run)},current:()=>{scopeHook();return auth&&scope;},recordAllowed:(item:any)=>item.change.source.containerId==='synthetic-calendar'&&item.change.record?.time?.kind==='instantRange'&&Date.parse(item.change.record.time.start.at)<Date.parse(run.endAt)&&Date.parse(item.change.record.time.end.at)>Date.parse(run.startAt)}:null};
 const open=(initialize=false)=>{db=new Database({path,migrations:loadCalendarBasicMigrations()});db.migrate();db.exec('CREATE TABLE IF NOT EXISTS assistant_relationships (relationship_id TEXT PRIMARY KEY)');journal=new RecoveryJournal(db,join(root,'safety'));assert.equal(journal.enableSources(initialize?'initializeEmpty':'requireExisting'),true);repo=new MobileContextRepository(db,mobileSourceGovernance(journal,db,100,null),100,()=>clock,{maximumOperationsPerHuman:50},mobileCalendarSourceGovernance(journal,db,100,policy as any));};open(true);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const request=(e:any,action:any)=>({schemaVersion:'1.0.0',operationId:randomUUID(),target:{principalId:a.principalId,endpointId:a.endpointId,collector:'eventKit',enrollmentId:e?.enrollmentId??null,sourceNamespace:e?.sourceNamespace??null,expectedRevision:e?.revision??0},action});
 const control=(r:any)=>repo.calendarControl(a,r);
 const applied=(r:any)=>{const result=control(r);assert.equal(result.kind,'terminal',JSON.stringify(result));assert.ok(calendarSettingsResponse({schemaVersion:'1.0.0',producerPin:calendarSettingsControlPin,result}));assert.equal((result as any).outcome.status,'applied');return (result as any).outcome.enrollment;};
 const enroll=()=>{let e=applied(request(null,{kind:'enroll'}));e=applied(request(e,{kind:'bindSource',binding:{createNew:true}}));return applied(request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration,syncWindow}}));};
 const item=(e:any)=>{const v=JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/mobile-context-calendar-delivery.json',import.meta.url),'utf8')).vectors[3].item;v.change.eventId=randomUUID();v.change.enrollmentId=e.enrollmentId;v.change.expectedPolicyRevision=e.revision;v.change.source.namespace=e.sourceNamespace;return v;};
 const run=(e:any)=>({anchorAt:'2026-11-01T18:00:00.000Z',startAt:'2026-10-25T17:00:00.000Z',endAt:'2026-12-01T18:00:00.000Z',timeZone:syncWindow.timeZone,configurationRevision:e.revision,selectionDigest:calendarSelectionDigest({principalId:a.principalId,endpointId:a.endpointId,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,configurationRevision:e.revision,collector:'eventKit',upstreamIdentityScope:'providerLocal',calendars:[{containerId:'synthetic-calendar',accountId:null}]})!});
 return {get db(){return db;},get journal(){return journal;},get repo(){return repo;},a,request,control,applied,enroll,item,run,restart(){db.close();open();},loseScope(){scope=false;},mutateCapture(){lastCapture.current=()=>true;},interrupt(f:()=>void){hook=f;},loseAuth(){auth=false;},scopeCurrentHook(f:()=>void){scopeHook=f;},finiteRetention(milliseconds:number){expiresAt=new Date(clock+milliseconds).toISOString();},advance(milliseconds:number){clock+=milliseconds;}};
}
test('actual original control owner enrolls, binds, configures and reconciles unchanged terminal across restart without replay',t=>{
 const f=fixture(t),e=f.enroll();assert.deepEqual(f.repo.calendarSettings(f.a,e.enrollmentId).syncWindow,syncWindow);
 const r=f.request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration,syncWindow:{...syncWindow,lookBackDays:9}}}),first=f.control(r);assert.equal(first.kind,'terminal',JSON.stringify(first));
 const count=f.db.connection.prepare('SELECT count(*) n FROM mobile_context_control_operations').get()!.n;f.restart();
 assert.deepEqual(f.repo.reconcileCalendarControl(f.a,r),first);assert.deepEqual(f.control(r),first);assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_control_operations').get()!.n,count);
});
test('absent setting preserves saved duration, while old enrollments have no invented setting',t=>{
 const f=fixture(t);let e=f.applied(f.request(null,{kind:'enroll'}));assert.equal(f.repo.calendarSettings(f.a,e.enrollmentId).syncWindow,null);
 e=f.enroll();e=f.applied(f.request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration}}));assert.deepEqual(f.repo.calendarSettings(f.a,e.enrollmentId).syncWindow,syncWindow);
});
test('stale and cross-endpoint controls cannot mutate a source or acquire a fresh revision',t=>{
 const f=fixture(t),e=f.enroll(),r=f.request({...e,revision:e.revision-1},{kind:'configure',state:'disconnected',configuration:{sourceConfiguration:configuration}}),result=f.control(r);
 assert.equal(result.kind,'terminal',JSON.stringify(result));assert.deepEqual((result as any).outcome,{status:'rejected',code:'settingsChanged'});assert.equal(f.repo.calendarSettings(f.a,e.enrollmentId).enrollment.revision,e.revision);
 const forged=f.request(e,r.action);forged.target.endpointId=randomUUID();assert.throws(()=>f.control(forged));
 assert.throws(()=>f.repo.calendarSettings({...f.a,endpointId:randomUUID()},e.enrollmentId));
});
test('uncertain attempted mutation stays held after restart and never retries the original callback',t=>{
 const f=fixture(t),e=f.enroll();let calls=0;f.interrupt(()=>{calls++;throw Error('synthetic interrupted original owner');});
 const r=f.request(e,{kind:'configure',state:'disconnected',configuration:{sourceConfiguration:configuration}});assert.equal(f.control(r).kind,'held');assert.equal(calls,1);f.interrupt(()=>{});f.restart();
 assert.equal(f.control(r).kind,'held');assert.equal(f.repo.reconcileCalendarControl(f.a,r).kind,'held');assert.equal(calls,1);assert.equal(f.repo.calendarSettings(f.a,e.enrollmentId).enrollment.revision,e.revision);
});
test('settings-enabled source rejects legacy ingest; unknown prefix denies all before effects; original scoped receipt survives restart',t=>{
 const f=fixture(t),e=f.enroll(),v=f.item(e);assert.equal(f.repo.ingestCalendar(f.a,{schemaVersion:'1.0.0',items:[v]})[0]!.outcome,'retryable');
 const bad=f.item(e);bad.change.source.containerId='unselected-calendar';assert.throws(()=>f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[v,bad]}));assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,0);
 const input={schemaVersion:'1.0.0' as const,enrollmentId:e.enrollmentId,run:f.run(e),items:[v]},receipt=f.repo.ingestCalendarScoped(f.a,input)[0]!;assert.equal(receipt.outcome,'accepted',JSON.stringify(receipt));assert.equal(receipt.durability,'sqlCommit');f.restart();assert.equal(f.repo.ingestCalendarScoped(f.a,input)[0]!.outcome,'duplicate');f.loseScope();assert.throws(()=>f.repo.ingestCalendarScoped(f.a,input));
});
test('loss of captured run scope inside the original invalidation callback rolls back record and receipt',t=>{
 const f=fixture(t),e=f.enroll(),v=f.item(e);f.interrupt(()=>f.loseScope());
 const receipt=f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[v]})[0]!;
 assert.equal(receipt.outcome,'retryable');assert.equal(receipt.durability,null);
 assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,0);assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_deliveries').get()!.n,0);
});
test('malformed sibling or run metadata denies the entire scoped prefix before original writes',t=>{
 const f=fixture(t),e=f.enroll(),v=f.item(e),bad=f.item(e);bad.extra=true;
 assert.throws(()=>f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[v,bad]}));
 const run={...f.run(e),endAt:'2028-01-01T00:00:00Z'};
 assert.throws(()=>f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run,items:[v]}));
 assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,0);
});
test('retained prefix spans separate subscans of the same full union; outside or unknown time denies whole prefix',t=>{
 const f=fixture(t),e=f.enroll(),first=f.item(e),last=f.item(e);
 last.change.source.upstreamId='synthetic-later-subscan';last.change.record.time={kind:'instantRange',start:{at:'2026-11-25T18:00:00Z',timeZone:{kind:'supplied',identifier:'America/Chicago'},offset:{kind:'supplied',minutes:-360}},end:{at:'2026-11-25T19:00:00Z',timeZone:{kind:'supplied',identifier:'America/Chicago'},offset:{kind:'supplied',minutes:-360}}};
 const payload={schemaVersion:'1.0.0' as const,enrollmentId:e.enrollmentId,run:f.run(e),items:[first,last]};
 assert.deepEqual(f.repo.ingestCalendarScoped(f.a,payload).map(r=>r.outcome),['accepted','accepted']);
 const fresh=f.item(e),outside=f.item(e);outside.change.record.time.start.at='2026-12-02T18:00:00Z';outside.change.record.time.end.at='2026-12-02T19:00:00Z';
 assert.throws(()=>f.repo.ingestCalendarScoped(f.a,{...payload,items:[fresh,outside]}));
 const unknown=f.item(e);unknown.change.record.time={kind:'allDay',startDate:'2026-11-01',endDateExclusive:'2026-11-03',timeZone:{kind:'unknown'}};
 assert.throws(()=>f.repo.ingestCalendarScoped(f.a,{...payload,items:[fresh,unknown]}));
 assert.throws(()=>f.repo.ingestCalendarScoped(f.a,{...payload,run:{...payload.run,selectionDigest:'f'.repeat(64)},items:[fresh]}));
 assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,2);
});
test('same-source aliases mirror duration without copying phone selection; foreign endpoint controls and scoped ingest deny',t=>{
 const f=fixture(t),e=f.enroll(),other={...f.a,endpointId:randomUUID()};
 const send=(enrollment:any,action:any)=>{const r=f.request(enrollment,action);r.target.endpointId=other.endpointId;const result=f.repo.calendarControl(other,r);assert.equal(result.kind,'terminal',JSON.stringify(result));assert.equal((result as any).outcome.status,'applied');return (result as any).outcome.enrollment;};
 let alias=send(null,{kind:'enroll'});alias=send(alias,{kind:'bindSource',binding:{sourceNamespace:e.sourceNamespace}});
 assert.deepEqual(f.repo.calendarSettings(other,alias.enrollmentId).syncWindow,syncWindow);
 const updated=f.applied(f.request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration,syncWindow:{...syncWindow,lookBackDays:4}}}));
 const second=f.repo.calendarSettings(other,alias.enrollmentId);assert.equal(second.syncWindow!.lookBackDays,4);assert.equal(second.enrollment.revision,updated.revision);assert.deepEqual(second.enrollment.configuration,configuration);assert.equal('calendars' in second,false);
 assert.throws(()=>f.repo.calendarSettings(f.a,alias.enrollmentId));
 assert.throws(()=>f.repo.ingestCalendarScoped(other,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(updated),items:[f.item(updated)]}));
 const wrong=f.request(updated,{kind:'configure',state:'disconnected',configuration:{sourceConfiguration:configuration}});wrong.target.endpointId=other.endpointId;const held=f.repo.calendarControl(other,wrong);assert.equal(held.kind,'terminal');assert.equal((held as any).outcome.status,'rejected');assert.equal((held as any).outcome.code,'scope');
 assert.equal(f.repo.calendarSettings(f.a,e.enrollmentId).enrollment.state,'active');
});
test('legacy sources without optional settings retain original same-human duplicate receipt semantics',t=>{
 const f=fixture(t);let e=f.applied(f.request(null,{kind:'enroll'}));e=f.applied(f.request(e,{kind:'bindSource',binding:{createNew:true}}));e=f.applied(f.request(e,{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration}}));
 assert.equal(f.repo.calendarSettings(f.a,e.enrollmentId).syncWindow,null);const item=f.item(e),batch={schemaVersion:'1.0.0',items:[item]};assert.equal(f.repo.ingestCalendar(f.a,batch)[0]!.outcome,'accepted');
 assert.equal(f.repo.ingestCalendar({...f.a,endpointId:randomUUID()},batch)[0]!.outcome,'duplicate');
});
test('replacing a captured run-current method cannot rearm revoked original scope inside a callback',t=>{
 const f=fixture(t),e=f.enroll(),v=f.item(e);f.interrupt(()=>{f.loseScope();f.mutateCapture();});
 const receipt=f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[v]})[0]!;
 assert.equal(receipt.outcome,'retryable');assert.equal(receipt.durability,null);assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,0);
});
test('review causal CALENDAR-ALIAS-DURATION-CUSTODY: actual new endpoint bind and omitted setting preserve source duration and forbid unscoped v1',t=>{
 const f=fixture(t),e=f.enroll(),other={...f.a,endpointId:randomUUID()};
 const send=(before:any,action:any)=>{const r=f.request(before,action);r.target.endpointId=other.endpointId;const result=f.repo.calendarControl(other,r);assert.equal(result.kind,'terminal',JSON.stringify(result));assert.equal((result as any).outcome.status,'applied');return (result as any).outcome.enrollment;};
 let alias=send(null,{kind:'enroll'});alias=send(alias,{kind:'bindSource',binding:{sourceNamespace:e.sourceNamespace}});
 assert.deepEqual(f.repo.calendarSettings(other,alias.enrollmentId).syncWindow,syncWindow);
 alias=send(alias,{kind:'configure',state:'active',configuration:{sourceConfiguration:configuration}});
 const first=f.repo.calendarSettings(f.a,e.enrollmentId),second=f.repo.calendarSettings(other,alias.enrollmentId);assert.deepEqual(first.syncWindow,syncWindow);assert.deepEqual(second.syncWindow,syncWindow);assert.equal(first.enrollment.revision,second.enrollment.revision);assert.deepEqual(second.enrollment.configuration,configuration);
 const receipt=f.repo.ingestCalendar(other,{schemaVersion:'1.0.0',items:[f.item(alias)]})[0]!;assert.equal(receipt.outcome,'retryable');assert.equal(receipt.durability,null);assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,0);
});
for(const mutation of ['revision','window'])test('review causal CALENDAR-SCOPED-FINAL-SQL-CURRENCY: last scope callback changes '+mutation+' after delivery INSERT',t=>{
 const f=fixture(t),e=f.enroll(),item=f.item(e);let armed=false;
 f.scopeCurrentHook(()=>{if(armed||!f.db.connection.prepare('SELECT 1 FROM mobile_context_deliveries WHERE event_id=?').get(item.change.eventId))return;armed=true;
  if(mutation==='revision')f.db.connection.prepare('UPDATE mobile_context_enrollments SET revision=revision+1 WHERE enrollment_id=?').run(e.enrollmentId);
  else f.db.connection.prepare('UPDATE mobile_context_enrollments SET sync_window_json=? WHERE enrollment_id=?').run(JSON.stringify({...syncWindow,lookBackDays:6}),e.enrollmentId);
 });
 const receipt=f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[item]})[0]!;assert.equal(armed,true);assert.equal(receipt.outcome,'retryable');assert.equal(receipt.durability,null);
 assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n,0);assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_context_deliveries').get()!.n,0);assert.equal(f.repo.calendarSettings(f.a,e.enrollmentId).enrollment.revision,e.revision);assert.deepEqual(f.repo.calendarSettings(f.a,e.enrollmentId).syncWindow,syncWindow);
 f.scopeCurrentHook(()=>{});const positive=f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[item]})[0]!;assert.equal(positive.outcome,'accepted');assert.equal(positive.durability,'sqlCommit');
});
test('review causal CALENDAR-ONLY-EXPIRY-OWNER: finite Calendar retention purges through original bounded owner while absent Health stays denied',t=>{
 const f=fixture(t),e=f.enroll();f.finiteRetention(1000);const first=f.item(e),second=f.item(e);second.change.source.upstreamId='synthetic-expiry-second';
 assert.deepEqual(f.repo.ingestCalendarScoped(f.a,{schemaVersion:'1.0.0',enrollmentId:e.enrollmentId,run:f.run(e),items:[first,second]}).map(r=>r.outcome),['accepted','accepted']);
 const health=randomUUID();f.db.connection.prepare('INSERT INTO mobile_context_enrollments VALUES(?,?,?,?,?,?,?,?,?,?)').run(health,f.a.principalId,f.a.endpointId,null,'healthKit',1,'unbound',JSON.stringify({categories:['SleepSegment'],uses:[],assistantIds:[],collectionPaused:true,usePaused:true}),'synthetic',null);
 f.db.connection.prepare('INSERT INTO mobile_context_records VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('0'.repeat(64),'1'.repeat(64),f.a.principalId,health,'SleepSegment',' {} ',' {"synthetic":"unrelated-health"} ','2020-01-01T00:00:00Z',randomUUID(),'2000-01-01T00:00:00Z','synthetic-original-health');
 const untouched=f.db.connection.prepare('SELECT rowid,* FROM mobile_context_records WHERE enrollment_id=?').all(health);assert.throws(()=>f.repo.enrollment(f.a,health));assert.throws(()=>f.repo.createUnbound(f.a,'healthKit'));
 f.advance(2000);assert.deepEqual(f.repo.purgeExpired(f.a,1),{removed:1,more:true});assert.deepEqual(f.repo.purgeExpired(f.a,1),{removed:1,more:false});assert.deepEqual(f.db.connection.prepare('SELECT rowid,* FROM mobile_context_records WHERE enrollment_id=?').all(health),untouched);
 assert.equal(f.journal.sourceSnapshot().intents.length,2);assert.ok(f.journal.sourceSnapshot().intents.every(i=>i.reason==='retentionExpired'&&i.scope.collector==='eventKit'&&i.scope.sourceNamespace===e.sourceNamespace));assert.throws(()=>f.repo.enrollment(f.a,health));
});
