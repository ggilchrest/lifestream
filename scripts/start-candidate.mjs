// Local candidate host. Provider credentials stay in the server environment.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,realpath,chmod,rename} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadTelegramConfiguration} from '../apps/server/src/channels/telegram-configuration.ts';
import {PwceConditionClient} from '../packages/providers-pwce/src/conditions.ts';
import {loadCandidateGameplayOwners} from './candidate-gameplay-owners.mjs';
import {candidateConfiguration,candidateInstallerToken} from './candidate-configuration.mjs';
const args=process.argv.slice(2),values={};
if(args.includes('--help')){console.log('node scripts/start-candidate.mjs --directory OUTSIDE_GIT [--presentations PRIVATE_PACKAGE_DIRECTORY] [--profile ai5090|test | --config PRIVATE_JSON] [--port 43182] [--incident-review PRIVATE_CONFIG_JSON] [--urgent-conditions PRIVATE_CONFIG_JSON] [--telegram PRIVATE_CONFIG_JSON] [--game-observation PRIVATE_REVIEWED_JSON | --gameplay-owners PRIVATE_REVIEWED_MODULE --gameplay-owners-sha256 SHA256]');process.exit(0);}
for(let i=0;i<args.length;i+=2){assert.ok(['--directory','--presentations','--profile','--config','--port','--incident-review','--urgent-conditions','--telegram','--game-observation','--gameplay-owners','--gameplay-owners-sha256'].includes(args[i])&&args[i+1]&&values[args[i]]===undefined,'Unknown, duplicate or incomplete option');values[args[i]]=args[i+1];}
assert.equal(!!values['--gameplay-owners'],!!values['--gameplay-owners-sha256'],'Gameplay owner module and digest must be supplied together');
assert.ok(!(values['--gameplay-owners']&&values['--game-observation']),'Select one game composition');
assert.ok(values['--directory'],'An operator-local state directory is required');
const config=await candidateConfiguration({profile:values['--profile'],configurationPath:values['--config']});
const directory=resolve(values['--directory']);await mkdir(directory,{recursive:true,mode:0o700});const canonical=await realpath(directory);
for(let p=canonical;;p=dirname(p)){assert.equal(existsSync(join(p,'.git')),false,'Candidate state must be outside Git roots');if(dirname(p)===p)break;}
await chmod(canonical,0o700);const marker=join(canonical,'candidate.json'),tokenFile=join(canonical,'installer-token.txt');
const profile=config.profile;
if(existsSync(marker)){const saved=JSON.parse(await readFile(marker,'utf8'));assert.equal(saved.kind,'lifestream-v01-candidate');assert.equal(saved.profile,profile,'Candidate provider selection cannot change on restart');}
else{assert.equal(existsSync(join(canonical,'data.sqlite')),false,'Use an empty candidate directory');await writeFile(marker,JSON.stringify({kind:'lifestream-v01-candidate',profile,createdAt:new Date().toISOString()},null,2),{mode:0o600,flag:'wx'});await writeFile(tokenFile,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});}
// Composition owns this opaque local deployment identity; it asserts no PWCE location.
const candidate=JSON.parse(await readFile(marker,'utf8'));
if(candidate.sessionEnvironmentId===undefined){candidate.sessionEnvironmentId=randomUUID();const pending=marker+'.'+randomUUID()+'.tmp';await writeFile(pending,JSON.stringify(candidate,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(pending,marker);}
assert.match(candidate.sessionEnvironmentId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,'Invalid local deployment session identity');
config.authority.authentication='local-password';config.storage={databasePath:join(canonical,'data.sqlite'),artifactDirectory:join(canonical,'artifacts')};
const port=Number(values['--port']??43182);assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535,'Invalid local port');
let incidentReview;if(values['--incident-review']){const file=await realpath(values['--incident-review']);for(let p=dirname(file);;p=dirname(p)){assert.equal(existsSync(join(p,'.git')),false,'Incident credentials must be outside Git');if(dirname(p)===p)break;}incidentReview=JSON.parse(await readFile(file,'utf8'));assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(incidentReview.baseUrl).hostname),'Candidate incident review must use loopback');}
let urgentConditions;if(values['--urgent-conditions']){const file=await realpath(values['--urgent-conditions']);for(let p=dirname(file);;p=dirname(p)){assert.equal(existsSync(join(p,'.git')),false,'Condition credentials must be outside Git');if(dirname(p)===p)break;}const bytes=await readFile(file);assert.ok(bytes.length<=65536,'Condition configuration is too large');try{urgentConditions=JSON.parse(bytes.toString('utf8'));}catch{throw Error('Condition configuration must contain valid JSON');}assert.ok(urgentConditions&&typeof urgentConditions==='object'&&!Array.isArray(urgentConditions)&&Object.keys(urgentConditions).every(key=>['baseUrl','token','worldRef','siteRef','replay','bindings','requestTimeoutMs','pollIntervalMs'].includes(key)),'Invalid condition configuration');assert.ok(['baseUrl','token','worldRef','siteRef'].every(key=>typeof urgentConditions[key]==='string'&&urgentConditions[key].length>0&&urgentConditions[key].length<=8192&&!/[\r\n]/.test(urgentConditions[key]))&&Array.isArray(urgentConditions.bindings),'Condition origin, credential, world, site and bindings are required');let url;try{url=new URL(urgentConditions.baseUrl);}catch{throw Error('Condition configuration requires a valid loopback origin');}assert.ok(['http:','https:'].includes(url.protocol)&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.username&&!url.password,'Candidate conditions must use a loopback origin without embedded credentials');assert.ok(urgentConditions.replay===undefined||typeof urgentConditions.replay==='boolean','Invalid condition replay setting');}
const telegram=values['--telegram']?await loadTelegramConfiguration(resolve(values['--telegram'])):undefined;
if(telegram&&urgentConditions)telegram.localAlerts={source:new PwceConditionClient(urgentConditions),pollIntervalMs:urgentConditions.pollIntervalMs};
let gameObservation;
if(values['--game-observation']){
 const file=await realpath(values['--game-observation']);for(let p=dirname(file);;p=dirname(p)){assert.equal(existsSync(join(p,'.git')),false,'Reviewed observation configuration must be outside Git');if(dirname(p)===p)break;}
 const bytes=await readFile(file);assert.ok(bytes.length<=32768,'Reviewed observation configuration too large');gameObservation=JSON.parse(bytes.toString('utf8'));
}
const gameplayOwners=values['--gameplay-owners']?await loadCandidateGameplayOwners(values['--gameplay-owners'],values['--gameplay-owners-sha256']):undefined;
const app=createLifestreamServer({...(gameplayOwners?{gameplayOwners}:{}),...(gameObservation?{gameObservation}:{}),...(telegram?{telegram}:{}),sessionEnvironmentId:candidate.sessionEnvironmentId,...(incidentReview?{incidentReview}:{}),...(urgentConditions?{urgentConditions}:{}),config,audiencePrivacy:{},host:'127.0.0.1',port,localAuth:{stateDirectory:join(canonical,'safety'),installerToken:await candidateInstallerToken(canonical)},...(values['--presentations']?{presentationPackages:{directory:await realpath(values['--presentations'])}}:{})});
try{await app.start();console.log(JSON.stringify({url:`http://127.0.0.1:${app.address().port}/control/#conversation`,profile,fixture:profile==='test',telegram:{configured:!!telegram,enabled:telegram?.enabled()??false,alertsConfigured:!!telegram?.localAlerts},stateDirectory:canonical,installerTokenFile:tokenFile,startupMode:app.health.acceptingInteractions?'ready':'administrationOnly',...(app.health.acceptingInteractions?{}:{notice:'Required selected providers are unavailable. Authenticated administration remains available; conversation is unavailable and no fallback was selected.'}),health:app.health},null,2));}
catch(error){await app.shutdown();throw error;}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.shutdown().then(()=>process.exit(0)));
