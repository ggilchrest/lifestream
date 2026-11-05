// Real package readers and copied launchers, using disposable synthetic state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,chmodSync,readFileSync,writeFileSync,rmSync,existsSync,cpSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire,syncBuiltinESMExports,registerHooks} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {validateCombinedLineagePlan,replaceUnique,physicalInventory,assertPhysicalPreservation} from './prepare-health-source-backend.mjs';
import {inventory} from './prepare-calendar-backend.mjs';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {selectSourceSchemaPlan,HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256} from './health-source-schema-compatibility.mjs';
export function installDiagnosticBoundary({scratch,caller,legacy=false}){
 const fs=createRequire(import.meta.url)('node:fs'),hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(scratch,'/srv/lifestream/workspace/runtime-state/real-daily/pwce-package-lineage-qualification-20261105-r2');
 const trace={caller,phase:'builtin-boundary-installation',forbiddenAttempts:[],rejectedImports:[],projections:[],legacy:[],deadlines:{},closed:false};
 for(const key of ['LIFESTREAM_TTS_LIFECYCLE_UNTIL_MS','LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS']){trace.deadlines[key]={previouslySet:Object.hasOwn(process.env,key),effective:'absent'};delete process.env[key];assert.equal(process.env[key],undefined);}
 const scratchStat=fs.lstatSync(scratch);assert(scratchStat.isDirectory()&&!scratchStat.isSymbolicLink()&&scratchStat.uid===process.getuid()&&(scratchStat.mode&0o777)===0o700);assert.equal(fs.realpathSync(scratch),scratch);
 const owned=fs.mkdtempSync(join(scratch,'diagnostic-port-'+caller+'-'));fs.chmodSync(owned,0o700);
 const directories={lifecycle:join(owned,'lifecycle'),transport:join(owned,'transport')};
 for(const path of Object.values(directories)){fs.mkdirSync(path,{mode:0o700});const st=fs.lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700);assert.equal(fs.realpathSync(path),path);}
 trace.directories=directories;
 const fdPaths=new Map(),originals=[];
 const pathValue=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():value;
 const isOwned=path=>path===scratch||path.startsWith(scratch+'/');
 function reject(operation,path){const event={operation,path,phase:trace.phase,atUTC:new Date().toISOString(),stack:new Error('before-IO').stack};trace.forbiddenAttempts.push(event);console.error('DIAGNOSTIC_GUARD_REJECTION '+JSON.stringify(event));throw Error('excluded_path_or_unowned_fd_before_IO');}
 function guard(operation,value,writing=false){
  if(typeof value==='number'){const path=fdPaths.get(value);if(writing&&value!==1&&value!==2&&(!path||!isOwned(path)))reject(operation,'fd:'+value);return;}
  const raw=pathValue(value);if(typeof raw!=='string')return;const path=resolve(raw);
  for(const denied of ['/srv/lifestream/private-diagnostics','/srv/lifestream/deployment'])if(path===denied||path.startsWith(denied+'/'))reject(operation,path);
 }
 function wrap(object,key,kind){const original=object[key];if(typeof original!=='function')return;
  originals.push([object,key,original]);object[key]=function(...args){guard(key,args[0],kind==='write');if(kind==='two')guard(key,args[1],true);const value=Reflect.apply(original,this,args);
   if(key==='openSync')fdPaths.set(value,resolve(pathValue(args[0])));if(key==='closeSync')fdPaths.delete(args[0]);return value;};
 }
 for(const key of ['readFileSync','openSync','readdirSync','lstatSync','statSync','existsSync','accessSync','realpathSync','opendirSync','closeSync','readSync','fstatSync'])wrap(fs,key,'read');
 for(const key of ['writeFileSync','appendFileSync','writeSync','ftruncateSync','rmSync','unlinkSync','rmdirSync','mkdirSync','truncateSync','chmodSync'])wrap(fs,key,'write');
 for(const key of ['renameSync','copyFileSync','cpSync'])wrap(fs,key,'two');
 for(const key of ['readFile','open','readdir','lstat','stat','access','realpath','opendir'])wrap(fs.promises,key,'read');
 for(const key of ['writeFile','appendFile','rm','unlink','rmdir','mkdir','truncate','chmod'])wrap(fs.promises,key,'write');
 for(const key of ['rename','copyFile','cp'])wrap(fs.promises,key,'two');
 syncBuiltinESMExports();
 const specs=[{file:'lifecycle-observation.js',sha256:'09cbfb1e5ccd81ad54320722f72a3b4ae02755dca5ade018d537e38226e5ec96',literal:'/srv/lifestream/deployment/diagnostics/tts-lifecycle-v1',offset:10008,length:55,directory:directories.lifecycle},{file:'transport-observation.js',sha256:'d8e2022aecb91d2b34eea04ae3e1a9eed3489f9d824f1aa279feef365befa2d6',literal:'/srv/lifestream/deployment/diagnostics/tts-transport-20261029',offset:5594,length:61,directory:directories.transport}];
 const targets=new Map();for(const mode of ['candidate','recovery'])for(const spec of specs){const path='/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/'+mode+'/backend/packages/providers-voxcpm/dist/'+spec.file;assert.equal(fs.realpathSync(path),path);assert.equal(hash(fs.readFileSync(path)),spec.sha256);targets.set(pathToFileURL(path).href,spec);}
 let legacyTransportURL;
 if(legacy){const base='/srv/lifestream/workspace/mobile-context-a-source-20261029/health-production-consent-work-r1/RUNTIME-FREEZE-r1/runtime/packages/providers-voxcpm/dist/',provider=base+'provider.js',transport=base+'transport-observation.js';
  assert.equal(hash(fs.readFileSync(provider)),'979e9e5942cc4a505da6927ff03724b4cc45c08181855e26b9d6286c1823a53f');assert(!/lifecycle-observation|lifecycleObservation/.test(fs.readFileSync(provider,'utf8')));assert(!fs.existsSync(base+'lifecycle-observation.js'));assert.equal(hash(fs.readFileSync(transport)),specs[1].sha256);legacyTransportURL=pathToFileURL(transport).href;
  trace.legacy.push({providerURL:pathToFileURL(provider).href,providerSHA256:hash(fs.readFileSync(provider)),lifecycleAbsent:true,transportURL:legacyTransportURL,transportSHA256:hash(fs.readFileSync(transport)),loaderProjection:false,loaded:false,transportDeadline:'absent'});
 }
 const hooks=registerHooks({load(url,context,nextLoad){
  const spec=targets.get(url),observer=/\/providers-voxcpm\/dist\/(?:lifecycle|transport)-observation\.js$/.test(new URL(url).pathname);
  if(observer&&!spec&&url!==legacyTransportURL){const event={url,phase:trace.phase,atUTC:new Date().toISOString()};trace.rejectedImports.push(event);throw Error('undeclared_observer_URL_before_evaluation');}
  const loaded=nextLoad(url,context);if(!spec){if(url===legacyTransportURL){trace.legacy[0].loaded=true;assert.equal(hash(Buffer.from(loaded.source)),specs[1].sha256);assert.equal(process.env.LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS,undefined);}return loaded;}
  assert.equal(loaded.format,'module');assert.equal(url,pathToFileURL(fileURLToPath(url)).href);const original=Buffer.from(loaded.source);assert.equal(hash(original),spec.sha256);assert.equal(original.subarray(spec.offset,spec.offset+spec.length).toString(),spec.literal);assert.equal(original.toString().split(spec.literal).length,2);assert.equal(original[spec.offset-1],39);assert.equal(original[spec.offset+spec.length],39);
  const replacement=Buffer.from(JSON.stringify(spec.directory).slice(1,-1));assert(!replacement.includes(39));const transformed=Buffer.concat([original.subarray(0,spec.offset),replacement,original.subarray(spec.offset+spec.length)]),reversed=Buffer.concat([transformed.subarray(0,spec.offset),Buffer.from(spec.literal),transformed.subarray(spec.offset+replacement.length)]);assert.deepEqual(reversed,original);
  trace.projections.push({url,format:loaded.format,originalSHA256:hash(original),transformedSHA256:hash(transformed),byteOffsetUTF8:spec.offset,originalLiteralBytes:spec.length,replacementBytes:replacement.length,originalLiteral:spec.literal,replacementDirectory:spec.directory,reverseExact:true,effectiveSource:transformed.toString()});return {...loaded,source:transformed};
 }});
 return {fs,trace,setPhase(value){trace.phase=value;},close(){assert.equal(trace.forbiddenAttempts.length,0);assert.equal(trace.rejectedImports.length,0);hooks.deregister();fs.rmSync(owned,{recursive:true,force:true});trace.closed=true;/* Guards remain installed through process exit; observer exit callbacks stay confined. */}};
}

const combinedPlanPath=process.env.COMBINED_PACKAGE_QUALIFICATION_PLAN;
const combinedInputs=combinedPlanPath?validateCombinedLineagePlan(combinedPlanPath,{requireAbsent:false}):null;
const packageObservations=[];
const packageDiagnosticBoundary=combinedInputs?installDiagnosticBoundary({scratch:combinedInputs.plan.qualificationScratch,caller:'package-parent',legacy:true}):null;
if(combinedInputs){
 assert.equal(process.env.HEALTH_SOURCE_PREPARED_ROOT,combinedInputs.plan.outputRoot);
 assert.equal(process.env.MOBILE_SOURCE_CONTROL_PREPARED_ROOT,combinedInputs.plan.outputRoot);
 assert.equal(process.env.TMPDIR,combinedInputs.plan.qualificationScratch);
 assert.equal(resolve(process.env.HEALTH_SOURCE_EVIDENCE_PATH),resolve(sourceEvidencePath()));
}
function sourceEvidencePath(){return join(combinedInputs.plan.qualificationScratch,'ACTUAL-PACKAGE-QUALIFICATION-OWNED-RETRY-r2.json');}
const packageBase=process.env.HEALTH_SOURCE_PREPARED_ROOT??'/srv/lifestream/workspace/health-source-backend-preparation-20261104-r5';
const source=resolve(import.meta.dirname,'..'),work=resolve(source,'../health-production-consent-work-r1');
const cliObservations=[];
const controlPreparedRoot=process.env.MOBILE_SOURCE_CONTROL_PREPARED_ROOT;
const sha=b=>createHash('sha256').update(b).digest('hex');
const load=p=>{packageDiagnosticBoundary?.setPhase('package-source-fixture-or-launch-module:'+p);return import(pathToFileURL(p));};
if(controlPreparedRoot)test('explicit control81 exact DDL and old-cohort refusals in both inactive packages',async()=>{
 process.env.LIFESTREAM_MOBILE_SOURCE_CONTROL_DRIVER='1';
 const {createMobileSourceProductionFixture}=await load(join(combinedInputs?join(packageBase,'candidate/backend'):source,'apps/server/test/mobile-source-production-consent.test.ts'));
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
 const {createHealthProductionFixture}=await load(combinedInputs?combinedInputs.plan.legacyHealthFixture.path:join(work,'RUNTIME-FREEZE-r1/runtime/apps/server/test/health-production-consent.test.ts'));
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
 const parent=combinedInputs?combinedInputs.plan.qualificationScratch:'/srv/lifestream/workspace/runtime-state/real-daily';mkdirSync(parent,{recursive:true,mode:0o700});
 const scratch=combinedInputs?parent:mkdtempSync(join(parent,'health-source-package-fake-'));try{
  for(const n of ['config','state','presentation-catalog'])mkdirSync(join(scratch,n),{mode:0o700});
  const dbPath=join(scratch,'state/data.sqlite');await healthSnapshot(dbPath);const before=sha(readFileSync(dbPath));
  put(join(scratch,'config/provider.json'),'SYNTHETIC BODY MUST NOT BE READ BY CHECK');
  for(const mode of ['candidate','recovery']){
   const root=join(packageBase,mode),{candidateId,validateAdoption}=await load(join(root,'launch/real-configuration.mjs'));
   const deployment={schemaVersion:'1.0.0',candidateId,stage:'qualification',providerConfigurationPath:join(scratch,'config/provider.json'),stateDirectory:join(scratch,'state'),presentationDirectory:join(scratch,'presentation-catalog'),stateAdoptionReceiptPath:join(scratch,'config/adoption.json'),ownershipBaselinePath:join(scratch,'config/absent-ownership.json'),host:'127.0.0.1',port:await freePort(),mobileSchemaPlan:'health-consent/1',historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}};
   const synthetic={schemaVersion:'canonical74-adoption:1.0.0',candidateId,preparedManifestSha256:sha(readFileSync(join(root,'prepared-source-manifest.json'))),sourceStateDirectory:join(scratch,'state'),targetStateDirectory:deployment.stateDirectory,targetPresentationDirectory:deployment.presentationDirectory,ownerIdentityPreserved:false,sessionEnvironmentPreserved:false,authSafetyPreserved:false,artifactsPreserved:false,presentationBindingsPreserved:false,migration74Compatible:false,deletionJournalPreserved:false,retentionJournalInitialization:'requireExisting'};
   let refusal;try{validateAdoption(synthetic,deployment,synthetic.preparedManifestSha256);}catch(error){refusal=String(error.message);}assert(refusal,'Original live-source provenance guard must refuse synthetic evidence');put(deployment.stateAdoptionReceiptPath,synthetic);
   const config=join(scratch,'config/deployment.json');put(config,deployment);
   const cli=action=>spawnSync(process.execPath,combinedInputs?['--experimental-transform-types','--input-type=module','-e',guardedCliDiagnosticHarness,root,action,config,combinedInputs.plan.qualificationScratch]:['--experimental-transform-types',join(root,'launch/start-canonical.mjs'),action,'--config',config],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
   const check=cli('--check');assert.equal(check.status,0,check.stderr+check.stdout);const checked=JSON.parse(check.stdout.trim());assert.equal(checked.event,'source-check');assert.equal(checked.providerProfileBodyRead,false);assert.equal(checked.activationPerformed,false);
   const start=cli('--start');assert.equal(start.status,1,start.stdout+start.stderr);const frames=start.stdout.trim().split('\n').map(s=>JSON.parse(s));assert(frames.some(f=>f.event==='failed'&&f.stage==='adoption-preflight'),start.stdout+start.stderr);assert(!frames.some(f=>['ready','administration-only'].includes(f.event)));
   assert.equal(sha(readFileSync(dbPath)),before);assert.equal(existsSync(join(scratch,'state',candidateId+'-adoption.json')),false);
   const {calendarProductionLaunchOptions}=await load(join(root,'launch/calendar-production-selection.mjs'));assert.deepEqual(calendarProductionLaunchOptions(deployment,'synthetic'),{});
   const inactive=await load(join(root,'launch/calendar-release-mode.mjs'));assert.equal(inactive.calendarReleaseMode,mode);assert.equal(inactive.calendarCollectionConfigured,false);
   cliObservations.push({mode,candidateId,checkDiagnosticStderr:check.stderr,startDiagnosticStderr:start.stderr,selectedSchemaPlan:deployment.mobileSchemaPlan,checkExit:check.status,check:checked,boundedStartExit:start.status,boundedStartFrames:frames,actualAdoptionRefusal:refusal,syntheticCompatibilityClaimsAllFalse:true,syntheticDatabaseSHA256Before:before,syntheticDatabaseSHA256After:sha(readFileSync(dbPath)),codeAdoptionWritten:false,fullStartupQualified:false});
  }
 if(process.env.HEALTH_SOURCE_EVIDENCE_PATH)put(process.env.HEALTH_SOURCE_EVIDENCE_PATH,{schemaVersion:'1.0.0',status:'ActualInstalledCLIAndOriginalAdoptionGuardQualifiedOnDisposableState',noRealStateRead:true,observations:cliObservations});
 }finally{if(combinedInputs){for(const name of ['config','state','presentation-catalog'])rmSync(join(scratch,name),{recursive:true,force:true});}else rmSync(scratch,{recursive:true,force:true});}
});

if(combinedInputs){
 test('new preparation rejects wrong donor, projection, helper and compiler bindings without package mutation',async()=>{
  const before=inventory(packageBase),scratch=mkdtempSync(join(tmpdir(),'closed-plan-refusals-')),refusals=[];
  try{
   for(const kind of ['donor','projection','helper','compiler','omission','destination']){
    const bad=structuredClone(combinedInputs.plan);
    if(kind==='donor')bad.inputPrepared.candidate.sha256='0'.repeat(64);
    if(kind==='projection')bad.projection.sha256='0'.repeat(64);
    if(kind==='compiler')bad.compiler.nodeSHA256='0'.repeat(64);
    if(kind==='omission')bad.omittedCommands=[];
    if(kind==='destination')bad.outputRoot=join(scratch,'unauthorized-output');
    if(kind==='helper'){
     const value=JSON.parse(readFileSync(bad.toolAfterManifest.path));value.files['scripts/prepare-health-source-backend.mjs'].sha256='0'.repeat(64);
     const changed=join(scratch,'wrong-tool-manifest.json');put(changed,value);bad.toolAfterManifest={path:changed,sha256:sha(readFileSync(changed))};bad.toolAfterManifestSHA256=bad.toolAfterManifest.sha256;
    }
    const path=join(scratch,kind+'.json');put(path,bad);let message;
    try{validateCombinedLineagePlan(path,{requireAbsent:false});}catch(error){message=error.message;}
    assert(message,'Reject changed '+kind);refusals.push({kind,message});assert(!existsSync(join(scratch,'unauthorized-output')));
   }
   assert.throws(()=>validateCombinedLineagePlan(combinedPlanPath),/Fresh output required/);
   assert.deepEqual(inventory(packageBase),before);packageObservations.push({gate:'closed-input-refusals',refusals,outputUnchanged:true});
  }finally{rmSync(scratch,{recursive:true,force:true});}
 });
 test('both generated packages preserve every outside-allowlist leaf and exact frozen59 plus retained27',()=>{
  for(const mode of ['candidate','recovery']){
   const root=join(packageBase,mode),actual=inventory(root),base=combinedInputs.before[mode],result=JSON.parse(readFileSync(join(packageBase,'PREPARATION-RESULT.json'))).modes[mode];
   const compiled=result.compiledProjects,union=new Set(Object.keys(combinedInputs.union).map(p=>'backend/'+p));
   const allowed=p=>union.has(p)||['SOURCE-MANIFEST.json','prepared-source-manifest.json','HEALTH-SOURCE-PREPARATION.json','launch/real-configuration.mjs'].includes(p)||compiled.some(project=>p.startsWith('backend/'+project+'/dist/')||p==='backend/'+project+'/tsconfig.tsbuildinfo');
   for(const p of new Set([...Object.keys(base),...Object.keys(actual)]))if(!allowed(p))assert.deepEqual(actual[p],base[p],mode+': '+p);
   for(const [p,v] of Object.entries(combinedInputs.projection.sourceProjection2192EachMode[mode]))assert.equal(sha(readFileSync(join(root,'backend',p))),v.sha256,p);
   const seam=combinedInputs.protection.identityOnlyLauncherSeams[mode];assert.equal(sha(replaceUnique(readFileSync(join(root,seam.path),'utf8'),combinedInputs.plan.prospectiveCandidateIds[mode],seam.beforeCandidateId)),seam.beforeSHA256);
   const manifest=JSON.parse(readFileSync(join(root,'prepared-source-manifest.json')));delete actual['prepared-source-manifest.json'];assert.deepEqual(actual,Object.fromEntries(manifest.files.map(({path,...v})=>[path,v])));
   packageObservations.push({gate:'full-package-projection',mode,source2192:2192,frozen59:59,retainedR5Outside59:27,allOtherLeavesExact:true});
  }
 });
 test('both compiled packages expose the five reviewed contracts and original schema assets',async()=>{
  for(const mode of ['candidate','recovery'])for(const name of ['mobile-context-activity','mobile-context-location','mobile-context-location-delivery','mobile-context-shared-item','mobile-context-signal']){
   const backend=join(packageBase,mode,'backend'),module=await load(join(backend,'packages/contracts/dist',name+'.js'));assert(Object.keys(module).length>0);
   assert.equal(sha(readFileSync(join(backend,'packages/contracts/dist/schemas',name+'.schema.json'))),sha(readFileSync(join(backend,'packages/contracts/src/schemas',name+'.schema.json'))));
  }
 });
 test('new package original source selection validates closed profiles, defaults off and refuses recovery',async()=>{
  const candidate=await load(join(packageBase,'candidate/launch/source-production-selection.mjs')),recovery=await load(join(packageBase,'recovery/launch/source-production-selection.mjs'));
  const p={destinationId:'synthetic-health-server',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:50};
  assert.equal(candidate.sourceProfileKind({}),'none');assert.deepEqual(candidate.sourceProductionLaunchOptions({},undefined),{});assert.deepEqual(recovery.sourceProductionLaunchOptions({},undefined),{});
  for(const [kind,plan] of [['health','health-consent/1'],['calendar','calendar-consent/1'],['combined','mobile-source-control/1']]){
   const field=kind==='combined'?'mobileSourceProfile':kind+'SourceProfile',value={mobileSchemaPlan:plan,[field]:kind==='combined'?{health:structuredClone(p),calendar:structuredClone(p)}:p};
   assert.equal(candidate.sourceProfileKind(value),kind);assert.throws(()=>candidate.sourceProductionLaunchOptions(value,'foreign-not-a-uuid'));assert.throws(()=>recovery.sourceProductionLaunchOptions(value,randomUUID()));
   for(const key of ['environmentId','installationId','sourceNamespace','classification','retention','consent','sdkReady','createGovernance','sourceSafetyInitialization']){
    const bad=structuredClone(value);(kind==='combined'?bad[field].health:bad[field])[key]='not-allowed';assert.throws(()=>candidate.captureSourceDeployment(bad));
   }
  }
  let invoked=0;const accessor=Object.defineProperty({mobileSchemaPlan:'health-consent/1'},'healthSourceProfile',{enumerable:true,get(){invoked++;return p;}});assert.throws(()=>candidate.captureSourceDeployment(accessor));assert.equal(invoked,0);
  for(const bad of [{mobileSchemaPlan:'mobile-source-control/1',healthSourceProfile:p},{mobileSchemaPlan:'health-consent/1',healthSourceProfile:p,calendarSourceProfile:p},{mobileSchemaPlan:'mobile-source-control/1',mobileSourceProfile:{health:p,calendar:{...p,maximumRecordsPerHuman:101}}}])assert.throws(()=>candidate.captureSourceDeployment(bad));
 });
 test('new package original factory/Auth/source owners compose positively without listening or data authority',async()=>{
  const {createMobileSourceProductionFixture}=await load(join(packageBase,'candidate/backend/apps/server/test/mobile-source-production-consent.test.ts'));
  const selection=await load(join(packageBase,'candidate/launch/source-production-selection.mjs')),recovery=await load(join(packageBase,'recovery/launch/source-production-selection.mjs'));
  for(const [kind,plan] of [['health','health-consent/1'],['calendar','calendar-consent/1'],['combined','mobile-source-control/1']]){
   const f=await createMobileSourceProductionFixture(false,plan);
   try{
    const operational={destinationId:f.profile.destinationId,maximumRecordsPerHuman:f.profile.maximumRecordsPerHuman,maximumControlOperationsPerHuman:f.profile.maximumControlOperationsPerHuman,finite:f.profile.finite};
    const field=kind==='combined'?'mobileSourceProfile':kind+'SourceProfile',deployment={mobileSchemaPlan:plan,[field]:kind==='combined'?{health:structuredClone(operational),calendar:structuredClone(operational)}:operational};
    const chosen=await f.applyLaunchSelection(selection.sourceProductionLaunchOptions,deployment);
    assert.equal(chosen.mobileContext.sourceSafetyInitialization,'requireExisting');assert.equal(f.app.server.listening,false);
    assert.equal(chosen.mobileContext.healthProduction?.environmentId??chosen.mobileContext.calendarProduction.environmentId,f.profile.environmentId);
    assert.equal(!!f.app.admin.healthPolicyOwner,kind!=='calendar');assert.equal(!!f.app.admin.calendarPolicyOwner,kind!=='health');
    for(const table of ['mobile_context_records','mobile_context_policy_decisions','mobile_context_enrollments'])assert.equal(Number(f.app.database.connection.prepare('SELECT count(*) n FROM '+table).get().n),0);
    const journal=readFileSync(f.app.admin.recovery.journal.directory+'/journal.json');await f.applyLaunchSelection(recovery.sourceProductionLaunchOptions,{mobileSchemaPlan:plan});
    assert.equal(f.app.mobileContext,undefined);assert.equal(f.app.admin.healthPolicyOwner,undefined);assert.equal(f.app.admin.calendarPolicyOwner,undefined);assert.deepEqual(readFileSync(f.app.admin.recovery.journal.directory+'/journal.json'),journal);
    packageObservations.push({gate:'positive-original-factory',kind,plan,originalAuthAndOwners:true,listening:false,records:0,enrollments:0,policyDecisions:0,installedStart:false});
   }finally{await f.close();}
  }
 });
 test('new package original source currentness keeps stale and missing journals held',async()=>{
  const {createMobileSourceProductionFixture}=await load(join(packageBase,'candidate/backend/apps/server/test/mobile-source-production-consent.test.ts')),selection=await load(join(packageBase,'candidate/launch/source-production-selection.mjs'));
  for(const kind of ['stale','missing']){
   const f=await createMobileSourceProductionFixture(false,'mobile-source-control/1');try{
    const journalPath=f.app.admin.recovery.journal.directory+'/journal.json',before=readFileSync(journalPath);if(kind==='stale')f.app.database.connection.exec('UPDATE recovery_source_projection SET epoch=epoch+1');
    const p={destinationId:f.profile.destinationId,maximumRecordsPerHuman:f.profile.maximumRecordsPerHuman,maximumControlOperationsPerHuman:f.profile.maximumControlOperationsPerHuman};
    const marker=f.app.database.connection.prepare('SELECT * FROM recovery_source_projection').all();
    await f.applyLaunchSelection(selection.sourceProductionLaunchOptions,{mobileSchemaPlan:'mobile-source-control/1',mobileSourceProfile:{health:structuredClone(p),calendar:structuredClone(p)}},kind==='missing'?()=>renameSync(journalPath,journalPath+'.retained-original'):undefined);
    assert.equal(f.app.admin.recovery.journal.sourceCurrent(),false);assert.equal(f.app.server.listening,false);assert.deepEqual(f.app.database.connection.prepare('SELECT * FROM recovery_source_projection').all(),marker);
    assert.deepEqual(readFileSync(kind==='missing'?journalPath+'.retained-original':journalPath),before);if(kind==='missing')assert.equal(existsSync(journalPath),false);
    assert.equal(Number(f.app.database.connection.prepare('SELECT count(*) n FROM mobile_context_records').get().n),0);packageObservations.push({gate:'original-source-currentness',kind,sourceCurrent:false,records:0});
   }finally{await f.close();}
  }
 });
 test.after(()=>{
  if(packageDiagnosticBoundary){packageDiagnosticBoundary.close();packageObservations.push({gate:'diagnostic-parent-boundary',trace:packageDiagnosticBoundary.trace});}
  if(process.env.HEALTH_SOURCE_EVIDENCE_PATH)put(process.env.HEALTH_SOURCE_EVIDENCE_PATH,{schemaVersion:1,status:'ActualInactivePackageSyntheticQualification',planSHA256:combinedInputs.planSHA256,observations:packageObservations,cliObservations,installedStartQualified:false,sidecarExecuted:false,noRealStateRead:true});
 });
}

// Exact child source is frozen for original-review inspection before execution.
export const compiledDiagnosticEntryHarness=String.raw`// Builtins only before the explicit compiled-audit binding.
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports,registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
function installDiagnosticBoundary({scratch,caller,legacy=false}){
 const fs=createRequire(import.meta.url)('node:fs'),hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(scratch,'/srv/lifestream/workspace/runtime-state/real-daily/pwce-package-lineage-qualification-20261105-r2');
 const trace={caller,phase:'builtin-boundary-installation',forbiddenAttempts:[],rejectedImports:[],projections:[],legacy:[],deadlines:{},closed:false};
 for(const key of ['LIFESTREAM_TTS_LIFECYCLE_UNTIL_MS','LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS']){trace.deadlines[key]={previouslySet:Object.hasOwn(process.env,key),effective:'absent'};delete process.env[key];assert.equal(process.env[key],undefined);}
 const scratchStat=fs.lstatSync(scratch);assert(scratchStat.isDirectory()&&!scratchStat.isSymbolicLink()&&scratchStat.uid===process.getuid()&&(scratchStat.mode&0o777)===0o700);assert.equal(fs.realpathSync(scratch),scratch);
 const owned=fs.mkdtempSync(join(scratch,'diagnostic-port-'+caller+'-'));fs.chmodSync(owned,0o700);
 const directories={lifecycle:join(owned,'lifecycle'),transport:join(owned,'transport')};
 for(const path of Object.values(directories)){fs.mkdirSync(path,{mode:0o700});const st=fs.lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700);assert.equal(fs.realpathSync(path),path);}
 trace.directories=directories;
 const fdPaths=new Map(),originals=[];
 const pathValue=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():value;
 const isOwned=path=>path===scratch||path.startsWith(scratch+'/');
 function reject(operation,path){const event={operation,path,phase:trace.phase,atUTC:new Date().toISOString(),stack:new Error('before-IO').stack};trace.forbiddenAttempts.push(event);console.error('DIAGNOSTIC_GUARD_REJECTION '+JSON.stringify(event));throw Error('excluded_path_or_unowned_fd_before_IO');}
 function guard(operation,value,writing=false){
  if(typeof value==='number'){const path=fdPaths.get(value);if(writing&&value!==1&&value!==2&&(!path||!isOwned(path)))reject(operation,'fd:'+value);return;}
  const raw=pathValue(value);if(typeof raw!=='string')return;const path=resolve(raw);
  for(const denied of ['/srv/lifestream/private-diagnostics','/srv/lifestream/deployment'])if(path===denied||path.startsWith(denied+'/'))reject(operation,path);
 }
 function wrap(object,key,kind){const original=object[key];if(typeof original!=='function')return;
  originals.push([object,key,original]);object[key]=function(...args){guard(key,args[0],kind==='write');if(kind==='two')guard(key,args[1],true);const value=Reflect.apply(original,this,args);
   if(key==='openSync')fdPaths.set(value,resolve(pathValue(args[0])));if(key==='closeSync')fdPaths.delete(args[0]);return value;};
 }
 for(const key of ['readFileSync','openSync','readdirSync','lstatSync','statSync','existsSync','accessSync','realpathSync','opendirSync','closeSync','readSync','fstatSync'])wrap(fs,key,'read');
 for(const key of ['writeFileSync','appendFileSync','writeSync','ftruncateSync','rmSync','unlinkSync','rmdirSync','mkdirSync','truncateSync','chmodSync'])wrap(fs,key,'write');
 for(const key of ['renameSync','copyFileSync','cpSync'])wrap(fs,key,'two');
 for(const key of ['readFile','open','readdir','lstat','stat','access','realpath','opendir'])wrap(fs.promises,key,'read');
 for(const key of ['writeFile','appendFile','rm','unlink','rmdir','mkdir','truncate','chmod'])wrap(fs.promises,key,'write');
 for(const key of ['rename','copyFile','cp'])wrap(fs.promises,key,'two');
 syncBuiltinESMExports();
 const specs=[{file:'lifecycle-observation.js',sha256:'09cbfb1e5ccd81ad54320722f72a3b4ae02755dca5ade018d537e38226e5ec96',literal:'/srv/lifestream/deployment/diagnostics/tts-lifecycle-v1',offset:10008,length:55,directory:directories.lifecycle},{file:'transport-observation.js',sha256:'d8e2022aecb91d2b34eea04ae3e1a9eed3489f9d824f1aa279feef365befa2d6',literal:'/srv/lifestream/deployment/diagnostics/tts-transport-20261029',offset:5594,length:61,directory:directories.transport}];
 const targets=new Map();for(const mode of ['candidate','recovery'])for(const spec of specs){const path='/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/'+mode+'/backend/packages/providers-voxcpm/dist/'+spec.file;assert.equal(fs.realpathSync(path),path);assert.equal(hash(fs.readFileSync(path)),spec.sha256);targets.set(pathToFileURL(path).href,spec);}
 let legacyTransportURL;
 if(legacy){const base='/srv/lifestream/workspace/mobile-context-a-source-20261029/health-production-consent-work-r1/RUNTIME-FREEZE-r1/runtime/packages/providers-voxcpm/dist/',provider=base+'provider.js',transport=base+'transport-observation.js';
  assert.equal(hash(fs.readFileSync(provider)),'979e9e5942cc4a505da6927ff03724b4cc45c08181855e26b9d6286c1823a53f');assert(!/lifecycle-observation|lifecycleObservation/.test(fs.readFileSync(provider,'utf8')));assert(!fs.existsSync(base+'lifecycle-observation.js'));assert.equal(hash(fs.readFileSync(transport)),specs[1].sha256);legacyTransportURL=pathToFileURL(transport).href;
  trace.legacy.push({providerURL:pathToFileURL(provider).href,providerSHA256:hash(fs.readFileSync(provider)),lifecycleAbsent:true,transportURL:legacyTransportURL,transportSHA256:hash(fs.readFileSync(transport)),loaderProjection:false,loaded:false,transportDeadline:'absent'});
 }
 const hooks=registerHooks({load(url,context,nextLoad){
  const spec=targets.get(url),observer=/\/providers-voxcpm\/dist\/(?:lifecycle|transport)-observation\.js$/.test(new URL(url).pathname);
  if(observer&&!spec&&url!==legacyTransportURL){const event={url,phase:trace.phase,atUTC:new Date().toISOString()};trace.rejectedImports.push(event);throw Error('undeclared_observer_URL_before_evaluation');}
  const loaded=nextLoad(url,context);if(!spec){if(url===legacyTransportURL){trace.legacy[0].loaded=true;assert.equal(hash(Buffer.from(loaded.source)),specs[1].sha256);assert.equal(process.env.LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS,undefined);}return loaded;}
  assert.equal(loaded.format,'module');assert.equal(url,pathToFileURL(fileURLToPath(url)).href);const original=Buffer.from(loaded.source);assert.equal(hash(original),spec.sha256);assert.equal(original.subarray(spec.offset,spec.offset+spec.length).toString(),spec.literal);assert.equal(original.toString().split(spec.literal).length,2);assert.equal(original[spec.offset-1],39);assert.equal(original[spec.offset+spec.length],39);
  const replacement=Buffer.from(JSON.stringify(spec.directory).slice(1,-1));assert(!replacement.includes(39));const transformed=Buffer.concat([original.subarray(0,spec.offset),replacement,original.subarray(spec.offset+spec.length)]),reversed=Buffer.concat([transformed.subarray(0,spec.offset),Buffer.from(spec.literal),transformed.subarray(spec.offset+replacement.length)]);assert.deepEqual(reversed,original);
  trace.projections.push({url,format:loaded.format,originalSHA256:hash(original),transformedSHA256:hash(transformed),byteOffsetUTF8:spec.offset,originalLiteralBytes:spec.length,replacementBytes:replacement.length,originalLiteral:spec.literal,replacementDirectory:spec.directory,reverseExact:true,effectiveSource:transformed.toString()});return {...loaded,source:transformed};
 }});
 return {fs,trace,setPhase(value){trace.phase=value;},close(){assert.equal(trace.forbiddenAttempts.length,0);assert.equal(trace.rejectedImports.length,0);hooks.deregister();fs.rmSync(owned,{recursive:true,force:true});trace.closed=true;/* Guards remain installed through process exit; observer exit callbacks stay confined. */}};
}

const [packageRoot,scratch,mode]=process.argv.slice(1);assert(['candidate','recovery'].includes(mode));assert.equal(packageRoot,'/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/'+mode);
const boundary=installDiagnosticBoundary({scratch,caller:'compiled-'+mode,legacy:false}),fs=boundary.fs,{forbiddenAttempts}=boundary.trace;
const backend=join(packageRoot,'backend'),auditPath=join(backend,'apps/server/dist/runtime/bounded-audit.mjs'),auditURL=pathToFileURL(auditPath).href;
const auditSHA256=createHash('sha256').update(fs.readFileSync(auditPath)).digest('hex');
assert.equal(auditSHA256,'ae85a725038beb675a5810cf6c8d762129c0c5e77fe2bffcdef1cd7163d426ac');
const owned=fs.mkdtempSync(join(scratch,'compiled-entry-'+mode+'-'));fs.chmodSync(owned,0o700);
const order=[];let app,bootstrap,syntheticAudit,outcome;
try{
 boundary.setPhase('compiled-audit-import-and-binding');const module=await import(auditURL);order.push('actual-compiled-audit-imported-timers-false');
 syntheticAudit=module.createAudit({root:join(owned,'audit'),timers:false});let disabledStartCalls=0;
 Object.assign(module.audit,syntheticAudit,{start(){disabledStartCalls++;}});order.push('exact-compiled-singleton-bound-synthetic-before-index');
 boundary.setPhase('compiled-index-import');const entryPath=join(backend,'apps/server/dist/index.js'),entry=await import(pathToFileURL(entryPath).href);order.push('actual-compiled-index-imported');
 assert.equal(typeof entry.createLifestreamServer,'function');assert.equal(disabledStartCalls,1);assert.equal(forbiddenAttempts.length,0);
 boundary.setPhase('compiled-fixture-factory-construction');const {loadProfile}=await import(pathToFileURL(join(backend,'apps/server/dist/config/loader.js')).href);
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(owned,'state/data.sqlite'),artifactDirectory:join(owned,'state/artifacts')};
 const environmentId=randomUUID(),options={config,mobileSchemaPlan:'mobile-source-control/1',sessionEnvironmentId:environmentId,historyRetention:{mode:'disabled'},historyStateRoot:join(owned,'state'),localAuth:{stateDirectory:join(owned,'auth'),installerToken:randomBytes(32).toString('hex')}};
 bootstrap=entry.createLifestreamServer(options);assert.equal(bootstrap.server.listening,false);bootstrap.admin.recovery.journal.enableSources('initializeEmpty');await bootstrap.shutdown();bootstrap=undefined;
 const selection=await import(pathToFileURL(join(packageRoot,'launch/source-production-selection.mjs')).href);
 const profile={destinationId:'synthetic-compiled-qualification',maximumRecordsPerHuman:100,maximumControlOperationsPerHuman:50};
 const deployment={mobileSchemaPlan:'mobile-source-control/1',mobileSourceProfile:{health:structuredClone(profile),calendar:structuredClone(profile)}};
 let chosen={};if(mode==='candidate')chosen=selection.sourceProductionLaunchOptions(deployment,environmentId);else assert.throws(()=>selection.sourceProductionLaunchOptions(deployment,environmentId));
 app=entry.createLifestreamServer({...options,...chosen});assert.equal(app.server.listening,false);assert(app.localAuth);
 for(const table of ['mobile_context_records','mobile_context_enrollments','mobile_context_policy_decisions'])assert.equal(Number(app.database.connection.prepare('SELECT count(*) n FROM '+table).get().n),0);
 assert.equal(!!app.admin.healthPolicyOwner,mode==='candidate');assert.equal(!!app.admin.calendarPolicyOwner,mode==='candidate');
 order.push('actual-compiled-factory-auth-sql-source-graph-constructed-not-listening');await app.shutdown();app=undefined;
 assert.equal(forbiddenAttempts.length,0);
 outcome={mode,diagnosticBoundary:boundary.trace,auditURL,auditSHA256,entryURL:pathToFileURL(entryPath).href,entrySHA256:createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex'),order,disabledStartCalls,forbiddenAttempts,compiledEntry:true,originalFactoryAuthSQL:true,listening:false,records:0,enrollments:0,policyDecisions:0,installedStart:false,diagnosticRuntimeCompatibility:false,diagnosticBinding:'original-createAudit-on-owned-root-with-disabled-start-test-port'};
}finally{await app?.shutdown();await bootstrap?.shutdown();syntheticAudit?.close();fs.rmSync(owned,{recursive:true,force:true});boundary.close();}
console.log(JSON.stringify(outcome));
`;

if(combinedInputs){
 test('both compiled entries and original factory graphs load only after exact compiled audit isolation',()=>{
  for(const mode of ['candidate','recovery']){
   const root=join(packageBase,mode),result=spawnSync(process.execPath,['--experimental-transform-types','--input-type=module','-e',compiledDiagnosticEntryHarness,root,combinedInputs.plan.qualificationScratch,mode],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
   assert.equal(result.status,0,result.stdout+result.stderr);const observation=JSON.parse(result.stdout.trim());assert.equal(observation.compiledEntry,true);assert.deepEqual(observation.forbiddenAttempts,[]);assert.equal(observation.listening,false);
   packageObservations.push({gate:'actual-compiled-entry-isolated',...observation,rawStdout:result.stdout,rawStderr:result.stderr});
  }
 });
 test('independent physical audit preserves modes, links and directories outside compiled outputs',()=>{
  for(const mode of ['candidate','recovery']){
   const root=join(packageBase,mode),donor=resolve(combinedInputs.plan.inputPrepared[mode].path,'..'),before=physicalInventory(donor),after=physicalInventory(root),result=JSON.parse(readFileSync(join(packageBase,'PREPARATION-RESULT.json'))).modes[mode];
   assertPhysicalPreservation(before,after,{compiledProjects:result.compiledProjects,sourcePaths:Object.keys(combinedInputs.union),full:combinedInputs.full});
   const vendor=Object.keys(before).filter(p=>p.startsWith('backend/node_modules/')&&p.includes('/dist/')&&before[p].type==='file'&&before[p].mode===0o400);assert.equal(vendor.length,643);
   for(const p of vendor)assert.equal(after[p].mode,0o400,p);
   // Causal negative uses a detached evidence map, never chmods a package.
   const changed=structuredClone(after);changed[vendor[0]].mode=0o600;assert.throws(()=>assertPhysicalPreservation(before,changed,{compiledProjects:result.compiledProjects,sourcePaths:Object.keys(combinedInputs.union),full:combinedInputs.full}),/Protected physical mode/);
   for(const asset of result.currentAssetLineage.assets){assert.equal(sha(readFileSync(join(root,asset.source))),asset.sourceSHA256);assert.equal(sha(readFileSync(join(root,asset.target))),asset.outputSHA256);}
   for(const entry of result.currentAssetLineage.relativeImports)assert(existsSync(join(root,entry.target)),entry.target);
   packageObservations.push({gate:'independent-physical-asset-preservation',mode,vendor643Retain0400:true,modeCounterexampleRejected:true,assets:result.currentAssetLineage});
  }
 });
}

export const guardedCliDiagnosticHarness=String.raw`// Builtins only before the explicit compiled-audit binding.
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports,registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
function installDiagnosticBoundary({scratch,caller,legacy=false}){
 const fs=createRequire(import.meta.url)('node:fs'),hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(scratch,'/srv/lifestream/workspace/runtime-state/real-daily/pwce-package-lineage-qualification-20261105-r2');
 const trace={caller,phase:'builtin-boundary-installation',forbiddenAttempts:[],rejectedImports:[],projections:[],legacy:[],deadlines:{},closed:false};
 for(const key of ['LIFESTREAM_TTS_LIFECYCLE_UNTIL_MS','LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS']){trace.deadlines[key]={previouslySet:Object.hasOwn(process.env,key),effective:'absent'};delete process.env[key];assert.equal(process.env[key],undefined);}
 const scratchStat=fs.lstatSync(scratch);assert(scratchStat.isDirectory()&&!scratchStat.isSymbolicLink()&&scratchStat.uid===process.getuid()&&(scratchStat.mode&0o777)===0o700);assert.equal(fs.realpathSync(scratch),scratch);
 const owned=fs.mkdtempSync(join(scratch,'diagnostic-port-'+caller+'-'));fs.chmodSync(owned,0o700);
 const directories={lifecycle:join(owned,'lifecycle'),transport:join(owned,'transport')};
 for(const path of Object.values(directories)){fs.mkdirSync(path,{mode:0o700});const st=fs.lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700);assert.equal(fs.realpathSync(path),path);}
 trace.directories=directories;
 const fdPaths=new Map(),originals=[];
 const pathValue=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():value;
 const isOwned=path=>path===scratch||path.startsWith(scratch+'/');
 function reject(operation,path){const event={operation,path,phase:trace.phase,atUTC:new Date().toISOString(),stack:new Error('before-IO').stack};trace.forbiddenAttempts.push(event);console.error('DIAGNOSTIC_GUARD_REJECTION '+JSON.stringify(event));throw Error('excluded_path_or_unowned_fd_before_IO');}
 function guard(operation,value,writing=false){
  if(typeof value==='number'){const path=fdPaths.get(value);if(writing&&value!==1&&value!==2&&(!path||!isOwned(path)))reject(operation,'fd:'+value);return;}
  const raw=pathValue(value);if(typeof raw!=='string')return;const path=resolve(raw);
  for(const denied of ['/srv/lifestream/private-diagnostics','/srv/lifestream/deployment'])if(path===denied||path.startsWith(denied+'/'))reject(operation,path);
 }
 function wrap(object,key,kind){const original=object[key];if(typeof original!=='function')return;
  originals.push([object,key,original]);object[key]=function(...args){guard(key,args[0],kind==='write');if(kind==='two')guard(key,args[1],true);const value=Reflect.apply(original,this,args);
   if(key==='openSync')fdPaths.set(value,resolve(pathValue(args[0])));if(key==='closeSync')fdPaths.delete(args[0]);return value;};
 }
 for(const key of ['readFileSync','openSync','readdirSync','lstatSync','statSync','existsSync','accessSync','realpathSync','opendirSync','closeSync','readSync','fstatSync'])wrap(fs,key,'read');
 for(const key of ['writeFileSync','appendFileSync','writeSync','ftruncateSync','rmSync','unlinkSync','rmdirSync','mkdirSync','truncateSync','chmodSync'])wrap(fs,key,'write');
 for(const key of ['renameSync','copyFileSync','cpSync'])wrap(fs,key,'two');
 for(const key of ['readFile','open','readdir','lstat','stat','access','realpath','opendir'])wrap(fs.promises,key,'read');
 for(const key of ['writeFile','appendFile','rm','unlink','rmdir','mkdir','truncate','chmod'])wrap(fs.promises,key,'write');
 for(const key of ['rename','copyFile','cp'])wrap(fs.promises,key,'two');
 syncBuiltinESMExports();
 const specs=[{file:'lifecycle-observation.js',sha256:'09cbfb1e5ccd81ad54320722f72a3b4ae02755dca5ade018d537e38226e5ec96',literal:'/srv/lifestream/deployment/diagnostics/tts-lifecycle-v1',offset:10008,length:55,directory:directories.lifecycle},{file:'transport-observation.js',sha256:'d8e2022aecb91d2b34eea04ae3e1a9eed3489f9d824f1aa279feef365befa2d6',literal:'/srv/lifestream/deployment/diagnostics/tts-transport-20261029',offset:5594,length:61,directory:directories.transport}];
 const targets=new Map();for(const mode of ['candidate','recovery'])for(const spec of specs){const path='/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/'+mode+'/backend/packages/providers-voxcpm/dist/'+spec.file;assert.equal(fs.realpathSync(path),path);assert.equal(hash(fs.readFileSync(path)),spec.sha256);targets.set(pathToFileURL(path).href,spec);}
 let legacyTransportURL;
 if(legacy){const base='/srv/lifestream/workspace/mobile-context-a-source-20261029/health-production-consent-work-r1/RUNTIME-FREEZE-r1/runtime/packages/providers-voxcpm/dist/',provider=base+'provider.js',transport=base+'transport-observation.js';
  assert.equal(hash(fs.readFileSync(provider)),'979e9e5942cc4a505da6927ff03724b4cc45c08181855e26b9d6286c1823a53f');assert(!/lifecycle-observation|lifecycleObservation/.test(fs.readFileSync(provider,'utf8')));assert(!fs.existsSync(base+'lifecycle-observation.js'));assert.equal(hash(fs.readFileSync(transport)),specs[1].sha256);legacyTransportURL=pathToFileURL(transport).href;
  trace.legacy.push({providerURL:pathToFileURL(provider).href,providerSHA256:hash(fs.readFileSync(provider)),lifecycleAbsent:true,transportURL:legacyTransportURL,transportSHA256:hash(fs.readFileSync(transport)),loaderProjection:false,loaded:false,transportDeadline:'absent'});
 }
 const hooks=registerHooks({load(url,context,nextLoad){
  const spec=targets.get(url),observer=/\/providers-voxcpm\/dist\/(?:lifecycle|transport)-observation\.js$/.test(new URL(url).pathname);
  if(observer&&!spec&&url!==legacyTransportURL){const event={url,phase:trace.phase,atUTC:new Date().toISOString()};trace.rejectedImports.push(event);throw Error('undeclared_observer_URL_before_evaluation');}
  const loaded=nextLoad(url,context);if(!spec){if(url===legacyTransportURL){trace.legacy[0].loaded=true;assert.equal(hash(Buffer.from(loaded.source)),specs[1].sha256);assert.equal(process.env.LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS,undefined);}return loaded;}
  assert.equal(loaded.format,'module');assert.equal(url,pathToFileURL(fileURLToPath(url)).href);const original=Buffer.from(loaded.source);assert.equal(hash(original),spec.sha256);assert.equal(original.subarray(spec.offset,spec.offset+spec.length).toString(),spec.literal);assert.equal(original.toString().split(spec.literal).length,2);assert.equal(original[spec.offset-1],39);assert.equal(original[spec.offset+spec.length],39);
  const replacement=Buffer.from(JSON.stringify(spec.directory).slice(1,-1));assert(!replacement.includes(39));const transformed=Buffer.concat([original.subarray(0,spec.offset),replacement,original.subarray(spec.offset+spec.length)]),reversed=Buffer.concat([transformed.subarray(0,spec.offset),Buffer.from(spec.literal),transformed.subarray(spec.offset+replacement.length)]);assert.deepEqual(reversed,original);
  trace.projections.push({url,format:loaded.format,originalSHA256:hash(original),transformedSHA256:hash(transformed),byteOffsetUTF8:spec.offset,originalLiteralBytes:spec.length,replacementBytes:replacement.length,originalLiteral:spec.literal,replacementDirectory:spec.directory,reverseExact:true,effectiveSource:transformed.toString()});return {...loaded,source:transformed};
 }});
 return {fs,trace,setPhase(value){trace.phase=value;},close(){assert.equal(trace.forbiddenAttempts.length,0);assert.equal(trace.rejectedImports.length,0);hooks.deregister();fs.rmSync(owned,{recursive:true,force:true});trace.closed=true;/* Guards remain installed through process exit; observer exit callbacks stay confined. */}};
}

const [root,action,config,scratch]=process.argv.slice(1);assert(['candidate','recovery'].some(mode=>root==='/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/'+mode));assert(['--check','--start'].includes(action));const boundary=installDiagnosticBoundary({scratch,caller:'cli',legacy:false});try{boundary.setPhase('original-configuration-or-adoption-refusal-CLI');const entry=join(root,'launch/start-canonical.mjs');process.argv=[process.execPath,entry,action,'--config',config];await import(pathToFileURL(entry).href);}finally{boundary.close();console.error('DIAGNOSTIC_BOUNDARY '+JSON.stringify(boundary.trace));}
`;

export const guardedBrowserDiagnosticHarness=String.raw`// Builtins only before the explicit compiled-audit binding.
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports,registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {after} from 'node:test';
function installDiagnosticBoundary({scratch,caller,legacy=false}){
 const fs=createRequire(import.meta.url)('node:fs'),hash=b=>createHash('sha256').update(b).digest('hex');
 assert.equal(scratch,'/srv/lifestream/workspace/runtime-state/real-daily/pwce-package-lineage-qualification-20261105-r2');
 const trace={caller,phase:'builtin-boundary-installation',forbiddenAttempts:[],rejectedImports:[],projections:[],legacy:[],deadlines:{},closed:false};
 for(const key of ['LIFESTREAM_TTS_LIFECYCLE_UNTIL_MS','LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS']){trace.deadlines[key]={previouslySet:Object.hasOwn(process.env,key),effective:'absent'};delete process.env[key];assert.equal(process.env[key],undefined);}
 const scratchStat=fs.lstatSync(scratch);assert(scratchStat.isDirectory()&&!scratchStat.isSymbolicLink()&&scratchStat.uid===process.getuid()&&(scratchStat.mode&0o777)===0o700);assert.equal(fs.realpathSync(scratch),scratch);
 const owned=fs.mkdtempSync(join(scratch,'diagnostic-port-'+caller+'-'));fs.chmodSync(owned,0o700);
 const directories={lifecycle:join(owned,'lifecycle'),transport:join(owned,'transport')};
 for(const path of Object.values(directories)){fs.mkdirSync(path,{mode:0o700});const st=fs.lstatSync(path);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===process.getuid()&&(st.mode&0o777)===0o700);assert.equal(fs.realpathSync(path),path);}
 trace.directories=directories;
 const fdPaths=new Map(),originals=[];
 const pathValue=value=>value instanceof URL?fileURLToPath(value):Buffer.isBuffer(value)?value.toString():value;
 const isOwned=path=>path===scratch||path.startsWith(scratch+'/');
 function reject(operation,path){const event={operation,path,phase:trace.phase,atUTC:new Date().toISOString(),stack:new Error('before-IO').stack};trace.forbiddenAttempts.push(event);console.error('DIAGNOSTIC_GUARD_REJECTION '+JSON.stringify(event));throw Error('excluded_path_or_unowned_fd_before_IO');}
 function guard(operation,value,writing=false){
  if(typeof value==='number'){const path=fdPaths.get(value);if(writing&&value!==1&&value!==2&&(!path||!isOwned(path)))reject(operation,'fd:'+value);return;}
  const raw=pathValue(value);if(typeof raw!=='string')return;const path=resolve(raw);
  for(const denied of ['/srv/lifestream/private-diagnostics','/srv/lifestream/deployment'])if(path===denied||path.startsWith(denied+'/'))reject(operation,path);
 }
 function wrap(object,key,kind){const original=object[key];if(typeof original!=='function')return;
  originals.push([object,key,original]);object[key]=function(...args){guard(key,args[0],kind==='write');if(kind==='two')guard(key,args[1],true);const value=Reflect.apply(original,this,args);
   if(key==='openSync')fdPaths.set(value,resolve(pathValue(args[0])));if(key==='closeSync')fdPaths.delete(args[0]);return value;};
 }
 for(const key of ['readFileSync','openSync','readdirSync','lstatSync','statSync','existsSync','accessSync','realpathSync','opendirSync','closeSync','readSync','fstatSync'])wrap(fs,key,'read');
 for(const key of ['writeFileSync','appendFileSync','writeSync','ftruncateSync','rmSync','unlinkSync','rmdirSync','mkdirSync','truncateSync','chmodSync'])wrap(fs,key,'write');
 for(const key of ['renameSync','copyFileSync','cpSync'])wrap(fs,key,'two');
 for(const key of ['readFile','open','readdir','lstat','stat','access','realpath','opendir'])wrap(fs.promises,key,'read');
 for(const key of ['writeFile','appendFile','rm','unlink','rmdir','mkdir','truncate','chmod'])wrap(fs.promises,key,'write');
 for(const key of ['rename','copyFile','cp'])wrap(fs.promises,key,'two');
 syncBuiltinESMExports();
 const specs=[{file:'lifecycle-observation.js',sha256:'09cbfb1e5ccd81ad54320722f72a3b4ae02755dca5ade018d537e38226e5ec96',literal:'/srv/lifestream/deployment/diagnostics/tts-lifecycle-v1',offset:10008,length:55,directory:directories.lifecycle},{file:'transport-observation.js',sha256:'d8e2022aecb91d2b34eea04ae3e1a9eed3489f9d824f1aa279feef365befa2d6',literal:'/srv/lifestream/deployment/diagnostics/tts-transport-20261029',offset:5594,length:61,directory:directories.transport}];
 const targets=new Map();for(const mode of ['candidate','recovery'])for(const spec of specs){const path='/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/'+mode+'/backend/packages/providers-voxcpm/dist/'+spec.file;assert.equal(fs.realpathSync(path),path);assert.equal(hash(fs.readFileSync(path)),spec.sha256);targets.set(pathToFileURL(path).href,spec);}
 let legacyTransportURL;
 if(legacy){const base='/srv/lifestream/workspace/mobile-context-a-source-20261029/health-production-consent-work-r1/RUNTIME-FREEZE-r1/runtime/packages/providers-voxcpm/dist/',provider=base+'provider.js',transport=base+'transport-observation.js';
  assert.equal(hash(fs.readFileSync(provider)),'979e9e5942cc4a505da6927ff03724b4cc45c08181855e26b9d6286c1823a53f');assert(!/lifecycle-observation|lifecycleObservation/.test(fs.readFileSync(provider,'utf8')));assert(!fs.existsSync(base+'lifecycle-observation.js'));assert.equal(hash(fs.readFileSync(transport)),specs[1].sha256);legacyTransportURL=pathToFileURL(transport).href;
  trace.legacy.push({providerURL:pathToFileURL(provider).href,providerSHA256:hash(fs.readFileSync(provider)),lifecycleAbsent:true,transportURL:legacyTransportURL,transportSHA256:hash(fs.readFileSync(transport)),loaderProjection:false,loaded:false,transportDeadline:'absent'});
 }
 const hooks=registerHooks({load(url,context,nextLoad){
  const spec=targets.get(url),observer=/\/providers-voxcpm\/dist\/(?:lifecycle|transport)-observation\.js$/.test(new URL(url).pathname);
  if(observer&&!spec&&url!==legacyTransportURL){const event={url,phase:trace.phase,atUTC:new Date().toISOString()};trace.rejectedImports.push(event);throw Error('undeclared_observer_URL_before_evaluation');}
  const loaded=nextLoad(url,context);if(!spec){if(url===legacyTransportURL){trace.legacy[0].loaded=true;assert.equal(hash(Buffer.from(loaded.source)),specs[1].sha256);assert.equal(process.env.LIFESTREAM_TTS_TRANSPORT_OBSERVATION_UNTIL_MS,undefined);}return loaded;}
  assert.equal(loaded.format,'module');assert.equal(url,pathToFileURL(fileURLToPath(url)).href);const original=Buffer.from(loaded.source);assert.equal(hash(original),spec.sha256);assert.equal(original.subarray(spec.offset,spec.offset+spec.length).toString(),spec.literal);assert.equal(original.toString().split(spec.literal).length,2);assert.equal(original[spec.offset-1],39);assert.equal(original[spec.offset+spec.length],39);
  const replacement=Buffer.from(JSON.stringify(spec.directory).slice(1,-1));assert(!replacement.includes(39));const transformed=Buffer.concat([original.subarray(0,spec.offset),replacement,original.subarray(spec.offset+spec.length)]),reversed=Buffer.concat([transformed.subarray(0,spec.offset),Buffer.from(spec.literal),transformed.subarray(spec.offset+replacement.length)]);assert.deepEqual(reversed,original);
  trace.projections.push({url,format:loaded.format,originalSHA256:hash(original),transformedSHA256:hash(transformed),byteOffsetUTF8:spec.offset,originalLiteralBytes:spec.length,replacementBytes:replacement.length,originalLiteral:spec.literal,replacementDirectory:spec.directory,reverseExact:true,effectiveSource:transformed.toString()});return {...loaded,source:transformed};
 }});
 return {fs,trace,setPhase(value){trace.phase=value;},close(){assert.equal(trace.forbiddenAttempts.length,0);assert.equal(trace.rejectedImports.length,0);hooks.deregister();fs.rmSync(owned,{recursive:true,force:true});trace.closed=true;/* Guards remain installed through process exit; observer exit callbacks stay confined. */}};
}

const [file,scratch]=process.argv.slice(1),allowed=["apps/control-web/test/audience-privacy.test.mjs", "apps/control-web/test/conversation-camera-frames.test.mjs", "apps/control-web/test/conversation-camera.test.mjs", "apps/control-web/test/conversation-capture.test.mjs", "apps/control-web/test/conversation-playback.test.mjs", "apps/control-web/test/conversation-ui.test.mjs", "apps/control-web/test/initiative-conversation.test.mjs", "apps/control-web/test/presentation-core.test.mjs", "apps/control-web/test/presentation-library.test.mjs", "apps/control-web/test/presentation-motion.test.mjs", "apps/control-web/test/presentation-playback.test.mjs", "apps/control-web/test/presentation-preview.test.mjs", "apps/control-web/test/presentation-reduced-motion.test.mjs", "apps/control-web/test/presentation-speech.test.mjs", "apps/control-web/test/presentation-state.test.mjs", "apps/control-web/test/relationship-extensions.test.mjs", "apps/control-web/test/relationship-tuning.test.mjs", "apps/control-web/test/urgent-attention.test.mjs", "apps/control-web/test/workspace-design.test.mjs"];const backend='/srv/lifestream/workspace/pwce-combined-inactive-package-preparation-20261105-r2/candidate/backend';assert(allowed.some(name=>file===join(backend,name)));assert.equal(process.env.PLAYWRIGHT_MODULE,undefined,'Retain actual absent optional browser environment');const boundary=installDiagnosticBoundary({scratch,caller:'browser',legacy:false}),fs=boundary.fs;boundary.setPhase('source-audit-before-browser-static-import');const auditPath=join(backend,'apps/server/src/runtime/bounded-audit.mjs');assert.equal(createHash('sha256').update(fs.readFileSync(auditPath)).digest('hex'),'ae85a725038beb675a5810cf6c8d762129c0c5e77fe2bffcdef1cd7163d426ac');const auditModule=await import(pathToFileURL(auditPath).href),auditRoot=join(boundary.trace.directories.lifecycle,'..','source-audit');fs.mkdirSync(auditRoot,{mode:0o700});const syntheticAudit=auditModule.createAudit({root:auditRoot,timers:false});let disabledStartCalls=0;Object.assign(auditModule.audit,syntheticAudit,{start(){disabledStartCalls++;}});after(()=>{syntheticAudit.close();boundary.close();console.error('DIAGNOSTIC_BOUNDARY '+JSON.stringify({file,disabledStartCalls,...boundary.trace}));});boundary.setPhase('browser-file-static-and-test-imports');await import(pathToFileURL(file).href);
`;
