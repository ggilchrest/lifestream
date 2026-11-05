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
const prefix=new URL(entry==='compiled'?'../dist/':'../src/',import.meta.url).href.replace(/\/$/,''),extension=entry==='compiled'?'js':'ts';
const {createLifestreamServer}=await import(`${prefix}/index.${extension}`);
const {loadProfile}=await import(`${prefix}/config/loader.${extension}`);
const {supervisedSessionBounds}=await import(`${prefix}/runtime/supervised-game-session.${extension}`);
const {selectSessionConversation,reviseSessionEndpoint,readSessionEndpoint}=await import(`${prefix}/runtime/session-context.${extension}`);
const route='/api/runtime/v1/game-session/';
async function fixture(t,mode={}){
 const integrationCounts={refresh:0,assert:0,repositoryCalls:0};
 const root=await mkdtemp(join(tmpdir(),'CT18-SYNTHETIC-'));const oldMask=mode.history?process.umask(0o077):null;let app;t.after(async()=>{try{await app?.shutdown();await rm(root,{recursive:true,force:true});}finally{if(oldMask!==null)process.umask(oldMask);}});
 const config=loadProfile('test');assert.equal(config.profile,'test');assert.equal(config.providers.inference,'fixture');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const localAuth={stateDirectory:join(root,'auth'),installerToken:'TEST-only-ct18',...(mode.persistent?{personalSessionPolicy:{enabled:true,scope:'installationOwner',expiration:'untilRevoked',windowFocusRequired:false}}:{})},environmentId=randomUUID();
 app=createLifestreamServer({config,localAuth,sessionEnvironmentId:environmentId});app.providers.inference.generate=()=>{throw Error('TEST-model-forbidden');};await app.start();const port=app.address().port,origin='http://127.0.0.1:'+port,headers={origin,'content-type':'application/json'};
 const post=(path,body={},extra={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 const setup=await post('/api/auth/v1/setup',{username:'TEST-ct18-owner',password:'TEST-ct18-password-only-12345',installerToken:localAuth.installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie').split(';')[0];const user=(await setup.json()).session;headers['x-lifestream-csrf']=user.csrfToken;
 const created=await post('/api/admin/v1/assistants',{displayName:'TEST-only-existing-assistant'});assert.equal(created.status,201);const {assistantId,profile}=await created.json();assert.equal((await post(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:profile.profileId,expectedActiveRevision:null})).status,200);
 const relation=await post(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relation.status,201);const {relationship}=await relation.json();
 const template={assistantId,principalId:user.principalId,relationshipId:relationship.relationshipId,environmentId,activityId:randomUUID(),runId:randomUUID(),activityEpoch:1,timelineId:randomUUID(),timelineRevision:1,observationDomain:'simulatedGame',campaignId:randomUUID(),ownerPermissionRef:'TEST-ct18-not-native-or-controller-authority'};
 const game={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',initialDialogue:'TEST-only-dialogue',template,profile:{profileId:profile.profileId,revision:1},maximumRunMs:90000,maximumPlanningSteps:8,planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024},attach:{pinsDigest:'a'.repeat(64),providerRef:'TEST-no-native',hostId:randomUUID(),sourceRevision:'b'.repeat(64)},campaign:{bounds:{...supervisedSessionBounds},policy:{revision:1}},nativeInstallation:mode.nativeFacts?{kind:'c72-container',configurationFile:join(root,'TEST-absent-native-facts.json')}:null,nativeLaunch:null};
 await app.shutdown();app=createLifestreamServer({config,localAuth:{stateDirectory:localAuth.stateDirectory,...(mode.persistent?{personalSessionPolicy:localAuth.personalSessionPolicy}:{})},port,sessionEnvironmentId:environmentId,ubuntuGame:mode.dedicated?undefined:game,...(mode.history?{audiencePrivacy:{sourceIds:[]},historyStateRoot:root,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'}}:{})});app.providers.inference.generate=()=>{throw Error('TEST-model-forbidden');};await app.start();
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
 return {get app(){return app;},game,request(extra={}){const value=new IncomingMessage(new Socket());value.method='POST';value.headers={...headers,host:new URL(origin).host,...extra};return value;},post,headers,user,origin,disclose,other,proxy,noEffects,raw,self,assistantId,integrationCounts,async restart(){await app.shutdown();app=createLifestreamServer({config,localAuth:{stateDirectory:localAuth.stateDirectory,...(mode.persistent?{personalSessionPolicy:localAuth.personalSessionPolicy}:{})},port,sessionEnvironmentId:environmentId,ubuntuGame:mode.dedicated?undefined:game,...(mode.history?{audiencePrivacy:{sourceIds:[]},historyStateRoot:root,historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'requireExisting'}}:{})});await app.start();}};
}

const endpoint='/api/runtime/v1/ct-browser-owner';
const get=(f,extra={})=>fetch(f.origin+endpoint,{headers:{...f.headers,...extra},signal:AbortSignal.timeout(5000)});
const body=async r=>({status:r.status,value:await r.json()});
test('actual original HTTP auth/CSRF/origin/freshness plus read-only GET; no session selector in response',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();t.after(()=>rm(directory,{recursive:true,force:true}));
 const bridge=f.app.registerDedicatedCtBrowserOwner(f.game,directory,{request(){assert.fail('No model');},response(){assert.fail('No model');}},{current(){},expiresAt:Date.now()+90000});
 assert.equal((await get(f,{cookie:''})).status,401);assert.equal((await get(f,{origin:'https://TEST-foreign.invalid'})).status,403);
 assert.equal((await f.post(endpoint,{}, {'x-lifestream-csrf':'TEST-wrong'})).status,403);
 const originalNow=f.app.localAuth.now;f.app.localAuth.now=()=>Date.now()+31*60000;const stale=await body(await get(f));assert.equal(stale.status,403);assert.equal(stale.value.code,'administration_freshness_required');f.app.localAuth.now=originalNow;
 const waiting=await body(await get(f));assert.deepEqual(waiting.value,{schemaVersion:'ct-browser-owner-review/1',state:'waitingForWorker',canBind:false});assert.equal(existsSync(directory),false);
 bridge.arm();const review=await body(await get(f));assert.equal(review.value.canBind,true);for(const secret of [f.user.sessionId,f.user.csrfToken,f.headers.cookie])assert(!JSON.stringify(review.value).includes(secret));
 for(const extra of [{actorId:f.user.principalId},{sessionId:f.user.sessionId},{configuration:f.game},{path:'/TEST'}]){const r=await f.post(endpoint,{challenge:review.value.challenge,...extra});assert.equal(r.status,422);}assert.equal(existsSync(directory),false);
 const foreign=await f.other();const signed=await f.post('/api/auth/v1/sign-in',{username:'TEST-ct18-other',password:'TEST-ct18-other-password-12345'});const foreignCookie=signed.headers.get('set-cookie').split(';')[0];const foreignResult=await body(await get(f,{cookie:foreignCookie}));assert.equal(foreignResult.status,409);assert.equal(foreignResult.value.code,'effective_context_changed');
 const session=await (await fetch(f.origin+'/api/runtime/v1/session-context',{headers:f.headers})).json(),privacy=await (await fetch(f.origin+'/api/runtime/v1/audience/personal-session',{headers:f.headers})).json();const locked=await f.post('/api/runtime/v1/audience/personal-session',{operation:'lock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:privacy.revision,expectedPersonalSessionEpoch:privacy.personalSessionEpoch,expectedSessionRevision:session.revision,endpointId:session.endpoint.endpointId,expectedEndpointRevision:session.endpoint.configurationRevision});assert.equal(locked.status,200);assert.equal((await get(f)).status,403);assert.equal(existsSync(directory),false);
});
test('actual retained request POST binds original owner; safe original permission summary suffices for unchanged canonical approval',async t=>{
 const f=await fixture(t,{dedicated:true});await f.disclose();const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();t.after(()=>rm(directory,{recursive:true,force:true}));
 const bridge=f.app.registerDedicatedCtBrowserOwner(f.game,directory,{request(){assert.fail('No model');},response(){assert.fail('No model');}},{current(){},expiresAt:Date.now()+90000});bridge.arm();
 const checked=await body(await get(f));assert.equal(checked.status,200);const bound=await body(await f.post(endpoint,{challenge:checked.value.challenge}));assert.equal(bound.status,200);assert.deepEqual(bound.value,{schemaVersion:'ct-browser-owner-review/1',state:'bound',canBind:false,nativeStarted:false});
 assert.equal((await f.post(endpoint,{challenge:checked.value.challenge})).status,409);const owner=await bridge.owner();const pending=await owner.reviewPermission();assert.match(pending.confirmationDigest,/^[a-f0-9]{64}$/);assert.equal(pending.requestedClass,'allowSession');
 const {readFileSync}=await import('node:fs'),{compileFunction}=await import('node:vm'),{createHash}=await import('node:crypto');const runner=readFileSync(new URL('../../../integration/ct-launcher/dedicated-ct-job.mjs',import.meta.url),'utf8');const selected=runner.slice(runner.indexOf(' const approvalSummary=value=>{'),runner.indexOf(' const frameSummary='));
 const summary=compileFunction(selected+'return approvalSummary;',['uuid','hash','fail'])(x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),code=>{throw Error(code);})(pending);
 assert(!JSON.stringify(summary).includes(f.user.sessionId));assert(!Object.hasOwn(summary,'scope'));const approval={schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload:{requestId:summary.requestId,expectedRevision:summary.revision,confirmationDigest:summary.confirmationDigest,grantClass:'allowSession',expiresAt:summary.grantExpiresAt,reviewAfter:summary.reviewAfter}};
 const {createContractValidator}=await import('@lifestream/contracts');assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/ApproveAuthorityRequestRequest',approval).valid,true);
 const result=await owner.authority('POST','/api/authority/v1/requests/'+summary.requestId+'/approve',approval);assert.equal(result.status,200);assert.equal(f.app.database.connection.prepare('SELECT count(*) AS n FROM canonical_grants').get().n,0);assert.equal(f.app.dedicatedCtStore.database.connection.prepare('SELECT count(*) AS n FROM canonical_grants').get().n,1);
 assert.equal(f.app.gameHost,undefined);assert.equal(f.app.gameRuntimeOptions,undefined);await bridge.close();
});

test('original current endpoint needs no extra selected chat; browser GET adds no metadata store',async t=>{const f=await fixture(t,{dedicated:true});await f.disclose();f.app.database.connection.prepare('DELETE FROM conversation_catalog').run();const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();t.after(()=>rm(directory,{recursive:true,force:true}));const bridge=f.app.registerDedicatedCtBrowserOwner(f.game,directory,{request(){assert.fail('No model');},response(){assert.fail('No model');}},{current(){},expiresAt:Date.now()+90000});bridge.arm();const r=await body(await get(f));assert.equal(r.status,200);assert.equal(r.value.canBind,true);assert.equal(existsSync(directory),false);});
test('actual delayed POST body cannot survive original manual Lock after request capture',async t=>{const f=await fixture(t,{dedicated:true});await f.disclose();let currentCalls=0;const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();t.after(()=>rm(directory,{recursive:true,force:true}));const bridge=f.app.registerDedicatedCtBrowserOwner(f.game,directory,{request(){assert.fail('No model');},response(){assert.fail('No model');}},{current(){currentCalls++;},expiresAt:Date.now()+90000});bridge.arm();const review=await (await get(f)).json(),before=currentCalls;let resolveResponse;const response=new Promise(r=>resolveResponse=r),request=httpRequest(f.origin+endpoint,{method:'POST',headers:f.headers},r=>{r.resume();r.on('end',()=>resolveResponse(r.statusCode));});request.on('error',e=>{throw e;});request.flushHeaders();request.write('{"challenge":');for(let i=0;currentCalls===before&&i<100;i++)await new Promise(r=>setTimeout(r,1));assert(currentCalls>before,'actual original route captured the request before body completion');const session=await (await fetch(f.origin+'/api/runtime/v1/session-context',{headers:f.headers})).json(),privacy=await (await fetch(f.origin+'/api/runtime/v1/audience/personal-session',{headers:f.headers})).json();const lock=await f.post('/api/runtime/v1/audience/personal-session',{operation:'lock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:privacy.revision,expectedPersonalSessionEpoch:privacy.personalSessionEpoch,expectedSessionRevision:session.revision,endpointId:session.endpoint.endpointId,expectedEndpointRevision:session.endpoint.configurationRevision});assert.equal(lock.status,200);request.end(JSON.stringify(review.challenge)+'}');assert.equal(await response,403);assert.equal(existsSync(directory),false);});

test('inactive original relationship refuses before challenge consumption or owner construction',async t=>{const f=await fixture(t,{dedicated:true});await f.disclose();const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();t.after(()=>rm(directory,{recursive:true,force:true}));const bridge=f.app.registerDedicatedCtBrowserOwner(f.game,directory,{request(){assert.fail('No model');},response(){assert.fail('No model');}},{current(){},expiresAt:Date.now()+90000});bridge.arm();const review=await (await get(f)).json(),id=f.game.template.relationshipId,row=f.app.database.connection.prepare('SELECT payload_json FROM assistant_relationships WHERE relationship_id=?').get(id),retired={...JSON.parse(row.payload_json),status:'ended'};f.app.database.connection.prepare('UPDATE assistant_relationships SET payload_json=? WHERE relationship_id=?').run(JSON.stringify(retired),id);assert.equal((await get(f)).status,403);assert.equal((await f.post(endpoint,{challenge:review.challenge})).status,403);assert.equal(existsSync(directory),false);});

test('actual original server constructs /3 timing from fixed ports only and refuses lookalike or replaced lifecycle before browser owner registration',async t=>{
 const f=await fixture(t,{dedicated:true,persistent:true});await f.disclose();
 const {createSelectedCtJobLifecycle,isSelectedCtJobLifecycle}=await import('../../../integration/ct-launcher/ct-job-lifecycle-owner.mjs');
 const execution={maximumGameplayMs:64000,operationLimits:{owner_prepare:120000,native_prepare:120000,native_start:120000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:5000};
 const fake=Object.freeze({check:()=>true,signal:new AbortController().signal});assert.throws(()=>f.app.prepareDedicatedCtLifecycle(execution,()=>fake,isSelectedCtJobLifecycle));
 const lifecycle=f.app.prepareDedicatedCtLifecycle(execution,createSelectedCtJobLifecycle,isSelectedCtJobLifecycle);t.after(()=>lifecycle.stop());assert.equal(isSelectedCtJobLifecycle(lifecycle,execution),true);assert.equal(lifecycle.snapshot().state,'preparing');assert.equal(lifecycle.snapshot().activeGameplayMs,0);assert.throws(()=>lifecycle.ready());assert.throws(()=>lifecycle.beginGameplay());
 const directory=join(tmpdir(),'CT63-MUST-NOT-EXIST-'+randomUUID());const evidence={request(){assert.fail('No model');},response(){assert.fail('No model');}};
 assert.throws(()=>f.app.registerDedicatedCtBrowserOwner(f.game,directory,evidence,{current(){},preparation:'untilCancelled',lifecycle:fake}));
 const bridge=f.app.registerDedicatedCtBrowserOwner(f.game,directory,evidence,{current(){assert.equal(lifecycle.check(),true);},preparation:'untilCancelled',lifecycle});bridge.arm();const review=await body(await get(f));assert.equal(review.status,200);assert.equal(review.value.canBind,true);assert.equal(existsSync(directory),false);assert.equal(lifecycle.snapshot().gameplayStarted,false);f.noEffects();await lifecycle.stop();assert.equal((await get(f)).status,409);assert.equal(existsSync(directory),false);f.noEffects();
});

// CT67 joined original local auth -> dedicated owner -> session/backend -> actual
// canonical SQLite/native preparation. All identities/state are temporary test
// fixtures. Public native source/continuation pins are read, never executed.
async function preparation67(t,{deferOwner=false}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=await fixture(t,{dedicated:true,persistent:true});await f.disclose();
 const fs=await import('node:fs'),native=await import('@lifestream/providers-bizhawk/c72-native-configuration');
 const root=await mkdtemp(join(tmpdir(),'CT67-JOINED-')),nativeRoot=join(root,'native'),templateFile=join(root,'template.json');
 const pin=path=>({path,sha256:native.fileDigest(fs.readFileSync(path))});
 const template={schemaVersion:'ct-native-template/1',image:native.C72_IMAGE,wrapper:pin(native.C72_WRAPPER),seccomp:pin(native.C72_SECCOMP),frontend:pin(native.C72_FRONTEND),continuation:{path:native.C72_STATE,...native.C72_CONTINUATION},sources:Object.fromEntries(Object.entries(native.C72_SOURCES).map(([k,p])=>[k,pin(p).sha256])),imagePins:Object.fromEntries(['mono','rom','core','controller','configFactory'].map(k=>[k,native.C72_KNOWN_PINS[k]])),romSha1:'b'.repeat(40),qualificationRef:'TEST-CT67-not-live-qualification'};
 fs.writeFileSync(templateFile,JSON.stringify(template)+'\n',{mode:0o600});
 f.game.nativePreparation={stateRoot:nativeRoot,templateFile,templateSha256:native.fileDigest(fs.readFileSync(templateFile))};
 f.game.nativeInstallation={kind:'c72-container',configurationFile:join(nativeRoot,'facts',f.game.template.runId+'.json')};
 const directory='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+randomUUID();
 const owner=deferOwner?null:f.app.openDedicatedCtSession(f.request(),f.game,directory,{request(){assert.fail('No model');},response(){assert.fail('No model');}});
 const db=f.app.dedicatedCtStore?.database;
 t.after(async()=>{await owner?.close();await rm(directory,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
 const {createHash}=await import('node:crypto'),digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const counts=()=>Object.fromEntries(['canonical_grant_requests','canonical_grants','game_host_dispatch'].map(table=>[table,Number(f.app.dedicatedCtStore.database.connection.prepare('SELECT count(*) AS n FROM '+table).get().n)]));
 const envelope=payload=>({schemaVersion:'1.0.0',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),payload});
 const grantBody=r=>envelope({requestId:r.requestId,expectedRevision:r.revision,confirmationDigest:r.confirmationDigest,grantClass:r.requestedClass,expiresAt:r.grantExpiresAt,reviewAfter:r.reviewAfter});
 const intent=()=>owner.reviewPreparationIntent();
 return {...f,owner,db,nativeRoot,templateFile,fs,native,digest,counts,envelope,grantBody,intent,advance:ms=>t.mock.timers.setTime(Date.now()+ms)};
}
test('CT67 joined intent survives days of review without request, grant, native facts or dispatch; original owner binds context without permission review',async t=>{
 const f=await preparation67(t),first=f.intent();assert.equal(first.schemaVersion,'ct-unused-preparation-intent/1');assert(Object.isFrozen(first));
 assert.deepEqual(f.counts(),{canonical_grant_requests:0,canonical_grants:0,game_host_dispatch:0});assert.equal(existsSync(f.nativeRoot),false);
 f.advance(7*24*60*60*1000);assert.deepEqual(f.intent(),first);assert.deepEqual(f.counts(),{canonical_grant_requests:0,canonical_grants:0,game_host_dispatch:0});assert.equal(existsSync(f.nativeRoot),false);
 const pair=f.owner.preparePreparationRequests(f.digest(first));assert.deepEqual(pair.intent,first);assert.equal(pair.permission.state,'pending');assert.equal(pair.native.state,'pending');assert.equal(Date.parse(pair.permission.expiresAt)-Date.now(),120000);assert.equal(Date.parse(pair.native.expiresAt)-Date.now(),120000);assert.equal(f.counts().canonical_grants,0);assert.equal(f.counts().game_host_dispatch,0);
});
test('CT67 joined expired unused requests renew within the same owner/store; old exact records and native confirmations cannot authorize the new pair',async t=>{
 const f=await preparation67(t),intent=f.intent(),digest=f.digest(intent),first=f.owner.preparePreparationRequests(digest),oldRow=f.db.connection.prepare('SELECT payload_json FROM canonical_grant_requests WHERE request_id=?').get(first.permission.requestId).payload_json;
 f.advance(120001);assert.deepEqual(f.intent(),intent);const second=f.owner.preparePreparationRequests(digest);assert.notEqual(second.permission.requestId,first.permission.requestId);assert.notEqual(second.native.requestId,first.native.requestId);assert.notEqual(second.permission.confirmationDigest,first.permission.confirmationDigest);assert.notEqual(second.native.confirmationDigest,first.native.confirmationDigest);
 assert.equal(f.db.connection.prepare('SELECT payload_json FROM canonical_grant_requests WHERE request_id=?').get(first.permission.requestId).payload_json,oldRow);assert.equal(f.counts().canonical_grant_requests,2);assert.equal(f.counts().canonical_grants,0);
 const expired=await f.owner.authority('POST','/api/authority/v1/requests/'+first.permission.requestId+'/approve',f.grantBody(first.permission));assert.equal(expired.status,409);assert.equal(f.counts().canonical_grants,0);
 assert.throws(()=>f.owner.approveNative({requestId:first.native.requestId,expectedRevision:first.native.revision,confirmationDigest:first.native.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true}));assert.equal(f.counts().game_host_dispatch,0);
});
for(const decision of ['deny','cancel'])test('CT67 joined explicit '+decision+' cannot be cleared by unused-request renewal',async t=>{
 const f=await preparation67(t),intent=f.intent(),pair=f.owner.preparePreparationRequests(f.digest(intent));
 const result=await f.owner.authority('POST','/api/authority/v1/requests/'+pair.permission.requestId+'/'+decision,f.envelope({requestId:pair.permission.requestId,expectedRevision:pair.permission.revision,confirmationDigest:pair.permission.confirmationDigest,reason:{code:'test_explicit_decision',summary:'Synthetic explicit owner decision.'}}));assert.equal(result.status,200);
 f.advance(120001);assert.throws(f.intent);assert.throws(()=>f.owner.preparePreparationRequests(f.digest(intent)));assert.equal(f.counts().canonical_grant_requests,1);assert.equal(f.counts().canonical_grants,0);
});
test('CT67 joined actual approved/revoked controller grant remains terminal for preparation even after its finite lifetime',async t=>{
 const f=await preparation67(t),intent=f.intent(),pair=f.owner.preparePreparationRequests(f.digest(intent));
 const result=await f.owner.authority('POST','/api/authority/v1/requests/'+pair.permission.requestId+'/approve',f.grantBody(pair.permission));assert.equal(result.status,200);assert.equal(f.counts().canonical_grants,1);assert.throws(f.intent);
 const {CanonicalGrantRepository}=await import('@lifestream/storage-sqlite'),repo=new CanonicalGrantRepository(f.db,'local-human'),grantId=f.db.connection.prepare('SELECT grant_id FROM canonical_grants').get().grant_id;
 const context={principalId:f.user.principalId,providerRef:'local-human',authenticationEvidenceRef:'urn:lifestream:TEST-CT67-explicit-revocation',now:()=>new Date().toISOString(),assertCurrent(){f.app.localAuth.assertCurrent(f.self(),true);}};
 repo.revokeGrant({grantId,expectedRevision:1},{requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID()},context);
 f.advance(120001);assert.throws(f.intent);assert.throws(()=>f.owner.preparePreparationRequests(f.digest(intent)));assert.equal(f.counts().canonical_grant_requests,1);assert.equal(f.counts().canonical_grants,1);
});
test('CT67 joined native approval cannot return to nonauthorizing intent or renew its finite facts',async t=>{
 const f=await preparation67(t),intent=f.intent(),pair=f.owner.preparePreparationRequests(f.digest(intent)),before=f.fs.readFileSync(f.game.nativeInstallation.configurationFile);
 f.owner.approveNative({requestId:pair.native.requestId,expectedRevision:pair.native.revision,confirmationDigest:pair.native.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true});assert.throws(f.intent);
 f.advance(120001);assert.throws(f.intent);assert.throws(()=>f.owner.preparePreparationRequests(f.digest(intent)));assert.deepEqual(f.fs.readFileSync(f.game.nativeInstallation.configurationFile),before);assert.equal(f.counts().canonical_grants,0);assert.equal(f.counts().game_host_dispatch,0);
});
for(const withdraw of ['lock','sign-out','close','source','profile'])test('CT67 joined '+withdraw+' stops dormant intent and request renewal',async t=>{
 const f=await preparation67(t),intent=f.intent();
 if(withdraw==='lock'){
  const session=await (await fetch(f.origin+'/api/runtime/v1/session-context',{headers:f.headers})).json(),privacy=await (await fetch(f.origin+'/api/runtime/v1/audience/personal-session',{headers:f.headers})).json();
  assert.equal((await f.post('/api/runtime/v1/audience/personal-session',{operation:'lock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:privacy.revision,expectedPersonalSessionEpoch:privacy.personalSessionEpoch,expectedSessionRevision:session.revision,endpointId:session.endpoint.endpointId,expectedEndpointRevision:session.endpoint.configurationRevision})).status,200);
 }else if(withdraw==='sign-out')assert.equal((await f.post('/api/auth/v1/sign-out',{})).status,200);
 else if(withdraw==='close')await f.owner.close();
 else if(withdraw==='source')f.fs.appendFileSync(f.templateFile,' ');
 else f.app.database.connection.prepare('UPDATE assistant_profiles SET revision=revision+1 WHERE assistant_id=?').run(f.assistantId);
 assert.throws(f.intent);assert.throws(()=>f.owner.preparePreparationRequests(f.digest(intent)));if(withdraw==='close')assert.throws(f.counts,/database is not open/);else assert.equal(f.counts().canonical_grant_requests,0);assert.equal(existsSync(f.nativeRoot),false);
});
test('CT67 joined partial native preparation failure creates no grant/dispatch and permanently refuses retry in that owner',async t=>{
 const f=await preparation67(t),intent=f.intent();f.fs.mkdirSync(f.nativeRoot,{mode:0o700});f.fs.mkdirSync(join(f.nativeRoot,'facts'),{mode:0o700});f.fs.writeFileSync(f.game.nativeInstallation.configurationFile,'{"TEST":"invalid original facts"}\n',{mode:0o600});
 assert.throws(()=>f.owner.preparePreparationRequests(f.digest(intent)));assert.equal(f.counts().canonical_grant_requests,1);assert.equal(f.counts().canonical_grants,0);assert.equal(f.counts().game_host_dispatch,0);assert.throws(f.intent);assert.throws(()=>f.owner.preparePreparationRequests(f.digest(intent)));assert.equal(f.counts().canonical_grant_requests,1);
});
test('CT67 actual filesystem launcher/browser/owner/SQLite join holds intent for days and renews unused requests without re-registration; stale renewed review fails closed',async t=>{
 const f=await preparation67(t,{deferOwner:true}),{mkdir,readFile,writeFile}=await import('node:fs/promises');
 const {registerDedicatedCtJob}=await import('../../../integration/ct-launcher/dedicated-ct-job.mjs');
 const {createSelectedCtJobLifecycle,isSelectedCtJobLifecycle}=await import('../../../integration/ct-launcher/ct-job-lifecycle-owner.mjs');
 const jobId=randomUUID(),root='/srv/lifestream/workspace/runtime-state/ct-owner-job-'+jobId,metadata='/srv/lifestream/workspace/runtime-state/ct-isolated-metadata-'+jobId;
 await mkdir(root,{mode:0o700});const rootInode=f.fs.statSync(root).ino,configurationBytes=Buffer.from(JSON.stringify(f.game));
 const execution={maximumGameplayMs:80000,operationLimits:{owner_prepare:30000,native_prepare:30000,native_start:30000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:10000};
 const selection={schemaVersion:'canonical-dedicated-ct-job/4',enabled:true,jobId,nonce:randomUUID().replaceAll('-',''),ownerBinding:'originalBrowserRequest',jobRoot:root,metadataDirectory:metadata,configurationSha256:f.native.fileDigest(configurationBytes),preparation:{mode:'untilCancelled'},execution};
 // Observe the original arm completing, rather than race its asynchronous file
 // fsync against the first real browser Review. Authentication is unmodified.
 let resolveArmed;const armed=new Promise(resolve=>resolveArmed=resolve),register=f.app.registerDedicatedCtBrowserOwner.bind(f.app);
 f.app.registerDedicatedCtBrowserOwner=(...args)=>{const original=register(...args);return Object.freeze({...original,arm(){original.arm();resolveArmed();}});};
 const lifecycle=f.app.prepareDedicatedCtLifecycle(execution,createSelectedCtJobLifecycle,isSelectedCtJobLifecycle);
 const job=await registerDedicatedCtJob(f.app,{selection,configuration:f.game,configurationBytes,lifecycle,evidenceOwner:{request(){assert.fail('No model');},response(){assert.fail('No model');}}});
 t.after(async()=>{await job.close();await job.completion;await rm(root,{recursive:true,force:true});await rm(metadata,{recursive:true,force:true});});
 const waitPublication=async name=>{const path=join(root,'published-'+name+'.json'),until=performance.now()+10000;while(!existsSync(path)){assert(performance.now()<until,'Expected original publication '+name);await new Promise(r=>setTimeout(r,5));}const raw=await readFile(path);return {raw,value:JSON.parse(raw),sha256:f.native.fileDigest(raw)};};
 const instruct=async(stage,pub,payload,stale=false)=>{
  const refs=[];
  for(const role of ['main','independent']){
   const review={schemaVersion:'ct52-staged-review/3',jobId,stage,role,status:'PASS',selectionDigest:pub.value.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:pub.sha256,generation:stale?1:pub.value.generation,intentDigest:pub.value.intentDigest,intentReview:stage.startsWith('prepare-')?{inspected:true,generation:pub.value.generation,intentDigest:pub.value.intentDigest}:null,imageReview:null};
   const raw=Buffer.from(JSON.stringify(review)+'\n'),name='review-'+role+'-'+stage+'.json';await writeFile(join(root,name),raw,{flag:'wx',mode:0o400});refs.push({name,sha256:f.native.fileDigest(raw),role});
  }
  const dispatch={schemaVersion:'ct52-worker-dispatch/3',jobId,nonce:selection.nonce,stage,selectionDigest:pub.value.selectionDigest,configurationSha256:selection.configurationSha256,publicationDigest:pub.sha256,preparation:{mode:'untilCancelled'},generation:pub.value.generation,intentDigest:pub.value.intentDigest,reviewReferences:refs,payload};
  await writeFile(join(root,'dispatch-'+stage+'.json'),JSON.stringify(dispatch)+'\n',{flag:'wx',mode:0o400});
 };
 const registered=await waitPublication('registered'),registrationClaim=await readFile(join(root,'REGISTRATION-CLAIM.json'));await instruct('owner',registered,{prepareOwner:true});
 await armed;assert.equal(existsSync(join(root,'CONSUMED-owner.json')),true);
 const review=await (await get(f)).json();assert.equal(review.canBind,true);assert.equal((await f.post(endpoint,{challenge:review.challenge})).status,200);
 const intent1=await waitPublication('preparation-intent-1');assert.deepEqual(f.counts(),{canonical_grant_requests:0,canonical_grants:0,game_host_dispatch:0});assert.equal(existsSync(f.nativeRoot),false);
 f.advance(7*24*60*60*1000);await new Promise(r=>setTimeout(r,125));assert.equal(existsSync(join(root,'published-staged-owner-1.json')),false);assert.deepEqual(f.counts(),{canonical_grant_requests:0,canonical_grants:0,game_host_dispatch:0});assert.equal(existsSync(f.nativeRoot),false);
 await instruct('prepare-1',intent1,{prepareRequests:true});const first=await waitPublication('staged-owner-1');assert.equal(f.counts().canonical_grant_requests,1);assert.equal(f.counts().canonical_grants,0);
 f.advance(120001);await instruct('renew-1',first,{returnToPreparation:true});const intent2=await waitPublication('preparation-intent-2');assert.equal(intent2.value.intentDigest,intent1.value.intentDigest);await instruct('prepare-2',intent2,{prepareRequests:true});const second=await waitPublication('staged-owner-2');
 assert.notEqual(first.value.permission.requestId,second.value.permission.requestId);assert.notEqual(first.value.native.requestId,second.value.native.requestId);assert.deepEqual(f.counts(),{canonical_grant_requests:2,canonical_grants:0,game_host_dispatch:0});assert.equal(lifecycle.snapshot().activeGameplayMs,0);assert.equal(lifecycle.snapshot().gameplayStarted,false);
 assert.equal(f.fs.statSync(root).ino,rootInode);assert.deepEqual(await readFile(join(root,'REGISTRATION-CLAIM.json')),registrationClaim);assert.deepEqual(await readFile(join(root,'published-staged-owner-1.json')),first.raw);assert.equal(existsSync(join(root,'CONSUMED-renew-1.json')),true);
 // Correct new publication/dispatch but intentionally stale actual review generation.
 await instruct('start-2',second,{},true);const failed=await waitPublication('failure');assert.equal(failed.value.code,'ct_job_staged_review_generation_mismatch');assert.equal(existsSync(join(root,'published-started.json')),false);await job.completion;
});
test('CT67 once-approved native intent remains terminal after legacy status clears approval on clock rollback and the clock is restored',async t=>{
 const f=await preparation67(t),intent=f.intent(),pair=f.owner.preparePreparationRequests(f.digest(intent));
 const {createUbuntuNativeApproval}=await import(`${prefix}/runtime/ubuntu-native-approval.${extension}`),scope=pair.native.scope;
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>true},context={assertCurrent(){}};
 const native=createUbuntuNativeApproval({scope,pinsDigest:f.game.attach.pinsDigest,configurationFile:f.game.nativeInstallation.configurationFile,inspectTemplate:()=>JSON.parse(f.fs.readFileSync(f.templateFile)),startCurrent:()=>false});t.after(()=>native.close());
 const review=native.review(actor,context);native.approve(actor,{requestId:review.requestId,expectedRevision:review.revision,confirmationDigest:review.confirmationDigest,launchOwnedNative:true,memoryOnlyPairing:true},context);
 const at=Date.now();t.mock.timers.setTime(at-1000);assert.equal(native.status(actor).state,'required');t.mock.timers.setTime(at);
 assert.throws(()=>native.preparationIntent(actor,context));assert.equal(f.counts().canonical_grants,0);assert.equal(f.counts().game_host_dispatch,0);
});
