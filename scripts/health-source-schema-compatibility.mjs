// Importing this module opens no state. Only an explicitly supplied closed
// fixture or separately authorized state path can be inspected, read-only.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const healthConsentMigrations=Object.freeze([
 {id:84,name:'mobile_context',digest:'352077d60d0c7daf701410bcf4eef92d6123c2c45677285c65308caf43535e67',file:'0084_mobile_context.sql'},
 {id:87,name:'mobile_context_policy_decisions',digest:'0f0b4f13102c176765b0c208c4b3f67c9debd40c67629a0b322267e462a495bd',file:'0087_mobile_context_policy_decisions.sql'},
 {id:90,name:'mobile_context_source_consent',digest:'cabc3a1bd436a24f0a516312dd5e691587d205babb59455b46b3bc35e32cfe89',file:'0090_mobile_context_source_consent.sql'}
]);
export const HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256=sha(JSON.stringify({base:'0ab5612b46962aefa3cd3435288799fad72523581d9ee1adf2a8623be3c183a2',health:healthConsentMigrations.map(({file,...p})=>p)}));
const projection={type:'table',name:'recovery_source_projection',tbl_name:'recovery_source_projection',sql:'CREATE TABLE recovery_source_projection (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL CHECK(epoch>=0))'};
const order=(a,b)=>a.type===b.type?(a.name<b.name?-1:a.name>b.name?1:0):(a.type<b.type?-1:1);
const objects=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r=>({...r}));
export function createHealthSourceSchemaChecker({baseReference,assertBase77,assertCalendar,migrationsDirectory}){
 const base=baseReference(),expanded=new DatabaseSync(':memory:');let ddl;
 try{
  expanded.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');
  for(const m of healthConsentMigrations){const b=readFileSync(join(migrationsDirectory,m.file));assert.equal(sha(b),m.digest,'Original Health SQL digest');expanded.exec(b.toString('utf8'));}
  expanded.exec('COMMIT');ddl=objects(expanded);
 }finally{expanded.close();}
 return function assertCompatibleSchema(databasePath){
  assert.equal(resolve(databasePath),databasePath);const st=lstatSync(databasePath);
  assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&st.gid===process.getgid()&&(st.mode&0o077)===0,'Owned private regular DB required');
  const db=new DatabaseSync(databasePath,{readOnly:true});try{
   db.exec('PRAGMA query_only=ON');const rows=db.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all().map(r=>({...r}));
   if(rows.at(-1)?.id===77)return {...assertBase77(databasePath),healthConsentSchema:false};
   // Calendar is independently checked against its own exact inventories.
   // A Calendar superset is never relabeled as standalone Health.
   if(rows.some(r=>r.id===86||r.id===89))return {...assertCalendar(databasePath),healthConsentSchema:false};
   assert.deepEqual(rows,[...base.migrations,...healthConsentMigrations.map(({file,...p})=>p)],'Exact standalone Health migration inventory required');
   const actual=objects(db),present=r=>actual.some(x=>x.name===r.name);
   const optionalCount=base.reference.optional.filter(present).length;assert(optionalCount===0||optionalCount===base.reference.optional.length,'Partial optional schema refused');
   const legacy=[];for(const group of base.reference.legacyGroups){const n=group.schema.filter(present).length;assert(n===0||n===group.schema.length,'Partial historical cohort refused');if(n)legacy.push(...group.schema);}
   const hasProjection=present(projection);
   assert.deepEqual(actual,[...base.reference.base,...(optionalCount?base.reference.optional:[]),...legacy,...base.additions,...ddl,...(hasProjection?[projection]:[])].sort(order),'Exact standalone Health DDL closure required');
   if(hasProjection){const p=db.prepare('SELECT singleton,epoch FROM recovery_source_projection').all();assert(p.length<=1&&p.every(r=>r.singleton===1&&Number.isSafeInteger(r.epoch)&&r.epoch>=0),'Exact original source projection metadata required');}
   assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
   return {schema:90,registeredMigrationCount:rows.length,migrationIdentitySha256:HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256,healthConsentSchema:true,calendarSchema:false};
  }finally{db.close();}
 };
}
export async function loadInstalledHealthSourceChecker(packageRoot){
 const original=await import(pathToFileURL(join(packageRoot,'launch/schema77-compatibility.mjs')));
 const calendar=await import(pathToFileURL(join(packageRoot,'launch/calendar-schema-compatibility.mjs')));
 const assertCalendar=await calendar.loadInstalledCalendarChecker(packageRoot,true,true);
 return createHealthSourceSchemaChecker({baseReference:original.healthBase77Reference,assertBase77:original.assertCompatibleSchema,assertCalendar,migrationsDirectory:join(packageRoot,'backend/packages/storage-sqlite/src/migrations')});
}
// Explicit plan and observed inventory jointly select an identity. No grant or
// owner is inferred from the schema version (both inventories end at 90).
export function selectSourceSchemaPlan(initial,explicit){
 const observed=initial.healthConsentSchema?'health-consent/1':initial.calendarConsentSchema?'calendar-consent/1':initial.calendarPolicySchema?'calendar-policy/1':initial.calendarSchema?'calendar-basic/1':undefined;
 assert(explicit===undefined||['health-consent/1','calendar-consent/1','calendar-policy/1','calendar-basic/1'].includes(explicit),'Unknown explicit source schema plan');
 if(observed&&explicit)assert.equal(explicit,observed,'Existing inventory and explicit plan must agree');
 return observed??explicit;
}

// Independent opt-in metadata cohort. The historical checker above stays strict.
export const mobileSourceControlMigrations=Object.freeze([{"id": 84, "name": "mobile_context", "digest": "352077d60d0c7daf701410bcf4eef92d6123c2c45677285c65308caf43535e67", "file": "0084_mobile_context.sql"}, {"id": 85, "name": "mobile_context_interpretation", "digest": "8701cc4499d774eddf289c27856a423f739c695707926737e14c0e804245f826", "file": "0085_mobile_context_interpretation.sql"}, {"id": 86, "name": "mobile_context_calendar", "digest": "b2c0924c22ff9c6c46d7533ea1101505959b8572c851b23219673bd795889705", "file": "0086_mobile_context_calendar.sql"}, {"id": 87, "name": "mobile_context_policy_decisions", "digest": "0f0b4f13102c176765b0c208c4b3f67c9debd40c67629a0b322267e462a495bd", "file": "0087_mobile_context_policy_decisions.sql"}, {"id": 89, "name": "mobile_context_calendar_settings", "digest": "e4adc394f14f6056bc690a517a72cbf759c096023929f9b9743dc9238a2f8116", "file": "0089_mobile_context_calendar_settings.sql"}, {"id": 90, "name": "mobile_context_source_consent", "digest": "cabc3a1bd436a24f0a516312dd5e691587d205babb59455b46b3bc35e32cfe89", "file": "0090_mobile_context_source_consent.sql"}]);
export const MOBILE_SOURCE_CONTROL_MIGRATION_IDENTITY_SHA256=sha(JSON.stringify({base:'0ab5612b46962aefa3cd3435288799fad72523581d9ee1adf2a8623be3c183a2',control:mobileSourceControlMigrations.map(({file,...p})=>p)}));
export function createMobileSourceControlSchemaChecker({baseReference,assertPrior,migrationsDirectory}){
 const base=baseReference(),expanded=new DatabaseSync(':memory:');let ddl;
 try{expanded.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');for(const m of mobileSourceControlMigrations){const bytes=readFileSync(join(migrationsDirectory,m.file));assert.equal(sha(bytes),m.digest,'Original control metadata SQL digest');expanded.exec(bytes.toString('utf8'));}expanded.exec('COMMIT');ddl=objects(expanded);}finally{expanded.close();}
 return function assertCompatibleControlSchema(databasePath){
  assert.equal(resolve(databasePath),databasePath);const stat=lstatSync(databasePath);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&stat.gid===process.getgid()&&(stat.mode&0o077)===0,'Owned private regular DB required');
  const db=new DatabaseSync(databasePath,{readOnly:true});let prior=false;
  try{db.exec('PRAGMA query_only=ON');const rows=db.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all().map(r=>({...r}));
   if(!rows.some(r=>r.id===85)){prior=true;}else{
    assert.deepEqual(rows,[...base.migrations,...mobileSourceControlMigrations.map(({file,...m})=>m)],'Exact control81 inventory required');
    const actual=objects(db),present=r=>actual.some(x=>x.name===r.name),optionalCount=base.reference.optional.filter(present).length;
    assert(optionalCount===0||optionalCount===base.reference.optional.length,'Partial optional schema refused');const legacy=[];
    for(const group of base.reference.legacyGroups){const count=group.schema.filter(present).length;assert(count===0||count===group.schema.length,'Partial historical cohort refused');if(count)legacy.push(...group.schema);}
    const hasProjection=present(projection);assert.deepEqual(actual,[...base.reference.base,...(optionalCount?base.reference.optional:[]),...legacy,...base.additions,...ddl,...(hasProjection?[projection]:[])].sort(order),'Exact control81 DDL closure required');
    if(hasProjection){const rows=db.prepare('SELECT singleton,epoch FROM recovery_source_projection').all();assert(rows.length<=1&&rows.every(r=>r.singleton===1&&Number.isSafeInteger(r.epoch)&&r.epoch>=0),'Original source projection metadata required');}
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    return {schema:90,registeredMigrationCount:rows.length,migrationIdentitySha256:MOBILE_SOURCE_CONTROL_MIGRATION_IDENTITY_SHA256,mobileSourceControlSchema:true,healthConsentSchema:false,calendarSchema:false};
   }
  }finally{db.close();}
  assert(prior);return {...assertPrior(databasePath),mobileSourceControlSchema:false};
 };
}
export async function loadInstalledMobileSourceControlChecker(packageRoot){
 const original=await import(pathToFileURL(join(packageRoot,'launch/schema77-compatibility.mjs')));
 return createMobileSourceControlSchemaChecker({baseReference:original.healthBase77Reference,assertPrior:await loadInstalledHealthSourceChecker(packageRoot),migrationsDirectory:join(packageRoot,'backend/packages/storage-sqlite/src/migrations')});
}
export function selectMobileSourceControlSchemaPlan(initial,explicit){
 if(explicit==='mobile-source-control/1'){
  assert(initial.mobileSourceControlSchema===true||initial.schema===77||initial.healthConsentSchema===true||initial.calendarConsentSchema===true,'Exact known original inventory required');return explicit;
 }
 assert(initial.mobileSourceControlSchema!==true,'Control81 requires explicit control plan');
 if(explicit==='mobile-source-consent/1'){assert(initial.schema===77||initial.healthConsentSchema===true||initial.calendarConsentSchema===true,'Exact known original combined inventory required');return explicit;}
 return selectSourceSchemaPlan(initial,explicit);
}
