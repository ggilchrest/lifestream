// Source-only exact Calendar admission. Callers supply a CLOSED synthetic or
// separately authorized DB path; importing this module never opens a database.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const calendarMigrations=Object.freeze([
 {id:84,name:'mobile_context',digest:'352077d60d0c7daf701410bcf4eef92d6123c2c45677285c65308caf43535e67',file:'0084_mobile_context.sql'},
 {id:86,name:'mobile_context_calendar',digest:'b2c0924c22ff9c6c46d7533ea1101505959b8572c851b23219673bd795889705',file:'0086_mobile_context_calendar.sql'},
 {id:89,name:'mobile_context_calendar_settings',digest:'e4adc394f14f6056bc690a517a72cbf759c096023929f9b9743dc9238a2f8116',file:'0089_mobile_context_calendar_settings.sql'}
]);
export const calendarPolicyMigrations=Object.freeze([...calendarMigrations,{id:87,name:'mobile_context_policy_decisions',digest:'0f0b4f13102c176765b0c208c4b3f67c9debd40c67629a0b322267e462a495bd',file:'0087_mobile_context_policy_decisions.sql'}].sort((a,b)=>a.id-b.id));
export const calendarConsentMigrations=Object.freeze([...calendarPolicyMigrations,{id:90,name:'mobile_context_source_consent',digest:'cabc3a1bd436a24f0a516312dd5e691587d205babb59455b46b3bc35e32cfe89',file:'0090_mobile_context_source_consent.sql'}]);
export const CONSENT_MIGRATION_IDENTITY_SHA256=sha(JSON.stringify({base:'0ab5612b46962aefa3cd3435288799fad72523581d9ee1adf2a8623be3c183a2',calendar:calendarConsentMigrations.map(({file,...p})=>p)}));
export const POLICY_MIGRATION_IDENTITY_SHA256=sha(JSON.stringify({base:'0ab5612b46962aefa3cd3435288799fad72523581d9ee1adf2a8623be3c183a2',calendar:calendarPolicyMigrations.map(({file,...p})=>p)}));
export const MIGRATION_IDENTITY_SHA256=sha(JSON.stringify({base:'0ab5612b46962aefa3cd3435288799fad72523581d9ee1adf2a8623be3c183a2',calendar:calendarMigrations.map(({file,...p})=>p)}));
const order=(a,b)=>a.type===b.type?(a.name<b.name?-1:a.name>b.name?1:0):(a.type<b.type?-1:1);
// Optional metadata created by the original RecoveryJournal.enableSources,
// not a migration or a source authority. Empty crash metadata grants nothing;
// the original journal alone validates source readiness and epoch currency.
const sourceProjection=Object.freeze({type:'table',name:'recovery_source_projection',tbl_name:'recovery_source_projection',sql:'CREATE TABLE recovery_source_projection (singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL CHECK(epoch>=0))'});
export function calendarExpandedDDL(migrationsDirectory,policy=false,consent=false){
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');db.exec('BEGIN IMMEDIATE');
  for(const p of consent?calendarConsentMigrations:policy?calendarPolicyMigrations:calendarMigrations){const bytes=readFileSync(join(migrationsDirectory,p.file));assert.equal(sha(bytes),p.digest,'Original Calendar SQL digest');db.exec(bytes.toString('utf8'));}
  db.exec('COMMIT');
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r=>({...r}));
 }finally{db.close();}
}
export function createCalendarSchemaChecker({baseReference,assertBase77,migrationsDirectory,policy=false,consent=false}){
 if(consent)policy=true;
 const expanded=calendarExpandedDDL(migrationsDirectory),policyExpanded=policy?calendarExpandedDDL(migrationsDirectory,true):null,consentExpanded=consent?calendarExpandedDDL(migrationsDirectory,true,true):null,base=baseReference();
 return function assertCompatibleSchema(databasePath){
  assert.equal(resolve(databasePath),databasePath);const st=lstatSync(databasePath);
  assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.uid===process.getuid()&&st.gid===process.getgid()&&(st.mode&0o077)===0,'Owned private regular DB required');
  const db=new DatabaseSync(databasePath,{readOnly:true});try{
   db.exec('PRAGMA query_only=ON');const rows=db.prepare('SELECT id,name,digest FROM schema_migrations ORDER BY id').all().map(r=>({...r}));
   if(rows.at(-1)?.id===77){const r=assertBase77(databasePath);assert.equal(r.schema,77);return {...r,calendarSchema:false};}
   const hasConsent=consent&&rows.some(row=>row.id===90),hasPolicy=(policy||consent)&&rows.some(row=>row.id===87),plan=hasConsent?calendarConsentMigrations:hasPolicy?calendarPolicyMigrations:calendarMigrations;assert.deepEqual(rows,[...base.migrations,...plan.map(({file,...p})=>p)],'Exact registered Calendar migration inventory required');
   const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r=>({...r}));
   const optionalCount=base.reference.optional.filter(r=>objects.some(x=>x.name===r.name)).length;
   assert(optionalCount===0||optionalCount===base.reference.optional.length,'Partial optional schema refused');
   const legacy=[];for(const group of base.reference.legacyGroups){const n=group.schema.filter(r=>objects.some(x=>x.name===r.name)).length;assert(n===0||n===group.schema.length,'Partial historical cohort refused');if(n)legacy.push(...group.schema);}
   const hasSourceProjection=objects.some(x=>x.name===sourceProjection.name);
   const expected=[...base.reference.base,...(optionalCount?base.reference.optional:[]),...legacy,...base.additions,...(hasConsent?consentExpanded:hasPolicy?policyExpanded:expanded),...(hasSourceProjection?[sourceProjection]:[])].sort(order);
   assert.deepEqual(objects,expected,'Exact expanded Calendar SQLite schema closure required');
   if(hasSourceProjection){const projection=db.prepare('SELECT singleton,epoch FROM recovery_source_projection').all();assert(projection.length<=1&&projection.every(r=>r.singleton===1&&Number.isSafeInteger(r.epoch)&&r.epoch>=0),'Exact original source projection metadata required');}
   assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
   return {schema:hasConsent?90:89,registeredMigrationCount:rows.length,migrationIdentitySha256:hasConsent?CONSENT_MIGRATION_IDENTITY_SHA256:hasPolicy?POLICY_MIGRATION_IDENTITY_SHA256:MIGRATION_IDENTITY_SHA256,calendarSchema:true,calendarPolicySchema:hasPolicy,calendarConsentSchema:hasConsent};
  }finally{db.close();}
 };
}
// Installed only in isolated launch/ by prepare-calendar-backend.mjs.
export async function loadInstalledCalendarChecker(packageRoot,policy=false,consent=false){
 const original=await import(pathToFileURL(join(packageRoot,'launch/schema77-compatibility.mjs')));
 return createCalendarSchemaChecker({baseReference:original.healthBase77Reference,assertBase77:original.assertCompatibleSchema,migrationsDirectory:join(packageRoot,'backend/packages/storage-sqlite/src/migrations'),policy,consent});
}
export async function assertInstalledCompatibleSchema(packageRoot,path){const checker=await loadInstalledCalendarChecker(packageRoot);return checker(path);}
