// Real local authentication and main route, isolated synthetic accounts only.
// No native review/start approval, child, model call, or live state is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {ConversationHistoryRepository} from '@lifestream/storage-sqlite';
import {selectSessionConversation,reviseSessionEndpoint,readSessionEndpoint} from '../src/runtime/session-context.ts';
import {C72_STATE,C72_CONTINUATION} from '@lifestream/providers-bizhawk/c72-native-configuration';
const route='/api/runtime/v1/native-observation/';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ct-native-route-INERT-'));
 let app;t.after(async()=>{await app?.shutdown();await rm(root,{recursive:true,force:true});});
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const localAuth={stateDirectory:join(root,'auth'),installerToken:'TEST-only-installer'},environmentId=randomUUID();
 app=createLifestreamServer({config,localAuth,sessionEnvironmentId:environmentId});await app.start();
 const port=app.address().port,origin='http://127.0.0.1:'+port,headers={origin,'content-type':'application/json'};
 const post=(path,body={},extra={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const setup=await post('/api/auth/v1/setup',{username:'TEST-route-owner',password:'TEST-route-password-only-12345',installerToken:localAuth.installerToken});assert.equal(setup.status,201);
 headers.cookie=setup.headers.get('set-cookie').split(';')[0];const user=(await setup.json()).session;headers['x-lifestream-csrf']=user.csrfToken;
 const created=await post('/api/admin/v1/assistants',{displayName:'TEST-existing-assistant'});assert.equal(created.status,201);const {assistantId,profile}=await created.json();
 assert.equal((await post(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:profile.profileId,expectedActiveRevision:null})).status,200);
 const relation=await post(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relation.status,201);const {relationship}=await relation.json();
 const template={assistantId,principalId:user.principalId,relationshipId:relationship.relationshipId,environmentId,activityId:randomUUID(),runId:randomUUID(),activityEpoch:1,timelineId:randomUUID(),timelineRevision:1,observationDomain:'simulatedGame',campaignId:randomUUID(),ownerPermissionRef:'TEST-native-observation-not-controller-authority'};
 const nativeRoot=join(root,'ct-native-observation-TEST'),observation={schemaVersion:'ct-native-observation/1',sessionProfile:'nativeObservationOnly',template,profile:{profileId:profile.profileId,revision:1},maximumRunMs:90000,maximumObservations:3,maximumCommandMs:3000,pinsDigest:'a'.repeat(64),providerRef:'TEST-unused-native',nativeInstallation:{kind:'c72-container',configurationFile:join(nativeRoot,'observation-facts',template.runId+'.json')},nativePreparation:{stateRoot:nativeRoot,templateFile:join(root,'TEST-absent-template.json'),templateSha256:'b'.repeat(64)},nativeLaunch:{host:'127.0.0.1',port:43187,continuation:{path:C72_STATE,...C72_CONTINUATION}}};
 await app.shutdown();
 app=createLifestreamServer({config,localAuth:{stateDirectory:localAuth.stateDirectory},port,sessionEnvironmentId:environmentId,ubuntuNativeObservation:observation});await app.start();
 const context=await fetch(origin+'/api/auth/v1/user-context',{headers});assert.equal(context.status,200);headers['x-lifestream-user-context']=(await context.json()).contextRef;
 const disclose=async()=>{
  const selected=await post('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass:'desktopCompanion',bindingKey:randomUUID()});assert.equal(selected.status,200,await selected.clone().text());
  const view=await selected.json(),personal=await fetch(origin+'/api/runtime/v1/audience/personal-session',{headers});assert.equal(personal.status,200);const current=await personal.json();
  const unlock=await post('/api/runtime/v1/audience/personal-session',{operation:'unlock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:current.revision,expectedPersonalSessionEpoch:current.personalSessionEpoch,expectedSessionRevision:view.revision,endpointId:view.endpoint.endpointId,expectedEndpointRevision:view.endpoint.configurationRevision});assert.equal(unlock.status,200,await unlock.clone().text());
  const row=app.database.connection.prepare('SELECT conversation_id FROM sessions WHERE id=?').get(user.sessionId);
  new ConversationHistoryRepository(app.database).adopt({actorId:user.principalId,effectiveUserId:user.principalId,contextGeneration:0},assistantId,String(row.conversation_id),new Date().toISOString());
 };
 return {get app(){return app;},config,observation,root,nativeRoot,post,headers,user,origin,disclose};
}
test('main observation route retains original auth/origin/CSRF and exact self conversation; bind has no native/controller/model work',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post(route+'bind',{}, {cookie:''})).status,401);
 assert.equal((await f.post(route+'bind',{}, {'x-lifestream-csrf':'TEST-wrong'})).status,403);
 assert.equal((await f.post(route+'bind',{}, {origin:'https://TEST-foreign.invalid'})).status,403);
 assert.equal((await f.post(route+'start',{observations:true,noPlanning:true,noControllerInput:true})).status,409);
 assert.equal((await f.post(route+'bind')).status,409);
 await f.disclose();
 assert.equal((await f.post(route+'bind',{principalId:f.user.principalId})).status,400);
 const bound=await f.post(route+'bind');assert.equal(bound.status,200,await bound.clone().text());const status=await bound.json();
 assert.equal(status.scope.principalId,f.user.principalId);assert.equal(status.scope.contextBinding.sessionId,f.user.sessionId);
 assert.equal(status.controllerActions,0);assert.equal(status.modelCalls,0);assert.equal(status.automaticFrameApprovals,0);assert.equal(existsSync(f.nativeRoot),false);
 assert.equal((await f.post(route+'start',{observations:true,noPlanning:true,noControllerInput:true})).status,409);
 assert.equal((await f.post(route+'permission')).status,404);
 assert.equal((await f.post(route+'stop')).status,200);
 assert.equal((await f.post(route+'native-review')).status,409);
 assert.equal(existsSync(f.nativeRoot),false);
 for(const name of ['canonical_grants','game_host_dispatch'])assert.equal(f.app.database.connection.prepare('SELECT count(*) AS n FROM '+name).get().n,0);
});
test('a context switch during the original request body retires its binding; missing/stale/proxy references cannot bind',async t=>{
 const f=await fixture(t);await f.disclose();
 const auth=f.app.localAuth,raw=auth.context(f.headers.cookie.split('=')[1],f.origin,true),self=auth.bindContext(raw,f.headers['x-lifestream-user-context']),other=await auth.provision(self,'TEST-proxy-target','TEST-proxy-password-only-12345');
 let seen;const accepted=new Promise(resolve=>{seen=resolve;});f.app.server.once('request',seen);
 let finish;const result=new Promise((resolve,reject)=>{const request=httpRequest(f.origin+route+'bind',{method:'POST',headers:f.headers},response=>{let bytes='';response.on('data',v=>bytes+=v);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(bytes)}));});request.on('error',reject);request.write('{');finish=()=>request.end('}');});
 await accepted;
 const current=auth.effectiveSubjects.resolve(self),proxy=auth.effectiveSubjects.execute(self,{schemaVersion:'1.0.0',operationId:randomUUID(),operation:'startContext',expectedGeneration:current.context.generation,payload:{targetUserId:other.principalId}});
 finish();assert.equal((await result).status,409);
 assert.equal((await f.post(route+'bind')).status,409);
 assert.equal((await f.post(route+'bind',{}, {'x-lifestream-user-context':''})).status,409);
 const proxyRef=auth.effectiveSubjects.resolve(raw).contextRef;
 assert.equal((await f.post(route+'bind',{}, {'x-lifestream-user-context':proxyRef})).status,403);
 assert.equal(existsSync(f.nativeRoot),false);
});
test('native observation and gameplay composition cannot coexist or bypass real local authentication',()=>{
 const config=loadProfile('test');
 for(const extra of [{ubuntuGame:{}},{gameHost:{}},{gameRuntime:{}}])assert.throws(()=>createLifestreamServer({config,ubuntuNativeObservation:{},localAuth:{stateDirectory:'/TEST-not-created'},sessionEnvironmentId:randomUUID(),...extra}));
 assert.throws(()=>createLifestreamServer({config,ubuntuNativeObservation:{}}));
});

async function delayedBind(f,change){
 let accepted;const ready=new Promise(resolve=>{accepted=resolve;});f.app.server.once('request',accepted);
 let finish;const result=new Promise((resolve,reject)=>{const request=httpRequest(f.origin+route+'bind',{method:'POST',headers:f.headers},response=>{let body='';response.on('data',v=>body+=v);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});request.on('error',reject);request.write('{');finish=()=>request.end('}');});
 await ready;try{await change();}finally{finish();}return result;
}
test('slow Bind retains original selected conversation revision, including selection ABA',async t=>{
 const f=await fixture(t);await f.disclose();
 const row=f.app.database.connection.prepare('SELECT conversation_id,revision FROM sessions WHERE id=?').get(f.user.sessionId);
 const response=await delayedBind(f,()=>{const revision=selectSessionConversation(f.app.database,f.user.sessionId,randomUUID(),row.revision);selectSessionConversation(f.app.database,f.user.sessionId,String(row.conversation_id),revision);});
 assert.equal(response.status,409);assert.equal(response.body.code,'native_observation_selection_changed');
 assert.equal(f.app.nativeObservation.scope,undefined);assert.equal(existsSync(f.nativeRoot),false);
 const fresh=await f.post(route+'bind');assert.equal(fresh.status,200,await fresh.clone().text());
});
test('slow Bind retains endpoint revision and disclosure, including endpoint ABA',async t=>{
 const f=await fixture(t);await f.disclose();const initial=readSessionEndpoint(f.app.database,f.user.sessionId);
 const response=await delayedBind(f,()=>{const next=reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:initial.revision,mode:'text',audienceScope:'unknown'},false,f.user.principalId);reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:next.revision,mode:'text',audienceScope:'authenticatedSession'},false,f.user.principalId);});
 assert.equal(response.status,409);assert.equal(response.body.code,'native_observation_selection_changed');
 assert.equal(f.app.nativeObservation.scope,undefined);assert.equal(existsSync(f.nativeRoot),false);
});
