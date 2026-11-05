import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileFunction,runInNewContext} from 'node:vm';
import {captureLoopbackBrowserOrigin} from '../../../apps/server/src/runtime/loopback-browser-origin.ts';
const source=readFileSync(new URL('../real-configuration.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export const candidateId='),source.indexOf('\nexport function providerConfiguration')).replace(/^export /gm,'');
const {candidateId,validateDeployment}=compileFunction(body+'\nreturn {candidateId,validateDeployment};',['assert','resolve','join','captureLoopbackBrowserOrigin'])(assert,resolve,join,captureLoopbackBrowserOrigin);
const deployment=()=>({schemaVersion:'1.0.0',candidateId,stage:'production',adoptionMode:'existingInstallation',providerConfigurationPath:'/srv/lifestream/deployment/config/linux-backend-public-github-required-gpu-profile.json',stateDirectory:'/srv/lifestream/deployment/state/lifestream',presentationDirectory:'/srv/lifestream/deployment/state/presentation-catalog',stateAdoptionReceiptPath:'/srv/lifestream/deployment/config/daily/TEST-adoption.json',ownershipBaselinePath:'/srv/lifestream/deployment/config/daily/TEST-ownership.json',host:'127.0.0.1',port:43182,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}});
test('deployment permits an optional literal loopback hostname with exact or dynamic port',()=>{
 assert.deepEqual(validateDeployment(deployment()),deployment());assert.equal(Object.hasOwn(validateDeployment(deployment()),'loopbackBrowserOrigin'),false);
 for(const alias of ['http://localhost:59445','http://127.0.0.1:54321','http://[::1]:54321','http://localhost:*','http://127.0.0.1:*','http://[::1]:*'])assert.equal(validateDeployment({...deployment(),loopbackBrowserOrigin:alias}).loopbackBrowserOrigin,alias);
 for(const alias of [undefined,null,{},['http://localhost:59445'],'http://*:*','http://*.localhost:*','http://localhost:*/','https://localhost:*','http://remote.invalid:*','http://localhost:59445/','https://localhost:59445','http://remote.invalid:59445','http://localhost:70000','http://localhost'])assert.throws(()=>validateDeployment({...deployment(),loopbackBrowserOrigin:alias}));
 let reads=0;const input=deployment();Object.defineProperty(input,'loopbackBrowserOrigin',{enumerable:true,get(){reads++;return 'http://localhost:59445';}});assert.throws(()=>validateDeployment(input));assert.equal(reads,0);
});
test('launcher passes the explicit alias only to the server and preserves original local-auth configuration',()=>{
 const source=readFileSync(new URL('../start-canonical.mjs',import.meta.url),'utf8'),start=source.indexOf('app=createLifestreamServer('),end=source.indexOf('\n   assertCompatibleSchema',start);
 const capture=alias=>{let captured;runInNewContext(source.slice(start,end),{createLifestreamServer:value=>captured=value,ctOptions:{},presenceOptions:{},config:{providers:{}},deployment:{...deployment(),...(alias?{loopbackBrowserOrigin:alias}:{})},marker:{sessionEnvironmentId:'TEST'},root:'/TEST-release',join});return JSON.parse(JSON.stringify(captured));};
 const before=capture();for(const alias of ['http://localhost:59445','http://localhost:*']){const after=capture(alias);assert.equal(after.loopbackBrowserOrigin,alias);delete after.loopbackBrowserOrigin;assert.deepEqual(after,before);}
});
