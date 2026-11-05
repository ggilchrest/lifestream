import {inspectOptionalPresentationRuntimeConfiguration,loadOptionalPresentationRuntime} from './presentation-runtime.mjs';
import {createSelectedCtJobLifecycle,isSelectedCtJobLifecycle} from './ct-job-lifecycle-owner.mjs';
import {inspectOptionalDedicatedCtSelection,loadOptionalDedicatedCtSelection} from './ct-dedicated-selection.mjs';
import {registerDedicatedCtJob} from './dedicated-ct-job.mjs';
import {createDedicatedCtEvidenceArchive} from './ct-evidence-archive.mjs';
import {assertCompatibleSchema,verifyOriginalBackend,revokeReturningForRecovery,RECOVERY_MODE,MIGRATION_IDENTITY_SHA256} from './schema74-compatibility.mjs';
import {createOptionalPresenceOptions} from './optional-presence.mjs';
// Staged launcher. --check reads this deployment document and path metadata only;
// --activate is a separate operator action; existing installation adoption requires
// its explicit exact-path configuration and original ownership evidence.
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {createServer} from 'node:net';
import {open,lstat,readFile,realpath,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {acquireLauncherLock} from './launcher-lock.mjs';
import {validateDeployment,providerConfiguration,validateAdoption,candidateId} from './real-configuration.mjs';
import {readOwnershipMetadata,assertOwnershipPreserved,providerBindingMetadata,adoptionPhase} from './ownership-metadata.mjs';
import {regularFile} from './owner-file.mjs';
import {inspectOptionalCanonicalCtConfiguration,loadOptionalCanonicalCtOptions,inspectOptionalCanonicalNativeObservationConfiguration,loadOptionalCanonicalNativeObservationOptions} from './ct-composition.mjs';

process.umask(0o077);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
async function directory(path,privateRoot=false){
 let cursor='/';for(const part of path.split('/').filter(Boolean)){
  cursor=join(cursor,part);const stat=await lstat(cursor);
  assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Real directories required');
  try{await lstat(join(cursor,'.git'));throw Error('Operator files and state must remain outside Git');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(privateRoot&&(cursor.startsWith('/srv/lifestream/workspace/runtime-state/real-daily/')||cursor.startsWith('/srv/lifestream/deployment/state/daily')||['/srv/lifestream/deployment','/srv/lifestream/deployment/state','/srv/lifestream/deployment/state/lifestream','/srv/lifestream/deployment/state/presentation-catalog'].some(path=>cursor===path)||cursor.startsWith('/srv/lifestream/deployment/state/lifestream/')||cursor.startsWith('/srv/lifestream/deployment/state/presentation-catalog/')))assert.ok(stat.uid===1000&&stat.gid===1000&&(stat.mode&0o777)===0o700,'Preserved state directories must be owner-only');
 }
}
let app,ctJob,ctArchive,launcherLock,installationPort,closing,started=false,stopping=false,stage='configuration';
async function releaseInstallationPort(){
 if(!installationPort)return;
 const server=installationPort;installationPort=null;
 await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
async function reserveInstallationPort(deployment){
 // The legacy service does not hold our launcher lock. Its unit must already
 // be stopped and its DB descriptors closed before approved adoption. Holding
 // its exact loopback port additionally rejects an active legacy listener
 // before any native constructor can migrate state. This is not a DB lock.
 const server=createServer(socket=>socket.destroy());
 await new Promise((resolve,reject)=>{
  const failed=error=>{server.removeListener('listening',ready);reject(error);};
  const ready=()=>{server.removeListener('error',failed);resolve();};
  server.once('error',failed);server.once('listening',ready);
  server.listen({host:deployment.host,port:deployment.port,exclusive:true});
 });
 installationPort=server;
}
function closeCtArchive(){const owner=ctArchive;ctArchive=undefined;owner?.close();}
async function close(){
 if(closing)return closing;
 closing=(async()=>{
  try{try{if(ctJob)await ctJob.close();}finally{try{closeCtArchive();}finally{if(app)await app.shutdown();}}}finally{await releaseInstallationPort();}
  if(launcherLock){await launcherLock.release();launcherLock=null;}
  emit({event:'closed',statePreserved:true});
 })();return closing;
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;if(started)void close().catch(()=>{emit({event:'failed',stage:'shutdown'});process.exitCode=1;});});
try{
 assert.equal(process.getuid(),1000);assert.equal(process.getgid(),1000);
 const args=process.argv.slice(2);
 assert.ok(args.length===3&&['--check','--start'].includes(args[0])&&args[1]==='--config','Use --check|--start --config ABSOLUTE_JSON');
 const configPath=resolve(args[2]);await directory(dirname(configPath));
 const deployment=validateDeployment(JSON.parse((await regularFile(configPath,8192)).toString('utf8')));
 await directory(root);
 if(args[0]==='--check'){
  // No provider profile, environment value, auth/private state body, database,
  // provider constructor, listener or state write is consumed in this mode.
  const ctMetadata=await inspectOptionalCanonicalCtConfiguration(deployment,{directory,releaseRoot:root});
  const nativeObservationMetadata=await inspectOptionalCanonicalNativeObservationConfiguration(deployment,{directory,releaseRoot:root});
  const dedicatedMetadata=await inspectOptionalDedicatedCtSelection(deployment,{directory});
  const presentationRuntimeMetadata=await inspectOptionalPresentationRuntimeConfiguration(deployment,{directory});
  const profile=await lstat(deployment.providerConfigurationPath);
  assert.ok(profile.isFile()&&!profile.isSymbolicLink()&&profile.uid===1000&&(profile.mode&0o077)===0,'Owner-only original provider configuration required');
  emit({event:'source-check',candidateId,activationPerformed:false,host:deployment.host,port:deployment.port,stateLayout:{database:'data.sqlite',authentication:'safety',artifacts:'artifacts'},historyRetention:deployment.historyRetention,gatewayAssociationVerified:false,providerProfileBodyRead:false,...(presentationRuntimeMetadata.configured?{presentationRuntimeConfigured:true,presentationRuntimeConfigurationBodyRead:false}:{}),...(dedicatedMetadata.configured?{dedicatedCtConfigured:true,dedicatedCtConfigurationBodyRead:false}:{}),...(ctMetadata.configured?{ctConfigured:true,ctConfigurationBodyRead:false}:{}),...(nativeObservationMetadata.configured?{nativeObservationConfigured:true,nativeObservationConfigurationBodyRead:false}:{})});
 }else{
  stage='existing-installation-exclusion';await reserveInstallationPort(deployment);
  stage='adoption-preflight';
  await directory(deployment.stateDirectory,true);await directory(deployment.presentationDirectory,true);await directory(dirname(deployment.providerConfigurationPath));
  launcherLock=await acquireLauncherLock(deployment.stateDirectory,candidateId);
  const manifestBytes=await regularFile(join(root,'prepared-source-manifest.json'),2*1024*1024);
  const manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
  const manifest=JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.candidateId,candidateId);assert.equal(manifest.schemaVersion,'canonical-package:1.0.0');assert.equal(manifest.containsPrivateAssets,false);
  for(const row of manifest.files){
   const path=resolve(root,row.path);assert.ok(path.startsWith(root+'/'));
   const stat=await lstat(path);
   if(row.symlink!==undefined){assert.ok(stat.isSymbolicLink());const {readlink,realpath}=await import('node:fs/promises');assert.equal(await readlink(path),row.symlink);assert.ok((await realpath(path)).startsWith(root+'/'));}
   else{assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);assert.equal(stat.size,row.bytes);assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),row.sha256);}
  }
  verifyOriginalBackend(root);
  const adoption=JSON.parse((await regularFile(deployment.stateAdoptionReceiptPath,8192)).toString('utf8'));validateAdoption(adoption,deployment,manifestHash);
  const config=providerConfiguration(JSON.parse((await regularFile(deployment.providerConfigurationPath,65536)).toString('utf8')),deployment.stateDirectory);
  const baseline=JSON.parse((await regularFile(deployment.ownershipBaselinePath,65536)).toString('utf8'));
  const adoptionMarkerPath=join(deployment.stateDirectory,'daily-adoption.json');
  const adoptionMarker=JSON.parse((await regularFile(adoptionMarkerPath,2048)).toString('utf8'));
  adoptionPhase(adoptionMarker,deployment.stateDirectory,join(deployment.stateDirectory,'data.sqlite'));
  const codeAdoptionPath=join(deployment.stateDirectory,candidateId+'-adoption.json');
  let codeAdoption;
  try{codeAdoption=JSON.parse((await regularFile(codeAdoptionPath,2048)).toString('utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(codeAdoption){
   assert.equal(Object.keys(codeAdoption).sort().join(','),['schemaVersion','candidateId','stateDirectory','manifestSha256','schemaCeiling','initialOwnershipSha256','originalFamilySchemaCeiling','migrationIdentitySha256'].sort().join(','));
   assert.equal(codeAdoption.schemaVersion,'canonical-code-adoption74:1.0.0');assert.equal(codeAdoption.candidateId,candidateId);assert.equal(codeAdoption.stateDirectory,deployment.stateDirectory);assert.equal(codeAdoption.manifestSha256,manifestHash);assert.equal(codeAdoption.schemaCeiling,74);assert.equal(codeAdoption.originalFamilySchemaCeiling,73);assert.equal(codeAdoption.migrationIdentitySha256,MIGRATION_IDENTITY_SHA256);assertCompatibleSchema(join(deployment.stateDirectory,'data.sqlite'));assert.match(codeAdoption.initialOwnershipSha256,/^[a-f0-9]{64}$/);
   assert.equal(codeAdoption.initialOwnershipSha256,createHash('sha256').update(JSON.stringify(baseline.ownership)).digest('hex'),'Historical ownership baseline integrity changed');
  }else{
   // This is only the FIRST adoption of these exact code bytes. The activation
   // helper captures then-current CLOSED metadata; later ordinary saves must
   // never be compared to this historic adoption baseline or restored from it.
   assert.deepEqual(providerBindingMetadata(config),baseline.providerBinding,'Preserve then-current provider configuration');
   assertOwnershipPreserved(readOwnershipMetadata(join(deployment.stateDirectory,'data.sqlite')),baseline.ownership);
  }
  const marker=JSON.parse((await regularFile(join(deployment.stateDirectory,'candidate.json'),8192)).toString('utf8'));
  assert.equal(marker.kind,'lifestream-v01-candidate');assert.equal(marker.profile,config.profile);
  assert.match(marker.sessionEnvironmentId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  const ctOptions={...await loadOptionalCanonicalCtOptions(deployment,{directory,releaseRoot:root,environmentId:marker.sessionEnvironmentId,capture:async(bytes,pin)=>{const {captureCanonicalCtOptions}=await import('../backend/apps/server/src/runtime/canonical-ct-configuration.ts');return captureCanonicalCtOptions(bytes,pin);}}),
   ...await loadOptionalCanonicalNativeObservationOptions(deployment,{directory,releaseRoot:root,environmentId:marker.sessionEnvironmentId,capture:async(bytes,pin)=>{const {captureCanonicalNativeObservationOptions}=await import('../backend/apps/server/src/runtime/native-observation-configuration.ts');return captureCanonicalNativeObservationOptions(bytes,pin);}})};
  // Only inspect existence/permissions of original auth files here. Their
  // contents are consumed solely by the unchanged native authentication owner.
  for(const path of [join(deployment.stateDirectory,'data.sqlite'),join(deployment.stateDirectory,'safety','authentication-key'),join(deployment.stateDirectory,'safety','owner-enrolled')]){
   const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===1000&&stat.gid===1000&&stat.nlink===1&&(stat.mode&0o077)===0);
  }
  for(const name of ['safety','artifacts'])await directory(join(deployment.stateDirectory,name),true);
  const journal=join(deployment.stateDirectory,'safety','conversation-retention-policy');
  if(adoptionMarker||deployment.historyRetention.journalInitialization==='requireExisting')await directory(journal,true);
  stage='launcher-lock';
  assert.ok(launcherLock);
  if(launcherLock.recovered)emit({event:'launcher-lock-recovered',...launcherLock.recovered});
  if(stopping){await close();}else{
   stage='canonical-start';
   if(RECOVERY_MODE){
    stage='durable-returning-withdrawal';
    const withdrawal=revokeReturningForRecovery(join(deployment.stateDirectory,'data.sqlite'));
    const path=join(deployment.stateDirectory,'canonical74-recovery-withdrawal-'+process.pid+'-'+Date.now()+'.json');
    const fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await fd.writeFile(JSON.stringify({...withdrawal,candidateId,stateDirectory:deployment.stateDirectory})+'\n');await fd.sync();}finally{await fd.close();}
    const parent=await open(deployment.stateDirectory,constants.O_RDONLY|constants.O_DIRECTORY);try{await parent.sync();}finally{await parent.close();}
    emit({event:'returning-preferences-withdrawn',...withdrawal});
   }
   stage='presentation-runtime-capture';
   const trustedPresentationRuntime=await loadOptionalPresentationRuntime(deployment,{directory,capture:async config=>{const {captureTrustedRuntime}=await import('../backend/apps/server/src/admin/presentation-runtime-registry.ts');return captureTrustedRuntime(config);}});
   stage='canonical-start';
   const {createLifestreamServer}=await import('../backend/apps/server/src/index.ts');
   const presenceOptions=createOptionalPresenceOptions(); // Inert until separately configured owner ports are explicitly supplied.
   app=createLifestreamServer({...ctOptions,...presenceOptions,config,host:deployment.host,port:deployment.port,sessionEnvironmentId:marker.sessionEnvironmentId,
    ...(deployment.loopbackBrowserOrigin?{loopbackBrowserOrigin:deployment.loopbackBrowserOrigin}:{}),
    conversationMemoryRecall:{mode:'idle',waitBudgetMs:0,fallback:'ordinary-context',warmOnMiss:true},
    historyStateRoot:deployment.stateDirectory,controlUiDirectory:join(root,'backend/apps/control-web'),historyRetention:{...deployment.historyRetention,journalInitialization:'requireExisting'},
    localAuth:{stateDirectory:join(deployment.stateDirectory,'safety'),...(deployment.personalSessionPolicy?{personalSessionPolicy:deployment.personalSessionPolicy}:{})},audiencePrivacy:{},
    presentationPackages:{directory:deployment.presentationDirectory,...(trustedPresentationRuntime?{trustedRuntime:trustedPresentationRuntime}:{})},...(config.providers.capability==='public-github'?{githubPublic:{enabled:true}}:{})});
   assertCompatibleSchema(join(deployment.stateDirectory,'data.sqlite'));
   if(!codeAdoption){
    assertOwnershipPreserved(readOwnershipMetadata(join(deployment.stateDirectory,'data.sqlite')),baseline.ownership,{afterMigration:true});
    const fd=await open(codeAdoptionPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await fd.writeFile(JSON.stringify({schemaVersion:'canonical-code-adoption74:1.0.0',candidateId,stateDirectory:deployment.stateDirectory,manifestSha256:manifestHash,schemaCeiling:74,originalFamilySchemaCeiling:73,migrationIdentitySha256:MIGRATION_IDENTITY_SHA256,initialOwnershipSha256:createHash('sha256').update(JSON.stringify(baseline.ownership)).digest('hex')})+'\n');await fd.sync();}finally{await fd.close();}
    const directory=await open(deployment.stateDirectory,constants.O_RDONLY|constants.O_DIRECTORY);try{await directory.sync();}finally{await directory.close();}
   }
   if(stopping){await close();}else{
    await releaseInstallationPort();
    await app.start();started=true;
    if(stopping)await close();else{
     const acceptingInteractions=app.health.acceptingInteractions===true;
     if(deployment.ctDedicatedJob&&acceptingInteractions){
      let dedicatedCt;
      try{
       dedicatedCt=await loadOptionalDedicatedCtSelection(deployment,{directory,releaseRoot:root,environmentId:marker.sessionEnvironmentId,capture:async(bytes,pin)=>{const {captureCanonicalCtOptions}=await import('../backend/apps/server/src/runtime/canonical-ct-configuration.ts');return captureCanonicalCtOptions(bytes,pin);}});
       if(!stopping){
        // Trusted local per-attempt diagnostic only; no deployment/env/HTTP switch.
        assert.equal(dedicatedCt.selection.jobId,"167e5847-c966-47e7-9760-c24c05a0a7a3");
        assert.equal(dedicatedCt.configuration.template.runId,"c1d8ec26-9d1d-4929-8a78-8b9f03a75448");
        assert.equal(dedicatedCt.configuration.nativePreparation.stateRoot,"/srv/lifestream/workspace/runtime-state/ct-native-owner-167e5847-c966-47e7-9760-c24c05a0a7a3");
        const privateCaptureDirectory="/srv/lifestream/workspace/runtime-state/ct-private-exact-167e5847-c966-47e7-9760-c24c05a0a7a3";
        const privateCaptureStat=await lstat(privateCaptureDirectory);
        assert.ok(privateCaptureStat.isDirectory()&&!privateCaptureStat.isSymbolicLink()
          &&privateCaptureStat.uid===1000&&privateCaptureStat.gid===1000
          &&(privateCaptureStat.mode&0o777)===0o700);
        assert.equal(await realpath(privateCaptureDirectory),privateCaptureDirectory);
        assert.equal((await readdir(privateCaptureDirectory)).length,0);
        app.configureDedicatedCtPrivateRequestCapture({enabled:true,
          jobId:"167e5847-c966-47e7-9760-c24c05a0a7a3",runId:"c1d8ec26-9d1d-4929-8a78-8b9f03a75448",directory:privateCaptureDirectory});
        ctArchive=createDedicatedCtEvidenceArchive(dedicatedCt.selection.jobRoot);
        const lifecycle=['canonical-dedicated-ct-job/3','canonical-dedicated-ct-job/4'].includes(dedicatedCt.selection.schemaVersion)?app.prepareDedicatedCtLifecycle(dedicatedCt.selection.execution,createSelectedCtJobLifecycle,isSelectedCtJobLifecycle,ctArchive.diagnostic):undefined;
        ctJob=await registerDedicatedCtJob(app,{...dedicatedCt,...(lifecycle?{lifecycle}:{}),evidenceOwner:ctArchive});
        if(stopping){try{await ctJob.close();}finally{closeCtArchive();}}
        // Launcher ownership recovery never authorizes replay of a consumed CT job.
        else void ctJob.completion.then(result=>{closeCtArchive();emit(result?.status==='CONSUMED_NO_RETRY'?{event:'dedicated-ct-job-refused',code:'ct_job_consumed_no_retry',recoveryRequired:'NOJOB',modelActionProven:false}:{event:'dedicated-ct-job-settled',modelActionProven:false});},()=>{closeCtArchive();emit({event:'dedicated-ct-job-refused',modelActionProven:false});}).catch(()=>emit({event:'dedicated-ct-job-refused',modelActionProven:false}));
       }
      }
      catch{try{closeCtArchive();}finally{emit({event:'dedicated-ct-job-refused',modelActionProven:false});}}
      finally{dedicatedCt?.configurationBytes.fill(0);}
     }
     if(!stopping)emit({event:acceptingInteractions?'ready':'administration-only',candidateId,url:`http://127.0.0.1:${app.address().port}/daily/`,startupMode:acceptingInteractions?'ready':'administrationOnly',acceptingInteractions,providers:config.providers,retentionRequiresUserGrant:true,gatewayAssociationVerified:false,hardwareSourcesComposed:false});
    }
   }
  }
 }
}catch{emit({event:'failed',stage});process.exitCode=1;try{await close();}catch{emit({event:'failed',stage:'cleanup'});}}
