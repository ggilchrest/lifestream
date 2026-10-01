import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {candidateConfiguration,candidateInstallerToken} from './candidate-configuration.mjs';

test('external profile is validated without creating state and retains exact operator provider identities',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lf-profile-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'configuration.json');const config=await candidateConfiguration({profile:'ai5090'});config.providers.inference='llama-cpp-local';config.inferenceProfile={runtime:'llama.cpp',runtimeVersion:'fixture-revision',model:'fixture',modelRevision:'fixture',servedModelName:'exact-linux-model',quantization:'Q4_K_M',contextLength:8192,endpoint:'http://127.0.0.1:30000',modelArtifactDigest:'sha256:fixture',developmentOnly:true};config.ttsProfile.endpoint='http://127.0.0.1:8787';await writeFile(path,JSON.stringify(config));const result=await candidateConfiguration({configurationPath:path});assert.equal(result.profile,'ai5090');assert.equal(result.inferenceProfile.servedModelName,'exact-linux-model');assert.equal(result.inferenceProfile.contextLength,8192);assert.equal(result.providers.inference,'llama-cpp-local');assert.equal(result.providerRequirements.stt,'required');assert.equal(result.ttsProfile.endpoint,'http://127.0.0.1:8787');await assert.rejects(candidateConfiguration({profile:'test',configurationPath:path}));await writeFile(path,'{"unknown":true}');await assert.rejects(candidateConfiguration({configurationPath:path}));await mkdir(join(dir,'.git'));await assert.rejects(candidateConfiguration({configurationPath:path}),/outside Git roots/);
});
test('enrolled state does not read or require an installer token, while fresh setup still requires its existing token file',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'lf-enrolled-'));t.after(()=>rm(dir,{recursive:true,force:true}));await assert.rejects(candidateInstallerToken(dir));await mkdir(join(dir,'safety'));await writeFile(join(dir,'safety','owner-enrolled'),'fixture-presence-only');assert.equal(await candidateInstallerToken(dir),undefined);
});
