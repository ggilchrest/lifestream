import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {test,type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,copyFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {RecoveryJournal,type RecoveryIntent,type SourceRecoveryScope,type SourceRecoveryIntent} from '../src/admin/recovery-journal.ts';
const key='a'.repeat(64),scope=():SourceRecoveryScope=>({principalId:randomUUID(),collector:'healthKit',sourceNamespace:randomUUID()});
const source=(s=scope(),keys=[key]):SourceRecoveryIntent=>({operationId:randomUUID(),idempotencyKey:randomUUID(),scope:s,reason:'recordDeleted',sourceKeys:keys,createdAt:new Date().toISOString()});
const legacy=():RecoveryIntent=>({operationId:randomUUID(),idempotencyKey:randomUUID(),requestDigest:'b'.repeat(64),rootRecordIds:[],rootMemoryIds:[],rootProfileIds:[],actor:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID(),action:'delete-source',recordIds:[],memoryIds:[],profileIds:[],sourceDigests:['c'.repeat(64)],contentDigests:[],createdAt:new Date().toISOString()});
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'source-recovery-')),path=join(root,'state.sqlite'),directory=join(root,'safety');let db=new Database({path});db.migrate();db.exec('CREATE TABLE assistant_relationships (relationship_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, user_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 return {root,path,directory,get db(){return db;},journal:()=>new RecoveryJournal(db,directory),restart(backup?:string){db.close();if(backup)copyFileSync(backup,path);db=new Database({path});db.migrate();return new RecoveryJournal(db,directory);}};
}
test('Calendar policy phases use the same durable journal but cannot reuse a Health family reservation',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');
 const pin={family:'calendarPolicy' as const,principalId:randomUUID(),operationId:randomUUID(),requestDigest:'a'.repeat(64),reservationDigest:'b'.repeat(64)};
 assert.equal(j.sourcePolicy(pin,'reserved',pin.reservationDigest,true),'created');
 assert.equal(j.sourcePolicy({...pin,family:'healthPolicy'},'reserved',pin.reservationDigest,true),'conflict');
 assert.equal(j.sourcePolicy(pin,'prepared','c'.repeat(64),true),'created');assert.equal(j.sourcePolicy(pin,'terminal','d'.repeat(64),true),'created');
 const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourceSnapshot().policyOperations![0]!.family,'calendarPolicy');assert.equal(reopened.sourcePolicy(pin,'terminal','d'.repeat(64)),'matching');
});
test('explicit source initialization extends the same journal without changing legacy scopes or granting uses',t=>{
 const f=fixture(t),j=f.journal(),old=legacy();j.admit(old);const before=j.snapshot();assert.equal(j.sourceCurrent(),false);assert.equal(j.enableSources('requireExisting'),false);assert.equal(j.enableSources('initializeEmpty'),true);
 assert.equal(j.sourceSnapshot().epoch,0);assert.equal(f.db.connection.prepare('PRAGMA table_info(relationship_recovery_currency)').all().length,2);f.db.connection.prepare('INSERT OR IGNORE INTO relationship_recovery_currency VALUES(1,0)').run();assert.deepEqual(j.snapshot().intents,before.intents);assert.equal(j.revision,before.epoch);assert.equal(j.sourceForbidden(scope(),key),false,'absence of a denial is not a source-use grant');
 const intent=source();j.admitSource(intent);assert.equal(j.sourceSnapshot().epoch,1);assert.equal(j.revision,before.epoch);assert.deepEqual(j.snapshot().intents,before.intents);assert.equal(j.forbidden(old.actor,old.relationshipId,'',old.sourceDigests[0]),true);assert.equal(j.forbidden(old.actor,randomUUID(),'',old.sourceDigests[0]),false);
 const next=legacy();j.admit(next);assert.equal(j.sourceCurrent(),true);assert.equal(j.sourceForbidden(intent.scope,key),true);assert.equal(j.snapshot().intents.length,2);assert.equal(j.sourceSnapshot().intents.length,1);assert.equal(JSON.parse(readFileSync(join(f.directory,'journal.json'),'utf8')).sourceSafety.epoch,1);
});
test('source denial isolates human, collector and namespace; raw payload and fabricated relationship scope rejected',t=>{
 const f=fixture(t),j=f.journal();assert.equal(j.enableSources('initializeEmpty'),true);const intent=source();j.admitSource(intent);assert.equal(j.sourceForbidden(intent.scope,key),true);
 for(const other of [{...intent.scope,principalId:randomUUID()},{...intent.scope,sourceNamespace:randomUUID()},{...intent.scope,collector:'healthConnect' as const}])assert.equal(j.sourceForbidden(other,key),false);
 const epoch=j.sourceSnapshot().epoch;
 for(const bad of [{...source(),scope:{...intent.scope,relationshipId:randomUUID()}},{...source(),sourceKeys:['private synthetic sample']},{...source(),sourceKeys:[key,key]},{...source(),sourceKeys:Array.from({length:257},(_,i)=>i.toString(16).padStart(64,'0'))},{...source(),retention:'untilDeletion'}])assert.throws(()=>j.admitSource(bad as SourceRecoveryIntent));
 assert.equal(j.sourceSnapshot().epoch,epoch);assert.doesNotMatch(readFileSync(join(f.directory,'journal.json'),'utf8'),/private synthetic sample|relationshipId.*sourceNamespace/);
});
test('same human idempotency preserves original denial and rejects a changed scope or reason',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const intent=source(scope(),[key,'b'.repeat(64)]);j.admitSource(intent);
 const retry={...intent,operationId:randomUUID(),createdAt:new Date(Date.now()+1000).toISOString(),sourceKeys:[...intent.sourceKeys].reverse()};assert.deepEqual(j.admitSource(retry),intent);assert.equal(j.sourceSnapshot().epoch,1);
 assert.throws(()=>j.admitSource({...retry,reason:'sourceRemoved'}),/idempotency conflict/);assert.throws(()=>j.admitSource({...retry,scope:{...intent.scope,sourceNamespace:randomUUID()}}),/idempotency conflict/);
 const returned=j.sourceSnapshot();(returned.intents[0]!.sourceKeys as string[]).length=0;assert.equal(j.sourceForbidden(intent.scope,key),true);
});
test('source suppression survives SQL rollback and old database restoration; no source payload is journaled',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const intent=source(),backup=join(f.root,'old.sqlite');f.db.connection.prepare('VACUUM INTO ?').run(backup);
 assert.throws(()=>f.db.durableTransaction(()=>{j.admitSource(intent);throw Error('synthetic source transaction rollback');}),/synthetic source transaction rollback/);
 assert.equal(j.sourceForbidden(intent.scope,key),true);assert.equal(f.db.connection.prepare('SELECT epoch AS source_epoch FROM recovery_source_projection').get()!.source_epoch,0);
 let reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourceForbidden(intent.scope,key),true);
 reopened=f.restart(backup);assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourceForbidden(intent.scope,key),true);assert.equal(reopened.sourceSnapshot().epoch,1);
});
test('older source journal than projected source epoch fails closed while legacy recovery stays valid',t=>{
 const f=fixture(t),j=f.journal(),old=legacy();j.admit(old);j.enableSources('initializeEmpty');const journalPath=join(f.directory,'journal.json'),before=readFileSync(journalPath);j.admitSource(source());writeFileSync(journalPath,before);
 assert.equal(j.sourceCurrent(),false);const reopened=f.restart();assert.equal(reopened.currency,'current');assert.equal(reopened.enableSources('requireExisting'),false);assert.equal(reopened.sourceForbidden(scope(),key),true);assert.equal(reopened.forbidden(old.actor,old.relationshipId,'',old.sourceDigests[0]),true);
});
test('missing or malformed source evidence withholds source use without changing legacy journal semantics',t=>{
 const f=fixture(t),j=f.journal(),old=legacy();j.admit(old);j.enableSources('initializeEmpty');const path=join(f.directory,'journal.json'),value=JSON.parse(readFileSync(path,'utf8'));value.sourceSafety.epoch=1;writeFileSync(path,JSON.stringify(value));
 const reopened=f.restart();assert.equal(reopened.currency,'current');assert.equal(reopened.enableSources('requireExisting'),false);assert.equal(reopened.forbidden(old.actor,old.relationshipId,'',old.sourceDigests[0]),true);assert.equal(reopened.sourceForbidden(scope(),key),true);
 unlinkSync(path);assert.equal(j.sourceCurrent(),false);assert.equal(j.currency,'current');
});
test('preexisting source rows cannot silently initialize an empty suppression history',t=>{
 const f=fixture(t),j=f.journal();f.db.exec('CREATE TABLE mobile_context_sources(source_namespace TEXT)');f.db.connection.prepare('INSERT INTO mobile_context_sources VALUES(?)').run(randomUUID());assert.equal(j.enableSources('initializeEmpty'),false);assert.equal(j.sourceForbidden(scope(),key),true);assert.equal(j.snapshot().sourceSafety,undefined);assert.equal(j.currency,'current');
});
test('source initialization cannot overwrite a newer legacy journal from an existing owner',t=>{
 const f=fixture(t),stale=f.journal(),owner=f.journal(),intent=legacy();owner.admit(intent);const path=join(f.directory,'journal.json'),before=readFileSync(path);assert.equal(stale.enableSources('initializeEmpty'),false);assert.deepEqual(readFileSync(path),before);assert.equal(owner.forbidden(intent.actor,intent.relationshipId,'',intent.sourceDigests[0]),true);
});
test('malformed source capacity cannot disable a legitimate legacy recovery append or discard unknown evidence',t=>{
 const f=fixture(t),j=f.journal(),first=legacy();j.admit(first);j.enableSources('initializeEmpty');const path=join(f.directory,'journal.json'),value=JSON.parse(readFileSync(path,'utf8'));value.sourceSafety.intents='x'.repeat(10000);writeFileSync(path,JSON.stringify(value));const reopened=f.restart();assert.equal(reopened.currency,'current');assert.equal(reopened.enableSources('requireExisting'),false);const next=legacy();assert.deepEqual(reopened.admit(next),next);assert.equal(reopened.snapshot().intents.length,2);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).sourceSafety,value.sourceSafety);assert.equal(reopened.sourceForbidden(scope(),key),true);
});
test('complete 129-record hash selection commits together and survives rollback and older SQL restore',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const owned=scope(),keys=Array.from({length:258},(_,i)=>i.toString(16).padStart(64,'0')),batch=[source(owned,keys.slice(0,256)),source(owned,keys.slice(256))],backup=join(f.root,'old-batch.sqlite');f.db.connection.prepare('VACUUM INTO ?').run(backup);
 assert.throws(()=>f.db.durableTransaction(()=>{assert.deepEqual(j.admitSourceBatch(batch),batch);throw Error('synthetic batch SQL rollback');}),/synthetic batch SQL rollback/);assert.equal(j.sourceSnapshot().epoch,2);assert.ok(keys.every(k=>j.sourceForbidden(owned,k)));assert.equal(f.db.connection.prepare('SELECT epoch FROM recovery_source_projection').get()!.epoch,0);
 const restored=f.restart(backup);assert.equal(restored.enableSources('requireExisting'),true);assert.equal(restored.sourceSnapshot().intents.length,2);assert.ok(keys.every(k=>restored.sourceForbidden(owned,k)));
 const before=readFileSync(join(f.directory,'journal.json')),changes=Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n);assert.deepEqual(restored.admitSourceBatch(batch),batch);assert.equal(Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n),changes);assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);
});
test('a malformed or conflicting later chunk cannot admit an earlier valid prefix',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const existing=source();j.admitSource(existing);const fresh=source(),before=readFileSync(join(f.directory,'journal.json'));
 for(const last of [{...source(),sourceKeys:['invalid-hash']},{...existing,reason:'retentionExpired' as const}]){assert.throws(()=>j.admitSourceBatch([fresh,last]));assert.equal(j.sourceSnapshot().epoch,1);assert.equal(j.sourceForbidden(fresh.scope,key),false);assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);}
});
test('whole-batch existing 8MiB capacity failure leaves every new denial uncommitted',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const owned=scope(),keys=Array.from({length:256},(_,i)=>i.toString(16).padStart(64,'0')),batch=Array.from({length:500},()=>source(owned,keys)),before=readFileSync(join(f.directory,'journal.json'));assert.ok(Buffer.byteLength(JSON.stringify(batch))>8388608);assert.throws(()=>j.admitSourceBatch(batch),/capacity/);assert.equal(j.sourceSnapshot().epoch,0);assert.equal(j.sourceForbidden(owned,keys[0]!),false);assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);
});

test('a post-rename directory sync failure cannot let a later legacy append erase published source denials',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const owned=scope(),batch=[source(owned,[key]),source(owned,['b'.repeat(64)])],original=fs.fsyncSync;let injected=false;
 fs.fsyncSync=((fd:number)=>{if(!injected&&fs.fstatSync(fd).isDirectory()){injected=true;throw Error('synthetic directory sync failure after rename');}return original(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{assert.throws(()=>j.admitSourceBatch(batch),/synthetic directory sync failure/);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(injected,true);assert.equal(JSON.parse(readFileSync(join(f.directory,'journal.json'),'utf8')).sourceSafety.intents.length,2);
 j.admit(legacy());const disk=JSON.parse(readFileSync(join(f.directory,'journal.json'),'utf8'));assert.equal(disk.sourceSafety.intents.length,2);assert.equal(disk.intents.length,1);assert.equal(j.sourceForbidden(owned,key),true);assert.equal(j.sourceForbidden(owned,'b'.repeat(64)),true);
 const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourceForbidden(owned,key),true);
});
test('same-batch retry cannot report committed denial until uncertain directory durability is confirmed',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const batch=[source()],original=fs.fsyncSync;let current=j;
 fs.fsyncSync=((fd:number)=>{if(fs.fstatSync(fd).isDirectory())throw Error('synthetic continued directory sync failure');return original(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{assert.throws(()=>j.admitSourceBatch(batch),/synthetic continued directory sync failure/);assert.throws(()=>j.admitSourceBatch(batch),/synthetic continued directory sync failure/);assert.equal(j.sourceCurrent(),false);assert.throws(()=>j.sourceSnapshot(),/unavailable/);const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),false);current=reopened;}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(current.enableSources('requireExisting'),true);assert.deepEqual(current.admitSourceBatch(batch),batch);assert.equal(current.sourceCurrent(),true);assert.equal(current.sourceSnapshot().epoch,1);
});

test('control admission extends legacy source state with identity hashes only and stable read-only conflict checks',t=>{
 const f=fixture(t),j=f.journal();assert.equal(j.enableSources('initializeEmpty'),true);const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)};
 const before=readFileSync(join(f.directory,'journal.json'));assert.equal(j.sourceControl(fence),'absent');assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);assert.equal(j.sourceControl(fence,true),'created');assert.deepEqual(j.sourceSnapshot().controls,[{...fence,phaseVersion:'1.0.0'}]);assert.equal(j.sourceSnapshot().epoch,1);
 const changes=Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n),file=readFileSync(join(f.directory,'journal.json'));assert.equal(j.sourceControl(fence,true),'matching');assert.equal(j.sourceControl({...fence,requestDigest:'e'.repeat(64)},true),'conflict');assert.equal(Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n),changes);assert.deepEqual(readFileSync(join(f.directory,'journal.json')),file);
 j.admitSource(source());assert.equal(j.sourceSnapshot().epoch,2);assert.deepEqual(j.sourceSnapshot().controls,[{...fence,phaseVersion:'1.0.0'}]);const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourceControl(fence),'matching');
});
test('unknown or duplicate control fence fields hold source operations while preserving legacy recovery',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const path=join(f.directory,'journal.json'),base=JSON.parse(readFileSync(path,'utf8')),fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)};
 for(const controls of [[{...fence,retention:'untilDeletion'}],[fence,fence],[{...fence,requestDigest:['d'.repeat(64)]}],[{...fence,preparedDigest:['e'.repeat(64)]}],[{...fence,terminalDigest:'invalid'}],{},null]){writeFileSync(path,JSON.stringify({...base,sourceSafety:{...base.sourceSafety,epoch:Array.isArray(controls)?controls.length:0,controls}}));const reopened=f.restart();assert.equal(reopened.currency,'current');assert.equal(reopened.enableSources('requireExisting'),false);assert.throws(()=>reopened.sourceControl(fence));assert.deepEqual(reopened.admit(legacy()).action,'delete-source');}
});
test('control admissions share the existing combined safety entry quota without eviction or partial writes',t=>{
 const f=fixture(t),j=f.journal();j.admit(legacy());j.enableSources('initializeEmpty');const path=join(f.directory,'journal.json'),value=JSON.parse(readFileSync(path,'utf8')),principalId=randomUUID(),controls=Array.from({length:9999},()=>({principalId,operationId:randomUUID(),requestDigest:'d'.repeat(64),phaseVersion:'1.0.0'}));value.sourceSafety={...value.sourceSafety,epoch:9999,controls};writeFileSync(path,JSON.stringify(value));const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);const file=readFileSync(path);assert.throws(()=>reopened.sourceControl({principalId,operationId:randomUUID(),requestDigest:'e'.repeat(64)},true),/capacity/);assert.throws(()=>reopened.admitSource(source()),/capacity/);assert.throws(()=>reopened.sourceControlPhase({principalId,operationId:controls[0]!.operationId,requestDigest:'d'.repeat(64)},'prepared','e'.repeat(64),true),/capacity/);assert.throws(()=>reopened.admit(legacy()),/capacity/);assert.deepEqual(readFileSync(path),file);assert.equal(reopened.sourceSnapshot().controls!.length,9999);
});
test('a control admission published before directory sync failure never becomes a fresh retry',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)},original=fs.fsyncSync;
 fs.fsyncSync=((fd:number)=>{if(fs.fstatSync(fd).isDirectory())throw Error('synthetic control directory sync failure');return original(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();
 try{assert.throws(()=>j.sourceControl(fence,true),/directory sync/);assert.equal(j.sourceCurrent(),false);assert.throws(()=>j.sourceControl(fence));assert.throws(()=>j.sourceControl(fence,true),/directory sync/);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(j.sourceControl(fence,true),'matching');assert.equal(j.sourceCurrent(),true);assert.equal(j.sourceSnapshot().controls!.length,1);
});

test('independent control phase fingerprints advance monotonically and never supply a receipt',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)},prepared='e'.repeat(64),terminal='f'.repeat(64);j.sourceControl(fence,true);
 assert.equal(j.sourceControlPhase(fence,'reserved',fence.requestDigest),'matching');assert.equal(j.sourceControlPhase(fence,'prepared',prepared),'absent');assert.equal(j.sourceControlPhase(fence,'prepared',prepared,true),'created');assert.equal(j.sourceSnapshot().epoch,2);assert.equal(j.sourceControlPhase(fence,'reserved',fence.requestDigest),'ahead');assert.equal(j.sourceControlPhase(fence,'prepared','a'.repeat(64)),'conflict');
 assert.equal(j.sourceControlPhase(fence,'terminal',terminal,true),'created');assert.equal(j.sourceSnapshot().epoch,3);assert.equal(j.sourceControlPhase(fence,'prepared',prepared,true),'ahead');assert.equal(j.sourceControlPhase(fence,'terminal',terminal),'matching');
 const file=readFileSync(join(f.directory,'journal.json')),changes=Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n);assert.equal(j.sourceControlPhase(fence,'terminal',terminal,true),'matching');assert.equal(j.sourceControlPhase(fence,'terminal','b'.repeat(64),true),'conflict');assert.equal(Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n),changes);assert.deepEqual(readFileSync(join(f.directory,'journal.json')),file);assert.deepEqual(j.sourceSnapshot().controls,[{...fence,phaseVersion:'1.0.0',preparedDigest:prepared,terminalDigest:terminal}]);
 const restored=f.restart();assert.equal(restored.enableSources('requireExisting'),true);assert.equal(restored.sourceControlPhase(fence,'reserved',fence.requestDigest),'ahead');assert.equal(restored.sourceControlPhase(fence,'terminal',terminal),'matching');
});
test('an older independent phase file than the existing SQL projection marker cannot qualify a control',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)};j.sourceControl(fence,true);const path=join(f.directory,'journal.json'),before=readFileSync(path);j.sourceControlPhase(fence,'prepared','e'.repeat(64),true);writeFileSync(path,before);assert.equal(j.sourceCurrent(),false);const reopened=f.restart();assert.equal(reopened.currency,'current');assert.equal(reopened.enableSources('requireExisting'),false);assert.throws(()=>reopened.sourceControlPhase(fence,'reserved',fence.requestDigest),/unavailable/);
});
test('terminal phase publication uncertainty remains held and cannot roll back to prepared evidence',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)},prepared='e'.repeat(64),terminal='f'.repeat(64);j.sourceControl(fence,true);j.sourceControlPhase(fence,'prepared',prepared,true);const original=fs.fsyncSync;
 fs.fsyncSync=((fd:number)=>{if(fs.fstatSync(fd).isDirectory())throw Error('synthetic terminal directory sync failure');return original(fd);}) as typeof fs.fsyncSync;syncBuiltinESMExports();try{assert.throws(()=>j.sourceControlPhase(fence,'terminal',terminal,true),/directory sync/);assert.equal(j.sourceCurrent(),false);assert.throws(()=>j.sourceControlPhase(fence,'prepared',prepared));assert.throws(()=>j.sourceControlPhase(fence,'terminal',terminal,true),/directory sync/);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(j.sourceControlPhase(fence,'terminal',terminal,true),'matching');assert.equal(j.sourceControlPhase(fence,'prepared',prepared),'ahead');assert.equal(j.sourceSnapshot().epoch,3);
});

test('a remembered pre-phase admission cannot be silently adopted even when SQL appears reserved',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'d'.repeat(64)},path=join(f.directory,'journal.json'),value=JSON.parse(readFileSync(path,'utf8'));value.sourceSafety={...value.sourceSafety,epoch:1,controls:[fence]};writeFileSync(path,JSON.stringify(value));const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);const before=readFileSync(path),changes=Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n);assert.equal(reopened.sourceControl(fence,true),'matching');assert.equal(reopened.sourceControlPhase(fence,'reserved',fence.requestDigest),'absent');assert.equal(reopened.sourceControlPhase(fence,'prepared','e'.repeat(64),true),'absent');assert.deepEqual(readFileSync(path),before);assert.equal(Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n),changes);
});

test('metadata-bearing reservation digest cannot be dropped, replaced or bypassed before attempt',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const base={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'a'.repeat(64)},pin='b'.repeat(64);assert.equal(j.sourceControl({...base,reservationDigest:pin},true),'created');assert.equal(j.sourceSnapshot().epoch,1);const before=readFileSync(join(f.directory,'journal.json')),changes=Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n);
 assert.equal(j.sourceControl(base),'matching');assert.equal(j.sourceControl(base,true),'conflict');assert.equal(j.sourceControl({...base,reservationDigest:'c'.repeat(64)},true),'conflict');assert.equal(j.sourceControlPhase(base,'reserved',pin),'matching');assert.equal(j.sourceControlPhase(base,'reserved','d'.repeat(64)),'conflict');assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);assert.equal(Number(f.db.connection.prepare('SELECT total_changes() AS n').get()!.n),changes);const restored=f.restart();assert.equal(restored.enableSources('requireExisting'),true);assert.equal(restored.sourceControlPhase(base,'reserved','d'.repeat(64)),'conflict');assert.equal(restored.sourceControlPhase(base,'reserved',pin),'matching');
});
test('an existing ordinary admission cannot silently acquire interpretation reservation evidence',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const base={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'a'.repeat(64)};assert.equal(j.sourceControl(base,true),'created');const before=readFileSync(join(f.directory,'journal.json'));assert.equal(j.sourceControl({...base,reservationDigest:'b'.repeat(64)},true),'conflict');assert.equal(j.sourceControlPhase(base,'reserved','c'.repeat(64)),'matching');assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);
});

test('Calendar denial collectors survive the existing independent journal restart and SQL restoration',t=>{const f=fixture(t),j=f.journal();assert.equal(j.enableSources('initializeEmpty'),true);const backup=join(f.root,'calendar-old.sqlite');f.db.connection.prepare('VACUUM INTO ?').run(backup);const intents=(['eventKit','androidCalendar','googleTasks'] as const).map(collector=>source({...scope(),collector}));for(const intent of intents)j.admitSource(intent);const reopened=f.restart(backup);assert.equal(reopened.enableSources('requireExisting'),true);for(const intent of intents){assert.equal(reopened.sourceForbidden(intent.scope,key),true);assert.equal(reopened.sourceForbidden({...intent.scope,collector:'healthKit'},key),false);}assert.equal(reopened.sourceSnapshot().intents.length,3);});

test('Calendar control uses the original journal with distinct closed family and restart-stable phase evidence',t=>{
 const f=fixture(t),j=f.journal();assert.equal(j.enableSources('initializeEmpty'),true);
 const fence={principalId:randomUUID(),operationId:randomUUID(),requestDigest:'a'.repeat(64),family:'calendarControl' as const,reservationDigest:'b'.repeat(64)};
 const phaseFence={principalId:fence.principalId,operationId:fence.operationId,requestDigest:fence.requestDigest};
 assert.equal(j.sourceControl(fence,true),'created');assert.equal(j.sourceControlPhase(phaseFence,'reserved',fence.reservationDigest),'matching');
 const before=readFileSync(join(f.directory,'journal.json'));
 assert.equal(j.sourceControl({...fence,family:'ordinaryControl'},true),'conflict');assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);
 assert.equal(j.sourceControlPhase(phaseFence,'prepared','c'.repeat(64),true),'created');assert.equal(j.sourceControlPhase(phaseFence,'terminal','d'.repeat(64),true),'created');
 const reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourceControl(fence),'matching');assert.equal(reopened.sourceControlPhase(phaseFence,'terminal','d'.repeat(64)),'matching');assert.equal(reopened.sourceSnapshot().controls![0]!.family,'calendarControl');
});

test('separate Calendar source-consent family shares original journal and survives cold read without borrowing Health/Calendar policy identity',t=>{
 const f=fixture(t),j=f.journal();j.enableSources('initializeEmpty');const fence={family:'calendarSourceConsent' as const,principalId:randomUUID(),operationId:randomUUID(),requestDigest:'a'.repeat(64),reservationDigest:'b'.repeat(64)};assert.equal(j.sourcePolicy(fence,'reserved',fence.reservationDigest,true),'created');assert.equal(j.sourcePolicy({...fence,family:'calendarPolicy'},'reserved',fence.reservationDigest,true),'conflict');assert.equal(j.sourcePolicy(fence,'prepared','c'.repeat(64),true),'created');assert.equal(j.sourcePolicy(fence,'terminal','d'.repeat(64),true),'created');const before=readFileSync(join(f.directory,'journal.json')),reopened=f.restart();assert.equal(reopened.enableSources('requireExisting'),true);assert.equal(reopened.sourcePolicy(fence,'terminal','d'.repeat(64)),'matching');assert.deepEqual(readFileSync(join(f.directory,'journal.json')),before);assert.equal(reopened.sourceSnapshot().policyOperations![0]!.family,'calendarSourceConsent');
});


test('dedicated Health source consent family cannot reuse Calendar consent or Health classification reservations',t=>{
 const f=fixture(t),j=f.journal();assert.equal(j.enableSources('initializeEmpty'),true);const pin={family:'healthSourceConsent' as const,principalId:randomUUID(),operationId:randomUUID(),requestDigest:'a'.repeat(64),reservationDigest:'b'.repeat(64)};assert.equal(j.sourcePolicy(pin,'reserved',pin.reservationDigest,true),'created');for(const family of ['calendarSourceConsent','healthPolicy']as const)assert.equal(j.sourcePolicy({...pin,family},'reserved',pin.reservationDigest,true),'conflict');assert.equal(j.sourcePolicy(pin,'prepared','c'.repeat(64),true),'created');assert.equal(j.sourcePolicy(pin,'terminal','d'.repeat(64),true),'created');const cold=f.restart();assert.equal(cold.enableSources('requireExisting'),true);assert.equal(cold.sourceSnapshot().policyOperations![0]!.family,'healthSourceConsent');assert.equal(cold.sourcePolicy(pin,'terminal','d'.repeat(64)),'matching');
});
