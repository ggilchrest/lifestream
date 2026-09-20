// Local candidate host. Provider credentials stay in the server environment.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,realpath,chmod} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadProfile} from '../apps/server/src/config/loader.ts';
const args=process.argv.slice(2),values={};
if(args.includes('--help')){console.log('node scripts/start-candidate.mjs --directory OUTSIDE_GIT [--presentations PRIVATE_PACKAGE_DIRECTORY] [--profile ai5090|test] [--port 43182]');process.exit(0);}
for(let i=0;i<args.length;i+=2){assert.ok(['--directory','--presentations','--profile','--port'].includes(args[i])&&args[i+1],'Unknown or incomplete option');values[args[i]]=args[i+1];}
assert.ok(values['--directory'],'An operator-local state directory is required');
const directory=resolve(values['--directory']);await mkdir(directory,{recursive:true,mode:0o700});const canonical=await realpath(directory);
for(let p=canonical;;p=dirname(p)){assert.equal(existsSync(join(p,'.git')),false,'Candidate state must be outside Git roots');if(dirname(p)===p)break;}
await chmod(canonical,0o700);const marker=join(canonical,'candidate.json'),tokenFile=join(canonical,'installer-token.txt');
const profile=values['--profile']??'ai5090';assert.ok(['test','ai5090'].includes(profile),'Use the existing selected development profile or explicitly labeled fixtures');
if(existsSync(marker)){const saved=JSON.parse(await readFile(marker,'utf8'));assert.equal(saved.kind,'lifestream-v01-candidate');assert.equal(saved.profile,profile,'Candidate provider selection cannot change on restart');}
else{assert.equal(existsSync(join(canonical,'data.sqlite')),false,'Use an empty candidate directory');await writeFile(marker,JSON.stringify({kind:'lifestream-v01-candidate',profile,createdAt:new Date().toISOString()},null,2),{mode:0o600,flag:'wx'});await writeFile(tokenFile,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});}
const config=loadProfile(profile);config.authority.authentication='local-password';config.storage={databasePath:join(canonical,'data.sqlite'),artifactDirectory:join(canonical,'artifacts')};
const port=Number(values['--port']??43182);assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535,'Invalid local port');
const app=createLifestreamServer({config,host:'127.0.0.1',port,localAuth:{stateDirectory:join(canonical,'safety'),installerToken:(await readFile(tokenFile,'utf8')).trim()},...(values['--presentations']?{presentationPackages:{directory:await realpath(values['--presentations'])}}:{})});
try{await app.start();if(app.health.status!=='ready')throw Error('Required selected providers are unavailable; no fallback was selected.');console.log(JSON.stringify({url:`http://127.0.0.1:${app.address().port}/control/#conversation`,profile,fixture:profile==='test',stateDirectory:canonical,installerTokenFile:tokenFile,health:app.health},null,2));}
catch(error){await app.shutdown();throw error;}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.shutdown().then(()=>process.exit(0)));
