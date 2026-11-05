import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {inspectOwnerFile,regularFile} from './owner-file.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const absolute=value=>typeof value==='string'&&resolve(value)===value&&!value.split('/').some(part=>part==='.'||part==='..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fields=['configurationFile','configurationSha256','principalId','assistantId','relationshipId','environmentId','profileId','profileRevision','nativeStateRoot','nativeTemplateFile','nativeTemplateSha256'];
const configRoot=d=>d.stage==='production'?'/srv/lifestream/deployment/config/daily':join(d.stateDirectory,'..','config');

/** Closed nonsecret deployment selection. These pins are neither an actor nor
 * a native/controller grant. The existing launcher owns deployment/adoption. */
export function validateOptionalCtSelection(value,{configRoot:configurationRoot,observationOnly=false}={}){
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
 assert.equal(Object.keys(value).sort().join(','),[...fields].sort().join(','));
 for(const key of ['principalId','assistantId','relationshipId','environmentId','profileId'])assert.ok(uuid(value[key]),'Existing identity pins required');
 assert.ok(Number.isSafeInteger(value.profileRevision)&&value.profileRevision>=1);
 assert.ok(digest(value.configurationSha256)&&digest(value.nativeTemplateSha256));
 for(const key of ['configurationFile','nativeStateRoot','nativeTemplateFile'])assert.ok(absolute(value[key]),'Canonical absolute paths required');
 assert.ok(typeof configurationRoot==='string'&&value.configurationFile.startsWith(configurationRoot+'/'),'Separate versioned configuration required');
 assert.match(value.nativeStateRoot,/^\/srv\/lifestream\/workspace\/runtime-state\/ct-native-[A-Za-z0-9-]+$/,'Dedicated CT namespace required');
 assert.ok(observationOnly?/^ct-native-observation-/.test(value.nativeStateRoot.split('/').at(-1)):!/^ct-native-observation-/.test(value.nativeStateRoot.split('/').at(-1)),'Disjoint native observation namespace required');
 return Object.freeze({...value});
}

/** --check remains metadata-only: never reads CT/template bodies, native facts,
 * authentication, provider settings or DB state and never creates directories. */
async function inspectSelection(deployment,{directory,releaseRoot},selectionKey,observationOnly){
 assert.ok(!(Object.hasOwn(deployment,'ctGame')&&Object.hasOwn(deployment,'ctNativeObservation')),'Choose one explicit CT purpose');
 if(!Object.hasOwn(deployment,selectionKey))return Object.freeze({configured:false,bodyRead:false});
 const selected=validateOptionalCtSelection(deployment[selectionKey],{configRoot:configRoot(deployment),observationOnly});
 assert.ok(absolute(releaseRoot)&&selected.nativeTemplateFile.startsWith(releaseRoot+'/ct/'),'Template belongs to this exact release');
 assert.equal(typeof directory,'function');
 for(const path of [selected.configurationFile,selected.nativeTemplateFile,selected.nativeStateRoot])await directory(dirname(path));
 await inspectOwnerFile(selected.configurationFile,262144);await inspectOwnerFile(selected.nativeTemplateFile,32768);
 return Object.freeze({configured:true,bodyRead:false});
}

/** Main passes its already reviewed pure captureCanonicalCtOptions function.
 * No default/fallback runtime, module path, model, identity creation or grant.
 * Reads exactly selected owner files using launcher4's unchanged validator. */
async function loadSelection(deployment,{directory,releaseRoot,environmentId,capture},selectionKey,optionKey,observationOnly){
 assert.ok(!(Object.hasOwn(deployment,'ctGame')&&Object.hasOwn(deployment,'ctNativeObservation')),'Choose one explicit CT purpose');
 if(!Object.hasOwn(deployment,selectionKey))return Object.freeze({});
 const selected=validateOptionalCtSelection(deployment[selectionKey],{configRoot:configRoot(deployment),observationOnly});
 assert.equal(environmentId,selected.environmentId,'Original installation environment required');
 assert.equal(typeof capture,'function','Explicit canonical CT source adapter required');
 await inspectSelection(deployment,{directory,releaseRoot},selectionKey,observationOnly);
 const bytes=await regularFile(selected.configurationFile,262144);let template;
 try{
  template=await regularFile(selected.nativeTemplateFile,32768);
  assert.equal(hash(bytes),selected.configurationSha256,'Reviewed CT bytes changed');
  assert.equal(hash(template),selected.nativeTemplateSha256,'Reviewed native template changed');
  const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const {nativePreparation:p,nativeInstallation:n,template:t}=body,factsDirectory=observationOnly?'observation-facts':'facts';
  assert.ok(uuid(t?.runId));assert.equal(p?.stateRoot,selected.nativeStateRoot);assert.equal(p?.templateFile,selected.nativeTemplateFile);assert.equal(p?.templateSha256,selected.nativeTemplateSha256);
  assert.equal(n?.kind,'c72-container');assert.equal(n?.configurationFile,join(selected.nativeStateRoot,factsDirectory,t.runId+'.json'));
  if(Object.hasOwn(n,'frameManifestFile'))assert.equal(n.frameManifestFile,join(selected.nativeStateRoot,factsDirectory,t.runId+'.frame.json'));
  if(observationOnly)assert.equal(Object.hasOwn(body,'inferenceQualificationFile'),false);else assert.equal(body.inferenceQualificationFile,join(selected.nativeStateRoot,'inference-qualification.json'));
  const pin=Object.fromEntries(['configurationSha256','principalId','assistantId','relationshipId','environmentId','profileId','profileRevision'].map(k=>[k,selected[k]]));
  const options=await capture(bytes,pin);
  assert.ok(options&&Object.keys(options).join(',')===optionKey&&isDeepStrictEqual(options[optionKey],body),'CT adapter may supply only its exact pinned CT option');
  return options;
 }finally{bytes.fill(0);template?.fill(0);}
}

// Separate, mutually exclusive purposes; neither can relax the other profile.
export const inspectOptionalCanonicalCtConfiguration=(deployment,ports)=>inspectSelection(deployment,ports,'ctGame',false);
export const inspectOptionalCanonicalNativeObservationConfiguration=(deployment,ports)=>inspectSelection(deployment,ports,'ctNativeObservation',true);
export const loadOptionalCanonicalCtOptions=(deployment,ports)=>loadSelection(deployment,ports,'ctGame','ubuntuGame',false);
export const loadOptionalCanonicalNativeObservationOptions=(deployment,ports)=>loadSelection(deployment,ports,'ctNativeObservation','ubuntuNativeObservation',true);
