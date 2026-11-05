// Actual public build/host/Auth/DB/catalog owners only. All state is disposable.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {ConversationRetentionOwner} from '../dist/runtime/conversation-retention-owner.js';
import {Database, AssistantProfileRepository, ConversationHistoryRepository, type ConversationHistoryScope} from '@lifestream/storage-sqlite';
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
type Internals = {database: Database; localAuth: LocalAuthentication; durableConversations: ConversationHistoryRepository; durableConversationRepository?: ConversationHistoryRepository; conversationRetentionOwner?: ConversationRetentionOwner; audience?: AudienceCoordinator; automaticMemory: {enqueue: (...args: any[]) => any}; prepareRuntimeInput: (...args: any[]) => any; runtimeFences: Set<{sessionId?: string; abort: () => void}>};
async function fixture(retention = true, extra: Partial<ServerOptions> = {}, endpointClass = 'desktopCompanion') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canonical-title-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);let now = Date.now();
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
  const created = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Synthetic title owner'});assert.equal(created.status, 201);const assistant = await created.json();f.assistantId = assistant.assistantId;
  assert.equal((await f.request(f.owner, `/api/admin/v1/assistants/${f.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null})).status, 200);
  const chat = await create(f);assert.equal((await select(f, chat.conversationId)).status, 200);if(manual)await unlock(f);
  return chat.conversationId;
}
async function message(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, userInput = 'Synthetic exact selected input', extra: Record<string, unknown> = {}) {return f.request(f.owner, '/api/runtime/v1/messages', {assistantId: f.assistantId, conversationId, userInput, ...extra});}
async function page(f: Awaited<ReturnType<typeof fixture>>, conversationId: string) {const response = await f.request(f.owner, route, envelope('page', {conversationId, direction: 'older', pageSize: 50}));assert.equal(response.status, 200);return (await response.json()).result.entries;}
const rows = (f: Awaited<ReturnType<typeof fixture>>, conversationId: string) => f.internal.database.connection.prepare('SELECT * FROM conversation_timeline WHERE conversation_id=? ORDER BY ordinal').all(conversationId);
async function waitFor(check: () => unknown) {const end = Date.now() + 2000;while (!check()) {if (Date.now() > end) assert.fail('Owned lifecycle metadata did not become available');await new Promise(resolve => setTimeout(resolve, 10));}}

const readTitle=(f:Awaited<ReturnType<typeof fixture>>,id:string)=>f.internal.durableConversations.read(f.scope(),id).title;
async function rename(f:Awaited<ReturnType<typeof fixture>>,id:string,title:string){const current=f.internal.durableConversations.read(f.scope(),id);const response=await f.request(f.owner,route,envelope('rename',{conversationId:id,expectedRevision:current.revision,title}));assert.equal(response.status,200,await response.clone().text());}
async function another(f:Awaited<ReturnType<typeof fixture>>,title='New chat'){const chat=await create(f,title);assert.equal((await select(f,chat.conversationId,readSessionEndpoint(f.internal.database,f.owner.sessionId).revision)).status,200);return chat.conversationId;}
const completed=(body:string)=>{assert.equal((body.match(/event: interaction.completed/g)??[]).length,1);assert.doesNotMatch(body,/event: interaction.error/);};

test('original host titles only its first completed selected exchange after the primary iterator closes', {timeout:15000},async()=>{
 const f=await fixture(false),original=FixtureInferenceProvider.prototype.generate;let primaryClosed=false,titleCalls=0,titleRequest:any;
 try{
  const id=await active(f),user='Synthetic bicycle chain snapped',answer='Check the chain link before riding.';
  FixtureInferenceProvider.prototype.generate=async function*(request){if(request.maximumOutputTokens===32){titleCalls++;titleRequest=request;assert.equal(primaryClosed,true);assert.equal(rows(f,id).length,2);assert.ok(rows(f,id).every(row=>row.state==='completed'));yield{kind:'text',text:'Bicycle Chain Repair'};yield{kind:'done'};return;}try{yield{kind:'text',text:answer};yield{kind:'done'};}finally{primaryClosed=true;}};
  const response=await message(f,id,user);assert.equal(response.status,200);const body=await response.text();completed(body);assert.match(body,/Check the chain link/);assert.equal(readTitle(f,id),'Bicycle Chain Repair');assert.equal(titleCalls,1);assert.equal(titleRequest.maximumOutputTokens,32);assert.equal(titleRequest.scope.assistantId,f.assistantId);assert.equal(titleRequest.scope.sessionId,f.owner.sessionId);assert.equal(titleRequest.scope.endpointId,readSessionEndpoint(f.internal.database,f.owner.sessionId).endpoint!.endpointId);assert.ok(Date.parse(titleRequest.deadlineAt)<=Date.now()+3000);assert.match(JSON.stringify(titleRequest.sections),/Synthetic bicycle chain snapped/);assert.match(JSON.stringify(titleRequest.sections),/Check the chain link/);assert.equal(titleRequest.sections.find((section:any)=>section.kind==='preparedMemory').content,'No prepared memory is available.');assert.equal(titleRequest.sections.find((section:any)=>section.kind==='conversation').content,'No prior conversation turns are supplied.');assert.equal(f.internal.database.connection.prepare('SELECT COUNT(*) AS n FROM conversation_timeline WHERE retained_text IS NOT NULL').get()!.n,0);
  completed(await(await message(f,id,'Synthetic second turn')).text());const named=await another(f,'My own title');completed(await(await message(f,named)).text());const legacy=await f.request(f.owner,'/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Synthetic legacy'});completed(await legacy.text());assert.equal(titleCalls,1);assert.equal(readTitle(f,named),'My own title');
 }finally{FixtureInferenceProvider.prototype.generate=original;await f.close();}
});

test('optional title provider failures leave the completed original reply and temporary title intact', {timeout:15000},async()=>{
 const f=await fixture(false),original=FixtureInferenceProvider.prototype.generate;let mode='throw',titleCalls=0;
 try{
  let id=await active(f);FixtureInferenceProvider.prototype.generate=async function*(request){if(request.maximumOutputTokens===32){titleCalls++;if(mode==='throw')throw new Error('Synthetic metadata failure');if(mode==='malformed'){yield{kind:'text',text:'Title: <invalid>'};yield{kind:'done'};}else yield{kind:'text',text:'No Terminal Title'};return;}yield{kind:'text',text:'Original reply remains complete'};yield{kind:'done'};};
  for(const next of ['throw','malformed','missingDone']){mode=next;if(next!=='throw')id=await another(f);const response=await message(f,id);assert.equal(response.status,200);const body=await response.text();completed(body);assert.match(body,/Original reply remains complete/);assert.equal(readTitle(f,id),'New chat');assert.ok(rows(f,id).every(row=>row.state==='completed'));}assert.equal(titleCalls,3);
 }finally{FixtureInferenceProvider.prototype.generate=original;await f.close();}
});

test('manual rename away and back retires an initial title attempt and a rename during metadata wins its revision CAS', {timeout:15000},async()=>{
 const f=await fixture(false),original=FixtureInferenceProvider.prototype.generate;let release!:()=>void,titleCalls=0,entered=false;
 try{
  let id=await active(f),held=new Promise<void>(resolve=>{release=resolve;});
  FixtureInferenceProvider.prototype.generate=async function*(request){if(request.maximumOutputTokens===32){titleCalls++;yield{kind:'text',text:'Automatic Must Not Win'};yield{kind:'done'};return;}yield{kind:'text',text:'Synthetic reply before manual rename'};await held;yield{kind:'done'};};
  const response=await message(f,id),body=response.text();await waitFor(()=>rows(f,id).some(row=>row.state==='generating'));await rename(f,id,'Manual choice');await rename(f,id,'New chat');release();completed(await body);assert.equal(titleCalls,0);assert.equal(readTitle(f,id),'New chat');
  id=await another(f);held=new Promise<void>(resolve=>{release=resolve;});FixtureInferenceProvider.prototype.generate=async function*(request){if(request.maximumOutputTokens===32){titleCalls++;entered=true;await held;yield{kind:'text',text:'Stale Automatic Title'};yield{kind:'done'};return;}yield{kind:'text',text:'Synthetic first completed reply'};yield{kind:'done'};};
  const second=await message(f,id),secondBody=second.text();await waitFor(()=>entered);await rename(f,id,'Chosen while metadata waits');release();completed(await secondBody);assert.equal(titleCalls,1);assert.equal(readTitle(f,id),'Chosen while metadata waits');
 }finally{release?.();FixtureInferenceProvider.prototype.generate=original;await f.close();}
});

test('a concurrent completed later exchange prevents first-turn title generation without losing either reply', {timeout:15000},async()=>{
 const f=await fixture(false),original=FixtureInferenceProvider.prototype.generate;let release!:()=>void,primaryCalls=0,titleCalls=0;const held=new Promise<void>(resolve=>{release=resolve;});
 try{
  const id=await active(f);FixtureInferenceProvider.prototype.generate=async function*(request){if(request.maximumOutputTokens===32){titleCalls++;yield{kind:'text',text:'Forbidden Late Title'};yield{kind:'done'};return;}primaryCalls++;const first=primaryCalls===1;yield{kind:'text',text:first?'First original reply':'Second original reply'};if(first)await held;yield{kind:'done'};};
  const first=await message(f,id,'First synthetic user'),firstBody=first.text();await waitFor(()=>rows(f,id).length===2);const second=await message(f,id,'Second synthetic user');assert.equal(second.status,200);completed(await second.text());release();completed(await firstBody);assert.equal(primaryCalls,2);assert.equal(titleCalls,0);assert.equal(rows(f,id).length,4);assert.equal(readTitle(f,id),'New chat');
 }finally{release?.();FixtureInferenceProvider.prototype.generate=original;await f.close();}
});

test('real Lock during optional metadata keeps the already completed reply truthful and prevents a late title write', {timeout:15000},async()=>{
 const f=await fixture(false),original=FixtureInferenceProvider.prototype.generate;let release!:()=>void,entered=false;const held=new Promise<void>(resolve=>{release=resolve;});
 try{
  const id=await active(f);FixtureInferenceProvider.prototype.generate=async function*(request){if(request.maximumOutputTokens===32){entered=true;await held;yield{kind:'text',text:'Private Late Title'};yield{kind:'done'};return;}yield{kind:'text',text:'Reply completed before Lock'};yield{kind:'done'};};
  const response=await message(f,id),body=response.text();await waitFor(()=>entered);assert.ok(rows(f,id).every(row=>row.state==='completed'));await commandLock(f);release();const text=await body;completed(text);assert.match(text,/Reply completed before Lock/);assert.equal(f.internal.database.connection.prepare('SELECT title FROM conversation_catalog WHERE conversation_id=?').get(id)!.title,'New chat');assert.ok(rows(f,id).every(row=>row.state==='completed'));
 }finally{release?.();FixtureInferenceProvider.prototype.generate=original;await f.close();}
});

