// Source-only isolated preparation from the exact retained R5 and Health17 donors.
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,readFileSync,writeFileSync,chmodSync,readdirSync,lstatSync,existsSync,rmSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {inventory} from './prepare-calendar-backend.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
export function replaceUnique(text,old,next){assert.equal(text.split(old).length,2,'Unique reviewed integration seam: '+old.slice(0,100));return text.replace(old,next);}
const reviewedIndexSeams=[
  [
    "import {calendarSourceConsentEnvelope} from '@lifestream/contracts/mobile-context-calendar-source-",
    "import {healthProductionBackendOptions} from './runtime/health-production-composition.ts';\nimport {healthSourceConsentEnvelope} from '@lifestream/contracts/mobile-context-health-source-consent';\nimport {calendarSourceConsentEnvelope} from '@lifestream/contracts/mobile-context-calendar-source-"
  ],
  [
    "import {loadHealthBasicMigrations,loadCalendarBasicMigrations,assertCalendarMigrationInventory} from '@lifestream/storage-sqlite",
    "import {loadHealthBasicMigrations,loadHealthConsentMigrations,assertHealthConsentMigrationInventory,loadCalendarBasicMigrations,assertCalendarMigrationInventory} from '@lifestream/storage-sqlite"
  ],
  [
    "import {healthPolicyOperation,calendarPolicyOperation,calendarSourceConsentOperation} from './runtime/mobile-context-policy-owner-http.ts';\n",
    "import {healthPolicyOperation,calendarPolicyOperation,calendarSourceConsentOperation,healthSourceConsentOperation} from './runtime/mobile-context-policy-owner-http.ts';\n"
  ],
  [
    "ds:number,policy:MobileSourcePolicy|null,ownerOptions?:{finite?:HealthFiniteConfiguration}){this.recovery.journal.enableSources(initialization);if(ownerOptions&&policy){this.healthPolicyOwner=new HealthPolicyOwner(this.database,this.r",
    "ds:number,policy:MobileSourcePolicy|null,ownerOptions?:{finite?:HealthFiniteConfiguration},production?:(import('./runtime/mobile-context-policy-owner.ts').HealthProductionAuthority&{finite?:HealthFiniteConfiguration})){this.recovery.journal.enableSources(initialization);if(production){if(policy||ownerOptions)throw Error('health_production_original_owner_only');this.healthPolicyOwner=new HealthPolicyOwner(this.database,this.recovery.journal,maximumRecords,production.finite,Date.now,'health',production);policy=this.healthPolicyOwner.productionHealthGovernance();}if(ownerOptions&&policy){this.healthPolicyOwner=new HealthPolicyOwner(this.database,this.r"
  ],
  [
    "  private readonly calendarBasicSchemaPlan:boolean;\n",
    "  private readonly healthConsentSchemaPlan:boolean;\n  private readonly calendarBasicSchemaPlan:boolean;\n"
  ],
  [
    "    this.personalPhoneAccess=capturePersonalPhoneAccess(options.personalPhoneAccess);\n",
    "    if(options.mobileContext?.healthProduction)healthProductionBackendOptions({...options.mobileContext.healthProduction,maximumRecordsPerHuman:options.mobileContext.maximumRecordsPerHuman,maximumControlOperationsPerHuman:options.mobileContext.maximumControlOperationsPerHuman!});\n    this.personalPhoneAccess=capturePersonalPhoneAccess(options.personalPhoneAccess);\n"
  ],
  [
    "rPolicySchemaPlan,this.calendarConsentSchemaPlan)}:this.healthBasicSchemaPlan?{migrations:loadHealthBasicMigrations()}:{}) }); if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(this.database,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan);this.migrationRecords = this.database.migrate(); this.presentationPackages = new Present",
    "rPolicySchemaPlan,this.calendarConsentSchemaPlan)}:this.healthBasicSchemaPlan?{migrations:this.healthConsentSchemaPlan?loadHealthConsentMigrations():loadHealthBasicMigrations()}:{}) }); if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(this.database,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan);if(this.healthConsentSchemaPlan)assertHealthConsentMigrationInventory(this.database);this.migrationRecords = this.database.migrate(); this.presentationPackages = new Present"
  ],
  [
    "t.createGovernance?.(this.database,this.localAuth)??null,options.mobileContext.policyOwner),options.mobileContext.maximumRecordsPerHuman,Date.now,options.mobileContext.maximumContr",
    "t.createGovernance?.(this.database,this.localAuth)??null,options.mobileContext.policyOwner,options.mobileContext.healthProduction?{...options.mobileContext.healthProduction,installationId:()=>this.localAuth!.administrators.current().installationId,invalidate:(a,id,reason)=>{if(!a.current())throw Error('health_context_changed');this.invalidateRuntimeInputs('configurationChanged');if(!a.current())throw Error('health_context_changed');},answersAllowed:(a,e,assistant)=>a.current()&&a.recipientAllowed?.(assistant)===true&&this.personalContextAllowed(assistant,a.principalId)&&this.admin.calendarSourceAnswersAllowed(assistant,a.principalId)}:undefined),options.mobileContext.maximumRecordsPerHuman,Date.now,options.mobileContext.maximumContr"
  ],
  [
    "tionInventory(this.database,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan);this.migrationRecords = this.database.migrate(); this.storageReady = true; await new Promi",
    "tionInventory(this.database,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan);if(this.healthConsentSchemaPlan)assertHealthConsentMigrationInventory(this.database);this.migrationRecords = this.database.migrate(); this.storageReady = true; await new Promi"
  ],
  [
    "igest(identity);const input=await readBody(request,healthPolicyLimits.requestBytes);const consent=calendarSourceConsentEnvelope(input)!==null,calendar=consent||calendarPolicyEnvelope(input)!==null,owner=calendar?this.admin.calendarPolicyOwner:this.admin.healthPolicyOwner;if(!owner)return json(response,404,{code:calendar?'calendar_policy_unavailable':'health_policy_unavailable'});const result=(consent?calendarSourceConsentOperation:calendar?calendarPolicyOperation:healthPolicyOperat",
    "igest(identity);const input=await readBody(request,healthPolicyLimits.requestBytes);const healthConsent=healthSourceConsentEnvelope(input)!==null,consent=calendarSourceConsentEnvelope(input)!==null,calendar=consent||calendarPolicyEnvelope(input)!==null,owner=calendar?this.admin.calendarPolicyOwner:this.admin.healthPolicyOwner;if(!owner)return json(response,404,{code:calendar?'calendar_policy_unavailable':'health_policy_unavailable'});const result=(healthConsent?healthSourceConsentOperation:consent?calendarSourceConsentOperation:calendar?calendarPolicyOperation:healthPolicyOperat"
  ],
  [
    "rPolicySchemaPlan,this.calendarConsentSchemaPlan)}:this.healthBasicSchemaPlan?{migrations:loadHealthBasicMigrations()}:{}) }); if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(candidateDatabase,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan);const candidateMigrations = candidateDatabase.migrate(); const candidateMemories = new M",
    "rPolicySchemaPlan,this.calendarConsentSchemaPlan)}:this.healthBasicSchemaPlan?{migrations:this.healthConsentSchemaPlan?loadHealthConsentMigrations():loadHealthBasicMigrations()}:{}) }); if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(candidateDatabase,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan);if(this.healthConsentSchemaPlan)assertHealthConsentMigrationInventory(candidateDatabase);const candidateMigrations = candidateDatabase.migrate(); const candidateMemories = new M"
  ]
];
export function integrateHealthIndex(text){
 for(const [old,next] of reviewedIndexSeams)text=replaceUnique(text,old,next);
 // Retained Daily has its original top-level healthSchemaPlan alias and guard.
 // Extend only the reviewed Health plan portions, preserving that alias/guard.
 text=replaceUnique(text,"mobileSchemaPlan?:'calendar-basic/1'","mobileSchemaPlan?:'health-consent/1'|'calendar-basic/1'");
 text=replaceUnique(text,"schemaPlan?:'health-basic/1'|'calendar-basic/1'","schemaPlan?:'health-basic/1'|'health-consent/1'|'calendar-basic/1'");
 text=replaceUnique(text,"calendarProduction?:{environmentId:string;destinationId:string;finite?:HealthFiniteConfiguration};","healthProduction?:{environmentId:string;destinationId:string;finite?:HealthFiniteConfiguration};calendarProduction?:{environmentId:string;destinationId:string;finite?:HealthFiniteConfiguration};");
 text=replaceUnique(text,"!['health-basic/1','calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(healthPlan)","!['health-basic/1','health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(healthPlan)");
 text=replaceUnique(text,"!['calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(options.mobileSchemaPlan)","!['health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(options.mobileSchemaPlan)");
 text=replaceUnique(text,"this.healthBasicSchemaPlan=healthPlan==='health-basic/1';","this.healthConsentSchemaPlan=healthPlan==='health-consent/1';this.healthBasicSchemaPlan=healthPlan==='health-basic/1'||this.healthConsentSchemaPlan;");
 text=replaceUnique(text,"this.healthBasicSchemaPlan=healthPlan==='health-basic/1'||this.healthConsentSchemaPlan;","this.healthBasicSchemaPlan=healthPlan==='health-basic/1'||this.healthConsentSchemaPlan;"+"\n    if(options.mobileContext?.healthProduction&&(!this.healthConsentSchemaPlan||options.mobileContext.createGovernance||options.mobileContext.policyOwner||options.mobileContext.calendarProduction||options.mobileContext.createCalendarGovernance||options.mobileContext.calendarPolicyOwner||options.mobileContext.sourceSafetyInitialization==='initializeEmpty'||!options.sessionEnvironmentId||options.mobileContext.healthProduction.environmentId!==options.sessionEnvironmentId))throw Error('health_production_profile_required');\n    if(options.mobileContext?.healthProduction)healthProductionBackendOptions({...options.mobileContext.healthProduction,maximumRecordsPerHuman:options.mobileContext.maximumRecordsPerHuman,maximumControlOperationsPerHuman:options.mobileContext.maximumControlOperationsPerHuman!});\n    ");
 // Retained R5 has a legacy Health-basic route whitelist absent from the
 // reviewed Health17 baseline. Keep it on every old plan; the new explicit
 // Health consent plan must reach the reviewed original producer parser.
 text=replaceUnique(text,"if(!this.calendarBasicSchemaPlan&&(!input||typeof input!=='object'", "if(!this.calendarBasicSchemaPlan&&!this.healthConsentSchemaPlan&&(!input||typeof input!=='object'");
 return text;
}
/** Apply only combined factory seams to the retained Daily alias/guards. */
export function integrateMobileSourceIndex(text){
 text=replaceUnique(text,"import {healthProductionBackendOptions}","import {readMobileSourceSchemaPlan,captureMobileSourceProductionOptions,assertMobileSourceConsentMigrationInventory} from './runtime/mobile-source-production-composition.ts';\nimport {healthProductionBackendOptions}");
 text=replaceUnique(text,"mobileSchemaPlan?:'health-consent/1'|","mobileSchemaPlan?:'mobile-source-consent/1'|'health-consent/1'|");
 text=replaceUnique(text,"schemaPlan?:'health-basic/1'|'health-consent/1'|","schemaPlan?:'health-basic/1'|'health-consent/1'|'mobile-source-consent/1'|");
 text=replaceUnique(text,'  private readonly healthConsentSchemaPlan:boolean;','  private readonly healthConsentSchemaPlan:boolean;\n  private readonly mobileSourceConsentSchemaPlan:boolean;');
 text=replaceUnique(text,"['health-basic/1','health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1']","['health-basic/1','health-consent/1','mobile-source-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1']");
 text=replaceUnique(text,"['health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1']","['health-consent/1','mobile-source-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1']");
 text=replaceUnique(text,"this.healthConsentSchemaPlan=healthPlan==='health-consent/1';","this.mobileSourceConsentSchemaPlan=healthPlan==='mobile-source-consent/1';\n    if(this.mobileSourceConsentSchemaPlan&&options.mobileContext!==undefined)options={...options,mobileContext:captureMobileSourceProductionOptions(options.mobileContext,options.sessionEnvironmentId)};\n    this.healthConsentSchemaPlan=healthPlan==='health-consent/1';");
 text=replaceUnique(text,'(!this.healthConsentSchemaPlan||options.mobileContext.createGovernance','(!this.healthConsentSchemaPlan&&!this.mobileSourceConsentSchemaPlan||options.mobileContext.createGovernance');
 text=replaceUnique(text,'||options.mobileContext.calendarProduction||options.mobileContext.createCalendarGovernance','||!this.mobileSourceConsentSchemaPlan&&options.mobileContext.calendarProduction||options.mobileContext.createCalendarGovernance');
 text=replaceUnique(text,"this.calendarConsentSchemaPlan=healthPlan==='calendar-consent/1';","this.calendarConsentSchemaPlan=healthPlan==='calendar-consent/1'||this.mobileSourceConsentSchemaPlan;");
 const old='if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(this.database,';assert.equal(text.split(old).length,3);text=text.replaceAll(old,'if(this.mobileSourceConsentSchemaPlan)assertMobileSourceConsentMigrationInventory(this.database);else '+old);
 text=replaceUnique(text,'if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(candidateDatabase,','if(this.mobileSourceConsentSchemaPlan)assertMobileSourceConsentMigrationInventory(candidateDatabase);else if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(candidateDatabase,');
 text=replaceUnique(text,"const healthPlan=options.mobileSchemaPlan??options.healthSchemaPlan??options.mobileContext?.schemaPlan;","const mobileContextSchemaPlan=readMobileSourceSchemaPlan(options.mobileContext);\n    const healthPlan=options.mobileSchemaPlan??options.healthSchemaPlan??mobileContextSchemaPlan;");
 text=replaceUnique(text,'options.mobileContext?.schemaPlan!==undefined&&healthPlan!==options.mobileContext.schemaPlan','mobileContextSchemaPlan!==undefined&&healthPlan!==mobileContextSchemaPlan');
 return text;
}
/** Add only the registered control plan to the original retained factory. */
export function integrateMobileSourceControlIndex(text){
 text=replaceUnique(text,'readMobileSourceSchemaPlan,captureMobileSourceProductionOptions,assertMobileSourceConsentMigrationInventory','readMobileSourceSchemaPlan,captureMobileSourceProductionOptions,captureMobileSourceControlProductionOptions,assertMobileSourceConsentMigrationInventory');
 text="import {loadMobileSourceControlMigrations,assertMobileSourceControlMigrationInventory} from '@lifestream/storage-sqlite';\n"+text;
 for(const old of ["'mobile-source-consent/1'|","'mobile-source-consent/1','calendar-basic/1'"]){const count=text.split(old).length-1;assert.equal(count,2,'Exact plan union/list seams');text=text.replaceAll(old,old==="'mobile-source-consent/1'|"?"'mobile-source-consent/1'|'mobile-source-control/1'|":"'mobile-source-consent/1','mobile-source-control/1','calendar-basic/1'");}
 text=replaceUnique(text,'private readonly mobileSourceConsentSchemaPlan:boolean;','private readonly mobileSourceConsentSchemaPlan:boolean;\n  private readonly mobileSourceControlSchemaPlan:boolean;');
 text=replaceUnique(text,"this.mobileSourceConsentSchemaPlan=healthPlan==='mobile-source-consent/1';","this.mobileSourceControlSchemaPlan=healthPlan==='mobile-source-control/1';\n    this.mobileSourceConsentSchemaPlan=healthPlan==='mobile-source-consent/1';\n    if(this.mobileSourceControlSchemaPlan&&options.mobileContext!==undefined)options={...options,mobileContext:captureMobileSourceControlProductionOptions(options.mobileContext,options.sessionEnvironmentId)};");
 text=replaceUnique(text,'!this.healthConsentSchemaPlan&&!this.mobileSourceConsentSchemaPlan','!this.healthConsentSchemaPlan&&!this.mobileSourceConsentSchemaPlan&&!this.mobileSourceControlSchemaPlan');
 text=replaceUnique(text,'!this.mobileSourceConsentSchemaPlan&&options.mobileContext.calendarProduction','!this.mobileSourceConsentSchemaPlan&&!this.mobileSourceControlSchemaPlan&&options.mobileContext.calendarProduction');
 text=replaceUnique(text,"healthPlan==='calendar-consent/1'||this.mobileSourceConsentSchemaPlan;","healthPlan==='calendar-consent/1'||this.mobileSourceConsentSchemaPlan||this.mobileSourceControlSchemaPlan;");
 const migration='...(this.calendarBasicSchemaPlan?{migrations:';assert.equal(text.split(migration).length,3);text=text.replaceAll(migration,'...(this.mobileSourceControlSchemaPlan?{migrations:loadMobileSourceControlMigrations()}:this.calendarBasicSchemaPlan?{migrations:');
 const check='if(this.mobileSourceConsentSchemaPlan)assertMobileSourceConsentMigrationInventory(this.database);';assert.equal(text.split(check).length,3);text=text.replaceAll(check,'if(this.mobileSourceControlSchemaPlan)assertMobileSourceControlMigrationInventory(this.database);else '+check);
 text=replaceUnique(text,'if(this.mobileSourceConsentSchemaPlan)assertMobileSourceConsentMigrationInventory(candidateDatabase);','if(this.mobileSourceControlSchemaPlan)assertMobileSourceControlMigrationInventory(candidateDatabase);else if(this.mobileSourceConsentSchemaPlan)assertMobileSourceConsentMigrationInventory(candidateDatabase);');
 return text;
}
/** Closed data configuration only; real environment is supplied later by the
 * original ownership marker. This module never creates a policy or SDK grant. */
export function sourceProfileSelectionModule(mode){
 assert(['candidate','recovery'].includes(mode));
 return `import assert from 'node:assert/strict';
import {types} from 'node:util';
import {createHash} from 'node:crypto';
import {unifiedDesktopSnapshot} from '../backend/packages/contracts/src/unified-desktop-contracts.ts';
import {healthProductionBackendOptions} from '../backend/apps/server/src/runtime/health-production-composition.ts';
import {calendarProductionBackendOptions} from '../backend/apps/server/src/runtime/calendar-production-composition.ts';
import {mobileSourceProductionBackendOptions} from '../backend/apps/server/src/runtime/mobile-source-production-composition.ts';
const releaseMode=${JSON.stringify(mode)},profileKeys=['calendarSourceProfile','healthSourceProfile','mobileSourceProfile'];
function data(v,seen=new Set()){
 if(v===null||typeof v!=='object')return v===null||['string','number','boolean'].includes(typeof v);
 if(types.isProxy(v)||seen.has(v)||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
 seen.add(v);return Reflect.ownKeys(v).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>Object.hasOwn(d,'value')&&data(d.value,seen));
}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function clone(v){assert(data(v),'Source configuration must contain plain JSON data only');const p=unifiedDesktopSnapshot(v,8192);assert(p&&typeof p==='object'&&!Array.isArray(p),'Bounded JSON object required');return freeze(p);}
function keys(p,expected){assert(p&&typeof p==='object'&&!Array.isArray(p));assert.equal(Object.keys(p).sort().join(','),expected.slice().sort().join(','),'Closed original operational profile fields required');}
// Structural validation only: no invented environment is passed to a producer.
// Original helpers validate the actual captured environment/profile at selection.
function operational(p){
 keys(p,['destinationId','maximumRecordsPerHuman','maximumControlOperationsPerHuman',...(Object.hasOwn(p,'finite')?['finite']:[])]);
 assert(typeof p.destinationId==='string'&&p.destinationId.length>=1&&p.destinationId.length<=256);
 for(const k of ['maximumRecordsPerHuman','maximumControlOperationsPerHuman'])assert(Number.isSafeInteger(p[k])&&p[k]>=1&&p[k]<=100000);
 if(Object.hasOwn(p,'finite')){const f=p.finite;keys(f,['allowedAnchors','allowedDurationDays']);assert(Array.isArray(f.allowedAnchors)&&f.allowedAnchors.length&&new Set(f.allowedAnchors).size===f.allowedAnchors.length&&f.allowedAnchors.every(x=>['sourceEnd','firstAuthoritativeImport'].includes(x)));assert(Array.isArray(f.allowedDurationDays)&&f.allowedDurationDays.length&&new Set(f.allowedDurationDays).size===f.allowedDurationDays.length&&f.allowedDurationDays.every(x=>Number.isSafeInteger(x)&&x>0));}
 return p;
}
function selection(value){
 const present=profileKeys.filter(k=>Object.hasOwn(value,k));assert(present.length<=1,'Exactly one explicit source profile may be selected');
 if(releaseMode==='recovery')assert.equal(present.length,0,'Recovery refuses all production profiles');
 if(!present.length)return {kind:'none',profile:null};
 const key=present[0],kind=key==='healthSourceProfile'?'health':key==='calendarSourceProfile'?'calendar':'combined';
 assert.equal(value.mobileSchemaPlan,kind==='health'?'health-consent/1':kind==='calendar'?'calendar-consent/1':'mobile-source-consent/1','Explicit matching profile schema plan required');
 const p=value[key];if(kind==='combined'){keys(p,['health','calendar']);operational(p.health);operational(p.calendar);for(const k of ['destinationId','maximumRecordsPerHuman','maximumControlOperationsPerHuman'])assert.equal(p.health[k],p.calendar[k],'Shared original scope and repository bounds required');}else operational(p);
 return {kind,profile:p};
}
export function captureSourceDeployment(value){const p=clone(value);selection(p);return p;}
export function sourceProfileKind(value){return selection(captureSourceDeployment(value)).kind;}
export function sourceProductionLaunchOptions(value,environmentId){
 const captured=selection(captureSourceDeployment(value));if(captured.kind==='none')return {};
 assert(typeof environmentId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(environmentId),'Original ownership-marker environment required');
 const profile=captured.profile;
 const mobileContext=captured.kind==='combined'?mobileSourceProductionBackendOptions({health:{...profile.health,environmentId},calendar:{...profile.calendar,environmentId}}):captured.kind==='health'?healthProductionBackendOptions({...profile,environmentId}):calendarProductionBackendOptions({...profile,environmentId});
 assert(mobileContext&&mobileContext.sourceSafetyInitialization==='requireExisting');return freeze({mobileContext});
}
function canonical(v){return Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);}
export function sourceCodeAdoption(plan,value,originalMigrationIdentity){
 const p=captureSourceDeployment(value),chosen=selection(p);if(chosen.kind!=='none')assert.equal(plan,p.mobileSchemaPlan);
 assert.match(originalMigrationIdentity,/^[a-f0-9]{64}$/);
 const migrationIdentitySha256=createHash('sha256').update(canonical({schemaPlan:plan??'default77',sourceAvailability:chosen.kind,profile:chosen.profile,originalMigrationIdentity,releaseMode})).digest('hex');
 return Object.freeze({schemaVersion:'canonical-code-adoption-source-profile-capable:1.0.0',migrationIdentitySha256,sourceProfileKind:chosen.kind});
}
`;
}
function put(path,bytes){mkdirSync(dirname(path),{recursive:true,mode:0o700});if(existsSync(path))chmodSync(path,0o600);writeFileSync(path,bytes,{mode:0o600});}
function writableDirectories(root){for(const n of readdirSync(root)){const p=join(root,n),st=lstatSync(p);if(st.isDirectory()){chmodSync(p,0o700);writableDirectories(p);}else if(st.isFile()&&(p.includes('/dist/')||p.endsWith('/tsconfig.tsbuildinfo')))chmodSync(p,0o600);}}
const basePins={candidate:'5c1f27828a4c1fed973e49d7ecba90603730eb8382da49e4104f273b05bb6fe4',recovery:'b32e60ebd400bea01a641d66ebcbc896f5334e0782da55d1e150004494c39bea'};
function verifyDonor(root,expected){const bytes=readFileSync(join(root,'prepared-source-manifest.json'));assert.equal(sha(bytes),expected);const m=JSON.parse(bytes),actual=inventory(root);delete actual['prepared-source-manifest.json'];assert.deepEqual(actual,Object.fromEntries(m.files.map(({path,...v})=>[path,v])),'Exact complete retained donor required');return inventory(root);}
export async function prepareHealthSourceBackend({base,reviewed,closure,output,tsc,node=process.execPath,composition,compositionManifestSha256,profileSource,profileSourceManifestSha256,controlSource,controlSourceManifestSha256}){
 for(const p of [base,reviewed,closure,output,tsc])assert(typeof p==='string'&&resolve(p)===p,'Explicit absolute inputs required');
 assert(!output.startsWith('/srv/lifestream/deployment/')&&!existsSync(output),'Fresh isolated workspace output required');
 assert(output.startsWith('/srv/lifestream/workspace/')&&!base.startsWith(output+'/')&&!reviewed.startsWith(output+'/'));
 const cb=readFileSync(closure);assert.equal(sha(cb),'d0e4ed2a5bf73015e205e965365de03e6a4d5bd5009a7cd965dff1892c6b250b');const classes=JSON.parse(cb).actualReviewed17InputClasses;
 const mb=readFileSync(join(reviewed,'CANDIDATE-MANIFEST.json'));assert.equal(sha(mb),'7ed6188410de966b385a18c4b55751304dbe36962255aa89b3cf45172643c3c3');
 const manifest=JSON.parse(mb),sourceHashes={};
 for(const [p,v] of Object.entries(manifest.exactRegistered17Paths)){const b=readFileSync(join(reviewed,'source',p));assert.equal(sha(b),v.sha256);sourceHashes[p]=v.sha256;assert.equal(classes[p].reviewedAfterSHA256,v.sha256);}
 let controlSourceHashes,controlMetadataSQL;
 if(controlSource!==undefined){
  assert(profileSource!==undefined&&resolve(controlSource)===controlSource&&/^[a-f0-9]{64}$/.test(controlSourceManifestSha256),'Explicit control closure plus immutable launcher input required');
  const bytes=readFileSync(join(controlSource,'CANDIDATE-MANIFEST.json'));assert.equal(sha(bytes),controlSourceManifestSha256);const m=JSON.parse(bytes);
  assert.equal(m.scope.sha256,'fb7d219a33b597660c0d65ad72790c2ad2e76ffcdf949a09c9818e173154ed4f');
  const expected=['packages/storage-sqlite/src/index.ts','apps/server/src/index.ts','apps/server/src/runtime/mobile-source-production-composition.ts','apps/server/test/mobile-source-production-consent.test.ts','scripts/prepare-health-source-backend.mjs','scripts/health-source-schema-compatibility.mjs','scripts/health-source-backend-preparation.test.mjs','packages/storage-sqlite/src/mobile-source-control-migrations.ts'];
  assert.deepEqual(Object.keys(m.exactRegisteredEightPaths).sort(),expected.sort());controlSourceHashes={};for(const [path,v]of Object.entries(m.exactRegisteredEightPaths)){assert.equal(sha(readFileSync(join(controlSource,'source',path))),v.sha256);controlSourceHashes[path]=v.sha256;}
  assert.equal(sha(readFileSync(fileURLToPath(import.meta.url))),controlSourceHashes['scripts/prepare-health-source-backend.mjs'],'Execute exact bound control builder');
  assert.equal(profileSourceManifestSha256,'b2426f1e3899a47b812d3fb876d8924682b0691e0b5936ba9554916c12566322');
  assert.equal(m.originalMetadataSQL.sha256,'8701cc4499d774eddf289c27856a423f739c695707926737e14c0e804245f826');controlMetadataSQL=readFileSync(m.originalMetadataSQL.path);assert.equal(sha(controlMetadataSQL),m.originalMetadataSQL.sha256);
 }
 let profileSourceHashes;
 if(profileSource!==undefined){
  assert(composition!==undefined&&resolve(profileSource)===profileSource&&/^[a-f0-9]{64}$/.test(profileSourceManifestSha256),'Explicit combined closure and new profile source binding required');
  const bytes=readFileSync(join(profileSource,'CANDIDATE-MANIFEST.json'));assert.equal(sha(bytes),profileSourceManifestSha256);const p=JSON.parse(bytes);assert.equal(p.scope.sha256,'18a174f0000765252c4b4b02b398737198b430a9d529440eb2563ab5bdeafdbd');assert.deepEqual(Object.keys(p.exactRegisteredTwoPaths).sort(),['scripts/prepare-health-source-backend.mjs','apps/server/test/mobile-source-production-consent.test.ts'].sort());profileSourceHashes={};
  for(const [path,v]of Object.entries(p.exactRegisteredTwoPaths)){assert.equal(sha(readFileSync(join(profileSource,'source',path))),v.sha256);profileSourceHashes[path]=v.sha256;}
  if(!controlSourceHashes)assert.equal(sha(readFileSync(fileURLToPath(import.meta.url))),profileSourceHashes['scripts/prepare-health-source-backend.mjs'],'Execute the separately hash-bound new profile builder');
  assert.equal(compositionManifestSha256,'3fedb656a335ad09d00e19d50f0954266b72222fea23e7fb5e698db03c749229','Reviewed original combined R2 factory closure required');
 }
 let combinedSourceHashes;
 if(composition!==undefined){
  assert(resolve(composition)===composition&&/^[a-f0-9]{64}$/.test(compositionManifestSha256),'Explicit hash-bound frozen composition input required');
  const bytes=readFileSync(join(composition,'CANDIDATE-MANIFEST.json'));assert.equal(sha(bytes),compositionManifestSha256);const combined=JSON.parse(bytes);
  const expected=['apps/server/src/index.ts','apps/server/src/runtime/mobile-source-production-composition.ts','apps/server/test/mobile-source-production-consent.test.ts','scripts/prepare-health-source-backend.mjs'];assert.deepEqual(Object.keys(combined.exactRegisteredFourPaths).sort(),expected.sort());combinedSourceHashes={};
  for(const [p,v] of Object.entries(combined.exactRegisteredFourPaths)){const bytes=readFileSync(join(composition,'source',p));assert.equal(sha(bytes),v.sha256);combinedSourceHashes[p]=v.sha256;}
  if(!profileSourceHashes)assert.equal(sha(readFileSync(fileURLToPath(import.meta.url))),combinedSourceHashes['scripts/prepare-health-source-backend.mjs'],'Execute the exact bound composition builder');
 }
 const before=Object.fromEntries(Object.entries(basePins).map(([mode,pin])=>[mode,verifyDonor(join(base,mode),pin)]));
 mkdirSync(output,{mode:0o700});const result={status:'preparedSourceOnlyNotArtifactQualified',activationPerformed:false,healthCollectionConfigured:false,fullStartupQualified:false,originalAdoptionProvenanceRequired:true,...(controlSourceHashes?{controlSourceManifestSha256,controlSourceHashes,explicitControlPlan:'mobile-source-control/1'}:{}),...(profileSourceHashes?{profileSourceManifestSha256,profileSourceHashes,profileAvailabilityMode:true}:{}),...(combinedSourceHashes?{compositionManifestSha256,combinedSourceHashes}:{}),modes:{}};
 for(const mode of ['candidate','recovery']){
  const root=join(output,mode),backend=join(root,'backend');cpSync(join(base,mode),root,{recursive:true,dereference:false,verbatimSymlinks:true});chmodSync(root,0o700);writableDirectories(root);assert.deepEqual(inventory(root),before[mode],'Exact isolated donor copy required');
  for(const [p,v] of Object.entries(manifest.exactRegistered17Paths)){
   if(['apps/server/src/index.ts','packages/contracts/package.json','packages/storage-sqlite/src/index.ts'].includes(p))continue;
   const c=classes[p];if(c.copyRule==='unchanged dependency: retain R5')continue;
   if(c.retainedR5Present)assert.equal(sha(readFileSync(join(backend,p))),c.retainedR5SHA256);
   put(join(backend,p),readFileSync(join(reviewed,'source',p)));
  }
  const index=join(backend,'apps/server/src/index.ts');assert.equal(sha(readFileSync(index)),classes['apps/server/src/index.ts'].retainedR5SHA256);const healthIndex=integrateHealthIndex(readFileSync(index,'utf8'));let composedIndex=combinedSourceHashes?integrateMobileSourceIndex(healthIndex):healthIndex;if(controlSourceHashes)composedIndex=integrateMobileSourceControlIndex(composedIndex);put(index,composedIndex);
  if(combinedSourceHashes)for(const p of ['apps/server/src/runtime/mobile-source-production-composition.ts','apps/server/test/mobile-source-production-consent.test.ts'])put(join(backend,p),readFileSync(join(composition,'source',p)));
  if(profileSourceHashes)put(join(backend,'apps/server/test/mobile-source-production-consent.test.ts'),readFileSync(join(profileSource,'source/apps/server/test/mobile-source-production-consent.test.ts')));
  const storage=join(backend,'packages/storage-sqlite/src/index.ts');assert.equal(sha(readFileSync(storage)),classes['packages/storage-sqlite/src/index.ts'].retainedR5SHA256);put(storage,readFileSync(storage,'utf8')+"\nexport {loadHealthConsentMigrations,assertHealthConsentMigrationInventory} from './mobile-health-migrations.ts';\n");
  if(controlSourceHashes){
   put(join(backend,'packages/storage-sqlite/src/migrations/0085_mobile_context_interpretation.sql'),controlMetadataSQL);
   for(const path of ['apps/server/src/runtime/mobile-source-production-composition.ts','apps/server/test/mobile-source-production-consent.test.ts','packages/storage-sqlite/src/mobile-source-control-migrations.ts'])put(join(backend,path),readFileSync(join(controlSource,'source',path)));
   put(storage,readFileSync(storage,'utf8')+"\nexport {loadMobileSourceControlMigrations,assertMobileSourceControlMigrationInventory} from './mobile-source-control-migrations.ts';\n");
  }
  const pkg=join(backend,'packages/contracts/package.json');assert.equal(sha(readFileSync(pkg)),classes['packages/contracts/package.json'].retainedR5SHA256);put(pkg,replaceUnique(readFileSync(pkg,'utf8'),'"./mobile-context-calendar-source-consent": "./dist/mobile-context-calendar-source-consent.js"','"./mobile-context-calendar-source-consent": "./dist/mobile-context-calendar-source-consent.js",\n    "./mobile-context-health-source-consent": "./dist/mobile-context-health-source-consent.js"'));
  put(join(root,'launch/health-source-schema-compatibility.mjs'),readFileSync(controlSourceHashes?join(controlSource,'source/scripts/health-source-schema-compatibility.mjs'):join(HERE,'health-source-schema-compatibility.mjs')));
  put(join(root,'launch/health-source-schema-installed.mjs'),`import {fileURLToPath} from 'node:url';
import {loadInstalledHealthSourceChecker,selectSourceSchemaPlan,HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256} from './health-source-schema-compatibility.mjs';
import * as calendar from './calendar-schema-compatibility.mjs';
import {MIGRATION_IDENTITY_SHA256 as baseIdentity} from './schema77-compatibility.mjs';
export {selectSourceSchemaPlan};
export const assertCompatibleSchema=await loadInstalledHealthSourceChecker(fileURLToPath(new URL('../',import.meta.url)));
export function identityForPlan(plan){switch(plan){case undefined:return baseIdentity;case'health-consent/1':return HEALTH_CONSENT_MIGRATION_IDENTITY_SHA256;case'calendar-consent/1':return calendar.CONSENT_MIGRATION_IDENTITY_SHA256;case'calendar-policy/1':return calendar.POLICY_MIGRATION_IDENTITY_SHA256;case'calendar-basic/1':return calendar.MIGRATION_IDENTITY_SHA256;default:throw Error('unknown_source_plan');}}
export function adoptionVersion(plan){return plan==='health-consent/1'?'canonical-code-adoption-health-source-inactive:1.0.0':'canonical-code-adoption-calendar-disabled:1.0.0';}
`);
  if(combinedSourceHashes){
   const installed=join(root,'launch/health-source-schema-installed.mjs');let wrapper=readFileSync(installed,'utf8');
   wrapper="import assert from 'node:assert/strict';\nimport {createHash} from 'node:crypto';\n"+wrapper;
   wrapper=replaceUnique(wrapper,'loadInstalledHealthSourceChecker,selectSourceSchemaPlan,','loadInstalledHealthSourceChecker,selectSourceSchemaPlan as selectPriorSourceSchemaPlan,');
   wrapper=replaceUnique(wrapper,'export {selectSourceSchemaPlan};',"export function selectSourceSchemaPlan(initial,explicit){if(explicit==='mobile-source-consent/1'){assert(initial.schema===77||initial.healthConsentSchema===true||initial.calendarSchema===true,'Known exact original inventory required');return explicit;}return selectPriorSourceSchemaPlan(initial,explicit);}");
   wrapper=replaceUnique(wrapper,'export function identityForPlan(plan){switch(plan){',"const combinedIdentity=createHash('sha256').update(JSON.stringify({schemaPlan:'mobile-source-consent/1',owners:['health','calendar'],migrationIdentitySha256:calendar.CONSENT_MIGRATION_IDENTITY_SHA256})).digest('hex');\nexport function identityForPlan(plan){switch(plan){case'mobile-source-consent/1':return combinedIdentity;");
   wrapper=replaceUnique(wrapper,"return plan==='health-consent/1'?", "return plan==='mobile-source-consent/1'?'canonical-code-adoption-mobile-source-inactive:1.0.0':plan==='health-consent/1'?");put(installed,wrapper);
  }
  if(controlSourceHashes){
   const installed=join(root,'launch/health-source-schema-installed.mjs');let wrapper=readFileSync(installed,'utf8');
   wrapper="import {loadInstalledMobileSourceControlChecker,selectMobileSourceControlSchemaPlan,MOBILE_SOURCE_CONTROL_MIGRATION_IDENTITY_SHA256} from './health-source-schema-compatibility.mjs';\n"+wrapper;
   const from=wrapper.indexOf('export function selectSourceSchemaPlan('),to=wrapper.indexOf('export const assertCompatibleSchema=',from);assert(from>=0&&to>from);wrapper=wrapper.slice(0,from)+'export const selectSourceSchemaPlan=selectMobileSourceControlSchemaPlan;\n'+wrapper.slice(to);
   wrapper=replaceUnique(wrapper,'await loadInstalledHealthSourceChecker(', 'await loadInstalledMobileSourceControlChecker(');
   wrapper=replaceUnique(wrapper,'export function identityForPlan(plan){switch(plan){',"export function identityForPlan(plan){switch(plan){case'mobile-source-control/1':return MOBILE_SOURCE_CONTROL_MIGRATION_IDENTITY_SHA256;");
   wrapper=replaceUnique(wrapper,"return plan==='mobile-source-consent/1'?","return plan==='mobile-source-control/1'?'canonical-code-adoption-mobile-source-control-inactive:1.0.0':plan==='mobile-source-consent/1'?");put(installed,wrapper);
  }
  const id=(controlSourceHashes?'canonical-daily-source-control-capable-':profileSourceHashes?'canonical-daily-source-profile-capable-':combinedSourceHashes?'canonical-daily-mobile-source-inactive-':'canonical-daily-health-source-inactive-')+mode+'-20261104-r1';
  const configPath=join(root,'launch/real-configuration.mjs');let config=readFileSync(configPath,'utf8');config=config.replace(/^export const candidateId=.*;$/m,'export const candidateId='+JSON.stringify(id)+';');
  config=replaceUnique(config,"['calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(value.mobileSchemaPlan)","['health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(value.mobileSchemaPlan)");if(combinedSourceHashes)config=replaceUnique(config,"['health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(value.mobileSchemaPlan)","['mobile-source-consent/1','health-consent/1','calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(value.mobileSchemaPlan)");if(controlSourceHashes)config=replaceUnique(config,"['mobile-source-consent/1','health-consent/1'","['mobile-source-control/1','mobile-source-consent/1','health-consent/1'");put(configPath,config);
  const release=join(root,'launch/calendar-release-mode.mjs');let rel=readFileSync(release,'utf8');rel=replaceUnique(rel,"assert.equal(value.schemaVersion,'canonical-code-adoption-calendar-disabled:1.0.0')","assert(['canonical-code-adoption-calendar-disabled:1.0.0','canonical-code-adoption-health-source-inactive:1.0.0'].includes(expected.schemaVersion));assert.equal(value.schemaVersion,expected.schemaVersion)");if(combinedSourceHashes)rel=replaceUnique(rel,"'canonical-code-adoption-health-source-inactive:1.0.0'].includes(expected.schemaVersion)","'canonical-code-adoption-health-source-inactive:1.0.0','canonical-code-adoption-mobile-source-inactive:1.0.0'].includes(expected.schemaVersion)");put(release,rel);
  const launchPath=join(root,'launch/start-canonical.mjs');let launch=readFileSync(launchPath,'utf8');
  launch=replaceUnique(launch,"import {assertCompatibleSchema,MIGRATION_IDENTITY_SHA256} from './calendar-schema-installed.mjs';","import {assertCompatibleSchema,selectSourceSchemaPlan,identityForPlan,adoptionVersion} from './health-source-schema-installed.mjs';");
  launch=replaceUnique(launch,"const selectedCalendarPlan=initialHealthSchema.calendarSchema||['calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(deployment.mobileSchemaPlan);","const selectedPlan=selectSourceSchemaPlan(initialHealthSchema,deployment.mobileSchemaPlan);const MIGRATION_IDENTITY_SHA256=identityForPlan(selectedPlan);const selectedAdoptionVersion=adoptionVersion(selectedPlan);");
  launch=replaceUnique(launch,"const selectedSchema=initialHealthSchema.calendarConsentSchema||deployment.mobileSchemaPlan==='calendar-consent/1'?90:selectedCalendarPlan?89:77;","const selectedSchema=['health-consent/1','calendar-consent/1'].includes(selectedPlan)?90:selectedPlan?89:77;");
  launch=replaceUnique(launch,"...(selectedCalendarPlan?{mobileSchemaPlan:initialHealthSchema.calendarConsentSchema||deployment.mobileSchemaPlan==='calendar-consent/1'?'calendar-consent/1':initialHealthSchema.calendarPolicySchema||deployment.mobileSchemaPlan==='calendar-policy/1'?'calendar-policy/1':'calendar-basic/1'}:{})","...(selectedPlan?{mobileSchemaPlan:selectedPlan}:{})");
  launch=replaceUnique(launch,"validateHealthCodeAdoption(codeAdoption,{candidateId,","validateHealthCodeAdoption(codeAdoption,{schemaVersion:selectedAdoptionVersion,candidateId,");
  launch=replaceUnique(launch,"schemaVersion:'canonical-code-adoption-calendar-disabled:1.0.0',candidateId","schemaVersion:selectedAdoptionVersion,candidateId");if(combinedSourceHashes)launch=replaceUnique(launch,"['health-consent/1','calendar-consent/1'].includes(selectedPlan)","['mobile-source-consent/1','health-consent/1','calendar-consent/1'].includes(selectedPlan)");if(controlSourceHashes)launch=replaceUnique(launch,"['mobile-source-consent/1','health-consent/1'","['mobile-source-control/1','mobile-source-consent/1','health-consent/1'");put(launchPath,launch);
  if(profileSourceHashes){
   let selectionModule=sourceProfileSelectionModule(mode);
   if(controlSourceHashes){selectionModule=replaceUnique(selectionModule,'{mobileSourceProductionBackendOptions}', '{mobileSourceProductionBackendOptions,mobileSourceControlProductionBackendOptions}');selectionModule=replaceUnique(selectionModule,"kind==='calendar'?'calendar-consent/1':'mobile-source-consent/1'","kind==='calendar'?'calendar-consent/1':value.mobileSchemaPlan==='mobile-source-control/1'?'mobile-source-control/1':'mobile-source-consent/1'");selectionModule=replaceUnique(selectionModule,"captured.kind==='combined'?mobileSourceProductionBackendOptions(","captured.kind==='combined'?(value.mobileSchemaPlan==='mobile-source-control/1'?mobileSourceControlProductionBackendOptions:mobileSourceProductionBackendOptions)(");selectionModule=replaceUnique(selectionModule,'canonical-code-adoption-source-profile-capable:1.0.0','canonical-code-adoption-source-control-capable:1.0.0');}
   put(join(root,'launch/source-production-selection.mjs'),selectionModule);
   let config=readFileSync(configPath,'utf8');config="import {captureSourceDeployment} from './source-production-selection.mjs';\n"+config;config=replaceUnique(config,'export function validateDeployment(value){','export function validateDeployment(value){\n value=captureSourceDeployment(value);');config=replaceUnique(config,"+(Object.hasOwn(value,'calendarSourceProfile')?',calendarSourceProfile':'')","+(Object.hasOwn(value,'calendarSourceProfile')?',calendarSourceProfile':'')+(Object.hasOwn(value,'healthSourceProfile')?',healthSourceProfile':'')+(Object.hasOwn(value,'mobileSourceProfile')?',mobileSourceProfile':'')");put(configPath,config);
   let launch=readFileSync(launchPath,'utf8');launch="import {sourceProductionLaunchOptions,sourceCodeAdoption,sourceProfileKind} from './source-production-selection.mjs';\n"+launch;launch=replaceUnique(launch,'const MIGRATION_IDENTITY_SHA256=identityForPlan(selectedPlan);const selectedAdoptionVersion=adoptionVersion(selectedPlan);','const selectedSourceAdoption=sourceCodeAdoption(selectedPlan,deployment,identityForPlan(selectedPlan));const MIGRATION_IDENTITY_SHA256=selectedSourceAdoption.migrationIdentitySha256;const selectedAdoptionVersion=selectedSourceAdoption.schemaVersion;');launch=replaceUnique(launch,'...calendarProductionLaunchOptions(deployment,marker.sessionEnvironmentId),','...sourceProductionLaunchOptions(deployment,marker.sessionEnvironmentId),');launch=replaceUnique(launch,'hardwareSourcesComposed:false,healthReleaseMode,healthCollectionConfigured:false','hardwareSourcesComposed:false,healthReleaseMode,sourceProfileAvailability:sourceProfileKind(deployment),sourceSDKAccessVerified:false');put(launchPath,launch);
   let releaseText=readFileSync(release,'utf8');releaseText=replaceUnique(releaseText,"'canonical-code-adoption-mobile-source-inactive:1.0.0'].includes(expected.schemaVersion)","'canonical-code-adoption-mobile-source-inactive:1.0.0','canonical-code-adoption-source-profile-capable:1.0.0'].includes(expected.schemaVersion)");if(controlSourceHashes)releaseText=replaceUnique(releaseText,"'canonical-code-adoption-source-profile-capable:1.0.0'].includes(expected.schemaVersion)","'canonical-code-adoption-source-profile-capable:1.0.0','canonical-code-adoption-source-control-capable:1.0.0'].includes(expected.schemaVersion)");put(release,releaseText);
  }
  // Ownership checks use the new exact inventory reader, with their original
  // ownership families and comparison code otherwise byte-for-byte retained.
  const ownership=join(root,'launch/ownership-metadata.mjs');put(ownership,replaceUnique(readFileSync(ownership,'utf8'),"from './calendar-schema-installed.mjs'","from './health-source-schema-installed.mjs'"));
  const build=execFileSync(node,[tsc,'-b','apps/server','--force','--pretty','false'],{cwd:backend,encoding:'utf8',maxBuffer:8*1024*1024});put(join(output,mode+'-build.log'),build);
  for(const directory of ['packages/contracts/src/schemas','packages/storage-sqlite/src/migrations'])for(const n of readdirSync(join(backend,directory)).filter(n=>directory.endsWith('schemas')?n.endsWith('.json'):n.endsWith('.sql')))put(join(backend,directory.replace('/src/','/dist/'),n),readFileSync(join(backend,directory,n)));
  const after=inventory(root),changes=Object.keys(after).filter(p=>JSON.stringify(after[p])!==JSON.stringify(before[mode][p]));assert.deepEqual(Object.keys(before[mode]).filter(p=>!Object.hasOwn(after,p)),[]);
  const allowedSources=new Set([...(controlSourceHashes?['packages/storage-sqlite/src/migrations/0085_mobile_context_interpretation.sql']:[]),...Object.keys(sourceHashes),...Object.keys(controlSourceHashes??{}).filter(p=>!p.startsWith('scripts/')),...Object.keys(combinedSourceHashes??{}).filter(p=>!p.startsWith('scripts/'))].map(p=>'backend/'+p));const launchAllowed=new Set(['health-source-schema-compatibility.mjs','health-source-schema-installed.mjs','real-configuration.mjs','calendar-release-mode.mjs','start-canonical.mjs','ownership-metadata.mjs',...(profileSourceHashes?['source-production-selection.mjs']:[])].map(p=>'launch/'+p));
  for(const p of changes)assert(allowedSources.has(p)||launchAllowed.has(p)||/^backend\/(apps|packages)\/[^/]+\/(dist\/|tsconfig\.tsbuildinfo$)/.test(p),'Unrelated package change: '+p);
  const metadata={mode,...(controlSourceHashes?{controlSourceManifestSha256,controlSourceHashes,explicitControlSchemaPlan:'mobile-source-control/1'}:{}),...(!profileSourceHashes?{healthInactive:true}:{}),profilesDefaultOff:true,...(profileSourceHashes?{profileSourceManifestSha256,profileSourceHashes,candidateProfileAvailability:mode==='candidate',recoveryRejectsAllProfiles:mode==='recovery'}:{}),recoveryForciblyInactive:mode==='recovery',fullStartupQualified:false,originalLiveSourceAdoptionGuardPreserved:true,defaultSchema:77,separateInventories:['base77','Calendar','standaloneHealth84/87/90'],changedPaths:changes,sourceHashes,...(combinedSourceHashes?{compositionManifestSha256,combinedSourceHashes,explicitCombinedSchemaOnly:!profileSourceHashes||mode==='recovery'}: {})};put(join(root,'HEALTH-SOURCE-PREPARATION.json'),JSON.stringify(metadata,null,2)+'\n');
  const files=inventory(root);delete files['SOURCE-MANIFEST.json'];delete files['prepared-source-manifest.json'];put(join(root,'SOURCE-MANIFEST.json'),JSON.stringify({schemaVersion:'health-source-preparation/1',containsPrivateAssets:false,files},null,2)+'\n');
  const all=inventory(root);delete all['prepared-source-manifest.json'];put(join(root,'prepared-source-manifest.json'),JSON.stringify({schemaVersion:'canonical-package:1.0.0',candidateId:id,containsPrivateAssets:false,files:Object.entries(all).map(([path,v])=>({path,...v}))},null,2)+'\n');
  result.modes[mode]={root,manifestSHA256:sha(readFileSync(join(root,'prepared-source-manifest.json'))),changedPaths:changes,unchangedBaseLeaves:Object.keys(before[mode]).length-changes.filter(p=>Object.hasOwn(before[mode],p)).length};
 }
 for(const [mode,pin] of Object.entries(basePins)){verifyDonor(join(base,mode),pin);assert.deepEqual(inventory(join(base,mode)),before[mode]);}
 if(controlSourceHashes)for(const [p,pin]of Object.entries(controlSourceHashes))assert.equal(sha(readFileSync(join(controlSource,'source',p))),pin);
 if(profileSourceHashes)for(const [p,pin]of Object.entries(profileSourceHashes))assert.equal(sha(readFileSync(join(profileSource,'source',p))),pin);
 if(combinedSourceHashes)for(const [p,pin] of Object.entries(combinedSourceHashes))assert.equal(sha(readFileSync(join(composition,'source',p))),pin);
 for(const [p,pin] of Object.entries(sourceHashes))assert.equal(sha(readFileSync(join(reviewed,'source',p))),pin);
 put(join(output,'PREPARATION-RESULT.json'),JSON.stringify(result,null,2)+'\n');return result;
}
// A separately released mode: the legacy 17/4/8 donor identities above remain
// unchanged. Executing tools are deliberately not the backend source donor.
const combinedScopePins=Object.freeze({
 proposal:'b0f658daf4ba56d2f1a1fa714897a4ef5712b47b05865dcc58ed3476e3f67e72',
 release:'c52fb1d224cfdaacec4eed0129876469c59f17898f2ea5f8dc9491e4a092bfc0',
 consistency:'82a14f65d6115904e70f713ce98563dfceff31a56665db0c8d1015b1aafd70f1',
 omission:'70cc0d74f81695fa07db142cfdf8100608cb6c4b376f91b45d8eb723f84e1e66',
 omissionAcceptance:'117a00ea9e985938ac44b0ae4891355b1961d7bfd42cc3674694efa514e947f8',
});
const combinedToolPaths=['scripts/prepare-health-source-backend.mjs','scripts/health-source-backend-preparation.test.mjs'];
function boundJSON(binding,expected){
 assert(binding&&resolve(binding.path)===binding.path&&/^[a-f0-9]{64}$/.test(binding.sha256),'Absolute hash-bound JSON input required');
 if(expected)assert.equal(binding.sha256,expected);
 const bytes=readFileSync(binding.path);assert.equal(sha(bytes),binding.sha256,'Changed bound input: '+binding.path);return JSON.parse(bytes);
}
function verifyEntries(root,entries){
 for(const [path,value] of Object.entries(entries)){
  assert(relative(root,resolve(root,path))===path&&!path.startsWith('../'),'Contained relative source path required');
  const bytes=readFileSync(join(root,path));assert.equal(sha(bytes),value.sha256??value,'Changed source: '+path);
  if(value.bytes!==undefined)assert.equal(bytes.length,value.bytes);
 }
}
export function validateCombinedLineagePlan(path,{requireAbsent=true}={}){
 assert(typeof path==='string'&&resolve(path)===path,'Absolute closed plan required');
 const plan=JSON.parse(readFileSync(path)),expectedKeys=['schemaVersion','status','inputPrepared','inputReviewedHandoff','inputReviewedReceipt','reviewedArchive','reviewedFullMap','projection','protection','toolAfterManifestSHA256','toolAfterManifest','outputRoot','prospectiveCandidateIds','compiler','noInstallNetworkAdoptionOrLiveState','scopeBindings','legacyHealthFixture','qualificationScratch','omittedCommands','repairRelease','repairStaging','observerBoundaryAmendment','observerConsistency'];
 assert.deepEqual(Object.keys(plan).sort(),expectedKeys.sort(),'Closed combined plan fields required');
 assert.equal(plan.schemaVersion,1);assert.equal(plan.status,'ClosedReleasedCombinedLineagePlan');assert.equal(plan.noInstallNetworkAdoptionOrLiveState,true);
 assert.deepEqual(Object.keys(plan.scopeBindings).sort(),Object.keys(combinedScopePins).sort());
 for(const [key,pin] of Object.entries(combinedScopePins))boundJSON(plan.scopeBindings[key],pin);
 const proposal=boundJSON(plan.scopeBindings.proposal);
 const repair=boundJSON(plan.repairRelease,'40397eaca0c5923b7f28fe4548b221668cb93861a11d520e48892ded293be2de'),staging=boundJSON(plan.repairStaging,repair.stagingProposalSHA256),roots=repair.selectedPreciseRoots;
 const observer=boundJSON(plan.observerBoundaryAmendment,'94f58201190e8a5f1f5c8276c4e9fda6db9e1500ac54b6c59f568a351d28cd34');boundJSON(plan.observerConsistency,observer.consistencySHA256);
 assert.equal(repair.originalReleaseSHA256,combinedScopePins.release);
 assert.equal(plan.outputRoot,roots.output);assert.deepEqual(plan.prospectiveCandidateIds,{candidate:roots.candidateId,recovery:roots.recoveryId});
 assert.equal(plan.qualificationScratch,roots.exclusiveScratch);
 assert.deepEqual(plan.omittedCommands,['retained-voice-sidecar-FakeModel-only']);
 if(requireAbsent)assert(!existsSync(plan.outputRoot),'Fresh output required');
 assert.deepEqual(plan.inputPrepared,proposal.preparedDonors);assert.deepEqual(plan.projection,proposal.exactProjectionAndLineage);assert.deepEqual(plan.protection,proposal.fullProtectedMaps);
 assert.deepEqual(plan.inputReviewedHandoff,proposal.reviewedCombinedSource.handoff);assert.deepEqual(plan.inputReviewedReceipt,proposal.reviewedCombinedSource.receipt);
 const handoff=boundJSON(plan.inputReviewedHandoff),selected=handoff.selectedFrozenSuccessor;
 assert.deepEqual(plan.reviewedFullMap,selected.finalSource2193Map);assert.deepEqual(plan.reviewedArchive,selected.archive);
 boundJSON(plan.inputReviewedReceipt);boundJSON(proposal.reviewedCombinedSource.closure);
 assert.equal(sha(readFileSync(plan.reviewedArchive.path)),plan.reviewedArchive.sha256);
 const full=boundJSON(plan.reviewedFullMap),projection=boundJSON(plan.projection),protection=boundJSON(plan.protection);
 assert.deepEqual(full,protection.frozenR4Complete2193);assert.equal(Object.keys(full).length,2193);verifyEntries(selected.publicRoot,full);
 const union=boundJSON(projection.reviewed59InputMap);assert.equal(Object.keys(union).length,59);
 assert.equal(Object.keys(projection.all27).length,27);
 assert.equal(plan.toolAfterManifestSHA256,plan.toolAfterManifest.sha256);const tools=boundJSON(plan.toolAfterManifest);
 assert.equal(tools.releaseSHA256,plan.repairRelease.sha256);assert.deepEqual(Object.keys(tools.files).sort(),combinedToolPaths.slice().sort());
 const workingRoot=resolve(HERE,'..');assert.equal(workingRoot,roots.workingPublic);verifyEntries(workingRoot,tools.files);
 assert.equal(tools.files[combinedToolPaths[0]].sha256,sha(readFileSync(fileURLToPath(import.meta.url))),'Execute actual bound new helper');
 assert.deepEqual(plan.legacyHealthFixture,proposal.testChangePlan.legacyHealthFixture);assert.equal(sha(readFileSync(plan.legacyHealthFixture.path)),plan.legacyHealthFixture.sha256);
 assert.equal(plan.compiler.node,process.execPath);assert.equal(sha(readFileSync(plan.compiler.node)),plan.compiler.nodeSHA256);assert.equal(sha(readFileSync(plan.compiler.tsc)),plan.compiler.tscSHA256);
 assert.equal(sha(readFileSync(plan.compiler.typescriptEntrypoint)),plan.compiler.typescriptEntrypointSHA256);
 const before={};
 for(const mode of ['candidate','recovery']){
  const binding=plan.inputPrepared[mode],root=dirname(binding.path);boundJSON(binding);before[mode]=verifyDonor(root,binding.sha256);
  const entries={...before[mode]};delete entries['prepared-source-manifest.json'];assert.deepEqual(entries,protection.preparedComplete7371EntryMaps[mode]);
  assert.equal(Object.keys(projection.sourceProjection2192EachMode[mode]).length,2192);
  for(const [source,value] of Object.entries(projection.sourceProjection2192EachMode[mode])){
   const target=Object.hasOwn(union,source)?full[source].sha256:before[mode]['backend/'+source]?.sha256;assert.equal(target,value.sha256,'Exact projected lineage: '+source);
  }
 }
 return {plan,proposal,repair,staging,full,projection,protection,union,before,reviewedRoot:selected.publicRoot,workingRoot,planSHA256:sha(readFileSync(path))};
}
function combinedProjectRoots(backend){
 const roots=new Set(['apps/server']);
 for(const {path} of JSON.parse(readFileSync(join(backend,'apps/server/tsconfig.json'))).references){
  const rel=relative(backend,resolve(backend,'apps/server',path));assert(/^packages\/[^/]+$/.test(rel));roots.add(rel);
 }
 return [...roots];
}
// Physical preservation is independent of the legacy byte-only inventories.
export function physicalInventory(root){
 const result={};
 function visit(path,key){const st=lstatSync(path),mode=st.mode&0o777;
  if(st.isSymbolicLink()){result[key]={type:'symlink',mode,target:readlinkSync(path)};return;}
  if(st.isDirectory()){result[key]={type:'directory',mode};for(const name of readdirSync(path).sort())visit(join(path,name),key?key+'/'+name:name);return;}
  assert(st.isFile());result[key]={type:'file',mode,bytes:st.size,sha256:sha(readFileSync(path))};
 }visit(root,'');return result;
}
function writableAncestor(root,path){
 assert(path===root||path.startsWith(root+'/'));
 for(let current=path;;current=dirname(current)){
  if(existsSync(current)){assert(lstatSync(current).isDirectory()&&!lstatSync(current).isSymbolicLink());chmodSync(current,0o700);}
  if(current===root)break;
 }
}
function writableOutputDirectories(path){if(!existsSync(path))return;assert(lstatSync(path).isDirectory());chmodSync(path,0o700);for(const name of readdirSync(path)){const child=join(path,name);if(lstatSync(child).isDirectory())writableOutputDirectories(child);}}
export function assertPhysicalPreservation(before,after,{compiledProjects,sourcePaths,full}){
 const compiled=p=>compiledProjects.some(project=>p==='backend/'+project+'/dist'||p.startsWith('backend/'+project+'/dist/')||p==='backend/'+project+'/tsconfig.tsbuildinfo');
 const byteExceptions=new Set([...sourcePaths.map(p=>'backend/'+p),'launch/real-configuration.mjs','SOURCE-MANIFEST.json','prepared-source-manifest.json','HEALTH-SOURCE-PREPARATION.json']);
 for(const p of new Set([...Object.keys(before),...Object.keys(after)])){
  if(compiled(p))continue;
  if(before[p]){assert(after[p],'Missing protected physical path: '+p);assert.equal(after[p].type,before[p].type,p);assert.equal(after[p].mode,before[p].mode,'Protected physical mode: '+p);if(!byteExceptions.has(p))assert.deepEqual(after[p],before[p],'Protected physical entry: '+p);}
  else{assert(byteExceptions.has(p)&&p.startsWith('backend/'),'Undeclared new physical path: '+p);assert.equal(after[p].type,'file');assert.equal(after[p].mode,full[p.slice(8)].mode);}
 }
}
function restoreNonOutputModes(root,before,projects,full,union){
 const compiled=p=>projects.some(project=>p==='backend/'+project+'/dist'||p.startsWith('backend/'+project+'/dist/')||p==='backend/'+project+'/tsconfig.tsbuildinfo');
 for(const [p,v] of Object.entries(before).sort((a,b)=>b[0].length-a[0].length))if(!compiled(p)&&v.type!=='symlink'&&existsSync(join(root,p)))chmodSync(join(root,p),v.mode);
 for(const p of Object.keys(union))if(!before['backend/'+p])chmodSync(join(root,'backend',p),full[p].mode);
}
function restoreCurrentStaticAssets(root,projects,staging){
 const changes=[],targets=[];
 for(const [target,value] of Object.entries(staging.requiredFrozenCurrentStaticAssets8)){
  const input=join(root,value.source),output=join(root,target),bytes=readFileSync(input);assert.equal(sha(bytes),value.sha256,'Frozen current static asset');let text=bytes.toString('utf8');const edits=[];
  if(target.endsWith('.mjs'))text=text.replace(/(from\s*|import\s*\(\s*)(['"])([^'"]+)\2/g,(match,prefix,quote,specifier)=>{
   if(!specifier.startsWith('.'))return match;
   const sourceTarget=resolve(dirname(input),specifier);assert(sourceTarget.startsWith(join(root,'backend')+'/'));let compiledTarget=sourceTarget;
   for(const project of projects)compiledTarget=compiledTarget.replace('/backend/'+project+'/src/','/backend/'+project+'/dist/');
   if(compiledTarget!==sourceTarget)compiledTarget=compiledTarget.replace(/\.ts$/,'.js');
   let projected=relative(dirname(output),compiledTarget);if(!projected.startsWith('.'))projected='./'+projected;
   targets.push({asset:target,original:specifier,projected,target:relative(root,compiledTarget)});
   if(projected!==specifier)edits.push({before:specifier,after:projected});return prefix+quote+projected+quote;
  });
  put(output,target.endsWith('.mjs')?text:bytes);changes.push({source:value.source,target,sourceSHA256:sha(bytes),outputSHA256:sha(readFileSync(output)),importSpecifierEdits:edits});
 }
 for(const value of targets)assert(existsSync(join(root,value.target)),'Missing projected static asset import: '+value.target);
 return {assets:changes,relativeImports:targets};
}

export async function prepareCombinedLineageBackend(path){
 // Validate every donor, tool, projection and compiler before creating output.
 const inputs=validateCombinedLineagePlan(path),{plan,full,union,before,protection,projection,reviewedRoot}=inputs;
 const result={schemaVersion:1,status:'PreparedInactiveCombinedProjectionNotInstalledAdoption',planSHA256:inputs.planSHA256,toolManifest:plan.toolAfterManifest,activationPerformed:false,fullStartupQualified:false,pythonSidecarExecuted:false,modes:{}};
 mkdirSync(plan.outputRoot,{mode:0o700});
 for(const mode of ['candidate','recovery']){
  const root=join(plan.outputRoot,mode),backend=join(root,'backend'),id=plan.prospectiveCandidateIds[mode];
  const physicalBefore=physicalInventory(dirname(plan.inputPrepared[mode].path));
  mkdirSync(root,{mode:0o700});cpSync(dirname(plan.inputPrepared[mode].path),root,{recursive:true,dereference:false,verbatimSymlinks:true});
  // Node cp creates writable destination directories: restore their recorded
  // donor modes before the first independent copy comparison. Files untouched.
  for(const [p,v] of Object.entries(physicalBefore).sort((a,b)=>b[0].length-a[0].length))if(v.type==='directory')chmodSync(join(root,p),v.mode);
  assert.deepEqual(inventory(root),before[mode]);assert.deepEqual(physicalInventory(root),physicalBefore);
  const projects=combinedProjectRoots(backend);
  for(const p of [...Object.keys(union).map(p=>'backend/'+p),'launch/real-configuration.mjs','SOURCE-MANIFEST.json','prepared-source-manifest.json','HEALTH-SOURCE-PREPARATION.json',...projects.map(p=>'backend/'+p+'/tsconfig.tsbuildinfo')])writableAncestor(root,dirname(join(root,p)));
  for(const project of projects)writableOutputDirectories(join(backend,project,'dist'));
  for(const source of Object.keys(union)){const bytes=readFileSync(join(reviewedRoot,source));assert.equal(sha(bytes),full[source].sha256);put(join(backend,source),bytes);}
  const seam=protection.identityOnlyLauncherSeams[mode],config=join(root,seam.path),old=readFileSync(config,'utf8');assert.equal(sha(old),seam.beforeSHA256);
  const updated=replaceUnique(old,seam.beforeCandidateId,id);assert.equal(replaceUnique(updated,id,seam.beforeCandidateId),old);put(config,updated);
  // The original schema lock is a runtime schema asset, not compiler output.
  const schemaLock=readFileSync(join(backend,'packages/contracts/src/unified-desktop.lock.json'));
  assert.equal(sha(schemaLock),before[mode]['backend/packages/contracts/dist/unified-desktop.lock.json'].sha256);
  for(const project of projects){rmSync(join(backend,project,'dist'),{recursive:true,force:true});rmSync(join(backend,project,'tsconfig.tsbuildinfo'),{force:true});}
  let log;
  try{log=execFileSync(plan.compiler.node,[plan.compiler.tsc,'-b','apps/server','--force','--pretty','false'],{cwd:backend,encoding:'utf8',maxBuffer:8*1024*1024});}
  catch(error){put(join(plan.outputRoot,mode+'-build-failure.log'),String(error.stdout??'')+String(error.stderr??'')+String(error));throw error;}
  put(join(plan.outputRoot,mode+'-build.log'),log);
  put(join(backend,'packages/contracts/dist/unified-desktop.lock.json'),schemaLock);
  const currentAssetLineage=restoreCurrentStaticAssets(root,projects,inputs.staging);
  for(const directory of ['packages/contracts/src/schemas','packages/storage-sqlite/src/migrations'])for(const name of readdirSync(join(backend,directory)).filter(n=>directory.endsWith('schemas')?n.endsWith('.json'):n.endsWith('.sql')))put(join(backend,directory.replace('/src/','/dist/'),name),readFileSync(join(backend,directory,name)));
  verifyEntries(backend,projection.sourceProjection2192EachMode[mode]);
  const sourceAllowed=new Set(Object.keys(union).map(p=>'backend/'+p)),metadataAllowed=new Set(['SOURCE-MANIFEST.json','prepared-source-manifest.json','HEALTH-SOURCE-PREPARATION.json']);
  const allowed=p=>sourceAllowed.has(p)||metadataAllowed.has(p)||p===seam.path||projects.some(project=>p.startsWith('backend/'+project+'/dist/')||p==='backend/'+project+'/tsconfig.tsbuildinfo');
  let after=inventory(root);const changedPaths=Object.keys(after).filter(p=>JSON.stringify(after[p])!==JSON.stringify(before[mode][p])),removedPaths=Object.keys(before[mode]).filter(p=>!Object.hasOwn(after,p));
  for(const p of [...changedPaths,...removedPaths])assert(allowed(p),'Out-of-scope generated output: '+p);
  const priorMetadata=JSON.parse(readFileSync(join(root,'HEALTH-SOURCE-PREPARATION.json')));
  put(join(root,'HEALTH-SOURCE-PREPARATION.json'),JSON.stringify({...priorMetadata,combinedInactiveLineage:{planSHA256:inputs.planSHA256,toolManifestSHA256:plan.toolAfterManifest.sha256,reviewedHandoffSHA256:plan.inputReviewedHandoff.sha256,reviewedSource59:Object.fromEntries(Object.keys(union).map(p=>[p,full[p].sha256])),retainedR5Outside59:27,fullStartupQualified:false,installedAdoptionQualified:false,sidecarRuntimeQualified:false,changedPaths,removedPaths}},null,2)+'\n');
  after=inventory(root);delete after['SOURCE-MANIFEST.json'];delete after['prepared-source-manifest.json'];put(join(root,'SOURCE-MANIFEST.json'),JSON.stringify({schemaVersion:'health-source-preparation/1',containsPrivateAssets:false,files:after},null,2)+'\n');
  after=inventory(root);delete after['prepared-source-manifest.json'];put(join(root,'prepared-source-manifest.json'),JSON.stringify({schemaVersion:'canonical-package:1.0.0',candidateId:id,containsPrivateAssets:false,files:Object.entries(after).map(([path,v])=>({path,...v}))},null,2)+'\n');
  after=inventory(root);for(const p of new Set([...Object.keys(before[mode]),...Object.keys(after)]))if(JSON.stringify(before[mode][p])!==JSON.stringify(after[p]))assert(allowed(p),'Out-of-scope final change: '+p);
  verifyEntries(backend,projection.sourceProjection2192EachMode[mode]);assert.equal(replaceUnique(readFileSync(config,'utf8'),id,seam.beforeCandidateId),old);
  restoreNonOutputModes(root,physicalBefore,projects,full,union);
  const physicalAfter=physicalInventory(root);assertPhysicalPreservation(physicalBefore,physicalAfter,{compiledProjects:projects,sourcePaths:Object.keys(union),full});
  const physicalEvidence=join(plan.outputRoot,mode+'-PHYSICAL-PRESERVATION.json');put(physicalEvidence,JSON.stringify({before:physicalBefore,after:physicalAfter,currentAssetLineage,outsideOutputPhysicalPreservation:true},null,2)+'\n');
  result.modes[mode]={root,candidateId:id,physicalEvidenceSHA256:sha(readFileSync(physicalEvidence)),currentAssetLineage,manifestSHA256:sha(readFileSync(join(root,'prepared-source-manifest.json'))),compiledProjects:projects,changedPaths:Object.keys(after).filter(p=>JSON.stringify(after[p])!==JSON.stringify(before[mode][p])),removedPaths,sourceProjection2192Verified:true,retainedR5Outside59Verified:27,allOutsideAllowedOutputsPreserved:true};
 }
 // Re-read every immutable input after the copies/builds; no donor is writable.
 validateCombinedLineagePlan(path,{requireAbsent:false});
 put(join(plan.outputRoot,'PREPARATION-RESULT.json'),JSON.stringify(result,null,2)+'\n');return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length===4&&process.argv[2]==='--combined-lineage-plan'){console.log(JSON.stringify(await prepareCombinedLineageBackend(process.argv[3])));}else{
 const args=process.argv.slice(2),keys=['base','reviewed','closure','output','tsc'];assert([10,14,18,22].includes(args.length));const options={};for(let i=0;i<keys.length;i++){assert.equal(args[i*2],'--'+keys[i]);options[keys[i]]=args[i*2+1];}if(args.length>=14){assert.equal(args[10],'--composition');assert.equal(args[12],'--composition-manifest-sha256');options.composition=args[11];options.compositionManifestSha256=args[13];}if(args.length>=18){assert.equal(args[14],'--profile-source');assert.equal(args[16],'--profile-source-manifest-sha256');options.profileSource=args[15];options.profileSourceManifestSha256=args[17];}if(args.length===22){assert.equal(args[18],'--control-source');assert.equal(args[20],'--control-source-manifest-sha256');options.controlSource=args[19];options.controlSourceManifestSha256=args[21];}console.log(JSON.stringify(await prepareHealthSourceBackend(options)));
}
}
