// Real package readers and copied launchers, using disposable synthetic state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,readFileSync,writeFileSync,rmSync,existsSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {selectSourceSchemaPlan,HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256} from './health-source-schema-compatibility.mjs';
const packageBase=process.env.HEALTH_SOURCE_PREPARED_ROOT??'/srv/lifestream/workspace/health-source-backend-preparation-20261104-r5';
const source=resolve(import.meta.dirname,'..'),work=resolve(source,'../health-production-consent-work-r1');
const cliObservations=[];
const controlPreparedRoot=process.env.MOBILE_SOURCE_CONTROL_PREPARED_ROOT;
const sha=b=>createHash('sha256').update(b).digest('hex');
const load=p=>import(pathToFileURL(p));
if(controlPreparedRoot)test('explicit control81 exact DDL and old-cohort refusals in both inactive packages',async()=>{
 process.env.LIFESTREAM_MOBILE_SOURCE_CONTROL_DRIVER='1';
 const {createMobileSourceProductionFixture}=await load(join(source,'apps/server/test/mobile-source-production-consent.test.ts'));
 const fixture=await createMobileSourceProductionFixture(true,'mobile-source-control/1');
 const scratch=mkdtempSync(join(tmpdir(),'control81-package-'));
 try{
  const path=join(scratch,'control.sqlite');fixture.app.database.connection.prepare('VACUUM INTO ?').run(path);chmodSync(path,0o600);const before=sha(readFileSync(path));
  for(const mode of ['candidate','recovery']){
   const root=join(controlPreparedRoot,mode),installed=await load(join(root,'launch/health-source-schema-installed.mjs'));
   const actual=installed.assertCompatibleSchema(path);assert.equal(actual.registeredMigrationCount,81);assert.equal(actual.mobileSourceControlSchema,true);assert.equal(installed.selectSourceSchemaPlan(actual,'mobile-source-control/1'),'mobile-source-control/1');
   for(const plan of [undefined,'health-consent/1','calendar-consent/1','mobile-source-consent/1'])assert.throws(()=>installed.selectSourceSchemaPlan(actual,plan));
   const {loadInstalledHealthSourceChecker}=await load(join(root,'launch/health-source-schema-compatibility.mjs'));// Check the actual retained strict reader separately.
   const old=await loadInstalledHealthSourceChecker(root);assert.throws(()=>old(path));
   for(const [i,sql] of ["DROP TRIGGER mobile_context_interpretation_immutable","UPDATE schema_migrations SET digest='wrong' WHERE id=85","CREATE TABLE unregistered_control_object(x TEXT)","DELETE FROM schema_migrations WHERE id=85"].entries()){
    const bad=join(scratch,mode+'-'+i+'.sqlite');cpSync(path,bad);chmodSync(bad,0o600);const db=new DatabaseSync(bad);try{db.exec(sql);}finally{db.close();}const hash=sha(readFileSync(bad));assert.throws(()=>installed.assertCompatibleSchema(bad));assert.equal(sha(readFileSync(bad)),hash);
   }
   const selection=await load(join(root,'launch/source-production-selection.mjs'));const profile={health:{destinationId:'synthetic-control',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:50},calendar:{destinationId:'synthetic-control',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:50}};
   const value={mobileSchemaPlan:'mobile-source-control/1',mobileSourceProfile:profile};
   if(mode==='recovery')assert.throws(()=>selection.sourceProductionLaunchOptions(value,fixture.profile.environmentId));
   else assert.equal(selection.sourceProductionLaunchOptions(value,fixture.profile.environmentId).mobileContext.schemaPlan,'mobile-source-control/1');
   assert.deepEqual(selection.sourceProductionLaunchOptions({mobileSchemaPlan:'mobile-source-control/1'},fixture.profile.environmentId),{});
  }
  assert.equal(sha(readFileSync(path)),before);
 }finally{await fixture.close();rmSync(scratch,{recursive:true,force:true});}
});
function put(p,v){writeFileSync(p,typeof v==='string'?v:JSON.stringify(v),{mode:0o600});chmodSync(p,0o600);}
async function healthSnapshot(path){
 process.env.LIFESTREAM_HEALTH_PRODUCTION_DRIVER='1';
 const {createHealthProductionFixture}=await load(join(work,'RUNTIME-FREEZE-r1/runtime/apps/server/test/health-production-consent.test.ts'));
 const f=await createHealthProductionFixture();try{assert.equal(f.checkpoint().records,0);f.app.database.connection.prepare('VACUUM INTO ?').run(path);}finally{await f.close();}
 chmodSync(path,0o600);
}
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('exact standalone Health inventory is admitted read-only in both copied packages',async()=>{
 const scratch=mkdtempSync(join(tmpdir(),'health-package-inventory-'));try{
  const path=join(scratch,'health.sqlite');await healthSnapshot(path);const before=sha(readFileSync(path));
  for(const mode of ['candidate','recovery']){
   const installed=await load(join(packageBase,mode,'launch/health-source-schema-installed.mjs'));const r=installed.assertCompatibleSchema(path);
   assert.equal(r.schema,90);assert.equal(r.registeredMigrationCount,78);assert.equal(r.healthConsentSchema,true);assert.equal(r.calendarSchema,false);
   assert.equal(r.migrationIdentitySha256,HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256);assert.equal(installed.identityForPlan('health-consent/1'),r.migrationIdentitySha256);
   assert.notEqual(installed.identityForPlan('calendar-consent/1'),r.migrationIdentitySha256);assert.notEqual(installed.adoptionVersion('calendar-consent/1'),installed.adoptionVersion('health-consent/1'));
  }
  assert.equal(sha(readFileSync(path)),before);
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test('unknown objects, corrupted migration identity and unsafe projection epochs refuse',async()=>{
 const scratch=mkdtempSync(join(tmpdir(),'health-package-refusals-'));try{
  const original=join(scratch,'original.sqlite');await healthSnapshot(original);
  const {assertCompatibleSchema}=await load(join(packageBase,'recovery/launch/health-source-schema-installed.mjs'));
  const mutations=[
   "CREATE TABLE unregistered_object (value TEXT)",
   "UPDATE schema_migrations SET digest='wrong' WHERE id=90",
   'UPDATE recovery_source_projection SET epoch=9007199254740992',
   'DROP TABLE recovery_source_projection; CREATE TABLE recovery_source_projection (singleton INTEGER PRIMARY KEY,epoch INTEGER)',
   'DELETE FROM schema_migrations WHERE id=87'
  ];
  for(let i=0;i<mutations.length;i++){const p=join(scratch,'bad-'+i+'.sqlite');cpSync(original,p);chmodSync(p,0o600);const db=new DatabaseSync(p);try{db.exec(mutations[i]);}finally{db.close();}const before=sha(readFileSync(p));assert.throws(()=>assertCompatibleSchema(p));assert.equal(sha(readFileSync(p)),before);}
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test('all original Calendar cohorts and default77 retain distinct selected identities',async()=>{
 const scratch=mkdtempSync(join(tmpdir(),'health-package-calendar-'));try{
  const original=await load(join(packageBase,'candidate/launch/schema77-compatibility.mjs'));const base=original.healthBase77Reference();const calendar=await load(join(packageBase,'candidate/launch/calendar-schema-compatibility.mjs'));
  const installed=await load(join(packageBase,'candidate/launch/health-source-schema-installed.mjs'));
  for(const [plan,policy,consent] of [[undefined,false,false],['calendar-basic/1',false,false],['calendar-policy/1',true,false],['calendar-consent/1',true,true]]){
   const path=join(scratch,(plan??'base').replace('/','-')+'.sqlite');const db=new DatabaseSync(path);try{
    db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');
    for(const row of [...base.reference.base,...base.additions].sort((a,b)=>(a.type==='table'?0:1)-(b.type==='table'?0:1)))if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(row.name))db.exec(row.sql);
    const insert=db.prepare('INSERT INTO schema_migrations(id,name,digest,applied_at) VALUES(?,?,?,?)');for(const m of base.migrations)insert.run(m.id,m.name,m.digest,'synthetic');
    if(plan)for(const m of consent?calendar.calendarConsentMigrations:policy?calendar.calendarPolicyMigrations:calendar.calendarMigrations){db.exec(readFileSync(join(packageBase,'candidate/backend/packages/storage-sqlite/src/migrations',m.file),'utf8'));insert.run(m.id,m.name,m.digest,'synthetic');}db.exec('COMMIT');
   }finally{db.close();}chmodSync(path,0o600);
   const r=installed.assertCompatibleSchema(path);assert.equal(selectSourceSchemaPlan(r,undefined),plan);assert.equal(r.healthConsentSchema,false);assert.equal(installed.identityForPlan(plan),r.migrationIdentitySha256);
   if(plan)assert.throws(()=>selectSourceSchemaPlan(r,'health-consent/1'));
  }
 }finally{rmSync(scratch,{recursive:true,force:true});}
});

test('selected Health code adoption refuses Calendar identities and unknown versions',async()=>{
 for(const mode of ['candidate','recovery']){
  const root=join(packageBase,mode),installed=await load(join(root,'launch/health-source-schema-installed.mjs'));
  const {validateCalendarCodeAdoption}=await load(join(root,'launch/calendar-release-mode.mjs'));
  const expected={schemaVersion:installed.adoptionVersion('health-consent/1'),candidateId:'synthetic-candidate',stateDirectory:'/synthetic-only',manifestSha256:'a'.repeat(64),schemaCeiling:90,migrationIdentitySha256:installed.identityForPlan('health-consent/1')};
  const receipt={...expected,originalFamilySchemaCeiling:73,initialOwnershipSha256:'b'.repeat(64)};
  assert.deepEqual(validateCalendarCodeAdoption(receipt,expected),receipt);
  assert.throws(()=>validateCalendarCodeAdoption({...receipt,migrationIdentitySha256:installed.identityForPlan('calendar-consent/1')},expected));
  assert.throws(()=>validateCalendarCodeAdoption({...receipt,schemaVersion:installed.adoptionVersion('calendar-consent/1')},expected));
  assert.throws(()=>validateCalendarCodeAdoption({...receipt,schemaVersion:'invented'},{...expected,schemaVersion:'invented'}));
 }
});

test('both actual installed CLIs check Health schema-only config and stop before false adoption',async()=>{
 // This is a newly created synthetic root, never an existing state/config read.
 const parent='/srv/lifestream/workspace/runtime-state/real-daily';mkdirSync(parent,{recursive:true,mode:0o700});
 const scratch=mkdtempSync(join(parent,'health-source-package-fake-'));try{
  for(const n of ['config','state','presentation-catalog'])mkdirSync(join(scratch,n),{mode:0o700});
  const dbPath=join(scratch,'state/data.sqlite');await healthSnapshot(dbPath);const before=sha(readFileSync(dbPath));
  put(join(scratch,'config/provider.json'),'SYNTHETIC BODY MUST NOT BE READ BY CHECK');
  for(const mode of ['candidate','recovery']){
   const root=join(packageBase,mode),{candidateId,validateAdoption}=await load(join(root,'launch/real-configuration.mjs'));
   const deployment={schemaVersion:'1.0.0',candidateId,stage:'qualification',providerConfigurationPath:join(scratch,'config/provider.json'),stateDirectory:join(scratch,'state'),presentationDirectory:join(scratch,'presentation-catalog'),stateAdoptionReceiptPath:join(scratch,'config/adoption.json'),ownershipBaselinePath:join(scratch,'config/absent-ownership.json'),host:'127.0.0.1',port:await freePort(),mobileSchemaPlan:'health-consent/1',historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}};
   const synthetic={schemaVersion:'canonical74-adoption:1.0.0',candidateId,preparedManifestSha256:sha(readFileSync(join(root,'prepared-source-manifest.json'))),sourceStateDirectory:join(scratch,'state'),targetStateDirectory:deployment.stateDirectory,targetPresentationDirectory:deployment.presentationDirectory,ownerIdentityPreserved:false,sessionEnvironmentPreserved:false,authSafetyPreserved:false,artifactsPreserved:false,presentationBindingsPreserved:false,migration74Compatible:false,deletionJournalPreserved:false,retentionJournalInitialization:'requireExisting'};
   let refusal;try{validateAdoption(synthetic,deployment,synthetic.preparedManifestSha256);}catch(error){refusal=String(error.message);}assert(refusal,'Original live-source provenance guard must refuse synthetic evidence');put(deployment.stateAdoptionReceiptPath,synthetic);
   const config=join(scratch,'config/deployment.json');put(config,deployment);
   const cli=action=>spawnSync(process.execPath,['--experimental-transform-types',join(root,'launch/start-canonical.mjs'),action,'--config',config],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
   const check=cli('--check');assert.equal(check.status,0,check.stderr+check.stdout);const checked=JSON.parse(check.stdout.trim());assert.equal(checked.event,'source-check');assert.equal(checked.providerProfileBodyRead,false);assert.equal(checked.activationPerformed,false);
   const start=cli('--start');assert.equal(start.status,1,start.stdout+start.stderr);const frames=start.stdout.trim().split('\n').map(s=>JSON.parse(s));assert(frames.some(f=>f.event==='failed'&&f.stage==='adoption-preflight'),start.stdout+start.stderr);assert(!frames.some(f=>['ready','administration-only'].includes(f.event)));
   assert.equal(sha(readFileSync(dbPath)),before);assert.equal(existsSync(join(scratch,'state',candidateId+'-adoption.json')),false);
   const {calendarProductionLaunchOptions}=await load(join(root,'launch/calendar-production-selection.mjs'));assert.deepEqual(calendarProductionLaunchOptions(deployment,'synthetic'),{});
   const inactive=await load(join(root,'launch/calendar-release-mode.mjs'));assert.equal(inactive.calendarReleaseMode,mode);assert.equal(inactive.calendarCollectionConfigured,false);
   cliObservations.push({mode,candidateId,selectedSchemaPlan:deployment.mobileSchemaPlan,checkExit:check.status,check:checked,boundedStartExit:start.status,boundedStartFrames:frames,actualAdoptionRefusal:refusal,syntheticCompatibilityClaimsAllFalse:true,syntheticDatabaseSHA256Before:before,syntheticDatabaseSHA256After:sha(readFileSync(dbPath)),codeAdoptionWritten:false,fullStartupQualified:false});
  }
 if(process.env.HEALTH_SOURCE_EVIDENCE_PATH)put(process.env.HEALTH_SOURCE_EVIDENCE_PATH,{schemaVersion:'1.0.0',status:'ActualInstalledCLIAndOriginalAdoptionGuardQualifiedOnDisposableState',noRealStateRead:true,observations:cliObservations});
 }finally{rmSync(scratch,{recursive:true,force:true});}
});
