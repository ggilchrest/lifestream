// Actual gameplay HTTP route + real local auth, ONLY synthetic temporary state.
// Source/compiled entry parity. Ephemeral loopback test listener; never production, native, real provider, model or controller.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {request as httpRequest} from 'node:http';
import {IncomingMessage} from 'node:http';import {Socket} from 'node:net';import {existsSync} from 'node:fs';
import {ConversationHistoryRepository,ActivityCheckpointRepository} from '@lifestream/storage-sqlite';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {selectGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import {requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
// Closed test-only entry choice: never a runtime configuration/module path.
const entry=process.env.CT_BINDING_ENTRY??'source';
if(!['source','compiled'].includes(entry))throw Error('CT_BINDING_ENTRY must be source or compiled');
const prefix=entry==='compiled'?'../dist':'../src',extension=entry==='compiled'?'js':'ts';
const {createLifestreamServer}=await import(`${prefix}/index.${extension}`);
const {loadProfile}=await import(`${prefix}/config/loader.${extension}`);
const {supervisedSessionBounds}=await import(`${prefix}/runtime/supervised-game-session.${extension}`);
const activeSupervisedBounds={...supervisedSessionBounds,decisionDeadlineMs:60000,maxPlanningAgeMs:180000};
const {selectSessionConversation,reviseSessionEndpoint,readSessionEndpoint}=await import(`${prefix}/runtime/session-context.${extension}`);
const route='/api/runtime/v1/game-session/';
async function fixture(t,mode={}){
 const integrationCounts={refresh:0,assert:0,repositoryCalls:0};
 const root=await mkdtemp(join(tmpdir(),'CT18-SYNTHETIC-'));const oldMask=mode.history?process.umask(0o077):null;let app;t.after(async()=>{try{await app?.shutdown();await rm(root,{recursive:true,force:true});}finally{if(oldMask!==null)process.umask(oldMask);}});
 const config=loadProfile('test');assert.equal(config.profile,'test');assert.equal(config.providers.inference,'fixture');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const localAuth={stateDirectory:join(root,'auth'),installerToken:'TEST-only-ct18'},environmentId=randomUUID();
 app=createLifestreamServer({config,localAuth,sessionEnvironmentId:environmentId});await app.start();const port=app.address().port,origin='http://127.0.0.1:'+port,headers={origin,'content-type':'application/json'};
 const post=(path,body={},extra={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const setup=await post('/api/auth/v1/setup',{username:'TEST-ct18-owner',password:'TEST-ct18-password-only-12345',installerToken:localAuth.installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie').split(';')[0];const user=(await setup.json()).session;headers['x-lifestream-csrf']=user.csrfToken;
 const created=await post('/api/admin/v1/assistants',{displayName:'TEST-only-existing-assistant'});assert.equal(created.status,201);const {assistantId,profile}=await created.json();assert.equal((await post(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:profile.profileId,expectedActiveRevision:null})).status,200);
 const relation=await post(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relation.status,201);const {relationship}=await relation.json();
 const template={assistantId,principalId:user.principalId,relationshipId:relationship.relationshipId,environmentId,activityId:randomUUID(),runId:randomUUID(),activityEpoch:1,timelineId:randomUUID(),timelineRevision:1,observationDomain:'simulatedGame',campaignId:randomUUID(),ownerPermissionRef:'TEST-ct18-not-native-or-controller-authority'};
 const game={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',initialDialogue:'TEST-only-dialogue',template,profile:{profileId:profile.profileId,revision:1},maximumRunMs:90000,maximumPlanningSteps:8,planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024},attach:{pinsDigest:'a'.repeat(64),providerRef:'TEST-no-native',hostId:randomUUID(),sourceRevision:'b'.repeat(64)},campaign:{bounds:{...supervisedSessionBounds},policy:{revision:1}},nativeInstallation:mode.nativeFacts?{kind:'c72-container',configurationFile:join(root,'TEST-absent-native-facts.json')}:null,nativeLaunch:null};
 await app.shutdown();app=createLifestreamServer({config,localAuth:{stateDirectory:localAuth.stateDirectory},port,sessionEnvironmentId:environmentId,ubuntuGame:mode.dedicated?undefined:game,...(mode.history?{audiencePrivacy:{sourceIds:[]},historyStateRoot:root,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'}}:{})});await app.start();
 if(mode.integration){
  const {CanonicalIntegration}=await import(`${prefix}/integrations/canonical-integration.${extension}`);
  const unexpected=()=>{integrationCounts.repositoryCalls++;throw Error('TEST repository must not be called');};
  const integration=new CanonicalIntegration(app.database,app.localAuth,{enabled:true,capabilities:{repositoryRead:'synthetic.repository.read'},repository:{read:unexpected,current:unexpected,custodyRevision:unexpected,refresh:unexpected}},()=>true);
  integration.attach(app.canonicalPreparation);
  const refresh=integration.refreshRetainedAccess.bind(integration),assertAccess=integration.assertRetainedAccess.bind(integration);
  integration.refreshRetainedAccess=(...args)=>{integrationCounts.refresh++;return refresh(...args);};
  integration.assertRetainedAccess=(...args)=>{integrationCounts.assert++;return assertAccess(...args);};
  app.integrations=integration;
 }
 const view=await fetch(origin+'/api/auth/v1/user-context',{headers});assert.equal(view.status,200);headers['x-lifestream-user-context']=(await view.json()).contextRef;
 const disclose=async()=>{const selected=await post('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass:'desktopCompanion',bindingKey:randomUUID()});assert.equal(selected.status,200,await selected.clone().text());const s=await selected.json(),personal=await fetch(origin+'/api/runtime/v1/audience/personal-session',{headers});assert.equal(personal.status,200);const p=await personal.json();const unlock=await post('/api/runtime/v1/audience/personal-session',{operation:'unlock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:p.revision,expectedPersonalSessionEpoch:p.personalSessionEpoch,expectedSessionRevision:s.revision,endpointId:s.endpoint.endpointId,expectedEndpointRevision:s.endpoint.configurationRevision});assert.equal(unlock.status,200,await unlock.clone().text());const row=app.database.connection.prepare('SELECT conversation_id FROM sessions WHERE id=?').get(user.sessionId);new ConversationHistoryRepository(app.database).adopt({actorId:user.principalId,effectiveUserId:user.principalId,contextGeneration:0},assistantId,String(row.conversation_id),new Date().toISOString());if(mode.history){const {unifiedDesktopContractPin}=await import('@lifestream/contracts/unified-desktop-contracts');const selected=await post('/api/runtime/v1/conversations/select',{producerPin:unifiedDesktopContractPin('conversation-history'),assistantId,conversationId:String(row.conversation_id),expectedSessionRevision:readSessionEndpoint(app.database,user.sessionId).revision});assert.equal(selected.status,200,await selected.clone().text());}};
 const auth=()=>app.localAuth,raw=()=>auth().context(headers.cookie.split('=')[1],origin,true),self=()=>auth().bindContext(raw(),headers['x-lifestream-user-context']);
 const other=async()=>auth().provision(self(),'TEST-ct18-other','TEST-ct18-other-password-12345');
 const proxy=target=>{const local=self(),current=auth().effectiveSubjects.resolve(local);auth().effectiveSubjects.execute(local,{schemaVersion:'1.0.0',operationId:randomUUID(),operation:'startContext',expectedGeneration:current.context.generation,payload:{targetUserId:target.principalId}});return auth().effectiveSubjects.resolve(raw()).contextRef;};
 const noEffects=()=>{assert.equal(app.gameHost,undefined);assert.equal(app.gameRuntimeOptions,undefined);assert.equal(app.database.connection.prepare('SELECT count(*) AS n FROM canonical_grants').get().n,0);assert.equal(app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get().n,0);};
 return {get app(){return app;},game,request(extra={}){const value=new IncomingMessage(new Socket());value.method='POST';value.headers={...headers,host:new URL(origin).host,...extra};return value;},post,headers,user,origin,disclose,other,proxy,noEffects,raw,self,assistantId,integrationCounts,async restart(){await app.shutdown();app=createLifestreamServer({config,localAuth:{stateDirectory:localAuth.stateDirectory},port,sessionEnvironmentId:environmentId,ubuntuGame:mode.dedicated?undefined:game,...(mode.history?{audiencePrivacy:{sourceIds:[]},historyStateRoot:root,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}}:{})});await app.start();}};
}
async function delayed(f,action,change,body='{}'){
 let accepted;const ready=new Promise(resolve=>{accepted=resolve;});f.app.server.once('request',accepted);let finish;
 const result=new Promise((resolve,reject)=>{const request=httpRequest(f.origin+route+action,{method:'POST',headers:f.headers},response=>{let bytes='';response.on('data',v=>bytes+=v);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(bytes)}));});request.on('error',reject);request.write(body.slice(0,1));finish=()=>request.end(body.slice(1));});
 await ready;try{await change();}finally{finish();}return result;
}
test('gameplay retains original auth/origin/CSRF, self Bind and closed bodies with zero native/controller/model owner',async t=>{const f=await fixture(t);assert.equal((await f.post(route+'bind',{}, {cookie:''})).status,401);assert.equal((await f.post(route+'bind',{}, {'x-lifestream-csrf':'TEST-wrong'})).status,403);assert.equal((await f.post(route+'bind',{}, {origin:'https://TEST-foreign.invalid'})).status,403);await f.disclose();assert.equal((await f.post(route+'bind',{actorId:f.user.principalId})).status,400);const response=await f.post(route+'bind');assert.equal(response.status,200,await response.clone().text());const bound=await response.json();assert.equal(bound.scope.principalId,f.user.principalId);assert.equal(bound.scope.contextBinding.sessionId,f.user.sessionId);assert.equal(bound.sessionProfile,'supervised8');assert.equal(bound.sceneProfileReady,false);assert.equal(bound.readyForStart,false);assert.equal((await f.post(route+'start',{observations:true,campaignJournal:true,controllerInput:true,sharedInference:true})).status,403);f.noEffects();});
test('gameplay Bind refuses a genuinely current proxy effective-context reference',async t=>{const f=await fixture(t);await f.disclose();const target=await f.other(),ref=f.proxy(target);const response=await f.post(route+'bind',{}, {'x-lifestream-user-context':ref});assert.equal(response.status,403,await response.clone().text());assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();});
test('gameplay Bind preserves original effective context through a slow body',async t=>{const f=await fixture(t);await f.disclose();const target=await f.other();const response=await delayed(f,'bind',()=>f.proxy(target));assert([403,409].includes(response.status),JSON.stringify(response.body));assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();});
test('gameplay Bind rejects conversation selection ABA across its original body',async t=>{const f=await fixture(t);await f.disclose();const row=f.app.database.connection.prepare('SELECT conversation_id,revision FROM sessions WHERE id=?').get(f.user.sessionId);const response=await delayed(f,'bind',()=>{const next=selectSessionConversation(f.app.database,f.user.sessionId,randomUUID(),row.revision);selectSessionConversation(f.app.database,f.user.sessionId,String(row.conversation_id),next);});assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();});
test('gameplay Bind rejects endpoint/disclosure revision ABA across its original body',async t=>{const f=await fixture(t);await f.disclose();const initial=readSessionEndpoint(f.app.database,f.user.sessionId);const response=await delayed(f,'bind',()=>{const next=reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:initial.revision,mode:'text',audienceScope:'unknown'},false,f.user.principalId);reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:next.revision,mode:'text',audienceScope:'authenticatedSession'},false,f.user.principalId);});assert.equal(response.status,409,JSON.stringify(response.body));assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();});

test('a real no-op save during slow Bind stays admissible',async t=>{const f=await fixture(t);await f.disclose();const original=readSessionEndpoint(f.app.database,f.user.sessionId);const response=await delayed(f,'bind',()=>{const next=reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:original.revision,mode:'text',audienceScope:'authenticatedSession'},false,f.user.principalId);assert.equal(next.revision,original.revision);});assert.equal(response.status,200,JSON.stringify(response.body));f.noEffects();});
test('stale or missing effective reference after context generation change is denied, never silently rebound',async t=>{const f=await fixture(t);await f.disclose();const target=await f.other();f.proxy(target);for(const ref of [f.headers['x-lifestream-user-context'],'']){const response=await f.post(route+'bind',{}, {'x-lifestream-user-context':ref});assert([403,409].includes(response.status),await response.clone().text());}assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();});
test('pending permission body cannot adopt a later selection or create controller authority',async t=>{const f=await fixture(t);await f.disclose();assert.equal((await f.post(route+'bind')).status,200);const row=f.app.database.connection.prepare('SELECT conversation_id,revision FROM sessions WHERE id=?').get(f.user.sessionId);const response=await delayed(f,'permission',()=>{const next=selectSessionConversation(f.app.database,f.user.sessionId,randomUUID(),row.revision);selectSessionConversation(f.app.database,f.user.sessionId,String(row.conversation_id),next);});assert.equal(response.status,409,JSON.stringify(response.body));f.noEffects();});
test('Start body is fenced on selected-conversation ABA before composition or native/controller install',async t=>{const f=await fixture(t);await f.disclose();assert.equal((await f.post(route+'bind')).status,200);const row=f.app.database.connection.prepare('SELECT conversation_id,revision FROM sessions WHERE id=?').get(f.user.sessionId);const response=await delayed(f,'start',()=>{const next=selectSessionConversation(f.app.database,f.user.sessionId,randomUUID(),row.revision);selectSessionConversation(f.app.database,f.user.sessionId,String(row.conversation_id),next);},JSON.stringify({observations:true,campaignJournal:true,controllerInput:false,sharedInference:true}));assert.equal(response.status,409,JSON.stringify(response.body));f.noEffects();});
test('bound original actor and its runtime port retire on effective-context change or logout',async t=>{const {bindGameplayRequest}=await import(`${prefix}/runtime/gameplay-request-binding.${extension}`);for(const kind of ['context','logout']){const f=await fixture(t);await f.disclose();const target=await f.other(),bound=await f.post(route+'bind');assert.equal(bound.status,200);const scope=(await bound.json()).scope;let runtimeCalls=0;const base={principalId:f.user.principalId,sessionId:f.user.sessionId,isCurrent:()=>true,runtimeFor:()=>{runtimeCalls++;return {TEST:'not a model runtime'};}},retained=bindGameplayRequest(f.app.localAuth,f.raw(),f.headers['x-lifestream-user-context'],base,f.app.database);assert.equal(retained.actor.isCurrent(scope),true);assert.equal(retained.actor.runtimeFor(scope,{}).TEST,'not a model runtime');assert.equal(runtimeCalls,1);if(kind==='context')f.proxy(target);else{f.app.localAuth.logout(f.self());assert.equal((await f.post(route+'permission')).status,401);}assert.equal(retained.actor.isCurrent(scope),false);assert.equal(retained.actor.runtimeFor(scope,{}),null);assert.equal(runtimeCalls,1);f.noEffects();}});
test('original request pins registry and endpoint ownership metadata, beyond selected logical settings',async t=>{const {bindGameplayRequest}=await import(`${prefix}/runtime/gameplay-request-binding.${extension}`);for(const kind of ['registration','ownership']){const f=await fixture(t);await f.disclose();const response=await f.post(route+'bind');assert.equal(response.status,200);const scope=(await response.json()).scope,base={principalId:f.user.principalId,sessionId:f.user.sessionId,isCurrent:()=>true},retained=bindGameplayRequest(f.app.localAuth,f.raw(),f.headers['x-lifestream-user-context'],base,f.app.database);assert.equal(retained.actor.isCurrent(scope),true);if(kind==='registration')f.app.database.connection.prepare('UPDATE interaction_endpoints SET configuration_revision=configuration_revision+1 WHERE endpoint_id=?').run(scope.contextBinding.endpointId);else f.app.database.connection.prepare('DELETE FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').run(f.user.principalId,scope.contextBinding.endpointId);assert.equal(retained.actor.isCurrent(scope),false);assert.throws(()=>retained.assertCurrent());f.noEffects();}});

test('the original Bind actor remains current across later requests, not just the body boundary',async t=>{const f=await fixture(t);await f.disclose();assert.equal((await f.post(route+'bind')).status,200);const row=f.app.database.connection.prepare('SELECT conversation_id,revision FROM sessions WHERE id=?').get(f.user.sessionId),next=selectSessionConversation(f.app.database,f.user.sessionId,randomUUID(),row.revision);selectSessionConversation(f.app.database,f.user.sessionId,String(row.conversation_id),next);const response=await f.post(route+'status');assert.equal(response.status,200);assert.equal((await response.json()).contextReady,false);assert.equal((await f.post(route+'permission')).status,403);f.noEffects();});
test('a later native review cannot renew an obsolete original Bind actor',async t=>{const f=await fixture(t,{nativeFacts:true});await f.disclose();assert.equal((await f.post(route+'bind')).status,200);const initial=readSessionEndpoint(f.app.database,f.user.sessionId),next=reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:initial.revision,mode:'text',audienceScope:'unknown'},false,f.user.principalId);reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:next.revision,mode:'text',audienceScope:'authenticatedSession'},false,f.user.principalId);const response=await f.post(route+'native-review');assert.equal(response.status,403,await response.clone().text());f.noEffects();});

test('a foreign authenticated principal cannot bind or read the configured owner gameplay scope',async t=>{const f=await fixture(t);await f.disclose();await f.other();assert.equal((await f.post(route+'bind')).status,200);const signed=await f.post('/api/auth/v1/sign-in',{username:'TEST-ct18-other',password:'TEST-ct18-other-password-12345'});assert.equal(signed.status,200);const cookie=signed.headers.get('set-cookie').split(';')[0],session=(await signed.json()).session,view=await fetch(f.origin+'/api/auth/v1/user-context',{headers:{origin:f.origin,cookie}});assert.equal(view.status,200);const reference=(await view.json()).contextRef,foreign={cookie,'x-lifestream-csrf':session.csrfToken,'x-lifestream-user-context':reference};for(const action of ['status','bind','permission']){const response=await f.post(route+action,{},foreign);assert.equal(response.status,403,await response.clone().text());}assert.equal(f.app.ubuntuGameBackend.scope.contextBinding.sessionId,f.user.sessionId);f.noEffects();});
test('another real authenticated session of the same principal cannot replace a bound session',async t=>{const f=await fixture(t);await f.disclose();const first=await f.post(route+'bind');assert.equal(first.status,200);const original=(await first.json()).scope;const signed=await f.post('/api/auth/v1/sign-in',{username:'TEST-ct18-owner',password:'TEST-ct18-password-only-12345'});assert.equal(signed.status,200);const cookie=signed.headers.get('set-cookie').split(';')[0],session=(await signed.json()).session;assert.notEqual(session.sessionId,f.user.sessionId);const view=await fetch(f.origin+'/api/auth/v1/user-context',{headers:{origin:f.origin,cookie}});assert.equal(view.status,200);const reference=(await view.json()).contextRef,foreign={cookie,'x-lifestream-csrf':session.csrfToken,'x-lifestream-user-context':reference};for(const action of ['status','permission','stop']){const response=await f.post(route+action,{},foreign);assert.equal(response.status,403,await response.clone().text());}assert.equal(f.app.ubuntuGameBackend.scope.contextBinding.sessionId,original.contextBinding.sessionId);f.noEffects();});
test('Daily57 supervised90s/eight-action limits remain exact and cannot be widened by binding repair',async()=>{const {finiteSupervisedGameConfiguration}=await import(`${prefix}/runtime/supervised-game-session.${extension}`),b=supervisedSessionBounds,c={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',maximumRunMs:90000,maximumPlanningSteps:8,campaign:{bounds:{...b}},planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024}};assert.equal(finiteSupervisedGameConfiguration(c),true);for(const [key,value]of Object.entries({wallBudgetMs:90000,actionBudget:8,modelCallBudget:8,maxActionFrames:12,maxActionWallMs:500,maxInputLeaseMs:500,startBudget:1,retryBudget:0,memoryEpisodeBudget:0,renderedSpeedFactor:1,fastForwardEnabled:false,rewindEnabled:false,planningClockPolicy:'pausesBetweenActions'}))assert.equal(b[key],value,key);for(const wider of [{...c,maximumRunMs:90001},{...c,maximumPlanningSteps:9},{...c,campaign:{bounds:{...b,actionBudget:9}}},{...c,campaign:{bounds:{...b,modelCallBudget:9}}},{...c,campaign:{bounds:{...b,maxActionFrames:13}}},{...c,campaign:{bounds:{...b,retryBudget:1}}},{...c,planningBounds:{...c.planningBounds,deadlineMs:3001}}])assert.equal(finiteSupervisedGameConfiguration(wider),false);});

// Integration-only regressions for pinned Daily58 returning-browser repair.
const readJson=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
// CT35: actual read-only Security inspection against synthetic local state.
// No approval endpoint, provider/native start, model or controller is invoked.
const controllerPreparationPath=r=>`/api/authority/v1/assistants/${r.assistantId}/tools/invocations/${r.invocationId}/preparation`;
test('CT35 Security reads the retained exact CT run without granting or starting',async t=>{
 const f=await fixture(t);await f.disclose();const bound=await readJson(await f.post(route+'bind')),r=await readJson(await f.post(route+'permission'));
 const inspect=()=>fetch(f.origin+controllerPreparationPath(r),{headers:{cookie:f.headers.cookie}}); // Normal Security GET has no CSRF/body.
 const result=await readJson(await inspect());
 assert.equal(result.executionOwner,'ctSession');assert.equal(result.permissionRequestId,r.requestId);
 assert.equal(result.grantsAuthority,false);assert.equal(result.dispatchStarted,false);assert.equal(result.idempotencyKey,undefined);
 assert.deepEqual(result.preparation.request.scope,r.scope);assert.equal(result.preparation.request.inputDigest,r.inputDigest);assert.equal(result.preparation.request.effectSummary,r.effectSummary);
 assert.deepEqual(result.input.scope,bound.scope);assert.deepEqual(result.input.bounds,activeSupervisedBounds);assert.equal(result.input.pinsDigest,'a'.repeat(64));
 assert.equal(result.input.controllerPolicy.revision,'supervised8-no-snes-start/1');assert.equal(result.input.controllerPolicy.allowedButtons.includes('start'),false);
 result.input.bounds.actionBudget=9;result.input.scope.runId=randomUUID();result.input.controllerPolicy.allowedButtons.push('start');
 assert.deepEqual((await readJson(await inspect())).input.bounds,activeSupervisedBounds);assert.deepEqual((await readJson(await inspect())).input.scope,bound.scope);
 assert.equal((await readJson(await f.post(route+'permission'))).requestId,r.requestId);
 assert.equal(f.app.database.connection.prepare('SELECT count(*) AS n FROM canonical_preparation_contexts').get().n,0,'No generic provider preparation is fabricated');f.noEffects();
});
test('CT35 retained CT inspection refuses other owners and withdrawn original context',async t=>{
 for(const kind of ['wrongAssistant','unknownInvocation','endpointABA','effectiveContext','otherSession'])await t.test(kind,async t=>{
  const f=await fixture(t);await f.disclose();await readJson(await f.post(route+'bind'));const r=await readJson(await f.post(route+'permission'));let path=controllerPreparationPath(r),cookie=f.headers.cookie,expected=403;
  if(kind==='wrongAssistant')path=path.replace(r.assistantId,randomUUID());
  if(kind==='unknownInvocation'){path=path.replace(r.invocationId,randomUUID());expected=404;}
  if(kind==='endpointABA'){const initial=readSessionEndpoint(f.app.database,f.user.sessionId),next=reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:initial.revision,mode:'text',audienceScope:'unknown'},false,f.user.principalId);reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:next.revision,mode:'text',audienceScope:'authenticatedSession'},false,f.user.principalId);}
  if(kind==='effectiveContext')f.proxy(await f.other());
  if(kind==='otherSession'){const response=await f.post('/api/auth/v1/sign-in',{username:'TEST-ct18-owner',password:'TEST-ct18-password-only-12345'});assert.equal(response.status,200);cookie=response.headers.get('set-cookie').split(';')[0];}
  const response=await fetch(f.origin+path,{headers:{cookie}});assert.equal(response.status,expected,await response.text());f.noEffects();
 });
});
test('CT35 inspecting an unowned reference cannot create a CT permission request',async t=>{
 const f=await fixture(t);await f.disclose();await readJson(await f.post(route+'bind'));const path=controllerPreparationPath({assistantId:f.assistantId,invocationId:randomUUID()});
 const response=await fetch(f.origin+path,{headers:{cookie:f.headers.cookie}});assert.equal(response.status,404,await response.text());
 assert.equal(f.app.database.connection.prepare('SELECT count(*) AS n FROM canonical_grant_requests').get().n,0);f.noEffects();
});
test('CT35 ordinary capability preparations still use their original inspection owner',async t=>{
 const f=await fixture(t);await f.disclose();await readJson(await f.post(route+'bind'));await readJson(await f.post(route+'permission'));
 const base=`/api/authority/v1/assistants/${f.assistantId}/tools`,now=Date.now();
 const response=await f.post(base+'/synthetic.echo/prepare',{idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{target:'synthetic:one',text:'TEST inert echo metadata'},requestedClass:'allowOnce',grantExpiresAt:new Date(now+90000).toISOString(),reviewAfter:null,expiresAt:new Date(now+45000).toISOString(),untrustedRationale:null});
 assert.equal(response.status,201,await response.clone().text());const retained=(await response.json()).preparation;
 const value=await readJson(await fetch(f.origin+base+'/invocations/'+retained.request.invocationId+'/preparation',{headers:{cookie:f.headers.cookie}}));
 assert.equal(value.executionOwner,undefined);assert.equal(value.preparation.request.scope.capabilityId,'synthetic.echo');assert.deepEqual(value.input,{target:'synthetic:one',text:'TEST inert echo metadata'});f.noEffects();
});
// CT36 exercises the actual integration precheck with an inert repository port.
// No approval, generic dispatch, external integration call or native run occurs.
async function integratedControllerRequest(t){
 const f=await fixture(t,{integration:true});await f.disclose();await readJson(await f.post(route+'bind'));const request=await readJson(await f.post(route+'permission'));
 const path=controllerPreparationPath(request),rows=()=>f.app.database.connection.prepare('SELECT * FROM canonical_grant_requests').all(),before=rows();
 return {f,request,path,unchanged(){assert.deepEqual(rows(),before);assert.equal(f.integrationCounts.repositoryCalls,0);f.noEffects();}};
}
test('CT36 exact CT inspection precedes attached CanonicalIntegration without changing the pending request',async t=>{
 const {f,request,path,unchanged}=await integratedControllerRequest(t);
 for(let n=0;n<2;n++){
  const value=await readJson(await fetch(f.origin+path,{headers:{cookie:f.headers.cookie}}));
  assert.equal(value.permissionRequestId,request.requestId);assert.deepEqual(value.preparation.request.scope,request.scope);assert.deepEqual(value.input.bounds,activeSupervisedBounds);assert.equal(value.input.controllerPolicy.allowedButtons.includes('start'),false);assert.equal(value.grantsAuthority,false);assert.equal(value.dispatchStarted,false);
 }
 assert.equal(f.integrationCounts.refresh,0);assert.equal(f.integrationCounts.assert,0);assert.equal(f.app.database.connection.prepare('SELECT count(*) AS n FROM canonical_preparation_contexts').get().n,0);unchanged();
});
test('CT36 attached integration cannot override CT authentication and original owner fences',async t=>{
 for(const kind of ['missingCookie','foreignPrincipal','otherSession','wrongAssistant','effectiveContext','endpointABA','staleProfile','expiredAdmin'])await t.test(kind,async t=>{
  const {f,path,unchanged}=await integratedControllerRequest(t);let selected=path,cookie=f.headers.cookie,expected=403;
  if(kind==='missingCookie'){cookie=undefined;expected=401;}
  if(kind==='foreignPrincipal'||kind==='otherSession'){
   if(kind==='foreignPrincipal')await f.other();
   const other=kind==='foreignPrincipal',signed=await f.post('/api/auth/v1/sign-in',{username:other?'TEST-ct18-other':'TEST-ct18-owner',password:other?'TEST-ct18-other-password-12345':'TEST-ct18-password-only-12345'});assert.equal(signed.status,200);cookie=signed.headers.get('set-cookie').split(';')[0];
  }
  if(kind==='wrongAssistant')selected=path.replace(f.assistantId,randomUUID());
  if(kind==='effectiveContext')f.proxy(await f.other());
  if(kind==='endpointABA'){const original=readSessionEndpoint(f.app.database,f.user.sessionId),next=reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:original.revision,mode:'text',audienceScope:'unknown'},false,f.user.principalId);reviseSessionEndpoint(f.app.database,f.user.sessionId,{expectedRevision:next.revision,mode:'text',audienceScope:'authenticatedSession'},false,f.user.principalId);}
  if(kind==='staleProfile'){f.app.database.connection.prepare("UPDATE assistant_profiles SET revision=revision+1 WHERE assistant_id=? AND status='active'").run(f.assistantId);expected=409;}
  if(kind==='expiredAdmin')t.mock.method(f.app.localAuth,'now',()=>Date.now()+31*60*1000);
  const response=await fetch(f.origin+selected,{headers:cookie?{cookie}:{}});assert.equal(response.status,expected,await response.text());assert.equal(f.integrationCounts.refresh,0);unchanged();
 });
});
test('CT36 attached integration preserves GET-only, query-free inspection and unknown-reference refusal',async t=>{
 const {f,request,path,unchanged}=await integratedControllerRequest(t);
 assert.equal((await f.post(path,{})).status,405);assert.equal((await fetch(f.origin+path+'?extra=1',{headers:{cookie:f.headers.cookie}})).status,422);assert.equal(f.integrationCounts.refresh,0);
 const unknown=path.replace(request.invocationId,randomUUID()),response=await fetch(f.origin+unknown,{headers:{cookie:f.headers.cookie}});assert.equal(response.status,404,await response.text());assert.equal(f.integrationCounts.refresh,1);assert(f.integrationCounts.assert>=1);
 assert.equal((await fetch(f.origin+path,{headers:{cookie:f.headers.cookie}})).status,200);assert.equal(f.integrationCounts.refresh,1);unchanged();
});
test('CT36 ordinary retained preparations keep the attached generic integration guard',async t=>{
 const {f,unchanged}=await integratedControllerRequest(t),base=`/api/authority/v1/assistants/${f.assistantId}/tools`,now=Date.now();
 const response=await f.post(base+'/synthetic.echo/prepare',{idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{target:'synthetic:one',text:'TEST integration metadata only'},requestedClass:'allowOnce',grantExpiresAt:new Date(now+90000).toISOString(),reviewAfter:null,expiresAt:new Date(now+45000).toISOString(),untrustedRationale:null});
 assert.equal(response.status,201,await response.clone().text());const retained=(await response.json()).preparation;
 const value=await readJson(await fetch(f.origin+base+'/invocations/'+retained.request.invocationId+'/preparation',{headers:{cookie:f.headers.cookie}}));
 assert.equal(value.executionOwner,undefined);assert.equal(value.preparation.request.scope.capabilityId,'synthetic.echo');assert.equal(value.input.text,'TEST integration metadata only');assert.equal(f.integrationCounts.refresh,1);assert(f.integrationCounts.assert>=1);unchanged();
});
test('CT36 selecting PWCE never claims a CT preparation ahead of the existing fallback guard',async t=>{
 const {f,path,unchanged}=await integratedControllerRequest(t);f.app.config.authority.provider='pwce';
 const response=await fetch(f.origin+path,{headers:{cookie:f.headers.cookie}});assert.equal(response.status,404,await response.text());assert.equal(f.integrationCounts.refresh,1);assert(f.integrationCounts.assert>=1);unchanged();
});
const dailyStartup=async(f,headers={})=>readJson(await fetch(f.origin+'/api/runtime/v1/daily-startup',{headers:{...f.headers,...headers}}));
const sessionSettings=async f=>readJson(await fetch(f.origin+'/api/runtime/v1/session-context',{headers:f.headers}));
async function returningSignIn(f,pendingLock=false,bindingKey){
 const key=bindingKey??f.app.database.connection.prepare('SELECT binding_key FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').get(f.user.principalId,(await sessionSettings(f)).endpoint.endpointId).binding_key;
 const response=await f.post('/api/auth/v1/sign-in',{username:'TEST-ct18-owner',password:'TEST-ct18-password-only-12345',returningBrowser:{bindingKey:key,pendingLock}},{cookie:''});
 assert.equal(response.status,200,await response.clone().text());const cookie=response.headers.get('set-cookie').split(';')[0],session=(await response.json()).session;
 const view=await readJson(await fetch(f.origin+'/api/auth/v1/user-context',{headers:{origin:f.origin,cookie}}));
 return {session,headers:{cookie,'x-lifestream-csrf':session.csrfToken,'x-lifestream-user-context':view.contextRef}};
}
async function personalCommand(f,operation){
 const view=await readJson(await fetch(f.origin+'/api/runtime/v1/audience/personal-session',{headers:f.headers})),selected=await sessionSettings(f);
 return readJson(await f.post('/api/runtime/v1/audience/personal-session',{operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:view.revision,expectedPersonalSessionEpoch:view.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint.endpointId,expectedEndpointRevision:selected.endpoint.configurationRevision}));
}
test('Daily58 restored same chat and endpoint do not revive the signed-out CT Bind or runtime delegation',async t=>{
 const {bindGameplayRequest}=await import(`${prefix}/runtime/gameplay-request-binding.${extension}`);
 const f=await fixture(t,{history:true});await f.disclose();assert.equal((await dailyStartup(f)).privateAllowed,true);
 const original=await readJson(await f.post(route+'bind')),selected=await sessionSettings(f);let delegates=0;
 const retained=bindGameplayRequest(f.app.localAuth,f.raw(),f.headers['x-lifestream-user-context'],{principalId:f.user.principalId,sessionId:f.user.sessionId,isCurrent:()=>true,runtimeFor:()=>{delegates++;return {TEST:'fixture only'};}},f.app.database);
 assert.equal(retained.actor.isCurrent(original.scope),true);
 const key=f.app.database.connection.prepare('SELECT binding_key FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').get(f.user.principalId,selected.endpoint.endpointId).binding_key;
 await readJson(await f.post('/api/auth/v1/sign-out'));
 const returned=await returningSignIn(f,false,key);assert.notEqual(returned.session.sessionId,f.user.sessionId);
 const ready=await dailyStartup(f,returned.headers);assert.equal(ready.privateAllowed,true);assert.equal(ready.session.selectedConversation.conversationId,original.scope.contextBinding.conversationId);
 const restored=await readJson(await fetch(f.origin+'/api/runtime/v1/session-context',{headers:{...f.headers,...returned.headers}}));assert.equal(restored.endpoint.endpointId,selected.endpoint.endpointId);assert.equal(restored.endpoint.configurationRevision,selected.endpoint.configurationRevision);
 assert.equal(retained.actor.isCurrent(original.scope),false);assert.equal(retained.actor.runtimeFor(original.scope,{}),null);assert.equal(delegates,0);
 for(const action of ['status','permission'])assert.equal((await f.post(route+action,{},returned.headers)).status,403);
 assert.equal(f.app.ubuntuGameBackend.scope.contextBinding.sessionId,f.user.sessionId);f.noEffects();
});
test('Daily58 normal chat selection preserves privacy while retiring the previous CT selected scope',async t=>{
 const f=await fixture(t,{history:true});await f.disclose();await readJson(await f.post(route+'bind'));
 const next=randomUUID();new ConversationHistoryRepository(f.app.database).adopt({actorId:f.user.principalId,effectiveUserId:f.user.principalId,contextGeneration:0},f.assistantId,next,new Date().toISOString());
 const {unifiedDesktopContractPin}=await import('@lifestream/contracts/unified-desktop-contracts');
 await readJson(await f.post('/api/runtime/v1/conversations/select',{producerPin:unifiedDesktopContractPin('conversation-history'),assistantId:f.assistantId,conversationId:next,expectedSessionRevision:(await sessionSettings(f)).revision}));
 const ready=await dailyStartup(f);assert.equal(ready.privateAllowed,true);assert.equal(ready.session.selectedConversation.conversationId,next);
 const status=await readJson(await f.post(route+'status'));assert.equal(status.contextReady,false);assert.equal((await f.post(route+'permission')).status,403);f.noEffects();
});
test('Daily58 Lock, Withhold plus Save, and pending Lock never acquire a CT binding after returning sign-in',async t=>{
 for(const kind of ['lock','withholdThenSave','pendingLock'])await t.test(kind,async t=>{
  const f=await fixture(t);await f.disclose();
  if(kind==='lock')await personalCommand(f,'lock');
  if(kind==='withholdThenSave'){
   const settings=await sessionSettings(f),key=f.app.database.connection.prepare('SELECT binding_key FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').get(f.user.principalId,settings.endpoint.endpointId).binding_key;
   for(const audienceScope of ['unknown','authenticatedSession'])await readJson(await f.post('/api/runtime/v1/session-context',{expectedRevision:(await sessionSettings(f)).revision,bindingKey:key,mode:'text',audienceScope}));
   assert.equal((await dailyStartup(f)).privateAllowed,false,'Save cannot supply Unlock');
  }
  const returned=await returningSignIn(f,kind==='pendingLock');assert.equal((await dailyStartup(f,returned.headers)).privateAllowed,false);
  assert.equal((await f.post(route+'bind',{},returned.headers)).status,403);assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();
 });
});

// Successor59 cached-cookie resume: test source and compiled actual HTTP graphs.
async function cookieResume(f,pendingLock=false){
 const settings=await sessionSettings(f),key=f.app.database.connection.prepare('SELECT binding_key FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').get(f.user.principalId,settings.endpoint.endpointId).binding_key;
 return readJson(await f.post('/api/auth/v1/resume-browser',{bindingKey:key,pendingLock}));
}
async function selectAdoptedChat(f,conversationId){
 const {unifiedDesktopContractPin}=await import('@lifestream/contracts/unified-desktop-contracts');
 return readJson(await f.post('/api/runtime/v1/conversations/select',{producerPin:unifiedDesktopContractPin('conversation-history'),assistantId:f.assistantId,conversationId,expectedSessionRevision:(await sessionSettings(f)).revision}));
}
test('Daily59 same-cookie resume after owned restart restores ordinary chat without restoring the old CT binding',async t=>{
 const {bindGameplayRequest}=await import(`${prefix}/runtime/gameplay-request-binding.${extension}`);
 const f=await fixture(t,{history:true});await f.disclose();const bound=await readJson(await f.post(route+'bind')),before=await sessionSettings(f),cookie=f.headers.cookie,csrf=f.headers['x-lifestream-csrf'];let delegates=0;
 const retained=bindGameplayRequest(f.app.localAuth,f.raw(),f.headers['x-lifestream-user-context'],{principalId:f.user.principalId,sessionId:f.user.sessionId,isCurrent:()=>true,runtimeFor:()=>{delegates++;return {TEST:'fixture only'};}},f.app.database);
 assert.equal(retained.actor.isCurrent(bound.scope),true);await f.restart();
 const dailySession=await readJson(await fetch(f.origin+'/api/auth/v1/daily-session',{headers:f.headers}));assert.equal(dailySession.sessionId,f.user.sessionId);assert.equal(dailySession.csrfToken,csrf);assert.equal(f.headers.cookie,cookie);
 f.headers['x-lifestream-user-context']=(await readJson(await fetch(f.origin+'/api/auth/v1/user-context',{headers:f.headers}))).contextRef;
 assert.equal((await dailyStartup(f)).privateAllowed,false,'GET cannot restore privacy');
 assert.equal((await cookieResume(f)).returning.status,'restored');assert.equal((await dailyStartup(f)).privateAllowed,true);
 const after=await sessionSettings(f);assert.equal(after.revision,before.revision);assert.equal(after.endpoint.endpointId,before.endpoint.endpointId);assert.equal(after.endpoint.configurationRevision,before.endpoint.configurationRevision);assert.equal(after.selectedConversation.conversationId,bound.scope.contextBinding.conversationId);
 assert.equal(retained.actor.isCurrent(bound.scope),false);assert.equal(retained.actor.runtimeFor(bound.scope,{}),null);assert.equal(delegates,0);assert.equal(f.app.ubuntuGameBackend.scope,undefined,'Resume cannot recreate Bind');
 const reply=await f.post('/api/runtime/v1/messages',{assistantId:f.assistantId,conversationId:after.selectedConversation.conversationId,userInput:'TEST synthetic ordinary chat after cached cookie resume'});assert.equal(reply.status,200,await reply.clone().text());assert.match(await reply.text(),/interaction.completed/);assert.equal(f.app.ubuntuGameBackend.scope,undefined);f.noEffects();
});
test('Daily59 healthy same-cookie resume cannot revive a CT binding retired by real conversation selection ABA',async t=>{
 const f=await fixture(t,{history:true});await f.disclose();const bound=await readJson(await f.post(route+'bind')),conversationId=bound.scope.contextBinding.conversationId,next=randomUUID();
 new ConversationHistoryRepository(f.app.database).adopt({actorId:f.user.principalId,effectiveUserId:f.user.principalId,contextGeneration:0},f.assistantId,next,new Date().toISOString());
 await selectAdoptedChat(f,next);await selectAdoptedChat(f,conversationId);
 assert.equal((await readJson(await f.post(route+'status'))).contextReady,false);assert.equal((await cookieResume(f)).returning.status,'restored');assert.equal((await dailyStartup(f)).privateAllowed,true);
 const after=await readJson(await f.post(route+'status'));assert.equal(after.contextReady,false);assert.equal(after.scope.contextBinding.conversationId,conversationId);assert.equal((await f.post(route+'permission')).status,403);f.noEffects();
});
test('Daily59 same-cookie resume keeps Lock, Withhold plus Save and pending Lock protected in a bound CT session',async t=>{
 for(const kind of ['lock','withholdThenSave','pendingLock'])await t.test(kind,async t=>{
  const f=await fixture(t,{history:true});await f.disclose();await readJson(await f.post(route+'bind'));
  if(kind==='lock')await personalCommand(f,'lock');
  if(kind==='withholdThenSave'){
   const settings=await sessionSettings(f),key=f.app.database.connection.prepare('SELECT binding_key FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').get(f.user.principalId,settings.endpoint.endpointId).binding_key;
   for(const audienceScope of ['unknown','authenticatedSession'])await readJson(await f.post('/api/runtime/v1/session-context',{expectedRevision:(await sessionSettings(f)).revision,bindingKey:key,mode:'text',audienceScope}));
  }
  assert.equal((await cookieResume(f,kind==='pendingLock')).returning.status,'protected');assert.equal((await dailyStartup(f)).privateAllowed,false);assert.equal((await readJson(await f.post(route+'status'))).contextReady,false);assert.equal((await f.post(route+'permission')).status,403);f.noEffects();
 });
});

test('trusted supervised permission review excludes SNES Start and closed HTTP bodies cannot widen its profile',async t=>{
 const f=await fixture(t);await f.disclose();assert.equal((await f.post(route+'bind')).status,200);
 for(const body of [{allowSnesStart:true},{sessionProfile:'qualification'},{controllerPolicy:{allowedButtons:['start']}}])assert.equal((await f.post(route+'permission',body)).status,400);
 const reviewed=await readJson(await f.post(route+'permission'));assert.equal(reviewed.state,'pending');assert.equal(reviewed.requestedClass,'allowSession');assert.match(reviewed.effectSummary,/SNES Start button is forbidden/);assert.match(reviewed.effectSummary,/8 actions/);assert.match(reviewed.effectSummary,/90000 ms/);f.noEffects();
});

test('dedicated CT authenticates before creating storage and refuses missing CSRF',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();
 for(const extra of [{cookie:''},{'x-lifestream-csrf':'TEST-invalid'}])assert.throws(()=>f.app.openDedicatedCtSession(f.request(extra),f.game,directory,{request(){},response(){}}));
 assert.equal(existsSync(directory),false);assert.equal(f.app.ubuntuGameBackend,undefined);
});

test('dedicated CT uses real original auth and profile with zero identity DB writes through canonical approval',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();let owner;
 t.after(async()=>{await owner?.close();await rm(directory,{recursive:true,force:true});});
 const identity=f.app.database,before=identity.connection.prepare('SELECT total_changes() AS n').get().n;
 owner=f.app.openDedicatedCtSession(f.request(),f.game,directory,{request(){assert.fail('No model call expected');},response(){assert.fail('No model result expected');}});
 const store=f.app.dedicatedCtStore.database;
 assert.notEqual(store,identity);assert.equal(owner.status().contextReady,true);
 for(const table of ['local_accounts','local_sessions','assistant_profiles','conversation_catalog'])assert.equal(store.connection.prepare('SELECT count(*) AS n FROM '+table).get().n,0,table+' identities must not be copied');
 const pending=await owner.reviewPermission();assert.equal(pending.state,'pending');
 const payload={requestId:pending.requestId,expectedRevision:pending.revision,confirmationDigest:pending.confirmationDigest,grantClass:'allowSession',expiresAt:pending.grantExpiresAt,reviewAfter:pending.reviewAfter};
 const result=await owner.authority('POST','/api/authority/v1/requests/'+pending.requestId+'/approve',{schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload});
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.result.grant.grantClass,'allowSession');
 assert.equal(store.connection.prepare('SELECT count(*) AS n FROM canonical_grants').get().n,1);
 assert.equal(identity.connection.prepare('SELECT count(*) AS n FROM canonical_grants').get().n,0);
 assert.equal(identity.connection.prepare('SELECT total_changes() AS n').get().n,before,'Binding/review/approval must not write identity/profile/history DB');
 assert.equal(f.app.gameHost,undefined);assert.equal(f.app.gameRuntimeOptions,undefined);
 await assert.rejects(owner.authority('GET','/api/authority/v1/requests/'+randomUUID(),{}));
 identity.connection.prepare('UPDATE assistant_profiles SET revision=revision+1 WHERE profile_id=?').run(f.game.profile.profileId);
 assert.throws(()=>owner.status(),/game_profile_changed/);
});

test('original authenticated actor retains a fail-closed runtime port before later CT installation',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 assert.equal(f.app.gameRuntimeOptions,undefined);
 const actor=f.app.gameHostActor(f.request(),true,true);
 assert.equal(typeof actor.runtimeFor,'function');
 assert.equal(actor.runtimeFor({},{}),null,'Absent runtime cannot be fabricated');
});

test('dedicated original request preparation retains actual persona and omits durable learning selection',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();let owner;
 t.after(async()=>{await owner?.close();await rm(directory,{recursive:true,force:true});});
 owner=f.app.openDedicatedCtSession(f.request(),f.game,directory,{request(){},response(){}});
 const original=f.app.experience,select=original.select.bind(original);let selections=0;
 // Reproduce the enabled-learning write which independent review found beyond
 // Bind/approval coverage. The genuine owner still performs its normal reads.
 original.select=(...args)=>{selections++;const result=select(...args);f.app.database.connection.prepare('INSERT INTO local_auth_events(principal_id,action,occurred_at) VALUES(?,?,?)').run(f.user.principalId,'TEST-learning-selection-write-tripwire',Date.now());return result;};
 const before=f.app.database.connection.prepare('SELECT total_changes() AS n').get().n;
 const prepared=f.app.prepareRuntimeInput({assistantId:f.assistantId,relationshipId:f.game.template.relationshipId,userInput:''},f.self(),'inactive','sessionEndpoint',()=>true,'activityStep',undefined,true);
 assert.equal(prepared.profileProjection.sourceRef,'assistant-profile:'+f.game.profile.profileId);
 assert.match(prepared.profileProjection.sourceRevision,/^1:adaptations:/);
 assert.equal(prepared.isCurrent(),true);assert.ok(prepared.preparedTurnBinding);
 assert.equal(selections,0);assert.equal(prepared.experienceSelection,undefined);assert.equal(prepared.onCompleted,undefined);
 assert.equal(f.app.database.connection.prepare('SELECT total_changes() AS n').get().n,before);
 const {captureGameRuntimeOptions}=await import(`${prefix}/runtime/game-host-runtime.${extension}`);
 const scope=owner.scope,approved={scope,approvedUntil:new Date(Date.now()+5000).toISOString(),maximumRunMs:5000,maximumPlanningSteps:1,observations:true,campaignJournal:true,controllerInput:false,memoryEpisodes:false};
 // Synthetic approval/observation ONLY; the actor, original preparation and
 // finalized-turn minting are real. Never run this fixture provider.
 f.app.gameRuntimeOptions=captureGameRuntimeOptions({resolveApproval:()=>approved,sourceCurrent:()=>true});
 const actor=f.app.gameHostActor(f.request(),true,true),repository=new ActivityCheckpointRepository(f.app.dedicatedCtStore.database,{maxRuns:4,maxReservations:8,maxCheckpointBytes:32768});
 const runtime=actor.runtimeFor(scope,repository);assert.ok(runtime);t.after(()=>runtime.close());
 const campaign=gameCampaignFixture(),input=structuredClone(campaign.input);
 input.expectedScope=scope;input.observation.scope=scope;input.binding.scope=scope;input.journal.campaignId=scope.campaignId;input.binding.journal=input.journal;
 for(const entry of input.binding.entryBindings)if(entry.currentDisposition==='current'){entry.runId=scope.runId;entry.timelineId=scope.timelineId;}
 const selection=selectGameCampaignContext(input,campaign.boundary);assert.equal(selection.status,'selected');
 const step=runtime.preparePlanning(selection,{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024,maximumOutputBytes:16384,maximumChunks:256});
 const final=requestForFinalizedTurn(step.turn,step.binding,()=>runtime.isCurrent());
 assert.equal(final.sections[1].sourceRef,'assistant-profile:'+f.game.profile.profileId);
 assert.equal(selections,0);assert.equal(f.app.database.connection.prepare('SELECT total_changes() AS n').get().n,before,'Actual actor.runtimeFor -> preparePlanning must remain read-only');
 assert.throws(()=>f.app.prepareRuntimeInput({assistantId:f.assistantId},f.self(),'inactive','sessionEndpoint',()=>true,'userTurn',undefined,true),/ct_read_only_activity_required/);
});

test('trusted host CT uses original current session without cookies and revokes with original logout',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();let owner;
 t.after(async()=>{await owner?.close();await rm(directory,{recursive:true,force:true});});
 const before=f.app.database.connection.prepare('SELECT total_changes() AS n').get().n;
 owner=f.app.openDedicatedCtHostSession(f.user.sessionId,f.game,directory,{request(){},response(){}});
 assert.equal(owner.scope.contextBinding.sessionId,f.user.sessionId);assert.equal(owner.status().contextReady,true);
 assert.equal(f.app.database.connection.prepare('SELECT total_changes() AS n').get().n,before);
 f.app.localAuth.logout(f.self());assert.throws(()=>owner.status());
});

test('trusted host CT fails original missing-session, administration freshness and proxy checks before storage',async t=>{
 for(const failure of ['missingSession','expiredAdmin','proxy'])await t.test(failure,async t=>{
  const f=await fixture(t,{dedicated:true});await f.disclose();
  const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();
  let sessionId=f.user.sessionId;
  if(failure==='missingSession')sessionId=randomUUID();
  if(failure==='expiredAdmin'){const old=Date.now()-31*60000;f.app.database.connection.prepare('UPDATE local_sessions SET authenticated_at=?,admin_last_activity=? WHERE session_id=?').run(old,old,sessionId);}
  if(failure==='proxy')f.proxy(await f.other());
  assert.throws(()=>f.app.openDedicatedCtHostSession(sessionId,f.game,directory,{request(){},response(){}}));
  assert.equal(existsSync(directory),false);assert.equal(f.app.ubuntuGameBackend,undefined);
 });
});

test('original continuing host traffic keeps non-administrative authentication semantics',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const old=Date.now()-31*60000;f.app.database.connection.prepare('UPDATE local_sessions SET authenticated_at=?,admin_last_activity=? WHERE session_id=?').run(old,old,f.user.sessionId);
 assert.doesNotThrow(()=>f.app.gameHostActor(f.request(),false));
 assert.throws(()=>f.app.gameHostActor(f.request(),true),error=>error.code==='administration_freshness_required');
});

test('trusted host CT preserves original loopback transport requirement',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID(),originalHost=f.app.host;
 try{f.app.host='0.0.0.0';assert.throws(()=>f.app.openDedicatedCtHostSession(f.user.sessionId,f.game,directory,{request(){},response(){}}),error=>error.code==='local_auth_requires_loopback_transport');}
 finally{f.app.host=originalHost;}
 assert.equal(existsSync(directory),false);
});

test('shutdown retains CT storage until pending host reconciliation has closed',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();let owner;
 t.after(async()=>{await owner?.close();await rm(directory,{recursive:true,force:true});});
 owner=f.app.openDedicatedCtHostSession(f.user.sessionId,f.game,directory,{request(){},response(){}});
 const store=f.app.dedicatedCtStore.database;let closed=false;
 // The real GameHostPort.close reconciles pending durable dispatch rows. This
 // isolated close control proves its backing DB is still usable at that point.
 f.app.gameHost={close(){if(closed)return;closed=true;store.connection.prepare('SELECT 1').get();}};
});
