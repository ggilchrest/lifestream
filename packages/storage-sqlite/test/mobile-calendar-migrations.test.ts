import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../src/database.ts';
import {loadMigrations} from '../src/migrations/index.ts';
import {loadCalendarBasicMigrations,assertCalendarMigrationInventory} from '../src/mobile-calendar-migrations.ts';

test('explicit policy plan upgrades exact Calendar-basic without rewriting rows or historical receipts; old plan refuses it',()=>{
 const root=mkdtempSync(join(tmpdir(),'calendar-policy-plan-')),path=join(root,'synthetic.sqlite');let db=new Database({path,migrations:loadCalendarBasicMigrations()});
 try{db.migrate();const raw=' {"categories":[],"uses":[],"assistantIds":[],"collectionPaused":true,"usePaused":true} ';
  db.connection.prepare('INSERT INTO mobile_context_enrollments VALUES(?,?,?,?,?,?,?,?,?,?)').run('e','p','x',null,'eventKit',7,'unbound',raw,'synthetic',null);
  const before=db.connection.prepare('SELECT * FROM schema_migrations ORDER BY id').all(),row=db.connection.prepare('SELECT rowid,* FROM mobile_context_enrollments').get();db.close();db=new Database({path,migrations:loadCalendarBasicMigrations(true)});
  assertCalendarMigrationInventory(db,true);db.migrate();assertCalendarMigrationInventory(db,true);
  assert.deepEqual(db.connection.prepare('SELECT * FROM schema_migrations WHERE id<>87 ORDER BY id').all(),before);assert.deepEqual(db.connection.prepare('SELECT rowid,* FROM mobile_context_enrollments').get(),row);
  assert.deepEqual(loadCalendarBasicMigrations(true).filter(x=>x.id>77).map(x=>x.id),[84,86,87,89]);assert.throws(()=>assertCalendarMigrationInventory(db),/inventory/);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM mobile_context_policy_decisions').get()!.n,0);assert.equal(db.connection.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('Calendar opt-in adds exactly 84/86/89 and preserves every default migration byte',()=>{
 const base=loadMigrations(),plan=loadCalendarBasicMigrations();
 assert.equal(base.at(-1)!.id,77);
 assert.deepEqual(plan.slice(0,base.length),base);
 assert.deepEqual(plan.slice(base.length).map(x=>x.id),[84,86,89]);
 assert.deepEqual(loadMigrations(),base);
});
test('pristine base adoption and reopen preserve migration receipts and use nullable settings without defaults',()=>{
 const db=new Database({path:':memory:',migrations:loadMigrations()});
 try{
  assertCalendarMigrationInventory(db);const before=db.migrate();assertCalendarMigrationInventory(db);
  // Use the same original SQL migration transaction with an explicitly selected plan.
  for(const m of loadCalendarBasicMigrations().filter(m=>m.id>77))db.durableTransaction(tx=>{
   db.exec(m.sql);tx.run('INSERT INTO schema_migrations(id,name,digest,applied_at)VALUES(?,?,?,?)',m.id,m.name,m.digest,'synthetic');
  });
  assertCalendarMigrationInventory(db);
  assert.deepEqual(db.connection.prepare('SELECT id,name,digest,applied_at AS appliedAt FROM schema_migrations WHERE id<=77 ORDER BY id').all(),before);
  const setting=db.connection.prepare('PRAGMA table_info(mobile_context_enrollments)').all().find(x=>x.name==='sync_window_json')!;
  assert.equal(setting.notnull,0);assert.equal(setting.dflt_value,null);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.connection.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
 }finally{db.close();}
});
test('partial, mixed Health, altered and unknown migration inventories fail before migration writes',()=>{
 for(const kind of ['partial','mixed','digest','unknown']){
  const db=new Database({path:':memory:',migrations:loadCalendarBasicMigrations()});
  try{db.migrate();
   if(kind==='partial')db.exec('DELETE FROM schema_migrations WHERE id=89');
   if(kind==='mixed')db.exec("INSERT INTO schema_migrations VALUES(87,'health','synthetic','synthetic')");
   if(kind==='digest')db.exec("UPDATE schema_migrations SET digest='altered' WHERE id=86");
   if(kind==='unknown')db.exec("INSERT INTO schema_migrations VALUES(90,'unknown','synthetic','synthetic')");
   const changes=db.connection.prepare('SELECT total_changes() n').get()!.n;
   assert.throws(()=>assertCalendarMigrationInventory(db),/calendar_migration_inventory/);
   assert.equal(db.connection.prepare('SELECT total_changes() n').get()!.n,changes);
  }finally{db.close();}
 }
});
test('89 preserves legacy enrollment rowid and raw bytes; transaction failure rolls back the added column',()=>{
 const db=new Database({path:':memory:',migrations:[]}),plan=loadCalendarBasicMigrations();
 try{
  for(const id of [84,86])db.exec(plan.find(m=>m.id===id)!.sql);
  const raw=' { "categories" : [], "uses":[], "assistantIds":[], "collectionPaused":true,"usePaused":true } ';
  db.connection.prepare('INSERT INTO mobile_context_enrollments VALUES(?,?,?,?,?,?,?,?,?)').run('e','p','endpoint',null,'eventKit',1,'unbound',raw,'synthetic');
  const before=db.connection.prepare('SELECT rowid,* FROM mobile_context_enrollments').get();
  assert.throws(()=>db.durableTransaction(()=>{db.exec(plan.find(m=>m.id===89)!.sql);throw Error('synthetic publication failure');}));
  assert.equal(db.connection.prepare('PRAGMA table_info(mobile_context_enrollments)').all().some(r=>r.name==='sync_window_json'),false);
  db.durableTransaction(()=>db.exec(plan.find(m=>m.id===89)!.sql));
  const after=db.connection.prepare('SELECT rowid,* FROM mobile_context_enrollments').get()!;assert.equal(after.sync_window_json,null);delete after.sync_window_json;assert.deepEqual(after,before);
  assert.throws(()=>db.connection.prepare('UPDATE mobile_context_enrollments SET sync_window_json=?').run('{broken'));
  assert.throws(()=>db.connection.prepare('UPDATE mobile_context_enrollments SET sync_window_json=?').run(JSON.stringify('x'.repeat(4096))));
 }finally{db.close();}
});

test('90 extends the SAME policy tables preserving physical rowids, exact original bytes, receipts, immutable history and foreign keys',()=>{
 const root=mkdtempSync(join(tmpdir(),'calendar-consent-upgrade-')),path=join(root,'synthetic.sqlite');let db=new Database({path,migrations:loadCalendarBasicMigrations(true)});
 try{db.migrate();const request=' { "old" : "original bytes" } ',actor=' {"actor":"synthetic"} ';
 db.connection.prepare('INSERT INTO mobile_context_policy_operations(rowid,principal_id,operation_id,scope_digest,kind,request_digest,request_json,original_endpoint_id,actor_json,received_at,state,attempt_started,prepared_json,outcome_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(37,'p','o','s','approveMapping','a'.repeat(64),request,'endpoint',actor,'synthetic','applied',1,' {} ',' {"receipt":"old"} ');
 db.connection.prepare('INSERT INTO mobile_context_policy_decisions(rowid,scope_digest,revision,kind,scope_json,previous_revision,value_json,value_digest,operation_principal_id,operation_id,actor_json,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(19,'s',1,'classification',' {"kind":"classification"} ',0,' {"classification":"personal"} ','b'.repeat(64),'p','o',actor,'synthetic');
 db.connection.prepare('INSERT INTO mobile_context_policy_records(rowid,principal_id,source_key,suppression_key,first_authoritative_import_at,binding_json,binding_digest,source_scope_digest) VALUES(?,?,?,?,?,?,?,?)').run(71,'p','source','suppression','synthetic',' {"old":"binding"} ','c'.repeat(64),'scope');
 const tables=['mobile_context_policy_operations','mobile_context_policy_decisions','mobile_context_policy_records'],before=Object.fromEntries(tables.map(t=>[t,db.connection.prepare('SELECT rowid,* FROM '+t).all()])),migrations=db.connection.prepare('SELECT * FROM schema_migrations ORDER BY id').all();db.close();db=new Database({path,migrations:loadCalendarBasicMigrations(true,true)});assertCalendarMigrationInventory(db,true,true);db.migrate();assertCalendarMigrationInventory(db,true,true);
 for(const t of tables)assert.deepEqual(db.connection.prepare('SELECT rowid,* FROM '+t).all(),before[t]);assert.deepEqual(db.connection.prepare('SELECT * FROM schema_migrations WHERE id<>90 ORDER BY id').all(),migrations);assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.connection.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
 for(const sql of ["UPDATE mobile_context_policy_operations SET request_json='{}'","DELETE FROM mobile_context_policy_operations","UPDATE mobile_context_policy_decisions SET value_json='{}'","DELETE FROM mobile_context_policy_decisions","UPDATE mobile_context_policy_records SET first_authoritative_import_at='later'"])assert.throws(()=>db.exec(sql),/immutable/);
 const changes=db.connection.prepare('SELECT total_changes() n').get()!.n;assert.throws(()=>assertCalendarMigrationInventory(db,true),/inventory/);assert.throws(()=>assertCalendarMigrationInventory(db),/inventory/);assert.equal(db.connection.prepare('SELECT total_changes() n').get()!.n,changes);assert.deepEqual(loadCalendarBasicMigrations(true,true).filter(x=>x.id>77).map(x=>x.id),[84,86,87,89,90]);assert.throws(()=>loadCalendarBasicMigrations(false,true),/required/);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
