import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../dist/index.js';
import {loadMigrations, type Migration} from '../src/migrations/index.ts';
import {loadHealthBasicMigrations} from '../src/mobile-health-migrations.ts';

test('Health plan is explicit and leaves the default catalog and base bytes unchanged', () => {
  const base=loadMigrations(), saved=structuredClone(base), plan=loadHealthBasicMigrations(base);
  assert.equal(Math.max(...base.map(m=>m.id)),77);
  assert.deepEqual(base,saved);
  assert.deepEqual(plan.filter(m=>m.id>77).map(m=>m.id),[84,87]);
  assert.deepEqual(plan.filter(m=>m.id<=77),base);
  assert.deepEqual(loadMigrations(),base);
});

test('an existing matching plan is idempotent and retains unrelated reserved migrations', () => {
  const plan=loadHealthBasicMigrations();
  const sql='CREATE TABLE synthetic_reserved_83(value TEXT);';
  const reserved={id:83,name:'synthetic_reserved_83',sql,digest:createHash('sha256').update(sql).digest('hex')};
  const merged=loadHealthBasicMigrations([...plan,reserved]);
  assert.deepEqual(merged.find(m=>m.id===83),reserved);
  assert.deepEqual(loadHealthBasicMigrations(merged),merged);
  assert.deepEqual(merged.map(m=>m.id),merged.map(m=>m.id).sort((a,b)=>a-b));
});

for (const id of [84,87]) test(`conflicting reserved Health migration ${id} is refused`, () => {
  const original=loadHealthBasicMigrations().find(m=>m.id===id)!;
  for(const replacement of [{...original,name:'different'}, {...original,sql:original.sql+'\n',digest:createHash('sha256').update(original.sql+'\n').digest('hex')}]) {
    assert.throws(()=>loadHealthBasicMigrations([replacement]),new RegExp(`health_migration_conflict_${id}`));
  }
});

test('duplicate IDs and corrupt base digests are refused before database work', () => {
  const first=loadMigrations()[0]!;
  assert.throws(()=>loadHealthBasicMigrations([first,first]),/health_migration_plan_invalid/);
  assert.throws(()=>loadHealthBasicMigrations([{...first,digest:'0'.repeat(64)}]),/health_migration_plan_invalid/);
  assert.throws(()=>loadHealthBasicMigrations([{...first,id:NaN}]),/health_migration_plan_invalid/);
});

test('actual SQLite adoption and reopen preserve prior digests and existing Health metadata', () => {
  const root=mkdtempSync(join(tmpdir(),'health-schema-')),path=join(root,'synthetic.sqlite');
  let db:Database|undefined;
  try {
    db=new Database({path,migrations:loadMigrations()});
    const prior=db.migrate();db.close();
    db=new Database({path,migrations:loadHealthBasicMigrations()});
    const current=db.migrate();
    for(const old of prior) assert.deepEqual(current.find(m=>m.id===old.id),old);
    db.connection.prepare('INSERT INTO mobile_context_sources VALUES(?,?,?,?,?)').run('synthetic-source','synthetic-human','healthKit',1,'{"categories":[]}');
    assert.equal(db.connection.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
    db.close();
    db=new Database({path,migrations:loadHealthBasicMigrations()});
    assert.deepEqual(db.migrate(),current);
    assert.equal(db.connection.prepare('SELECT configuration_json FROM mobile_context_sources WHERE source_namespace=?').get('synthetic-source')!.configuration_json,'{"categories":[]}');
    assert.equal(db.connection.prepare("SELECT name FROM sqlite_master WHERE name='mobile_context_calendar_sources'").get(),undefined);
  } finally {db?.close();rmSync(root,{recursive:true,force:true});}
});

test('existing Database migration owner still rejects an altered applied digest', () => {
  const root=mkdtempSync(join(tmpdir(),'health-schema-conflict-')),path=join(root,'synthetic.sqlite');
  let db:Database|undefined;
  try {
    db=new Database({path,migrations:loadHealthBasicMigrations()});db.migrate();
    db.connection.prepare('UPDATE schema_migrations SET digest=? WHERE id=84').run('0'.repeat(64));db.close();
    db=new Database({path,migrations:loadHealthBasicMigrations()});
    assert.throws(()=>db!.migrate(),/Migration 84 digest mismatch/);
  } finally {db?.close();rmSync(root,{recursive:true,force:true});}
});


test('explicit consent plan selects only original84/87/90 and preserves basic/default plans',async()=>{
 const {loadHealthConsentMigrations}=await import('../src/mobile-health-migrations.ts');const base=loadMigrations(),old=loadHealthBasicMigrations();const plan=loadHealthConsentMigrations();assert.deepEqual(plan.filter(x=>x.id>77).map(x=>x.id),[84,87,90]);assert.deepEqual(plan.filter(x=>x.id<=77),base);assert.deepEqual(loadHealthBasicMigrations(),old);assert.deepEqual(loadMigrations(),base);
});
test('original migration owner preserves prior rowids and exact Health request bytes through consent and cold reopen',async()=>{
 const {loadHealthConsentMigrations,assertHealthConsentMigrationInventory}=await import('../src/mobile-health-migrations.ts');
 const root=mkdtempSync(join(tmpdir(),'health-consent-schema-')),path=join(root,'state.sqlite');let db=new Database({path,migrations:loadHealthBasicMigrations()});
 try{
  db.migrate();const request=' {"literal":"old exact original request bytes"} ';
  db.connection.prepare('INSERT INTO mobile_context_sources VALUES(?,?,?,?,?)').run('s','p','healthKit',1,'{"categories":[]}');
  db.connection.prepare('INSERT INTO mobile_context_control_operations VALUES(?,?,?,?,?,?,?,?,?,?)').run('p','op','a'.repeat(64),request,'pending',null,'synthetic',null,0,null);
  db.connection.prepare('INSERT INTO mobile_context_policy_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('p','policy','s','approveMapping','a'.repeat(64),request,'endpoint','{}','synthetic','pending',0,null,null);
  const tables=['mobile_context_sources','mobile_context_control_operations','mobile_context_policy_operations'],before=Object.fromEntries(tables.map(t=>[t,db.connection.prepare('SELECT rowid,* FROM '+t).all()])),prior=db.connection.prepare('SELECT id,name,digest,applied_at FROM schema_migrations ORDER BY id').all();db.close();
  db=new Database({path,migrations:loadHealthConsentMigrations()});assertHealthConsentMigrationInventory(db);db.migrate();
  for(const t of tables)assert.deepEqual(db.connection.prepare('SELECT rowid,* FROM '+t).all(),before[t]);
  assert.deepEqual(db.connection.prepare('SELECT id,name,digest,applied_at FROM schema_migrations WHERE id<90 ORDER BY id').all(),prior);db.close();
  db=new Database({path,migrations:loadHealthConsentMigrations()});assertHealthConsentMigrationInventory(db);db.migrate();for(const t of tables)assert.deepEqual(db.connection.prepare('SELECT rowid,* FROM '+t).all(),before[t]);
  assert.equal(db.connection.prepare('PRAGMA quick_check').get()!.quick_check,'ok');assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
  db.connection.prepare('UPDATE schema_migrations SET digest=? WHERE id=90').run('wrong');assert.throws(()=>assertHealthConsentMigrationInventory(db),/health_consent_inventory/);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
