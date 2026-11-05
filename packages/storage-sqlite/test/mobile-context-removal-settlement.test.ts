// Genuine repository/SQLite/independent journal, explicit synthetic policy only.
// Imports are inert owners; no index/factory/providers/audit or server fixture.
import test,{type TestContext} from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Database} from '../src/database.ts';import {loadMobileSourceControlMigrations} from '../src/mobile-source-control-migrations.ts';
import {MobileContextRepository,type MobileAccess,type MobileGovernance} from '../src/mobile-context.ts';
import {RecoveryJournal} from '../../../apps/server/src/admin/recovery-journal.ts';
import {mobileSourceSafety} from '../../../apps/server/src/runtime/mobile-context-source-safety.ts';
import {removalControlPin,removalControlSettlement,removalControlResponse} from '../../contracts/src/mobile-context-removal-settlement.ts';
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'removal-owner-unit-')),db=new Database({path:join(root,'data.sqlite'),migrations:loadMobileSourceControlMigrations()});db.migrate();
 db.exec('CREATE TABLE IF NOT EXISTS assistant_relationships (relationship_id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL,user_id TEXT NOT NULL,payload_json TEXT NOT NULL)');
 const journal=new RecoveryJournal(db,join(root,'journal'));assert.equal(journal.enableSources('initializeEmpty'),true);let current=true,denyFailure=false;
 const a:MobileAccess={principalId:randomUUID(),endpointId:randomUUID(),current:()=>current};
 const safety=mobileSourceSafety(journal,db,1000),g:MobileGovernance={...safety,allowed:()=>true,retention:()=>({policyRef:'explicit-synthetic-policy',expiresAt:null}),recordCurrent:()=>true,invalidate(){},remove:(...args)=>{if(denyFailure)throw Error('synthetic independent denial failure');safety.remove(...args);}};
 const repo=new MobileContextRepository(db,g,1000,Date.now,{maximumOperationsPerHuman:100});let e=repo.createUnbound(a,'healthKit');e=repo.bindSource(a,e.enrollmentId,e.revision,{createNew:true});e=repo.configure(a,e.enrollmentId,e.revision,'active',{categories:['SleepSegment'],uses:[],assistantIds:[],collectionPaused:false,usePaused:true});
 const original=()=>({schemaVersion:'1.0.0' as const,operationId:randomUUID(),target:{principalId:a.principalId,endpointId:a.endpointId,collector:'healthKit' as const,enrollmentId:e.enrollmentId,sourceNamespace:e.sourceNamespace,expectedRevision:repo.enrollment(a,e.enrollmentId).revision},action:{kind:'remove' as const,scope:'wholeSource' as const}});
 const ingest=(name:string)=>{const value=repo.enrollment(a,e.enrollmentId);const result=repo.ingest(a,{schemaVersion:'1.0.0',changes:[{schemaVersion:'1.0.0',eventId:randomUUID(),enrollmentId:e.enrollmentId,expectedPolicyRevision:value.revision,source:{collector:'healthKit',namespace:e.sourceNamespace,upstreamId:name},collectedAt:'2026-11-05T00:00:00.000Z',mappingVersion:'explicit-synthetic-mapping',operation:'upsert',recordType:'SleepSegment',record:{schemaVersion:'1.0.0',startAt:'2026-11-04T00:00:00.000Z',endAt:'2026-11-04T08:00:00.000Z',stage:'coreLight',classification:'unknown'}}]});assert.equal(result[0]!.outcome,'accepted');};
 const snapshot=()=>({journal:readFileSync(join(root,'journal/journal.json')),rows:db.connection.prepare('SELECT * FROM mobile_context_control_operations ORDER BY operation_id').all(),changes:Number(db.connection.prepare('SELECT total_changes() n').get()!.n)});
 const count=()=>Number(db.connection.prepare('SELECT count(*) n FROM mobile_context_records').get()!.n),response=(result:ReturnType<typeof repo.reconcileRemovalControl>)=>({schemaVersion:'1.0.0' as const,producerPin:removalControlPin,result});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {root,db,journal,a,g,repo,e,original,ingest,snapshot,count,response,setDenyFailure:(v:boolean)=>{denyFailure=v;},setCurrent:(v:boolean)=>{current=v;}};
}
test('new family initial is observed; only exact independently reconciled terminal settles without replay',t=>{
 const f=fixture(t);f.ingest('one');const original=f.original(),before=f.snapshot();assert.deepEqual(f.repo.reconcileRemovalControl(f.a,original),{kind:'held',reason:'unknown'});assert.deepEqual(f.snapshot(),before);
 const first=f.repo.controlRemoval(f.a,original);assert.equal(first.kind,'observed');assert.equal(removalControlSettlement(original,f.response(first)),'held');assert.equal(f.count(),0);
 const terminal=f.repo.reconcileRemovalControl(f.a,original);assert.equal(terminal.kind,'terminal');assert.equal(removalControlSettlement(original,f.response(terminal)),'applied');assert(removalControlResponse(f.response(terminal)));
 const stored=f.journal.sourceSnapshot().controls![0]!;assert.equal(stored.family,'sourceRemovalControl');assert(stored.preparedDigest&&stored.terminalDigest);
 const stable=f.snapshot();assert.equal(f.repo.controlRemoval(f.a,original).kind,'observed');assert.equal(f.repo.reconcileRemovalControl(f.a,original).kind,'terminal');assert.deepEqual(f.snapshot(),stable);
 assert.equal(f.repo.enrollment(f.a,f.e.enrollmentId).state,'active','removal is not disconnect');assert.equal(f.repo.enrollment(f.a,f.e.enrollmentId).configuration.collectionPaused,false);
});
test('129 selected records have all258 durable denial keys BEFORE each deletion; initial still cannot settle',t=>{
 const f=fixture(t);for(let i=0;i<129;i++)f.ingest('selected-'+i);let deletes=0;
 const expected=f.db.connection.prepare('SELECT source_key,suppression_key FROM mobile_context_records').all();
 f.db.connection.function('all_selected_denied',()=>{const denied=new Set(f.journal.sourceSnapshot().intents.flatMap(v=>[...v.sourceKeys]));if(!expected.every(v=>denied.has(String(v.source_key))&&denied.has(String(v.suppression_key))))return 0;deletes++;return 1;});
 f.db.exec("CREATE TRIGGER all_denials_before_each_delete BEFORE DELETE ON mobile_context_records BEGIN SELECT CASE WHEN all_selected_denied()<>1 THEN RAISE(ABORT,'not independently denied') END; END");
 const r=f.original(),initial=f.repo.controlRemoval(f.a,r);assert.equal(initial.kind,'observed');const result=f.repo.reconcileRemovalControl(f.a,r);assert.equal(result.kind,'terminal');if(result.kind!=='terminal')throw Error('missing terminal');
 assert.equal(result.control.result.receipt.result.kind,'remove');if(result.control.result.receipt.result.kind!=='remove')throw Error('wrong result');assert.equal(result.control.result.receipt.result.removedCount,129);assert.equal(deletes,129);assert.equal(f.journal.sourceSnapshot().intents.length,2);assert.equal(f.count(),0);
});
test('independent denial failure freezes selection; only explicit original host recovery removes selected, retaining later record',t=>{
 const f=fixture(t);f.ingest('selected');const r=f.original();f.setDenyFailure(true);assert.equal(f.repo.controlRemoval(f.a,r).kind,'observed');assert.equal(f.count(),1);const row=f.db.connection.prepare('SELECT selection_json,attempt_started FROM mobile_context_control_operations').get()!;assert.equal(row.attempt_started,1);assert.equal(JSON.parse(String(row.selection_json)).length,1);
 f.setDenyFailure(false);f.ingest('later-unselected');const stable=f.snapshot();assert.notEqual(f.repo.reconcileRemovalControl(f.a,r).kind,'terminal');assert.equal(f.repo.controlRemoval(f.a,r).kind,'observed');assert.deepEqual(f.snapshot(),stable);assert.equal(f.count(),2);
 f.repo.completeReservedControl(f.a,r);assert.equal(f.repo.reconcileRemovalControl(f.a,r).kind,'terminal');assert.equal(f.count(),1);assert.equal(JSON.parse(String(f.db.connection.prepare('SELECT source_json FROM mobile_context_records').get()!.source_json)).upstreamId,'later-unselected');
});
test('receipt SQL failure retains independent terminal/denial truth but never fabricates terminal or rollback on replay',t=>{
 const f=fixture(t);f.ingest('selected');f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON mobile_context_control_operations WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");const r=f.original();assert.equal(f.repo.controlRemoval(f.a,r).kind,'observed');assert.equal(f.count(),1);assert(f.journal.sourceSnapshot().controls![0]!.terminalDigest);assert(f.journal.sourceSnapshot().intents.length>0);
 const stable=f.snapshot();assert.notEqual(f.repo.reconcileRemovalControl(f.a,r).kind,'terminal');assert.throws(()=>f.repo.controlRemoval(f.a,r));assert.deepEqual(f.snapshot(),stable);assert.equal(f.count(),1);
});
test('legacy base/NULL originals are never upgraded into removal family or witnessed terminal',t=>{
 const f=fixture(t);const r=f.original();assert.equal(f.repo.control(f.a,r).result.status,'applied');assert.equal(f.journal.sourceSnapshot().controls![0]!.family,undefined);const stable=f.snapshot();assert.notEqual(f.repo.reconcileRemovalControl(f.a,r).kind,'terminal');assert.throws(()=>f.repo.controlRemoval(f.a,r));assert.deepEqual(f.snapshot(),stable);
});
test('wrong subject, endpoint, changed original and unavailable scope cannot borrow terminal authority',t=>{
 const f=fixture(t),r=f.original();f.repo.controlRemoval(f.a,r);const bad=structuredClone(r);bad.target.expectedRevision++;assert.throws(()=>f.repo.controlRemoval(f.a,bad));assert.throws(()=>f.repo.reconcileRemovalControl({...f.a,principalId:randomUUID()},r));assert.throws(()=>f.repo.controlRemoval({...f.a,endpointId:randomUUID()},r));f.setCurrent(false);assert.throws(()=>f.repo.reconcileRemovalControl(f.a,r));
});
test('changed SQL during extensible family callback is caught by final pure captured-row publication',t=>{
 const f=fixture(t),r=f.original();f.repo.controlRemoval(f.a,r);const original=f.g.removalControlFamily!;let calls=0;
 f.g.removalControlFamily=(a,input)=>{const proof=original(a,input);if(++calls===2){const row=f.db.connection.prepare('SELECT outcome_json FROM mobile_context_control_operations').get()!;const value=JSON.parse(String(row.outcome_json));value.receipt.receiptId=randomUUID();f.db.connection.prepare('UPDATE mobile_context_control_operations SET outcome_json=?').run(JSON.stringify(value));}return proof;};
 assert.notEqual(f.repo.reconcileRemovalControl(f.a,r).kind,'terminal');assert.equal(calls,2);assert.equal(f.count(),0,'known earlier deletion is not invented rollback');
});
