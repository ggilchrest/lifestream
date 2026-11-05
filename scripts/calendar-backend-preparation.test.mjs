import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {calendarMigrations,calendarPolicyMigrations,calendarConsentMigrations,calendarExpandedDDL,createCalendarSchemaChecker} from './calendar-schema-compatibility.mjs';
import {integrateCalendarIndex} from './prepare-calendar-backend.mjs';
const source=resolve(import.meta.dirname,'..'),migrationsDirectory=join(source,'packages/storage-sqlite/src/migrations');
const packageRoot=process.env.CALENDAR_PREPARED_PACKAGE;
test('expanded DDL is derived only from exact original84/86 plus nullable89, without policy decisions or interpretation',()=>{
 const ddl=calendarExpandedDDL(migrationsDirectory);assert.ok(ddl.some(x=>x.name==='mobile_context_enrollments'&&x.sql.includes('sync_window_json')));assert.equal(ddl.some(x=>x.name.includes('policy_decisions')),false);assert.equal(ddl.some(x=>x.name.includes('interpretation')),false);assert.deepEqual(calendarMigrations.map(x=>x.id),[84,86,89]);
});
test('exact current-base index seams reject a different source and preserve unrelated bytes',()=>{
 assert.throws(()=>integrateCalendarIndex('unrelated server'),/Exact unique/);
});
if(packageRoot){
 const root=resolve(packageRoot),original=await import(pathToFileURL(join(root,'launch/schema77-compatibility.mjs'))),base=original.healthBase77Reference(),checker=createCalendarSchemaChecker({baseReference:original.healthBase77Reference,assertBase77:original.assertCompatibleSchema,migrationsDirectory:join(root,'backend/packages/storage-sqlite/src/migrations')});
 const consentChecker=createCalendarSchemaChecker({baseReference:original.healthBase77Reference,assertBase77:original.assertCompatibleSchema,migrationsDirectory:join(root,'backend/packages/storage-sqlite/src/migrations'),policy:true,consent:true});
 const policyChecker=createCalendarSchemaChecker({baseReference:original.healthBase77Reference,assertBase77:original.assertCompatibleSchema,migrationsDirectory:join(root,'backend/packages/storage-sqlite/src/migrations'),policy:true});
 test('original-owner source projection is admitted read-only without conferring source currency',async()=>{
  const prior=process.env.LIFESTREAM_CALENDAR_PRODUCTION_DRIVER;process.env.LIFESTREAM_CALENDAR_PRODUCTION_DRIVER='1';
  let createCalendarProductionFixture;try{({createCalendarProductionFixture}=await import(pathToFileURL(join(root,'backend/apps/server/test/calendar-production-consent.test.ts'))));}finally{if(prior===undefined)delete process.env.LIFESTREAM_CALENDAR_PRODUCTION_DRIVER;else process.env.LIFESTREAM_CALENDAR_PRODUCTION_DRIVER=prior;}
  const f=await createCalendarProductionFixture();try{
   const path=join(f.root,'test.sqlite'),db=f.app.database.connection,journal=f.app.admin.recovery.journal,journalPath=join(journal.directory,'journal.json');chmodSync(path,0o600);
   assert.equal(journal.sourceCurrent(),true);assert.equal(f.app.server.listening,false);
   assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='recovery_source_projection'").get().sql,'CREATE TABLE recovery_source_projection (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL CHECK(epoch>=0))');
   for(const state of ['original','ahead','empty']){
    if(state==='ahead')db.prepare('UPDATE recovery_source_projection SET epoch=?').run(journal.sourceSnapshot().epoch+1);
    if(state==='empty')db.exec('DELETE FROM recovery_source_projection');
    const before={db:readFileSync(path),journal:readFileSync(journalPath),rows:db.prepare('SELECT rowid,* FROM recovery_source_projection').all()};
    assert.equal(consentChecker(path).schema,90);assert.throws(()=>policyChecker(path));assert.throws(()=>checker(path));
    assert.deepEqual(readFileSync(path),before.db);assert.deepEqual(readFileSync(journalPath),before.journal);assert.deepEqual(db.prepare('SELECT rowid,* FROM recovery_source_projection').all(),before.rows);
    assert.equal(journal.sourceCurrent(),state==='original','Schema admission must not supply source authority');
   }
  }finally{await f.close();}
 });
 function fixture(t,expanded=true){const dir=mkdtempSync(join(tmpdir(),'calendar-prepared-schema-')),path=join(dir,'synthetic.sqlite'),db=new DatabaseSync(path);chmodSync(path,0o600);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  // Exact preserved pristine reference, not recreated approximate DDL.
  db.exec('PRAGMA foreign_keys=OFF');db.exec('BEGIN IMMEDIATE');
  for(const row of [...base.reference.base,...base.additions].sort((a,b)=>(a.type==='table'?0:1)-(b.type==='table'?0:1))){if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(row.name))db.exec(row.sql);}
  const insert=db.prepare('INSERT INTO schema_migrations(id,name,digest,applied_at)VALUES(?,?,?,?)');for(const m of base.migrations)insert.run(m.id,m.name,m.digest,'synthetic');db.exec('COMMIT');db.exec('PRAGMA foreign_keys=ON');
  if(expanded)db.exec('BEGIN IMMEDIATE');if(expanded)for(const m of calendarMigrations){db.exec(readFileSync(join(migrationsDirectory,m.file),'utf8'));insert.run(m.id,m.name,m.digest,'synthetic');}if(expanded)db.exec('COMMIT');return {db,path};
 }
 const projectionDDL='CREATE TABLE recovery_source_projection (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL CHECK(epoch>=0))';
 test('exact optional projection cohort preserves empty and safe epochs in expanded old and consent plans',t=>{
  for(const consent of [false,true]){const f=fixture(t);if(consent)for(const id of [87,90]){const m=calendarConsentMigrations.find(x=>x.id===id);f.db.exec(readFileSync(join(migrationsDirectory,m.file),'utf8'));f.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(m.id,m.name,m.digest,'synthetic');}
   f.db.exec(projectionDDL);const selected=consent?consentChecker:checker;
   for(const epoch of [null,0,Number.MAX_SAFE_INTEGER]){f.db.exec('DELETE FROM recovery_source_projection');if(epoch!==null)f.db.prepare('INSERT INTO recovery_source_projection VALUES(1,?)').run(epoch);const before=readFileSync(f.path),rows=f.db.prepare('SELECT rowid,* FROM recovery_source_projection').all();assert.equal(selected(f.path).schema,consent?90:89);assert.deepEqual(readFileSync(f.path),before);assert.deepEqual(f.db.prepare('SELECT rowid,* FROM recovery_source_projection').all(),rows);}
  }
 });
 for(const kind of ['DDL','fractional','unsafe','text','negative','singleton','unknown-object'])test('projection cohort rejects '+kind+' without writes',t=>{
  const f=fixture(t);f.db.exec(kind==='DDL'?projectionDDL.replace('epoch>=0','epoch>=-1'):projectionDDL);
  if(kind==='unknown-object')f.db.exec('CREATE INDEX invented_projection_index ON recovery_source_projection(epoch)');
  if(['fractional','unsafe','text'].includes(kind))f.db.prepare('INSERT INTO recovery_source_projection VALUES(1,?)').run(kind==='fractional'?0.5:kind==='unsafe'?9007199254740992n:'invalid');
  if(['negative','singleton'].includes(kind)){f.db.exec('PRAGMA ignore_check_constraints=ON');f.db.prepare('INSERT INTO recovery_source_projection VALUES(?,?)').run(kind==='singleton'?2:1,kind==='negative'?-1:0);f.db.exec('PRAGMA ignore_check_constraints=OFF');}
  const before=readFileSync(f.path);assert.throws(()=>consentChecker(f.path));assert.deepEqual(readFileSync(f.path),before);
 });
 test('consent-capable readonly checker admits exact90 and both old plans refuse before writes',t=>{const f=fixture(t);for(const id of [87,90]){const m=calendarConsentMigrations.find(x=>x.id===id);f.db.exec(readFileSync(join(migrationsDirectory,m.file),'utf8'));f.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(m.id,m.name,m.digest,'synthetic');}const before=readFileSync(f.path);assert.equal(consentChecker(f.path).schema,90);assert.equal(consentChecker(f.path).calendarConsentSchema,true);assert.throws(()=>policyChecker(f.path));assert.throws(()=>checker(f.path));assert.deepEqual(readFileSync(f.path),before);});
 test('actual candidate launcher selects production explicitly; actual recovery launcher remains inactive for same profile',async()=>{const {calendarProductionLaunchOptions:select}=await import(pathToFileURL(join(root,'launch/calendar-production-selection.mjs')));const mode=await import(pathToFileURL(join(root,'launch/calendar-release-mode.mjs')));assert.deepEqual(select({},'synthetic-environment'),{});const input={mobileSchemaPlan:'calendar-consent/1',calendarSourceProfile:{destinationId:'synthetic-server',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:50}};const options=select(input,'synthetic-environment');if(mode.calendarReleaseMode==='recovery')assert.deepEqual(options,{});else{assert.equal(options.mobileContext.schemaPlan,'calendar-consent/1');assert.deepEqual(options.mobileContext.calendarProduction,{environmentId:'synthetic-environment',destinationId:'synthetic-server'});assert.equal(options.mobileContext.createCalendarGovernance,undefined);assert.equal(options.mobileContext.sourceSafetyInitialization,'requireExisting');assert.throws(()=>select({...input,mobileSchemaPlan:'calendar-policy/1'},'synthetic'));}});
 test('policy-capable checker accepts exact old and new Calendar inventories, while old checker refuses policy state without writes',t=>{
  const f=fixture(t);assert.equal(policyChecker(f.path).calendarPolicySchema,false);const m=calendarPolicyMigrations.find(x=>x.id===87);f.db.exec(readFileSync(join(migrationsDirectory,m.file),'utf8'));f.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(m.id,m.name,m.digest,'synthetic');
  const before=readFileSync(f.path);assert.equal(policyChecker(f.path).calendarPolicySchema,true);assert.throws(()=>checker(f.path));assert.deepEqual(readFileSync(f.path),before);
 });
 test('prepared checker admits exact77 and exact89 without mutating synthetic latest rows',t=>{
  const f=fixture(t),raw=' {"categories":[],"uses":[],"assistantIds":[],"collectionPaused":true,"usePaused":true} ';
  f.db.prepare('INSERT INTO mobile_context_enrollments VALUES(?,?,?,?,?,?,?,?,?,?)').run('e','p','x',null,'eventKit',7,'unbound',raw,'synthetic',null);
  const before=readFileSync(f.path);assert.equal(checker(f.path).schema,89);assert.deepEqual(readFileSync(f.path),before);assert.equal(f.db.prepare('SELECT configuration_json FROM mobile_context_enrollments').get().configuration_json,raw);
  const b=fixture(t,false);assert.equal(checker(b.path).schema,77);
 });
 for(const kind of ['partial','unknown','digest','DDL','optional'])test('prepared readonly admission rejects '+kind,t=>{
  const f=fixture(t);
  if(kind==='partial')f.db.exec('DELETE FROM schema_migrations WHERE id=89');
  if(kind==='unknown')f.db.exec("INSERT INTO schema_migrations VALUES(90,'unknown','unknown','synthetic')");
  if(kind==='digest')f.db.exec("UPDATE schema_migrations SET digest='wrong' WHERE id=86");
  if(kind==='DDL')f.db.exec('ALTER TABLE mobile_context_enrollments ADD COLUMN invented TEXT');
  if(kind==='optional')f.db.exec(base.reference.optional[0].sql);
  const before=readFileSync(f.path);assert.throws(()=>checker(f.path));assert.deepEqual(readFileSync(f.path),before);
 });
 test('latest synthetic expanded DB reopens with original migration owner and preserves row bytes without restore',async t=>{
  const f=fixture(t);f.db.prepare('INSERT INTO mobile_context_enrollments VALUES(?,?,?,?,?,?,?,?,?,?)').run('latest','human','endpoint',null,'eventKit',9,'unbound',' {"categories":[]} ','synthetic',null);
  const before=f.db.prepare('SELECT rowid,* FROM mobile_context_enrollments').all(),migrations=f.db.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
  const {Database,loadCalendarBasicMigrations,assertCalendarMigrationInventory}=await import(pathToFileURL(join(root,'backend/packages/storage-sqlite/dist/index.js')));
  const reopened=new Database({path:f.path,migrations:loadCalendarBasicMigrations()});try{assertCalendarMigrationInventory(reopened);reopened.migrate();assert.deepEqual(reopened.connection.prepare('SELECT rowid,* FROM mobile_context_enrollments').all(),before);assert.deepEqual(reopened.connection.prepare('SELECT * FROM schema_migrations ORDER BY id').all(),migrations);}finally{reopened.close();}
  assert.equal(checker(f.path).schema,89);
 });
 test('complete original optional and historical cohorts remain admitted',t=>{
  const f=fixture(t),rows=[...base.reference.optional,...base.reference.legacyGroups.flatMap(g=>g.schema)];f.db.exec('PRAGMA foreign_keys=OFF');
  for(const row of rows.sort((a,b)=>(a.type==='table'?0:1)-(b.type==='table'?0:1))){if(!f.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(row.name))f.db.exec(row.sql);}
  f.db.exec('PRAGMA foreign_keys=ON');assert.equal(checker(f.path).schema,89);
 });
 test('prepared forward recovery remains Calendar-disabled and binds original family73 with exact89',async()=>{
  const mode=await import(pathToFileURL(join(root,'launch/calendar-release-mode.mjs')));assert.equal(mode.calendarCollectionConfigured,false);assert.ok(['candidate','recovery'].includes(mode.calendarReleaseMode));
  const identity={candidateId:'synthetic',stateDirectory:'/synthetic',manifestSha256:'a'.repeat(64),schemaCeiling:89,migrationIdentitySha256:'b'.repeat(64)};
  assert.ok(mode.validateCalendarCodeAdoption({...identity,schemaVersion:'canonical-code-adoption-calendar-disabled:1.0.0',initialOwnershipSha256:'c'.repeat(64),originalFamilySchemaCeiling:73},identity));
  assert.throws(()=>mode.validateCalendarCodeAdoption({...identity,schemaVersion:'canonical-code-adoption-calendar-disabled:1.0.0',initialOwnershipSha256:'c'.repeat(64),originalFamilySchemaCeiling:89},identity));
 });
}
