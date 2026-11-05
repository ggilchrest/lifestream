// Fixed private launcher selection; JSON cannot name modules or supply actors.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {inspectOwnerFile,regularFile} from './owner-file.mjs';
import {validateDedicatedCtSelection} from './dedicated-ct-job.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateOptionalDedicatedCtSelection(value,{configRoot}={}){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.equal(Object.keys(value).sort().join(','),'configurationPath,configurationSha256,jobPath,jobSha256');
 for(const key of ['jobSha256','configurationSha256'])assert.match(value[key],/^[a-f0-9]{64}$/);
 for(const [key,kind] of [['jobPath','job'],['configurationPath','game']])assert(typeof value[key]==='string'&&new RegExp('^'+configRoot+'/ct52-'+kind+'-[a-f0-9-]{36}\\.json$').test(value[key]));
 return Object.freeze({...value});
}
export async function inspectOptionalDedicatedCtSelection(deployment,{directory}){
 if(!Object.hasOwn(deployment,'ctDedicatedJob'))return {configured:false,bodyRead:false};
 assert(!Object.hasOwn(deployment,'ctGame')&&!Object.hasOwn(deployment,'ctNativeObservation'));
 const selected=validateOptionalDedicatedCtSelection(deployment.ctDedicatedJob,{configRoot:'/srv/lifestream/deployment/config/daily'});
 for(const path of [selected.jobPath,selected.configurationPath]){await directory(dirname(path));await inspectOwnerFile(path,262144);}
 return Object.freeze({configured:true,bodyRead:false});
}
export async function loadOptionalDedicatedCtSelection(deployment,{directory,releaseRoot,environmentId,capture}){
 if(!Object.hasOwn(deployment,'ctDedicatedJob'))return null;
 await inspectOptionalDedicatedCtSelection(deployment,{directory});const selected=deployment.ctDedicatedJob;
 const jobBytes=await regularFile(selected.jobPath,262144),configurationBytes=await regularFile(selected.configurationPath,262144);let templateBytes;
 try{
  assert.equal(hash(jobBytes),selected.jobSha256);assert.equal(hash(configurationBytes),selected.configurationSha256);
  const selection=JSON.parse(jobBytes.toString('utf8')),configuration=JSON.parse(configurationBytes.toString('utf8'));
  validateDedicatedCtSelection(selection,configuration,configurationBytes);
  if(['canonical-dedicated-ct-job/3','canonical-dedicated-ct-job/4'].includes(selection.schemaVersion)){
   assert.equal(selected.jobPath,join('/srv/lifestream/deployment/config/daily','ct52-job-'+selection.jobId+'.json'));
   assert.equal(selected.configurationPath,join('/srv/lifestream/deployment/config/daily','ct52-game-'+selection.jobId+'.json'));
  }
  assert.equal(configuration.template.environmentId,environmentId);assert.equal(selection.configurationSha256,selected.configurationSha256);
  const p=configuration.nativePreparation,n=configuration.nativeInstallation,runId=configuration.template.runId;
  assert.match(runId,/^[a-f0-9-]{36}$/);assert.equal(p.stateRoot,`/srv/lifestream/workspace/runtime-state/ct-native-owner-${selection.jobId}`);
  assert.equal(p.templateFile,join(releaseRoot,'ct','ct-native-template52.json'));
  assert.equal(n.configurationFile,join(p.stateRoot,'facts',runId+'.json'));
  if(Object.hasOwn(n,'frameManifestFile'))assert.equal(n.frameManifestFile,join(p.stateRoot,'facts',runId+'.frame.json'));
  assert.equal(configuration.inferenceQualificationFile,join(p.stateRoot,'inference-qualification.json'));
  templateBytes=await regularFile(p.templateFile,32768);assert.equal(hash(templateBytes),p.templateSha256);
  const template=JSON.parse(templateBytes.toString('utf8'));
  assert(template&&typeof template==='object'&&!Array.isArray(template));
  if(Object.hasOwn(template,'wakePreparation'))assert.equal(template.wakePreparation,'ct50-prefix33/1');
  const pin={configurationSha256:selected.configurationSha256,...Object.fromEntries(['principalId','assistantId','relationshipId','environmentId'].map(k=>[k,configuration.template[k]])),profileId:configuration.profile.profileId,profileRevision:configuration.profile.revision};
  const captured=await capture(configurationBytes,pin);assert.deepEqual(captured,{ubuntuGame:configuration});
  return Object.freeze({selection,configuration:captured.ubuntuGame,configurationBytes:Buffer.from(configurationBytes)});
 }finally{jobBytes.fill(0);configurationBytes.fill(0);templateBytes?.fill(0);}
}
