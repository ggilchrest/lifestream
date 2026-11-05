// Isolated source package preparation only. Never launches, installs or opens
// operator state. Every current release byte is captured and accounted for.
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,readFileSync,writeFileSync,chmodSync,readdirSync,lstatSync,readlinkSync,existsSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const HERE=dirname(fileURLToPath(import.meta.url)),SOURCE=resolve(HERE,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
function replaceOnce(text,old,next){assert.equal(text.split(old).length,2,'Exact unique source integration seam: '+old.slice(0,100));return text.replace(old,next);}
export function integrateCalendarIndex(text){
 text=replaceOnce(text,"import {loadHealthBasicMigrations}","import {loadHealthBasicMigrations,loadCalendarBasicMigrations,assertCalendarMigrationInventory}");
 text=replaceOnce(text,"import{mobileSourceGovernance,type MobileSourcePolicy}","import{mobileSourceGovernance,mobileCalendarSourceGovernance,type CalendarSourcePolicy,type MobileSourcePolicy}");
 text=replaceOnce(text,"healthSchemaPlan?:'health-basic/1';mobileContext?:{schemaPlan?:'health-basic/1';", "healthSchemaPlan?:'health-basic/1';mobileSchemaPlan?:'calendar-basic/1';mobileContext?:{schemaPlan?:'health-basic/1'|'calendar-basic/1';");
 text=replaceOnce(text,"maximumRecordsPerHuman:number;sourceSafetyInitialization?", "maximumRecordsPerHuman:number;maximumControlOperationsPerHuman?:number;createCalendarGovernance?:(database:Database,authentication:LocalAuthentication)=>CalendarSourcePolicy|null;sourceSafetyInitialization?");
 text=replaceOnce(text,"createGovernance:(database:Database,authentication:LocalAuthentication)=>MobileSourcePolicy", "createGovernance?:(database:Database,authentication:LocalAuthentication)=>MobileSourcePolicy");
 text=replaceOnce(text,"policy:MobileSourcePolicy,ownerOptions?", "policy:MobileSourcePolicy|null,ownerOptions?");
 text=replaceOnce(text,"if(ownerOptions){this.healthPolicyOwner=", "if(ownerOptions&&policy){this.healthPolicyOwner=");
 const admin="  calendarGovernance(initialization:'requireExisting'|'initializeEmpty',maximumRecords:number,policy:CalendarSourcePolicy|null){this.recovery.journal.enableSources(initialization);return mobileCalendarSourceGovernance(this.recovery.journal,this.database,maximumRecords,policy);}\n";
 text=replaceOnce(text,"  healthPolicyOwner:HealthPolicyOwner|undefined;",admin+"  healthPolicyOwner:HealthPolicyOwner|undefined;");
 text=replaceOnce(text,"  private readonly healthBasicSchemaPlan:boolean;", "  private readonly healthBasicSchemaPlan:boolean;\n  private readonly calendarBasicSchemaPlan:boolean;");
 text=replaceOnce(text,"const healthPlan=options.healthSchemaPlan??options.mobileContext?.schemaPlan;", "const healthPlan=options.mobileSchemaPlan??options.healthSchemaPlan??options.mobileContext?.schemaPlan;");
 text=replaceOnce(text,"if(healthPlan!==undefined&&healthPlan!=='health-basic/1'||options.healthSchemaPlan!==undefined&&options.mobileContext?.schemaPlan!==undefined&&options.healthSchemaPlan!==options.mobileContext.schemaPlan)", "if(healthPlan!==undefined&&!['health-basic/1','calendar-basic/1'].includes(healthPlan)||options.mobileSchemaPlan!==undefined&&(options.mobileSchemaPlan!=='calendar-basic/1'||options.healthSchemaPlan!==undefined)||options.mobileContext?.schemaPlan!==undefined&&healthPlan!==options.mobileContext.schemaPlan)");
 text=replaceOnce(text,"this.healthBasicSchemaPlan=healthPlan==='health-basic/1';", "this.healthBasicSchemaPlan=healthPlan==='health-basic/1';this.calendarBasicSchemaPlan=healthPlan==='calendar-basic/1';");
 const old="...(this.healthBasicSchemaPlan?{migrations:loadHealthBasicMigrations()}:{})";assert.equal(text.split(old).length,3);text=text.replaceAll(old,"...(this.calendarBasicSchemaPlan?{migrations:loadCalendarBasicMigrations()}:this.healthBasicSchemaPlan?{migrations:loadHealthBasicMigrations()}:{})");
 assert.equal(text.split("this.migrationRecords = this.database.migrate();").length,3);text=text.replaceAll("this.migrationRecords = this.database.migrate();", "if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(this.database);this.migrationRecords = this.database.migrate();");
 text=replaceOnce(text,"const candidateMigrations = candidateDatabase.migrate();", "if(this.calendarBasicSchemaPlan)assertCalendarMigrationInventory(candidateDatabase);const candidateMigrations = candidateDatabase.migrate();");
 text=replaceOnce(text,"options.mobileContext.createGovernance(this.database,this.localAuth)","options.mobileContext.createGovernance?.(this.database,this.localAuth)??null");
 text=replaceOnce(text,"options.mobileContext.maximumRecordsPerHuman)):undefined;if(this.mobileContext)","options.mobileContext.maximumRecordsPerHuman,Date.now,options.mobileContext.maximumControlOperationsPerHuman!==undefined?{maximumOperationsPerHuman:options.mobileContext.maximumControlOperationsPerHuman}:undefined,this.admin.calendarGovernance(options.mobileContext.sourceSafetyInitialization??'requireExisting',options.mobileContext.maximumRecordsPerHuman,options.mobileContext.createCalendarGovernance?.(this.database,this.localAuth)??null))):undefined;if(this.mobileContext)");
 const gate="if(!input||typeof input!=='object'||!['inventory','enroll','bindSource','policy','configure','ingest','remove'].includes(String((input as any).operation)))";
 // Retain the current-release Health-only route filter except for the exact
 // explicit Calendar composition; its own producing parser is the admission.
 text=replaceOnce(text,gate,"if(!this.calendarBasicSchemaPlan&&("+gate.slice(3,-1)+"))");
 return text;
}
/** Add only the released Calendar policy seams to the preserved Daily index. */
export function integrateCalendarPolicyIndex(text){
 text="import {calendarPolicyEnvelope} from '@lifestream/contracts/mobile-context-calendar-policy-owner';\n"+text;
 text=replaceOnce(text,'import {healthPolicyOperation}','import {healthPolicyOperation,calendarPolicyOperation}');
 text=replaceOnce(text,"mobileSchemaPlan?:'calendar-basic/1';","mobileSchemaPlan?:'calendar-basic/1'|'calendar-policy/1';");
 text=replaceOnce(text,"schemaPlan?:'health-basic/1'|'calendar-basic/1';","schemaPlan?:'health-basic/1'|'calendar-basic/1'|'calendar-policy/1';calendarPolicyOwner?:{finite?:HealthFiniteConfiguration};");
 text=replaceOnce(text,'  private readonly calendarBasicSchemaPlan:boolean;','  private readonly calendarBasicSchemaPlan:boolean;\n  private readonly calendarPolicySchemaPlan:boolean;');
 text=replaceOnce(text,"!['health-basic/1','calendar-basic/1'].includes(healthPlan)","!['health-basic/1','calendar-basic/1','calendar-policy/1'].includes(healthPlan)");
 text=replaceOnce(text,"options.mobileSchemaPlan!=='calendar-basic/1'","!['calendar-basic/1','calendar-policy/1'].includes(options.mobileSchemaPlan)");
 text=replaceOnce(text,"this.calendarBasicSchemaPlan=healthPlan==='calendar-basic/1';","this.calendarPolicySchemaPlan=healthPlan==='calendar-policy/1';this.calendarBasicSchemaPlan=healthPlan==='calendar-basic/1'||this.calendarPolicySchemaPlan;if(options.mobileContext?.calendarPolicyOwner&&!this.calendarPolicySchemaPlan)throw Error('calendar_policy_schema_required');");
 text=text.replaceAll('loadCalendarBasicMigrations()','loadCalendarBasicMigrations(this.calendarPolicySchemaPlan)').replaceAll('assertCalendarMigrationInventory(this.database)','assertCalendarMigrationInventory(this.database,this.calendarPolicySchemaPlan)').replaceAll('assertCalendarMigrationInventory(candidateDatabase)','assertCalendarMigrationInventory(candidateDatabase,this.calendarPolicySchemaPlan)');
 text=replaceOnce(text,'  healthPolicyOwner:HealthPolicyOwner|undefined;','  healthPolicyOwner:HealthPolicyOwner|undefined;\n  calendarPolicyOwner:HealthPolicyOwner|undefined;');
 const begin=text.indexOf('  calendarGovernance('),end=text.indexOf('\n',begin);assert(begin>=0&&end>begin);
 const actual=readFileSync(join(SOURCE,'apps/server/src/index.ts'),'utf8'),a=actual.indexOf('  calendarGovernance('),z=actual.indexOf('\n',a);assert(a>=0&&z>a);text=text.slice(0,begin)+actual.slice(a,z)+text.slice(end);
 text=replaceOnce(text,'options.mobileContext.createCalendarGovernance?.(this.database,this.localAuth)??null))','options.mobileContext.createCalendarGovernance?.(this.database,this.localAuth)??null,options.mobileContext.calendarPolicyOwner))');
 text=replaceOnce(text,'if(this.mobileContext)this.admin.healthPolicyOwner?.attach(this.mobileContext.repository);','if(this.mobileContext){this.admin.healthPolicyOwner?.attach(this.mobileContext.repository);this.admin.calendarPolicyOwner?.attach(this.mobileContext.repository);}');
 text=replaceOnce(text,'const owner=this.admin.healthPolicyOwner,auth=this.localAuth;if(!owner||!auth)','const auth=this.localAuth;if(!auth||!this.admin.healthPolicyOwner&&!this.admin.calendarPolicyOwner)');
 text=replaceOnce(text,'const result=healthPolicyOperation(owner,input,()=>',"const calendar=calendarPolicyEnvelope(input)!==null,owner=calendar?this.admin.calendarPolicyOwner:this.admin.healthPolicyOwner;if(!owner)return json(response,404,{code:calendar?'calendar_policy_unavailable':'health_policy_unavailable'});const result=(calendar?calendarPolicyOperation:healthPolicyOperation)(owner,input,()=>");
 return text;
}
/** Add only registered consent/production seams; preserve current-release unrelated code. */
export function integrateCalendarConsentIndex(text){
 text="import {calendarSourceConsentEnvelope} from '@lifestream/contracts/mobile-context-calendar-source-consent';\n"+text;
 text=replaceOnce(text,'import {healthPolicyOperation,calendarPolicyOperation}','import {healthPolicyOperation,calendarPolicyOperation,calendarSourceConsentOperation}');
 text=replaceOnce(text,"mobileSchemaPlan?:'calendar-basic/1'|'calendar-policy/1';","mobileSchemaPlan?:'calendar-basic/1'|'calendar-policy/1'|'calendar-consent/1';");
 text=replaceOnce(text,"schemaPlan?:'health-basic/1'|'calendar-basic/1'|'calendar-policy/1';","schemaPlan?:'health-basic/1'|'calendar-basic/1'|'calendar-policy/1'|'calendar-consent/1';calendarProduction?:{environmentId:string;destinationId:string;finite?:HealthFiniteConfiguration};");
 const originalRelationship="  conversationRelationshipId(assistantId:string,relationshipId:string|undefined,actor:string):string|null{return this.resolveRelationship(assistantId,relationshipId,actor)?.relationshipId??null;}";const actualRelationship=readFileSync(join(SOURCE,'apps/server/src/index.ts'),'utf8').split('\n').find(line=>line.startsWith('  calendarSourceAnswersAllowed('));assert(actualRelationship);text=replaceOnce(text,originalRelationship,originalRelationship+'\n'+actualRelationship);
 text=replaceOnce(text,'  private readonly calendarPolicySchemaPlan:boolean;','  private readonly calendarPolicySchemaPlan:boolean;\n  private readonly calendarConsentSchemaPlan:boolean;');
 text=text.replaceAll("['health-basic/1','calendar-basic/1','calendar-policy/1']","['health-basic/1','calendar-basic/1','calendar-policy/1','calendar-consent/1']").replaceAll("['calendar-basic/1','calendar-policy/1']","['calendar-basic/1','calendar-policy/1','calendar-consent/1']");
 text=replaceOnce(text,"this.calendarPolicySchemaPlan=healthPlan==='calendar-policy/1';","this.calendarConsentSchemaPlan=healthPlan==='calendar-consent/1';this.calendarPolicySchemaPlan=healthPlan==='calendar-policy/1'||this.calendarConsentSchemaPlan;");
 const guard="if(options.mobileContext?.calendarPolicyOwner&&!this.calendarPolicySchemaPlan)throw Error('calendar_policy_schema_required');";
 text=replaceOnce(text,guard,guard+"if(options.mobileContext?.calendarProduction&&(!this.calendarConsentSchemaPlan||options.mobileContext.createCalendarGovernance||options.mobileContext.calendarPolicyOwner||!options.sessionEnvironmentId||options.mobileContext.calendarProduction.environmentId!==options.sessionEnvironmentId))throw Error('calendar_production_profile_required');");
 text=text.replaceAll('loadCalendarBasicMigrations(this.calendarPolicySchemaPlan)','loadCalendarBasicMigrations(this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan)').replaceAll('assertCalendarMigrationInventory(this.database,this.calendarPolicySchemaPlan)','assertCalendarMigrationInventory(this.database,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan)').replaceAll('assertCalendarMigrationInventory(candidateDatabase,this.calendarPolicySchemaPlan)','assertCalendarMigrationInventory(candidateDatabase,this.calendarPolicySchemaPlan,this.calendarConsentSchemaPlan)');
 const actual=readFileSync(join(SOURCE,'apps/server/src/index.ts'),'utf8'),begin=actual.indexOf(',options.mobileContext.calendarProduction?{'),end=actual.indexOf('))):undefined',begin);assert(begin>0&&end>begin);
 text=replaceOnce(text,'options.mobileContext.calendarPolicyOwner))','options.mobileContext.calendarPolicyOwner'+actual.slice(begin,end)+'))');
 text=replaceOnce(text,'const calendar=calendarPolicyEnvelope(input)!==null,owner=calendar?','const consent=calendarSourceConsentEnvelope(input)!==null,calendar=consent||calendarPolicyEnvelope(input)!==null,owner=calendar?');
 text=replaceOnce(text,'(calendar?calendarPolicyOperation:healthPolicyOperation)','(consent?calendarSourceConsentOperation:calendar?calendarPolicyOperation:healthPolicyOperation)');
 const recipient="recipientAllowed:(assistant:string)=>access.current()&&access.authorize(assistant)&&this.audiencePermits(bound)&&this.personalContextAllowed(assistant,bound.principalId)&&this.admin.calendarSourceAnswersAllowed(assistant,bound.principalId),";
 text=replaceOnce(text,'identity,current:()=>{try{return access.current()','identity,'+recipient+'current:()=>{try{return access.current()');
 text=replaceOnce(text,'endpointId:endpoint.endpointId,current:()=>{try{return access.current()&&access.ordinarySelf()','endpointId:endpoint.endpointId,recipientAllowed:(recipient:string)=>access.current()&&access.authorize(recipient)&&this.audiencePermits(bound),current:()=>{try{return access.current()&&access.ordinarySelf()');
 return text;
}
export function calendarProductionSelectionModule(mode){return `import assert from 'node:assert/strict';
import {calendarProductionBackendOptions} from '../backend/apps/server/src/runtime/calendar-production-composition.ts';
export function calendarProductionLaunchOptions(deployment,environmentId){
 if(${JSON.stringify(mode)}==='recovery'||deployment.calendarSourceProfile===undefined)return {};
 assert.equal(deployment.mobileSchemaPlan,'calendar-consent/1','Explicit consent schema/profile selection required');
 const profile=deployment.calendarSourceProfile;assert(profile&&typeof profile==='object'&&!Array.isArray(profile));assert(!Object.hasOwn(profile,'environmentId'),'Environment comes from original ownership marker');
 return {mobileContext:calendarProductionBackendOptions({...profile,environmentId})};
}
`;}
export function inventory(root){const files={};function walk(dir){for(const name of readdirSync(dir).sort()){assert(!['.git','.private'].includes(name),'No Git/private roots in packages');const p=join(dir,name),st=lstatSync(p),key=relative(root,p);if(st.isSymbolicLink()){const target=realpathSync(p);assert(target.startsWith(root+'/'),'External symlink');files[key]={symlink:readlinkSync(p)};}else if(st.isDirectory())walk(p);else{assert(st.isFile());files[key]={sha256:sha(readFileSync(p)),bytes:st.size};}}}walk(root);return files;}
function put(path,bytes){mkdirSync(dirname(path),{recursive:true});if(existsSync(path))chmodSync(path,0o600);writeFileSync(path,bytes,{mode:0o600});}
function modeModule(mode){return `import assert from 'node:assert/strict';\nexport const calendarReleaseMode=${JSON.stringify(mode)};\nexport const calendarCollectionConfigured=false;\nexport function validateCalendarCodeAdoption(value,expected){const keys=['schemaVersion','candidateId','stateDirectory','manifestSha256','schemaCeiling','initialOwnershipSha256','originalFamilySchemaCeiling','migrationIdentitySha256'];assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),keys.sort());assert.equal(value.schemaVersion,'canonical-code-adoption-calendar-disabled:1.0.0');assert.equal(value.originalFamilySchemaCeiling,73);assert.ok([77,89,90].includes(value.schemaCeiling));for(const k of ['candidateId','stateDirectory','manifestSha256','schemaCeiling','migrationIdentitySha256'])assert.equal(value[k],expected[k]);for(const k of ['manifestSha256','initialOwnershipSha256','migrationIdentitySha256'])assert.match(value[k],/^[a-f0-9]{64}$/);return value;}\n`;}
export async function prepareCalendarBackend({base,output,source=SOURCE,node=process.execPath,tsc,policy=true,consent=false}){
 assert(!consent||policy,'Consent requires original policy plan');
 base=resolve(base);output=resolve(output);source=resolve(source);
 assert(!output.startsWith('/srv/lifestream/deployment/')&&output!==base&&!output.startsWith(base+'/')&&!source.startsWith(output+'/'),'Isolated output required');assert(!existsSync(output),'Fresh output required');
 const before=inventory(base);mkdirSync(output,{recursive:true,mode:0o700});
 const scope=JSON.parse(readFileSync(join(source,'../calendar-backend-composition-work-r1/SCOPE-PROPOSAL-r5.json'))),sourceHashes={};
 if(policy){const extension=JSON.parse(readFileSync(join(source,'../calendar-policy-integration-work-r1/SCOPE-PROPOSAL-r1.json')));scope.exactPaths=[...new Set([...scope.exactPaths,...extension.exactPaths])];}
 if(policy){const extension=JSON.parse(readFileSync(join(source,'../calendar-production-consent-work-r1/SCOPE-PROPOSAL-r1.json')));scope.exactPaths=[...new Set([...scope.exactPaths,...extension.exactPaths])];}
 for(const path of scope.exactPaths){assert(existsSync(join(source,path)),'Registered source path missing: '+path);sourceHashes[path]=sha(readFileSync(join(source,path)));}
 const changedByMode={};
 for(const mode of ['candidate','recovery']){
  const packageId='canonical-daily-calendar-'+(consent?'consent-':policy?'policy-':'')+'disabled-'+mode+'-20261102-r1';
  const root=join(output,mode);cpSync(base,root,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true});
  // Permit edits in disposable copies, never in the original release.
  function writable(dir){chmodSync(dir,0o700);for(const n of readdirSync(dir)){const p=join(dir,n),s=lstatSync(p);if(s.isDirectory())writable(p);else if(s.isFile())chmodSync(p,0o600);}}writable(root);
  assert.deepEqual(inventory(root),before,'Exact isolated copy before integration');
  const backend=join(root,'backend');
  const typesSource=join(source,'node_modules/@types/ws');assert(existsSync(typesSource),'Existing local ws declaration dependency required');cpSync(typesSource,join(backend,'node_modules/@types/ws'),{recursive:true,dereference:true});
  const buildTypes=Object.fromEntries(Object.entries(inventory(join(backend,'node_modules/@types/ws'))).map(([p,v])=>['backend/node_modules/@types/ws/'+p,v]));
  for(const path of scope.exactPaths){
   if(path.startsWith('scripts/')||!consent&&['apps/server/src/runtime/calendar-production-composition.ts','apps/server/test/calendar-production-consent.test.ts'].includes(path))continue;
   if(path==='apps/server/src/index.ts'||path==='packages/storage-sqlite/src/index.ts'||path==='packages/contracts/package.json')continue;
   put(join(backend,path),readFileSync(join(source,path)));
  }
  const deliveryFixture='packages/contracts/test/fixtures/mobile-context-calendar-delivery.json';put(join(backend,deliveryFixture),readFileSync(join(source,deliveryFixture)));
  const calendar86='packages/storage-sqlite/src/migrations/0086_mobile_context_calendar.sql';assert.equal(sha(readFileSync(join(source,calendar86))),scope.protectedSHA256[calendar86]);put(join(backend,calendar86),readFileSync(join(source,calendar86)));
  const integrated=integrateCalendarIndex(readFileSync(join(backend,'apps/server/src/index.ts'),'utf8'));put(join(backend,'apps/server/src/index.ts'),consent?integrateCalendarConsentIndex(integrateCalendarPolicyIndex(integrated)):policy?integrateCalendarPolicyIndex(integrated):integrated);
  const storageIndex=join(backend,'packages/storage-sqlite/src/index.ts');put(storageIndex,readFileSync(storageIndex,'utf8')+"\nexport {loadCalendarBasicMigrations,assertCalendarMigrationInventory} from './mobile-calendar-migrations.ts';\n");
  const packagePath=join(backend,'packages/contracts/package.json'),pkg=JSON.parse(readFileSync(packagePath));for(const stem of ['mobile-context-calendar-settings-control',...(policy?['mobile-context-calendar-policy-owner','mobile-context-calendar-selected-delivery']:[]),...(policy?['mobile-context-calendar-source-consent']:[])])pkg.exports['./'+stem]=JSON.parse(readFileSync(join(source,'packages/contracts/package.json'))).exports['./'+stem];put(packagePath,JSON.stringify(pkg,null,2)+'\n');
  put(join(root,'launch/calendar-schema-compatibility.mjs'),readFileSync(join(source,'scripts/calendar-schema-compatibility.mjs')));
  put(join(root,'launch/calendar-release-mode.mjs'),modeModule(mode));
  if(consent)put(join(root,'launch/calendar-production-selection.mjs'),calendarProductionSelectionModule(mode));
  put(join(root,'launch/calendar-schema-installed.mjs'),(consent?"import {loadInstalledCalendarChecker,CONSENT_MIGRATION_IDENTITY_SHA256 as MIGRATION_IDENTITY_SHA256} from './calendar-schema-compatibility.mjs';\nimport {fileURLToPath} from 'node:url';\nexport {MIGRATION_IDENTITY_SHA256};\nexport const assertCompatibleSchema=await loadInstalledCalendarChecker(fileURLToPath(new URL('../',import.meta.url)),true,true);\n":policy?"import {loadInstalledCalendarChecker,POLICY_MIGRATION_IDENTITY_SHA256 as MIGRATION_IDENTITY_SHA256} from './calendar-schema-compatibility.mjs';\nimport {fileURLToPath} from 'node:url';\nexport {MIGRATION_IDENTITY_SHA256};\nexport const assertCompatibleSchema=await loadInstalledCalendarChecker(fileURLToPath(new URL('../',import.meta.url)),true);\n":"import {loadInstalledCalendarChecker,MIGRATION_IDENTITY_SHA256} from './calendar-schema-compatibility.mjs';\nimport {fileURLToPath} from 'node:url';\nexport {MIGRATION_IDENTITY_SHA256};\nexport const assertCompatibleSchema=await loadInstalledCalendarChecker(fileURLToPath(new URL('../',import.meta.url)));\n"));
  const ownership=join(root,'launch/ownership-metadata.mjs');put(ownership,replaceOnce(readFileSync(ownership,'utf8'),"from './health-schema-compatibility.mjs'","from './calendar-schema-installed.mjs'"));
  const configPath=join(root,'launch/real-configuration.mjs');let config=readFileSync(configPath,'utf8');
  config=replaceOnce(config,"export const candidateId='canonical-daily-health-disabled-20261031-r1';","export const candidateId="+JSON.stringify(packageId)+";");
  config=replaceOnce(config,"+(Object.hasOwn(value,'healthSchemaPlan')?',healthSchemaPlan':'')", "+(Object.hasOwn(value,'healthSchemaPlan')?',healthSchemaPlan':'')+(Object.hasOwn(value,'mobileSchemaPlan')?',mobileSchemaPlan':'')");
  config=replaceOnce(config," if(Object.hasOwn(value,'healthSchemaPlan'))", " if(Object.hasOwn(value,'mobileSchemaPlan')){assert.equal(value.mobileSchemaPlan,'calendar-basic/1');assert.equal(value.healthSchemaPlan,undefined);}\n if(Object.hasOwn(value,'healthSchemaPlan'))");if(policy)config=config.replace("assert.equal(value.mobileSchemaPlan,'calendar-basic/1')","assert(['calendar-basic/1','calendar-policy/1'].includes(value.mobileSchemaPlan))");if(consent){config=config.replace("['calendar-basic/1','calendar-policy/1'].includes(value.mobileSchemaPlan)","['calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(value.mobileSchemaPlan)");config=replaceOnce(config,"+(Object.hasOwn(value,'mobileSchemaPlan')?',mobileSchemaPlan':'')","+(Object.hasOwn(value,'mobileSchemaPlan')?',mobileSchemaPlan':'')+(Object.hasOwn(value,'calendarSourceProfile')?',calendarSourceProfile':'')");config=replaceOnce(config," assert.equal(value.schemaVersion,'1.0.0');", " if(Object.hasOwn(value,'calendarSourceProfile')){assert.equal(value.mobileSchemaPlan,'calendar-consent/1');const p=value.calendarSourceProfile;object(p);fields(p,'destinationId,maximumRecordsPerHuman,maximumControlOperationsPerHuman'+(Object.hasOwn(p,'finite')?',finite':''));}\n assert.equal(value.schemaVersion,'1.0.0');");}put(configPath,config);
  const launchPath=join(root,'launch/start-canonical.mjs');let launch=readFileSync(launchPath,'utf8');
  launch=replaceOnce(launch,"from './health-schema-compatibility.mjs'","from './calendar-schema-installed.mjs'");
  launch=replaceOnce(launch,"import {healthReleaseMode,healthCollectionConfigured,validateHealthCodeAdoption} from './health-release-mode.mjs';", "import {calendarReleaseMode as healthReleaseMode,calendarCollectionConfigured as healthCollectionConfigured,validateCalendarCodeAdoption as validateHealthCodeAdoption} from './calendar-release-mode.mjs';");
  launch=replaceOnce(launch,"const selectedHealthPlan=initialHealthSchema.healthSchema||deployment.healthSchemaPlan==='health-basic/1';", "assert.equal(deployment.healthSchemaPlan,undefined,'Calendar package admits only original77 or exact Calendar89');\n  const selectedCalendarPlan=initialHealthSchema.calendarSchema||deployment.mobileSchemaPlan==='calendar-basic/1';");
  launch=replaceOnce(launch,"const selectedSchema=selectedHealthPlan?87:77;","const selectedSchema=selectedCalendarPlan?89:77;");
  launch=replaceOnce(launch,"...(selectedHealthPlan?{healthSchemaPlan:'health-basic/1'}:{})", "...(selectedCalendarPlan?{mobileSchemaPlan:'calendar-basic/1'}:{})");
  launch=replaceOnce(launch,"schemaVersion:'canonical-code-adoption-health-disabled:1.0.0'","schemaVersion:'canonical-code-adoption-calendar-disabled:1.0.0'");if(policy){launch=launch.replace("deployment.mobileSchemaPlan==='calendar-basic/1'","['calendar-basic/1','calendar-policy/1'].includes(deployment.mobileSchemaPlan)");launch=launch.replace("mobileSchemaPlan:'calendar-basic/1'","mobileSchemaPlan:initialHealthSchema.calendarPolicySchema||deployment.mobileSchemaPlan==='calendar-policy/1'?'calendar-policy/1':'calendar-basic/1'");}if(consent){launch="import {calendarProductionLaunchOptions} from './calendar-production-selection.mjs';\n"+launch;launch=launch.replace("['calendar-basic/1','calendar-policy/1'].includes(deployment.mobileSchemaPlan)","['calendar-basic/1','calendar-policy/1','calendar-consent/1'].includes(deployment.mobileSchemaPlan)");launch=replaceOnce(launch,'const selectedSchema=selectedCalendarPlan?89:77;',"const selectedSchema=initialHealthSchema.calendarConsentSchema||deployment.mobileSchemaPlan==='calendar-consent/1'?90:selectedCalendarPlan?89:77;");launch=replaceOnce(launch,"mobileSchemaPlan:initialHealthSchema.calendarPolicySchema||deployment.mobileSchemaPlan==='calendar-policy/1'?'calendar-policy/1':'calendar-basic/1'","mobileSchemaPlan:initialHealthSchema.calendarConsentSchema||deployment.mobileSchemaPlan==='calendar-consent/1'?'calendar-consent/1':initialHealthSchema.calendarPolicySchema||deployment.mobileSchemaPlan==='calendar-policy/1'?'calendar-policy/1':'calendar-basic/1'");launch=replaceOnce(launch,'...ctOptions,...presenceOptions,','...ctOptions,...presenceOptions,...calendarProductionLaunchOptions(deployment,marker.sessionEnvironmentId),');}put(launchPath,launch);
  // Compiler is supplied explicitly; no dependency install, network or server run.
  assert(tsc&&existsSync(tsc),'Explicit existing TypeScript compiler required');
  const build=execFileSync(node,[tsc,'-b','apps/server','--force','--pretty','false'],{cwd:backend,encoding:'utf8',maxBuffer:8*1024*1024});put(join(output,mode+'-build.log'),build);
  for(const dir of ['packages/contracts/src/schemas','packages/storage-sqlite/src/migrations'])for(const n of readdirSync(join(backend,dir)).filter(n=>dir.endsWith('migrations')?n.endsWith('.sql'):n.endsWith('.json'))){const dest=dir.replace('/src/','/dist/');put(join(backend,dest,n),readFileSync(join(backend,dir,n)));}
  const after=inventory(root),changes=Object.keys(after).filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]));
  const removed=Object.keys(before).filter(p=>!Object.hasOwn(after,p));assert.deepEqual(removed,[],'No captured base file removal');
  const sourceAllowed=new Set(scope.exactPaths.map(p=>'backend/'+p));
  const launchAllowed=new Set(['launch/start-canonical.mjs','launch/real-configuration.mjs','launch/ownership-metadata.mjs','launch/calendar-schema-compatibility.mjs','launch/calendar-schema-installed.mjs','launch/calendar-release-mode.mjs',...(consent?['launch/calendar-production-selection.mjs']:[])]);
  for(const p of changes)assert(sourceAllowed.has(p)||p==='backend/'+deliveryFixture||p==='backend/'+calendar86||launchAllowed.has(p)||Object.hasOwn(buildTypes,p)||/^backend\/(?:apps|packages)\/[^/]+\/(?:dist\/|tsconfig\.tsbuildinfo$)/.test(p),'Unexpected package delta: '+p);
  changedByMode[mode]=changes;
  put(join(root,'CALENDAR-PREPARATION.json'),JSON.stringify({schemaVersion:'calendar-source-preparation/1',mode,activationPerformed:false,collectionConfigured:false,defaultSchema:77,optionalSchema:consent?[84,86,87,89,90]:policy?[84,86,87,89]:[84,86,89],originalFamilySchemaCeiling:73,sourceHashes,buildDeclarationDependency:buildTypes,syntheticDeliveryFixtureSHA256:sha(readFileSync(join(source,deliveryFixture))),baseSourceManifestSHA256:sha(readFileSync(join(base,'prepared-source-manifest.json'))),changedPaths:changes},null,2)+'\n');
  const sourceManifest={schemaVersion:'calendar-prepared-source/1',containsPrivateAssets:false,files:inventory(root)};delete sourceManifest.files['SOURCE-MANIFEST.json'];delete sourceManifest.files['prepared-source-manifest.json'];put(join(root,'SOURCE-MANIFEST.json'),JSON.stringify(sourceManifest,null,2)+'\n');
  const all=inventory(root);delete all['prepared-source-manifest.json'];
  put(join(root,'prepared-source-manifest.json'),JSON.stringify({schemaVersion:'canonical-package:1.0.0',candidateId:packageId,containsPrivateAssets:false,files:Object.entries(all).map(([path,v])=>({path,...v}))},null,2)+'\n');
 }
 assert.deepEqual(inventory(base),before,'Original current release changed during preparation');
 for(const [path,digest] of Object.entries(sourceHashes))assert.equal(sha(readFileSync(join(source,path))),digest,'Source changed during preparation: '+path);
 const result={status:'preparedSourceOnly',source,base,output,liveActions:false,baseUnchanged:true,sourceHashes,changedByMode,candidateManifestSHA256:sha(readFileSync(join(output,'candidate/prepared-source-manifest.json'))),recoveryManifestSHA256:sha(readFileSync(join(output,'recovery/prepared-source-manifest.json')))};put(join(output,'PREPARATION-RESULT.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const consent=args.at(-1)==='--consent';if(consent)args.pop();const policy=true;if(args.at(-1)==='--policy')args.pop();assert(args.length===6&&args[0]==='--base'&&args[2]==='--output'&&args[4]==='--tsc','Use --base SOURCE_RELEASE --output FRESH_ISOLATED_ROOT --tsc EXISTING_COMPILER');
 const result=await prepareCalendarBackend({base:args[1],output:args[3],tsc:args[5],policy,consent});console.log(JSON.stringify(result));
}
