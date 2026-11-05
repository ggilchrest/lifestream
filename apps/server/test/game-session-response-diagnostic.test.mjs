import test from 'node:test';
import assert from 'node:assert/strict';
import {createUbuntuGameSession} from '../src/runtime/ubuntu-game-session.ts';
import {GAME_HOST_BASE_PATH} from '@lifestream/contracts/game-host';
import {observe} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
import {GAME_HOST_RESPONSE_CODES,GAME_HOST_ERROR_HEADER} from '../../../packages/providers-bizhawk/src/game-host-client.ts';
async function fixture(error){
 const scope=observe().scope,actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>true},session=createUbuntuGameSession(scope,{maximumRunMs:90000,maximumPlanningSteps:8});let calls=0;
 session.configure({broker:{next(){calls++;throw error;}},origin:'http://127.0.0.1:43182',database:{}});
 session.bindHandle({startClient(){},ready:()=>new Promise(()=>{}),completion:()=>new Promise(()=>{}),snapshot:()=>({})});
 await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false});
 const response=await session.fetchAuthenticated('http://127.0.0.1:43182'+GAME_HOST_BASE_PATH+'/next',{method:'POST',redirect:'error',body:'{}'});return {response,calls};
}
for(const [status,code] of [[403,'game_host_scope_denied'],[410,'game_host_expired'],[500,'game_host_unavailable']])test('original direct broker '+status+' preserves body/status with closed header',async()=>{
 const {response,calls}=await fixture({status,code});assert.equal(calls,1);assert.equal(response.status,status);assert.equal(response.headers.get(GAME_HOST_ERROR_HEADER),code);assert.deepEqual(await response.json(),{code});
});
test('all client allowlist members are the exact direct-broker metadata enum',async()=>{
 for(const code of GAME_HOST_RESPONSE_CODES){const {response}=await fixture({status:503,code});assert.equal(response.headers.get(GAME_HOST_ERROR_HEADER),code);}
});
test('arbitrary private broker code remains out of diagnostic header; original response unchanged',async()=>{
 const code='PRIVATE body not diagnostic', {response}=await fixture({status:500,code});assert.equal(response.headers.get(GAME_HOST_ERROR_HEADER),null);assert.deepEqual(await response.json(),{code});
});
test('existing broker fallback still produces503 with exact closed fallback code',async()=>{
 const {response}=await fixture({});assert.equal(response.status,503);assert.equal(response.headers.get(GAME_HOST_ERROR_HEADER),'game_session_unavailable');assert.deepEqual(await response.json(),{code:'game_session_unavailable'});
});

const siteHeader='x-lifestream-game-host-cancellation-site',predicateHeader='x-lifestream-game-host-cancellation-predicate',nativeHeader='x-lifestream-game-host-native-source';
test('next expiry transports paired closed fence metadata without changing response body',async()=>{
 const error={status:410,code:'game_host_expired',cancellationSite:'sweep_current',cancellationPredicate:'current_runtime'};
 const {response}=await fixture(error);assert.equal(response.headers.get(siteHeader),'sweep_current');assert.equal(response.headers.get(predicateHeader),'current_runtime');assert.equal(response.headers.get(nativeHeader),null);assert.deepEqual(await response.json(),{code:'game_host_expired'});
});
test('next expiry includes only a validated native source witness',async()=>{
 const witness={stage:'custody-pre',predicate:'inspect_not_fresh',ageMs:30001},error={status:410,code:'game_host_expired',cancellationSite:'sweep_current',cancellationPredicate:'current_native_source',nativeSourceWitness:witness};
 const {response}=await fixture(error);assert.deepEqual(JSON.parse(response.headers.get(nativeHeader)),witness);
 for(const patch of [{cancellationPredicate:'current_runtime'},{nativeSourceWitness:{...witness,nonce:'PRIVATE'}}]){const {response}=await fixture({...error,...patch});assert.equal(response.headers.get(nativeHeader),null);}
});
test('wrong denial or unknown partial fence metadata is omitted without invoking getters',async()=>{
 let traps=0;for(const patch of [{status:403},{code:'game_host_scope_denied'},{cancellationSite:'PRIVATE'},{cancellationPredicate:undefined},{get cancellationSite(){traps++;throw Error('PRIVATE');}}]){
  const error={status:410,code:'game_host_expired',cancellationSite:'sweep_current',cancellationPredicate:'current_runtime'};Object.defineProperties(error,Object.getOwnPropertyDescriptors(patch));const {response}=await fixture(error);assert.equal(response.headers.get(siteHeader),null);assert.equal(response.headers.get(predicateHeader),null);
 }assert.equal(traps,0);
});

test('explicit bounded read deadline survives next response metadata',async()=>{
 const {response}=await fixture({status:410,code:'game_host_expired',cancellationSite:'sweep_refresh_failed',cancellationPredicate:'read_refresh_deadline'});assert.equal(response.headers.get(predicateHeader),'read_refresh_deadline');assert.deepEqual(await response.json(),{code:'game_host_expired'});
});
