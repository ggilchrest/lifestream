import {ORDINARY_GAME_SESSION_LIMITS} from '@lifestream/contracts/game-host';
import {mkdirSync,readdirSync,writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {C72_IMAGE,C72_SOURCES,C72_KNOWN_PINS,C72_WRAPPER,C72_SECCOMP,C72_FRONTEND,C72_STATE,C72_CONTINUATION,readNativeFile,canonicalNativePath,fileDigest,scopeDigest,readC72NativeConfiguration} from './c72-native-configuration.ts';
import {captureWakePreparation} from './ct-wake-prelude.ts';

const exact=(value:any,fields:string[])=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===fields.sort().join(',');
const fail=():never=>{throw Error('Reviewed nonsecret native preparation unavailable');};
const privateDirectory=(path:string)=>{try{mkdirSync(path,{mode:0o700});}catch(e){if((e as any).code!=='EEXIST')throw e;}canonicalNativePath(path,true,true);};
/** Construction is inert. Explicit authenticated native-review derives all
 * session-bound fields and a FRESH expiry inside this existing backend owner.
 * Only nonsecret directories/JSON are prepared; no entropy/process/DB/auth API. */
export function createNativeFactsPreparation(configuration:any,scope:any,pinsDigest:string,configurationFile:string){
 const observation=configuration?.purpose==='nativeObservationOnly',factsDirectory=observation?'observation-facts':'facts',runsDirectory=observation?'observation-runs':'runs';
 if(!exact(configuration,observation?['templateFile','templateSha256','stateRoot','purpose','maximumRunMs']:['templateFile','templateSha256','stateRoot',...(Object.hasOwn(configuration??{},'maximumNativeLifetimeMs')?['maximumNativeLifetimeMs']:[]),...(Object.hasOwn(configuration??{},'sessionLifetime')?['sessionLifetime']:[])])||observation&&(!Number.isSafeInteger(configuration.maximumRunMs)||configuration.maximumRunMs<1000||configuration.maximumRunMs>90000)||!/^[a-f0-9]{64}$/.test(configuration.templateSha256)||typeof configuration.stateRoot!=='string'||configurationFile!==join(configuration.stateRoot,factsDirectory,scope.runId+'.json'))fail();
 if(observation&&!/^ct-native-observation-[A-Za-z0-9-]+$/.test(configuration.stateRoot.split('/').at(-1)))fail();
 if(!observation&&/^ct-native-observation-/.test(configuration.stateRoot.split('/').at(-1)))fail();
 const maximumNativeLifetimeMs=observation?configuration.maximumRunMs:(Object.hasOwn(configuration,'maximumNativeLifetimeMs')?configuration.maximumNativeLifetimeMs:120000);
 if(!Number.isSafeInteger(maximumNativeLifetimeMs)||maximumNativeLifetimeMs<1||maximumNativeLifetimeMs>(!observation&&configuration.sessionLifetime==='sessionScoped'?ORDINARY_GAME_SESSION_LIMITS.maximumMs:300000)||configuration.sessionLifetime!==undefined&&configuration.sessionLifetime!=='sessionScoped')fail();
 const options=structuredClone(configuration),bound=structuredClone(scope);
 const template=()=>{
  const raw=readNativeFile(options.templateFile,32768,true);if(fileDigest(raw)!==options.templateSha256)fail();const value=JSON.parse(raw.toString('utf8'));
  const hasWake=!!value&&Object.hasOwn(value,'wakePreparation');
  if(!exact(value,['schemaVersion','image','wrapper','seccomp','frontend','continuation','sources','imagePins','romSha1','qualificationRef',...(hasWake?['wakePreparation']:[])])||value.schemaVersion!=='ct-native-template/1'||value.image!==C72_IMAGE||value.wrapper?.path!==C72_WRAPPER||value.seccomp?.path!==C72_SECCOMP||value.frontend?.path!==C72_FRONTEND||!isDeepStrictEqual(value.continuation,{path:C72_STATE,...C72_CONTINUATION})||!exact(value.sources,Object.keys(C72_SOURCES))||!exact(value.imagePins,['mono','rom','core','controller','configFactory'])||!/^[a-f0-9]{40}$/.test(value.romSha1)||typeof value.qualificationRef!=='string'||!value.qualificationRef.trim())fail();
  if(hasWake&&(observation||captureWakePreparation(value.wakePreparation)===undefined))fail();
  for(const name of ['wrapper','seccomp','frontend']){const p=value[name];if(!exact(p,['path','sha256'])||fileDigest(readNativeFile(p.path,134217728))!==p.sha256)fail();}
  if(value.frontend.sha256!==C72_KNOWN_PINS.frontend)fail();
  for(const [name,path]of Object.entries(C72_SOURCES)){if(!/^[a-f0-9]{64}$/.test(value.sources[name])||fileDigest(readNativeFile(path,262144))!==value.sources[name])fail();}
  for(const [name,pin]of Object.entries(value.imagePins)){if(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin)||C72_KNOWN_PINS[name as keyof typeof C72_KNOWN_PINS]!==pin)fail();}
  return value;
 };
 return Object.freeze({
  inspectTemplate:template,
  prepare(){
   const value=template();canonicalNativePath(dirname(options.stateRoot),true);
   privateDirectory(options.stateRoot);privateDirectory(join(options.stateRoot,factsDirectory));privateDirectory(join(options.stateRoot,runsDirectory));
   const runDirectory=join(options.stateRoot,runsDirectory,bound.runId);privateDirectory(runDirectory);
   if(readdirSync(runDirectory).some(name=>!['frames','evidence'].includes(name)))fail();
   for(const name of ['frames','evidence']){const path=join(runDirectory,name);privateDirectory(path);if(readdirSync(path).length)fail();}
   const expiresAt=new Date(Date.now()+maximumNativeLifetimeMs).toISOString();
   const facts={schemaVersion:'ct-native-c72/1',...(options.sessionLifetime==='sessionScoped'?{sessionLifetime:'sessionScoped'}:{}),image:value.image,wrapper:value.wrapper,seccomp:value.seccomp,frontend:value.frontend,continuation:value.continuation,sources:Object.fromEntries(Object.entries(C72_SOURCES).map(([name,path])=>[name,{path,sha256:value.sources[name]}])),imagePins:value.imagePins,romSha1:value.romSha1,runDirectory,scope:bound,pinsDigest,approvalRef:value.qualificationRef,expiresAt,pairing:{scopeDigest:scopeDigest(bound),pinsDigest,expiresAt,approvalRef:value.qualificationRef+':memory-pairing'},...(Object.hasOwn(value,'wakePreparation')?{wakePreparation:captureWakePreparation(value.wakePreparation)}:{})};
   if(existsSync(configurationFile)){
    const previous=JSON.parse(readNativeFile(configurationFile,32768,true).toString('utf8'));
    // Re-review may renew an UNUSED run's expired nonsecret facts, never a
    // consumed native lease, changed source or transferred session approval.
    const withoutTime=(v:any)=>({...v,expiresAt:null,pairing:{...v.pairing,expiresAt:null}});
    if(!isDeepStrictEqual(withoutTime(previous),withoutTime(facts)))fail();
   }
   const next=configurationFile+'.next';let written=false;
   try{writeFileSync(next,JSON.stringify(facts)+'\n',{flag:'wx',mode:0o600});written=true;renameSync(next,configurationFile);written=false;return readC72NativeConfiguration(configurationFile,bound,pinsDigest);}
   finally{if(written)unlinkSync(next);}
  }
 });
}
