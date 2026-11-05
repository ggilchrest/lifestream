import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileFunction,runInNewContext} from 'node:vm';

const raw=readFileSync(new URL('../real-configuration.mjs',import.meta.url),'utf8');
const section=raw.slice(raw.indexOf('export const candidateId='),raw.indexOf('\nexport function providerConfiguration')).replace(/^export /gm,'');
const {validateDeployment,candidateId}=compileFunction(section+'\nreturn {validateDeployment,candidateId};',['assert','resolve','join'])(assert,resolve,join);
const inactive={enabled:false,scope:'installationOwner',expiration:'untilRevoked',windowFocusRequired:false};
const deployment=()=>({schemaVersion:'1.0.0',candidateId,stage:'production',adoptionMode:'existingInstallation',providerConfigurationPath:'/srv/lifestream/deployment/config/linux-backend-public-github-required-gpu-profile.json',stateDirectory:'/srv/lifestream/deployment/state/lifestream',presentationDirectory:'/srv/lifestream/deployment/state/presentation-catalog',stateAdoptionReceiptPath:'/srv/lifestream/deployment/config/daily/TEST-adoption.json',ownershipBaselinePath:'/srv/lifestream/deployment/config/daily/TEST-ownership.json',host:'127.0.0.1',port:43182,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}});
test('absent policy is inert; explicit inactive configuration is closed and independently cloned',()=>{
 const old=deployment();assert.deepEqual(validateDeployment(old),old);assert.equal(Object.hasOwn(validateDeployment(old),'personalSessionPolicy'),false);
 const input={...old,personalSessionPolicy:{...inactive}},copy=validateDeployment(input);assert.deepEqual(copy.personalSessionPolicy,inactive);assert.notEqual(copy.personalSessionPolicy,input.personalSessionPolicy);
 for(const policy of [{...inactive,extra:true},{...inactive,scope:'allAccounts'},{...inactive,expiration:'arbitraryDate'},{...inactive,windowFocusRequired:true},{...inactive,enabled:'true'}])assert.throws(()=>validateDeployment({...old,personalSessionPolicy:policy}));
 let called=false;const getter={...inactive};Object.defineProperty(getter,'enabled',{enumerable:true,get(){called=true;return true;}});assert.throws(()=>validateDeployment({...old,personalSessionPolicy:getter}));assert.equal(called,false);
});
test('the optional owner policy cannot select another deployment or create runtime effects',()=>{
 const enabled={...inactive,enabled:true};assert.deepEqual(validateDeployment({...deployment(),personalSessionPolicy:enabled}).personalSessionPolicy,enabled);
 assert.throws(()=>validateDeployment({...deployment(),adoptionMode:undefined,personalSessionPolicy:enabled}));
 assert.throws(()=>validateDeployment({...deployment(),port:43183,personalSessionPolicy:enabled}));
});
test('actual launcher passes only the explicit option to the existing authentication owner',()=>{
 const source=readFileSync(new URL('../start-canonical.mjs',import.meta.url),'utf8'),start=source.indexOf('app=createLifestreamServer('),end=source.indexOf('\n   assertCompatibleSchema',start);
 const capture=personalSessionPolicy=>{let captured;const d={...deployment(),...(personalSessionPolicy?{personalSessionPolicy}:{})};runInNewContext(source.slice(start,end),{createLifestreamServer:value=>{captured=value;},ctOptions:{},presenceOptions:{},config:{providers:{}},deployment:d,marker:{sessionEnvironmentId:'TEST'},root:'/TEST-release',join});return JSON.parse(JSON.stringify(captured));};
 const old=capture();assert.deepEqual(old.localAuth,{stateDirectory:'/srv/lifestream/deployment/state/lifestream/safety'});
 const next=capture(inactive);assert.deepEqual(next.localAuth,{...old.localAuth,personalSessionPolicy:inactive});delete next.localAuth.personalSessionPolicy;assert.deepEqual(next,old);
});
