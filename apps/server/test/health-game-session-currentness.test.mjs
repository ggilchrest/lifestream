import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LifestreamServer} from '../src/index.ts';
import {createUbuntuGameSession} from '../src/runtime/ubuntu-game-session.ts';
import {fixtureEpisode} from '../../../packages/runtime/test/fixtures/game-memory.ts';

// Exercise the actual route and runtime invalidation methods without constructing
// a server, provider, database, listener or native process. The backend's tiny
// returned invalidate method is evaluated from its exact source into these
// original-owned fixture closures; session.retire itself is production code.
const backendSource=await readFile(new URL('../src/runtime/ubuntu-game-backend.ts',import.meta.url),'utf8');
const backendInvalidate=backendSource.match(/invalidate\(\)\{nativeApproval\?\.invalidate\(\);session\?\.retire\(\);\}/g);
assert.equal(backendInvalidate?.length,1);
const makeBackendInvalidate=new Function('nativeApproval','session','return ({'+backendInvalidate[0]+'}).invalidate;');

async function fixture({before='ready',after=true,probeError=false,replaceRegistry=false}={}){
 const scope=fixtureEpisode().scope,actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>true};
 const session=createUbuntuGameSession(scope,{maximumRunMs:90000,maximumPlanningSteps:1,inferenceMode:'supervisedForeground'});
 let stopped=0,nativeInvalidated=0,observationInvalidated=0;
 session.configure({broker:{},origin:'http://127.0.0.1:1',database:{}});
 session.bindHandle({startClient(){},ready:()=>new Promise(()=>{}),completion:()=>new Promise(()=>{}),snapshot:()=>({pauseConfirmation:'confirmed'}),stop:()=>{stopped++;}});
 await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:true});
 assert.equal(session.current(scope),true);
 const app=Object.create(LifestreamServer.prototype),registry={ready:true,async probe(){if(probeError)throw Error('synthetic probe failure');registry.ready=after;if(replaceRegistry)app.providers={...registry};}};
 Object.assign(app,{state:before,providers:registry,ubuntuGameBackend:{invalidate:makeBackendInvalidate({invalidate(){nativeInvalidated++;}},session)},nativeObservation:{invalidate(){observationInvalidated++;}},visualInput:{reset(){},close(){}},conversationHistory:{prune(){}},initiativeHost:{invalidate(){}},invalidateWorldInputs(){}});
 Object.defineProperty(app,'acknowledgments',{value:{start(){}}});Object.defineProperty(app,'experience',{value:{start(){}}});
 Object.defineProperty(app,'health',{get(){return {status:app.state};}});
 const response={status:null,writeHead(value){this.status=value;},end(){}};
 return {app,scope,session,response,counts:()=>({stopped,nativeInvalidated,observationInvalidated}),async get(path){await app.handle({url:path,method:'GET'},response);await Promise.resolve();}};
}

for(const path of ['/health','/health/ready','/health/degraded'])test('stable ready '+path+' preserves the actual active session and native approval',async()=>{
 const f=await fixture();await f.get(path);assert.equal(f.session.current(f.scope),true);assert.deepEqual(f.counts(),{stopped:0,nativeInvalidated:0,observationInvalidated:0});
});
for(const options of [{after:false},{before:'degraded',after:true},{before:'degraded',after:false},{replaceRegistry:true}])test('readiness change or non-ready/changed owner still retires '+JSON.stringify(options),async()=>{
 const f=await fixture(options);await f.get('/health/ready');assert.equal(f.session.current(f.scope),false);assert.deepEqual(f.counts(),{stopped:1,nativeInvalidated:1,observationInvalidated:1});
});
test('unexpected probe failure retires before propagating without changing its error',async()=>{
 const f=await fixture({probeError:true});await assert.rejects(f.get('/health/ready'),/synthetic probe failure/);assert.equal(f.session.current(f.scope),false);assert.deepEqual(f.counts(),{stopped:1,nativeInvalidated:1,observationInvalidated:1});
});
for(const reason of ['audienceChanged','cameraAudienceChanged','sessionHandoff','securityChanged','profileChanged','configurationChanged','shutdown'])test(reason+' continues to retire even if an unchanged-ready hint is supplied',async()=>{
 const f=await fixture();f.app.invalidateRuntimeInputs(reason,true);await Promise.resolve();assert.equal(f.session.current(f.scope),false);assert.equal(f.counts().stopped,1);assert.equal(f.counts().nativeInvalidated,1);
});
test('readiness probe without original stable-ready evidence still retires',async()=>{
 const f=await fixture();f.app.invalidateRuntimeInputs('readinessProbe');await Promise.resolve();assert.equal(f.session.current(f.scope),false);assert.equal(f.counts().stopped,1);
});
