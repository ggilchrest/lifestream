// Actual public build/host/Auth/DB/catalog owners only. All state is disposable.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {ConversationRetentionOwner} from '../dist/runtime/conversation-retention-owner.js';
import {Database, AssistantProfileRepository, MemoryRepository, ConversationHistoryRepository, type ConversationHistoryScope} from '@lifestream/storage-sqlite';
import {unifiedDesktopContractPin} from '@lifestream/contracts/unified-desktop-contracts';
import {createLifestreamServer, type ServerOptions} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication} from '../dist/auth/local-auth.js';
import {AudienceCoordinator} from '../dist/runtime/audience.js';
import {readSessionEndpoint, reviseSessionEndpoint} from '../dist/runtime/session-context.js';
const secret = () => 'Synthetic-' + randomBytes(24).toString('hex');
const pin = unifiedDesktopContractPin('conversation-history');
const route = '/api/runtime/v1/conversations';
type Owner = {cookie: string; csrf: string; principalId: string; sessionId: string; contextRef: string};
type Internals = {admin: {handle:(...args:any[])=>any}; memories:MemoryRepository; database: Database; localAuth: LocalAuthentication; durableConversations: ConversationHistoryRepository; durableConversationRepository?: ConversationHistoryRepository; conversationRetentionOwner?: ConversationRetentionOwner; audience?: AudienceCoordinator; automaticMemory: {enqueue: (...args: any[]) => any}; prepareRuntimeInput: (...args: any[]) => any; runtimeFences: Set<{sessionId?: string; abort: () => void}>};
async function fixture(retention = true, extra: Partial<ServerOptions> = {}, endpointClass = 'desktopCompanion') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'daily-workspace-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);let now = Date.now();
  const config = loadProfile('test');config.authority.authentication = 'local-password';config.storage = {databasePath: join(root, 'test.sqlite'), artifactDirectory: join(root, 'artifacts')};
  const installerToken = secret(), password = secret(), app = createLifestreamServer({config, localAuth: {stateDirectory: join(root, 'auth'), installerToken, now: () => now}, ...(retention ? {historyRetention: {mode: 'localUserConsent', retention: 'untilDeletion', journalInitialization: 'initializeEmpty'}, historyStateRoot: root} as Partial<ServerOptions> : {}), ...extra});
  try {await app.start();} catch (error) {process.umask(mask);rmSync(root, {recursive: true, force: true});throw error;}
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (owner: Owner | null, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {origin: base, 'content-type': 'application/json', ...(owner ? {cookie: owner.cookie, 'x-lifestream-csrf': owner.csrf, 'x-lifestream-user-context': owner.contextRef} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(10000)});
  const setup = await request(null, '/api/auth/v1/setup', {username: 'synthetic-owner', password, installerToken});assert.equal(setup.status, 201);const {session} = await setup.json();
  const owner: Owner = {cookie: setup.headers.get('set-cookie')!.split(';')[0]!, csrf: session.csrfToken, principalId: session.principalId, sessionId: session.sessionId, contextRef: ''};
  const scopeView = await fetch(base + '/api/auth/v1/user-context', {headers: {origin: base, cookie: owner.cookie}, signal: AbortSignal.timeout(5000)});assert.equal(scopeView.status, 200);owner.contextRef = (await scopeView.json()).contextRef;
  const response = await request(owner, '/api/runtime/v1/session-context', {expectedRevision: 0, mode: 'text', audienceScope: 'authenticatedSession', endpointClass, bindingKey: randomUUID()});assert.equal(response.status, 200);const sessionView = await response.json();
  const internal = app as unknown as Internals, assistantId = randomUUID();
  new AssistantProfileRepository(internal.database).create({schemaVersion: '2.0.0', assistantId, profileId: randomUUID(), revision: 1, status: 'draft', createdBy: owner.principalId, createdAt: new Date().toISOString()});
  const scope = (): ConversationHistoryScope => {const context = internal.localAuth.hostSessionContext(owner.sessionId);return {actorId: context.principalId, effectiveUserId: context.effectiveContext!.effectiveUserId, contextGeneration: context.effectiveContext!.generation, authorityCurrent: () => {try {internal.localAuth.assertCurrent(context, false);return true;} catch {return false;}}};};
  return {root, app, base, owner, sessionView, internal, assistantId, request, scope, time: () => now, advance: (ms: number) => {now += ms;}, close: async () => {await app.shutdown();process.umask(mask);rmSync(root, {recursive: true, force: true});}};
}
const envelope = (operation: string, payload: Record<string, unknown>) => ({producerPin: pin, request: {schemaVersion: '1.0.0', operation, operationId: randomUUID(), ...(['create', 'rename', 'pin', 'unpin', 'archive', 'restore'].includes(operation) ? {idempotencyKey: randomUUID()} : {}), payload}});
async function create(f: Awaited<ReturnType<typeof fixture>>, title = 'New chat') {const response = await f.request(f.owner, route, envelope('create', {assistantId: f.assistantId, title}));assert.equal(response.status, 200, await response.clone().text());return (await response.json()).result;}
function select(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, expectedSessionRevision = f.sessionView.revision) {return f.request(f.owner, route + '/select', {producerPin: pin, conversationId, assistantId: f.assistantId, expectedSessionRevision});}
async function lock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.request(f.owner, '/api/runtime/v1/audience/personal-session');assert.equal(state.status, 200);return state.json();
}
async function unlock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await lock(f), selected = readSessionEndpoint(f.internal.database, f.owner.sessionId);
  const response = await f.request(f.owner, '/api/runtime/v1/audience/personal-session', {operation: 'unlock', operationId: randomUUID(), declarationId: randomUUID(), expectedAudienceRevision: state.revision, expectedPersonalSessionEpoch: state.personalSessionEpoch, expectedSessionRevision: selected.revision, endpointId: selected.endpoint!.endpointId, expectedEndpointRevision: selected.endpoint!.configurationRevision});assert.equal(response.status, 200);return response.json();
}

async function commandLock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await (await f.request(f.owner, '/api/runtime/v1/audience/personal-session')).json(), selected = readSessionEndpoint(f.internal.database, f.owner.sessionId);
  const response = await f.request(f.owner, '/api/runtime/v1/audience/personal-session', {operation: 'lock', operationId: randomUUID(), declarationId: randomUUID(), expectedAudienceRevision: state.revision, expectedPersonalSessionEpoch: state.personalSessionEpoch, expectedSessionRevision: selected.revision, endpointId: selected.endpoint!.endpointId, expectedEndpointRevision: selected.endpoint!.configurationRevision});assert.equal(response.status, 200);
}

async function active(f: Awaited<ReturnType<typeof fixture>>, manual = true) {
  const created = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Synthetic workspace owner'});assert.equal(created.status, 201);const assistant = await created.json();f.assistantId = assistant.assistantId;
  assert.equal((await f.request(f.owner, `/api/admin/v1/assistants/${f.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null})).status, 200);
  const chat = await create(f);assert.equal((await select(f, chat.conversationId)).status, 200);if(manual)await unlock(f);
  return chat.conversationId;
}
async function message(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, userInput = 'Synthetic exact selected input', extra: Record<string, unknown> = {}) {return f.request(f.owner, '/api/runtime/v1/messages', {assistantId: f.assistantId, conversationId, userInput, ...extra});}
async function page(f: Awaited<ReturnType<typeof fixture>>, conversationId: string) {const response = await f.request(f.owner, route, envelope('page', {conversationId, direction: 'older', pageSize: 50}));assert.equal(response.status, 200);return (await response.json()).result.entries;}
const rows = (f: Awaited<ReturnType<typeof fixture>>, conversationId: string) => f.internal.database.connection.prepare('SELECT * FROM conversation_timeline WHERE conversation_id=? ORDER BY ordinal').all(conversationId);
async function waitFor(check: () => unknown) {const end = Date.now() + 2000;while (!check()) {if (Date.now() > end) assert.fail('Owned lifecycle metadata did not become available');await new Promise(resolve => setTimeout(resolve, 10));}}

const startup='/api/runtime/v1/daily-startup',workspace='/api/runtime/v1/daily-context',library='/api/runtime/v1/daily-library';
async function relationship(f:Awaited<ReturnType<typeof fixture>>){const response=await f.request(f.owner,`/api/admin/v1/assistants/${f.assistantId}/relationships`,{});assert.equal(response.status,201);return (await response.json()).relationship;}
function memory(f:Awaited<ReturnType<typeof fixture>>,relationshipId:string,content:string,actor=f.owner.principalId,id=randomUUID()){return f.internal.memories.save({id,assistantId:f.assistantId,content,provenance:{actor,relationshipId,source:'synthetic-library-test'},lifecycle:{status:'inactive',revision:1,contentRemoved:false},createdAt:new Date().toISOString()});}
const url=(f:Awaited<ReturnType<typeof fixture>>,relationshipId:string)=>library+'?assistantId='+f.assistantId+'&relationshipId='+relationshipId;
async function json200(response:Response){assert.equal(response.status,200,await response.clone().text());return response.json();}

test('actual returning and31min ordinary owner restores selected metadata and canonical inactive Library without admin refresh; Lock masks and logout retires',async()=>{
 const f=await fixture(false);try{
  const id=await active(f),relation=await relationship(f),own=memory(f,relation.relationshipId,'Synthetic real saved inactive record');memory(f,relation.relationshipId,'FOREIGN_LIBRARY_BODY',randomUUID());const before=readSessionEndpoint(f.internal.database,f.owner.sessionId),activity=f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity;
  for(const aged of [false,true]){if(aged)f.advance(31*60*1000);
   const value=await json200(await f.request(f.owner,startup));assert.equal(value.privateAllowed,true);assert.equal(value.selection.status,'selectedConversation');assert.equal(value.session.selectedConversation.conversationId,id);assert.equal(value.assistant.assistantId,f.assistantId);assert.equal(value.assistant.profiles.length,1);assert.equal(value.assistant.profiles[0].status,'active');assert.deepEqual(Object.keys(value.relationships[0]).sort(),['assistantId','relationshipId','revision','status','userId']);assert.equal(value.relationships[0].userId,f.owner.principalId);assert.equal(value.endpointConfiguration.readOnly,true);assert.equal(value.endpointConfiguration.session.endpointId,before.endpoint!.endpointId);assert.equal('nativeVoiceProviderBinding' in value.endpointConfiguration,false);assert.equal('configuredDefaultVoice' in value.endpointConfiguration,false);
   const choices=await json200(await f.request(f.owner,workspace+'?assistantId='+f.assistantId));assert.equal(choices.assistant.assistantId,f.assistantId);assert.equal(choices.relationships[0].relationshipId,relation.relationshipId);
   const view=await json200(await f.request(f.owner,url(f,relation.relationshipId)));assert.equal(view.memories.length,1);assert.equal(view.memories[0].id,own.id);assert.equal(view.memories[0].lifecycle.status,'inactive');assert.equal(view.recovery.currency,'current');assert.equal(view.recovery.relationshipRevision,relation.revision);assert.equal(view.page.truncated,false);assert.ok(Buffer.byteLength(JSON.stringify(view))<=view.page.maxBytes);assert.doesNotMatch(JSON.stringify(view),/FOREIGN_LIBRARY_BODY/);
  }
  assert.deepEqual(readSessionEndpoint(f.internal.database,f.owner.sessionId),before);assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.owner.sessionId)!.admin_last_activity,activity);assert.equal((await f.request(f.owner,`/api/admin/v1/assistants/${f.assistantId}`)).status,403);
  await commandLock(f);const masked=await json200(await f.request(f.owner,startup));assert.equal(masked.privateAllowed,false);assert.equal(masked.protected,true);assert.equal(masked.assistant,null);assert.deepEqual(masked.relationships,[]);assert.equal(masked.endpointConfiguration,null);assert.equal(masked.session.selectedConversation,null);assert.equal(masked.session.conversationId,null);assert.doesNotMatch(JSON.stringify(masked),/Synthetic real saved inactive record|Synthetic workspace owner/);assert.equal((await f.request(f.owner,workspace)).status,403);assert.equal((await f.request(f.owner,url(f,relation.relationshipId))).status,403);
  assert.equal((await f.request(f.owner,'/api/auth/v1/sign-out',{})).status,200);for(const path of [startup,workspace,url(f,relation.relationshipId)])assert.equal((await f.request(f.owner,path)).status,401);
 }finally{await f.close();}
});

test('startup stays lazy with no chosen chat, and multiple permitted active Assistants require an explicit choice',async()=>{
 const f=await fixture(false);try{
  const empty=await json200(await f.request(f.owner,startup));assert.equal(empty.selection.status,'unavailable');assert.equal(empty.assistant,null);assert.equal(f.internal.durableConversationRepository,undefined);
  for(let i=0;i<2;i++){const createdResponse=await f.request(f.owner,'/api/admin/v1/assistants',{displayName:'Synthetic choice '+i});assert.equal(createdResponse.status,201);const created=await createdResponse.json();assert.equal((await f.request(f.owner,`/api/admin/v1/assistants/${created.assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);}
  const value=await json200(await f.request(f.owner,startup));assert.equal(value.selection.status,'ambiguous');assert.equal(value.assistant,null);assert.equal(value.session.selectedConversation,null);assert.equal(f.internal.durableConversationRepository,undefined);const choices=await json200(await f.request(f.owner,workspace));assert.equal(choices.assistants.length,2);assert.ok(choices.assistants.every((row:any)=>row.profiles.every((profile:any)=>profile.status==='active')));
  assert.equal((await f.request(f.owner,startup+'?assistantId='+f.assistantId)).status,422);assert.equal((await f.request(f.owner,workspace+'?assistantId='+f.assistantId+'&assistantId='+f.assistantId)).status,422);assert.equal((await f.request(f.owner,workspace,{})).status,405);assert.equal((await f.request(f.owner,library)).status,422);assert.equal((await f.request(f.owner,workspace+'?assistantId='+randomUUID())).status,403);
 }finally{await f.close();}
});

test('Library bounds both record count and entire encoded DTO while preserving truncation and source inventory',async()=>{
 const f=await fixture(false);try{
  await active(f);const relation=await relationship(f);for(let i=0;i<205;i++)memory(f,relation.relationshipId,'Synthetic bounded record '+i,f.owner.principalId,'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
  const first=await json200(await f.request(f.owner,url(f,relation.relationshipId)));assert.equal(first.memories.length,200);assert.equal(first.page.totalCount,205);assert.equal(first.page.truncated,true);assert.equal(first.page.maxBytes,262144);assert.ok(Buffer.byteLength(JSON.stringify(first))<=262144);
  memory(f,relation.relationshipId,'X'.repeat(262144),f.owner.principalId,'00000000-0000-4000-8000-000000000000');const large=await json200(await f.request(f.owner,url(f,relation.relationshipId)));assert.equal(large.page.totalCount,206);assert.equal(large.memories.length,0);assert.equal(large.page.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(large))<=262144);assert.equal(f.internal.memories.list(f.assistantId).length,206);
 }finally{await f.close();}
});

test('original Admin inventory callback cannot leak its captured Library across real logout',async()=>{
 const f=await fixture(false);const admin=f.internal.admin,handle=admin.handle;try{
  await active(f);const relation=await relationship(f);memory(f,relation.relationshipId,'DO_NOT_PUBLISH_AFTER_SOURCE_LOGOUT');admin.handle=function(...args:any[]){const result=Reflect.apply(handle,this,args);if(args[0]==='GET'&&args[1]===`/api/admin/v1/assistants/${f.assistantId}/memories`)f.internal.localAuth.logout(f.internal.localAuth.hostSessionContext(f.owner.sessionId));return result;};const response=await f.request(f.owner,url(f,relation.relationshipId));assert.equal(response.status,401);assert.doesNotMatch(await response.text(),/DO_NOT_PUBLISH/);
 }finally{admin.handle=handle;await f.close();}
});

test('fresh authorized act-as workspace uses actual effective relationship and Library; aged reference and real shared-source denial do not grant',async()=>{
 const f=await fixture(false,{audiencePrivacy:{sourceIds:[]}});try{
  const declared=await f.request(f.owner,'/api/runtime/v1/audience',{mode:'solo',seconds:300});assert.equal(declared.status,200);const id=await active(f,false),actorRelation=await relationship(f);memory(f,actorRelation.relationshipId,'ACTOR_ONLY_LIBRARY');
  const password=secret(),accountResponse=await f.request(f.owner,'/api/auth/v1/accounts',{username:'synthetic-target',password});assert.equal(accountResponse.status,201);const member=await accountResponse.json();assert.equal((await f.request(f.owner,'/api/auth/v1/permissions',{principalId:member.principalId,assistantId:f.assistantId,administer:true})).status,200);
  const signed=await f.request(null,'/api/auth/v1/sign-in',{username:'synthetic-target',password});assert.equal(signed.status,200);const session=(await signed.json()).session,target:Owner={cookie:signed.headers.get('set-cookie')!.split(';')[0]!,csrf:session.csrfToken,principalId:session.principalId,sessionId:session.sessionId,contextRef:''};const targetRelationResponse=await f.request(target,`/api/admin/v1/assistants/${f.assistantId}/relationships`,{});assert.equal(targetRelationResponse.status,201);const relation=(await targetRelationResponse.json()).relationship;memory(f,relation.relationshipId,'TARGET_ONLY_LIBRARY',member.principalId);
  const auth=f.internal.localAuth,before=auth.hostSessionContext(f.owner.sessionId);auth.effectiveSubjects.execute(before,{schemaVersion:'1.0.0',operation:'startContext',operationId:randomUUID(),expectedGeneration:before.effectiveContext!.generation,payload:{targetUserId:member.principalId}});const current=await fetch(f.base+'/api/auth/v1/user-context',{headers:{origin:f.base,cookie:f.owner.cookie},signal:AbortSignal.timeout(5000)});f.owner.contextRef=(await current.json()).contextRef;
  const targetChat=await create(f);assert.equal((await select(f,targetChat.conversationId,readSessionEndpoint(f.internal.database,f.owner.sessionId).revision)).status,200);const value=await json200(await f.request(f.owner,startup));assert.equal(value.session.selectedConversation.conversationId,targetChat.conversationId);assert.notEqual(value.session.selectedConversation.conversationId,id);assert.equal(value.relationships[0].userId,member.principalId);assert.equal(value.relationships[0].relationshipId,relation.relationshipId);const view=await json200(await f.request(f.owner,url(f,relation.relationshipId)));assert.equal(view.memories.length,1);assert.equal(view.memories[0].content,'TARGET_ONLY_LIBRARY');assert.doesNotMatch(JSON.stringify(view),/ACTOR_ONLY_LIBRARY/);assert.equal((await f.request(f.owner,url(f,actorRelation.relationshipId))).status,409);
  const protectedState=await f.request(f.owner,'/api/runtime/v1/audience/personal-session');assert.equal(protectedState.status,403,'Self-only manual admission remains denied during act-as');assert.equal((await f.request(f.owner,'/api/runtime/v1/audience',{mode:'shared'})).status,200);const protectedStartup=await json200(await f.request(f.owner,startup));assert.equal(protectedStartup.privateAllowed,false);assert.equal(protectedStartup.assistant,null);assert.equal((await f.request(f.owner,url(f,relation.relationshipId))).status,403);
  f.advance(31*60*1000);assert.equal((await f.request(f.owner,startup)).status,409);
 }finally{await f.close();}
});

test('last original persona read cannot publish an old active profile after genuine repository activation',async()=>{
 const f=await fixture(false);const admin=f.internal.admin as any,persona=admin.getActivePersona;let calls=0;try{
  await active(f);const profiles=new AssistantProfileRepository(f.internal.database),before=profiles.list(f.assistantId).find(profile=>profile.status==='active')!;const next=profiles.create({...before,profileId:randomUUID(),revision:before.revision+1,status:'draft',displayName:'New current source profile'});
  admin.getActivePersona=function(...args:any[]){const value=Reflect.apply(persona,this,args);if(++calls===2)profiles.activate(next.profileId,before.revision,f.owner.principalId,'Synthetic source callback activation',new Date().toISOString());return value;};
  const response=await f.request(f.owner,startup);assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/Synthetic workspace owner/);assert.equal(profiles.list(f.assistantId).find(profile=>profile.status==='active')!.profileId,next.profileId);
 }finally{admin.getActivePersona=persona;await f.close();}
});
