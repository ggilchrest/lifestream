import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {loadConfig,loadProfile} from '../apps/server/src/config/loader.ts';

// Validate operator configuration before any candidate/authentication writes.
export async function candidateConfiguration({profile,configurationPath}={}){
  if(configurationPath===undefined){const selected=profile??'ai5090';assert.ok(['test','ai5090'].includes(selected),'Use the existing selected development profile or explicitly labeled fixtures');return loadProfile(selected);}
  assert.equal(profile,undefined,'Choose --config or --profile');
  const path=await realpath(resolve(configurationPath));
  for(let p=dirname(path);;p=dirname(p)){assert.equal(existsSync(resolve(p,'.git')),false,'Operator configuration must be outside Git roots');if(dirname(p)===p)break;}
  const bytes=await readFile(path);assert.ok(bytes.length>0&&bytes.length<=65536,'Operator configuration must be bounded JSON');
  return loadConfig({defaults:{},profile:JSON.parse(bytes.toString('utf8')),environment:{},cli:{}});
}

export async function candidateInstallerToken(stateDirectory){
  // An enrolled migration preserves its safety state and closes fresh setup.
  if(existsSync(resolve(stateDirectory,'safety','owner-enrolled')))return undefined;
  return (await readFile(resolve(stateDirectory,'installer-token.txt'),'utf8')).trim();
}
