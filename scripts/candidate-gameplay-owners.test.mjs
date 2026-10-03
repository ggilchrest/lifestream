import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadCandidateGameplayOwners} from './candidate-gameplay-owners.mjs';

test('launcher refuses changed operator code before execution and loads only the pinned outside-Git owner export',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-gameplay-module-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const key='syntheticGameplayModuleExecuted',path=join(root,'owners.mjs'),code=`globalThis.${key}=true; export const gameplayOwners={syntheticOnly:true};\n`;
 await writeFile(path,code);delete globalThis[key];t.after(()=>delete globalThis[key]);
 await assert.rejects(loadCandidateGameplayOwners(path,'a'.repeat(64)),/module changed/);assert.equal(globalThis[key],undefined);
 const digest=createHash('sha256').update(code).digest('hex');assert.deepEqual(await loadCandidateGameplayOwners(path,digest),{syntheticOnly:true});assert.equal(globalThis[key],true);
 await writeFile(path,code+'// changed\n');await assert.rejects(loadCandidateGameplayOwners(path,digest),/module changed/);
});

test('launcher keeps operator owner code outside public Git roots and requires explicit reviewed digest',async t=>{
 const root=await mkdtemp(join(tmpdir(),'synthetic-owner-repo-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'owners.mjs'),code='export const gameplayOwners={syntheticOnly:true};\n';await writeFile(path,code);await writeFile(join(root,'.git'),'synthetic repository marker');
 await assert.rejects(loadCandidateGameplayOwners(path,undefined),/digest required/);
 await assert.rejects(loadCandidateGameplayOwners(path,createHash('sha256').update(code).digest('hex')),/outside Git roots/);
});
