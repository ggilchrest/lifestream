import {validateOptionalPresentationRuntime} from './presentation-runtime.mjs';
import {captureLoopbackBrowserOrigin} from '../backend/apps/server/src/runtime/loopback-browser-origin.ts';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {loadConfig} from '../backend/apps/server/src/config/loader.ts';
import {validateOptionalDedicatedCtSelection} from './ct-dedicated-selection.mjs';
import {validateOptionalCtSelection} from './ct-composition.mjs';

export const candidateId='canonical-daily-voice-title-20261025-r1';
export const deploymentState='/srv/lifestream/deployment/state/lifestream';
const fields=(value,expected)=>assert.equal(Object.keys(value).sort().join(','),expected.split(',').sort().join(','),'Unexpected configuration fields');
const object=value=>assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'An object is required');

export function validateDeployment(value){
 object(value);
 const existing=Object.hasOwn(value,'adoptionMode');
 if(existing)assert.equal(value.adoptionMode,'existingInstallation','Only explicit existing-installation adoption is supported');
 fields(value,'schemaVersion,candidateId,stage,providerConfigurationPath,stateDirectory,presentationDirectory,stateAdoptionReceiptPath,ownershipBaselinePath,host,port,historyRetention'+(existing?',adoptionMode':'')+(Object.hasOwn(value,'ctGame')?',ctGame':'')+(Object.hasOwn(value,'ctNativeObservation')?',ctNativeObservation':'')+(Object.hasOwn(value,'ctDedicatedJob')?',ctDedicatedJob':'')+(Object.hasOwn(value,'personalSessionPolicy')?',personalSessionPolicy':'')+(Object.hasOwn(value,'loopbackBrowserOrigin')?',loopbackBrowserOrigin':'')+(Object.hasOwn(value,'presentationRuntime')?',presentationRuntime':''));
 assert.equal(value.schemaVersion,'1.0.0');assert.equal(value.candidateId,candidateId);
 assert.equal(value.host,'127.0.0.1','Existing loopback transport only');
 if(Object.hasOwn(value,'loopbackBrowserOrigin')){const descriptor=Object.getOwnPropertyDescriptor(value,'loopbackBrowserOrigin');assert.ok(Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='string','Browser origin must be an explicit data string');captureLoopbackBrowserOrigin(descriptor.value);}
 assert.ok(Number.isInteger(value.port)&&value.port>=1024&&value.port<=65535,'A valid owned port is required');
 assert.ok(['qualification','production'].includes(value.stage));
 if(Object.hasOwn(value,'personalSessionPolicy')){
  assert.equal(value.adoptionMode,'existingInstallation','Personal policy is scoped to the existing personal installation');
  const policy=value.personalSessionPolicy;object(policy);
  assert.equal(Object.getPrototypeOf(policy),Object.prototype);
  assert.equal(Reflect.ownKeys(policy).length,4);
  assert.ok(Object.values(Object.getOwnPropertyDescriptors(policy)).every(d=>Object.hasOwn(d,'value')),'Policy must contain data properties');
  fields(policy,'enabled,scope,expiration,windowFocusRequired');
  assert.equal(typeof policy.enabled,'boolean');assert.equal(policy.scope,'installationOwner');
  assert.equal(policy.expiration,'untilRevoked');assert.equal(policy.windowFocusRequired,false);
 }
 for(const key of ['providerConfigurationPath','stateDirectory','presentationDirectory','stateAdoptionReceiptPath','ownershipBaselinePath']){
  assert.equal(typeof value[key],'string');assert.equal(resolve(value[key]),value[key]);
 }
 if(existing){
  // Preserve the installed account's exact state, auth origin and owned assets.
  // This branch still requires the original adoption and ownership evidence.
  assert.equal(value.stage,'production');
  assert.equal(value.stateDirectory,deploymentState);
  assert.equal(value.port,43182);
  assert.equal(value.presentationDirectory,'/srv/lifestream/deployment/state/presentation-catalog');
  assert.equal(value.providerConfigurationPath,'/srv/lifestream/deployment/config/linux-backend-public-github-required-gpu-profile.json');
 }else{
  assert.notEqual(value.port,43182,'Use a separate owned port');
  if(value.stage==='qualification')assert.match(value.stateDirectory,/^\/srv\/lifestream\/workspace\/runtime-state\/real-daily\/[A-Za-z0-9-]+\/state$/,'Use independent development state');
  else assert.equal(value.stateDirectory,'/srv/lifestream/deployment/state/daily/state','Independent production state required');
  assert.equal(value.presentationDirectory,join(value.stateDirectory,'..','presentation-catalog'));
 }
 const configRoot=value.stage==='production'?'/srv/lifestream/deployment/config/daily':join(value.stateDirectory,'..','config');
 if(Object.hasOwn(value,'presentationRuntime')){assert.equal(value.adoptionMode,'existingInstallation');validateOptionalPresentationRuntime(value.presentationRuntime,{configRoot});}
 assert.ok(['ctGame','ctNativeObservation','ctDedicatedJob'].filter(k=>Object.hasOwn(value,k)).length<=1,'Choose one explicit CT purpose');
 if(Object.hasOwn(value,'ctDedicatedJob')){assert.equal(value.adoptionMode,'existingInstallation');validateOptionalDedicatedCtSelection(value.ctDedicatedJob,{configRoot});}
 if(Object.hasOwn(value,'ctGame'))validateOptionalCtSelection(value.ctGame,{configRoot});
 if(Object.hasOwn(value,'ctNativeObservation'))validateOptionalCtSelection(value.ctNativeObservation,{configRoot,observationOnly:true});
 for(const key of ['stateAdoptionReceiptPath','ownershipBaselinePath'])assert.ok(value[key].startsWith(configRoot+'/'),'Use separate versioned deployment configuration');
 object(value.historyRetention);
 fields(value.historyRetention,'mode,retention,journalInitialization');
 assert.equal(value.historyRetention.mode,'localUserConsent');assert.equal(value.historyRetention.retention,'untilDeletion');
 assert.equal(value.historyRetention.journalInitialization,'requireExisting','Existing journals only; enrollment/setup is separate from this launcher');
 return structuredClone(value);
}

export function providerConfiguration(value,stateDirectory){
 object(value);
 // The original provider loader consumes only references to credentials.
 // Reject embedded credential material instead of introducing another resolver.
 function referencesOnly(input){
  if(!input||typeof input!=='object')return;
  for(const [key,child] of Object.entries(input)){
   if(key==='secretRefs'){object(child);for(const ref of Object.values(child)){object(ref);fields(ref,'kind,name');assert.equal(ref.kind,'env');assert.match(ref.name,/^[A-Za-z_][A-Za-z0-9_]*$/);}continue;}
   assert.ok(!/^(password|token|apiKey|api_key|secret|credential|authorization)$/i.test(key),'Credentials must remain original environment references');
   referencesOnly(child);
  }
 }
 referencesOnly(value);
 const config=loadConfig({defaults:{},profile:value,environment:{},cli:{}});
 assert.notEqual(config.profile,'test','Fixture profiles cannot become G');
 assert.ok(['llama-cpp-local','ai5090-development','ollama-mac-local'].includes(config.providers.inference),'Use an existing real inference adapter');
 assert.ok(['nemo-speech','moonshine-mlx'].includes(config.providers.stt),'Use an existing real STT adapter');
 assert.equal(config.providers.tts,'voxcpm','Use the existing TTS adapter');
 assert.ok(config.inferenceProfile&&config.sttProfile&&config.ttsProfile,'Preserve explicit existing provider profiles');
 // Memory/world/capability/renderer may deliberately remain fixture entries,
 // exactly as in the original profiles; this is not an all-real claim.
 config.authority.authentication='local-password';
 config.storage={databasePath:join(stateDirectory,'data.sqlite'),artifactDirectory:join(stateDirectory,'artifacts')};
 return config;
}

export function validateAdoption(value,deployment,preparedManifestSha256){
 object(value);
 fields(value,'schemaVersion,candidateId,preparedManifestSha256,sourceStateDirectory,targetStateDirectory,targetPresentationDirectory,ownerIdentityPreserved,sessionEnvironmentPreserved,authSafetyPreserved,artifactsPreserved,presentationBindingsPreserved,migration74Compatible,deletionJournalPreserved,retentionJournalInitialization');
 assert.equal(value.schemaVersion,'canonical74-adoption:1.0.0');assert.equal(value.candidateId,candidateId);
 assert.equal(value.preparedManifestSha256,preparedManifestSha256);
 assert.equal(value.sourceStateDirectory,deploymentState);
 assert.equal(value.targetStateDirectory,deployment.stateDirectory);assert.equal(value.targetPresentationDirectory,deployment.presentationDirectory);
 for(const key of ['ownerIdentityPreserved','sessionEnvironmentPreserved','authSafetyPreserved','artifactsPreserved','presentationBindingsPreserved','migration74Compatible','deletionJournalPreserved'])assert.equal(value[key],true,`Compatibility evidence required: ${key}`);
 assert.equal(value.retentionJournalInitialization,deployment.historyRetention.journalInitialization);
 return value;
}
