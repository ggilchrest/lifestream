// Synthetic pinned files; no runtime state, native process, or provider profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,chmod} from 'node:fs/promises';
import {readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {directory} from './launcher44-directory-fixture.mjs';
import {validateOptionalCtSelection,inspectOptionalCanonicalNativeObservationConfiguration,loadOptionalCanonicalNativeObservationOptions,loadOptionalCanonicalCtOptions} from '../ct-composition.mjs';
import {captureCanonicalNativeObservationOptions} from '../../../apps/server/src/runtime/native-observation-configuration.ts';
import {C72_STATE,C72_CONTINUATION} from '@lifestream/providers-bizhawk/c72-native-configuration';
const hash=v=>createHash('sha256').update(v).digest('hex');
const reference=new URL('../../../../evidence/launcher46-reference/',import.meta.url),projection=new URL('../../../../evidence/launcher-projection/launch/',import.meta.url);
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ct-observation-launcher-INERT-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const state=join(root,'state'),configRoot=join(root,'config'),releaseRoot=join(root,'release');await mkdir(configRoot);await mkdir(join(releaseRoot,'ct'),{recursive:true});
 const nativeStateRoot='/srv/lifestream/workspace/runtime-state/ct-native-observation-TEST-'+randomUUID(),runId=randomUUID();
 const template={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID(),environmentId:randomUUID(),activityId:randomUUID(),runId,timelineId:randomUUID(),campaignId:randomUUID(),activityEpoch:1,timelineRevision:1,observationDomain:'simulatedGame',ownerPermissionRef:'TEST-observation-only-not-a-controller-grant'};
 const selected={configurationFile:join(configRoot,'observation.json'),configurationSha256:'0'.repeat(64),...Object.fromEntries(['principalId','assistantId','relationshipId','environmentId'].map(k=>[k,template[k]])),profileId:randomUUID(),profileRevision:1,nativeStateRoot,nativeTemplateFile:join(releaseRoot,'ct/native-template.json'),nativeTemplateSha256:hash('TEST-uninterpreted-template')};
 const body={schemaVersion:'ct-native-observation/1',sessionProfile:'nativeObservationOnly',template,profile:{profileId:selected.profileId,revision:1},maximumRunMs:90000,maximumObservations:3,maximumCommandMs:3000,pinsDigest:'a'.repeat(64),providerRef:'TEST-native-source',nativeInstallation:{kind:'c72-container',configurationFile:join(nativeStateRoot,'observation-facts',runId+'.json')},nativePreparation:{stateRoot:nativeStateRoot,templateFile:selected.nativeTemplateFile,templateSha256:selected.nativeTemplateSha256},nativeLaunch:{host:'127.0.0.1',port:43187,continuation:{path:C72_STATE,...C72_CONTINUATION}}};
 const bytes=Buffer.from(JSON.stringify(body));selected.configurationSha256=hash(bytes);await writeFile(selected.configurationFile,bytes,{mode:0o600});await writeFile(selected.nativeTemplateFile,'TEST-uninterpreted-template',{mode:0o400});
 let captures=0,lastBytes;const ports={directory,releaseRoot,environmentId:selected.environmentId,capture:async(raw,pin)=>{captures++;lastBytes=raw;return captureCanonicalNativeObservationOptions(raw,pin);}};
 return {root,bytes,body,selected,ports,deployment:{stage:'qualification',stateDirectory:state,ctNativeObservation:selected},get captures(){return captures;},get lastBytes(){return lastBytes;},async rewrite(v){const b=Buffer.from(JSON.stringify(v));await writeFile(selected.configurationFile,b);selected.configurationSha256=hash(b);}};
}
test('absent observation mode is inert; conflicting purposes reject before any IO or adapter import',async()=>{
 const fail=()=>{throw Error('Unexpected IO');},ports={directory:fail,capture:fail};
 assert.deepEqual(await inspectOptionalCanonicalNativeObservationConfiguration({},ports),{configured:false,bodyRead:false});
 assert.deepEqual(await loadOptionalCanonicalNativeObservationOptions({},ports),{});
 for(const load of [loadOptionalCanonicalNativeObservationOptions,loadOptionalCanonicalCtOptions])await assert.rejects(load({ctGame:{},ctNativeObservation:{}},ports));
});
test('exact canonical observation pin remains separate, frozen, <=90s, provider/model qualification free and buffer-cleared',async t=>{
 const f=await fixture(t),options=await loadOptionalCanonicalNativeObservationOptions(f.deployment,f.ports);
 assert.deepEqual(Object.keys(options),['ubuntuNativeObservation']);assert.deepEqual(options.ubuntuNativeObservation,f.body);assert(Object.isFrozen(options.ubuntuNativeObservation.template));assert(f.lastBytes.every(v=>v===0));assert.equal(f.captures,1);assert.equal(existsSync(f.selected.nativeStateRoot),false);
 await assert.rejects(loadOptionalCanonicalNativeObservationOptions(f.deployment,{...f.ports,environmentId:randomUUID()}));
 const pin={...f.selected,configurationSha256:hash(f.bytes)};
 for(const key of ['principalId','assistantId','relationshipId','environmentId','profileId'])assert.throws(()=>captureCanonicalNativeObservationOptions(f.bytes,{...pin,[key]:randomUUID()}));
 assert.throws(()=>captureCanonicalNativeObservationOptions(f.bytes,{...pin,profileRevision:2}));assert.throws(()=>captureCanonicalNativeObservationOptions(Buffer.concat([f.bytes,Buffer.from(' ')]),pin));
 for(const change of [{maximumRunMs:90001},{maximumObservations:9},{maximumCommandMs:3001},{sessionProfile:'supervisedSession'},{inferenceQualificationFile:'/TEST-no-model'},{controller:{allowed:true}},{sceneProfile:{approved:true}}]){await f.rewrite({...f.body,...change});await assert.rejects(loadOptionalCanonicalNativeObservationOptions(f.deployment,f.ports));}
});
test('metadata check never reads malformed private bodies; start checks exact source/template bytes and purpose namespace',async t=>{
 const f=await fixture(t);await writeFile(f.selected.configurationFile,'TEST invalid JSON');await chmod(f.selected.configurationFile,0);
 assert.deepEqual(await inspectOptionalCanonicalNativeObservationConfiguration(f.deployment,f.ports),{configured:true,bodyRead:false});assert.equal(f.captures,0);
 await chmod(f.selected.configurationFile,0o600);await f.rewrite(f.body);await chmod(f.selected.nativeTemplateFile,0o600);await writeFile(f.selected.nativeTemplateFile,'TEST changed');
 await assert.rejects(loadOptionalCanonicalNativeObservationOptions(f.deployment,f.ports));assert.equal(f.captures,0);
 const configRoot=join(f.root,'config');assert.throws(()=>validateOptionalCtSelection(f.selected,{configRoot}));assert.throws(()=>validateOptionalCtSelection({...f.selected,nativeStateRoot:'/srv/lifestream/workspace/runtime-state/ct-native-supervised-TEST'},{configRoot,observationOnly:true}));
});
function validator(url){let s=readFileSync(new URL('real-configuration.mjs',url),'utf8');s=s.slice(s.indexOf('export const candidateId='),s.indexOf('\nexport function providerConfiguration')).replace(/^export /gm,'');return runInNewContext(s+'\nvalidateDeployment;',{assert,resolve,join,structuredClone,validateOptionalCtSelection});}
test('launcher46 deployment defaults/adoption contract remain exact; observation key is closed and mutually exclusive',()=>{
 const previous=validator(reference),next=validator(projection),state='/srv/lifestream/workspace/runtime-state/real-daily/TEST-not-created/state',configRoot=join(state,'..','config');
 const base={schemaVersion:'1.0.0',candidateId:'canonical-daily37',stage:'qualification',providerConfigurationPath:'/TEST-unused-profile.json',stateDirectory:state,presentationDirectory:join(state,'..','presentation-catalog'),stateAdoptionReceiptPath:join(configRoot,'adoption.json'),ownershipBaselinePath:join(configRoot,'ownership.json'),host:'127.0.0.1',port:43892,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}};
 assert.deepEqual(next(base),previous(base));
 const selected={configurationFile:join(configRoot,'observation.json'),configurationSha256:'a'.repeat(64),principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID(),environmentId:randomUUID(),profileId:randomUUID(),profileRevision:1,nativeStateRoot:'/srv/lifestream/workspace/runtime-state/ct-native-observation-TEST',nativeTemplateFile:'/TEST-release/ct/template.json',nativeTemplateSha256:'b'.repeat(64)};
 assert.throws(()=>previous({...base,ctNativeObservation:selected}));assert.deepEqual(next({...base,ctNativeObservation:selected}).ctNativeObservation,selected);
 for(const change of [{ctNativeObservation:{...selected,approved:true}},{ctGame:selected},{ctNativeObservation:selected,ctGame:{...selected,nativeStateRoot:'/srv/lifestream/workspace/runtime-state/ct-native-supervised-TEST'}},{adoptionMode:'invented'}])assert.throws(()=>next({...base,...change}));
});
test('launcher46 actual server factory keeps every original memory/provider/adoption option for absent or observation input',()=>{
 const source=url=>readFileSync(new URL('start-canonical.mjs',url),'utf8');
 const invoke=(s,ctOptions)=>{const a=s.indexOf('app=createLifestreamServer('),b=s.indexOf('\n   if(!codeAdoption)',a);assert(a>=0&&b>a);let result;const config={providers:{capability:'public-github'},TEST:'original-profile'},deployment={host:'127.0.0.1',port:43892,stateDirectory:'/TEST-state',historyRetention:{mode:'localUserConsent'},presentationDirectory:'/TEST-presentations'},marker={sessionEnvironmentId:'TEST-original-environment'};runInNewContext(s.slice(a,b),{createLifestreamServer:v=>{result=v;},config,deployment,marker,root:'/TEST-release',ctOptions,presenceOptions:{},join});assert.equal(result.config,config);return JSON.parse(JSON.stringify(result));};
 const before=invoke(source(reference),{});assert.deepEqual(invoke(source(projection),{}),before);const input={TEST:'inert-pinned-options'};assert.deepEqual(invoke(source(projection),{ubuntuNativeObservation:input}),{ubuntuNativeObservation:input,...before});assert.deepEqual(before.conversationMemoryRecall,{mode:'idle',waitBudgetMs:0,fallback:'ordinary-context',warmOnMiss:true});
});
