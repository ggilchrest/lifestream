// Actual public build/host/Auth/DB/catalog owners only. All state is disposable.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, chmodSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
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
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'canonical-history-lifecycle-http-'));chmodSync(root, 0o700);const mask = process.umask(0o077);let now = Date.now();
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

const retentionPath = '/api/runtime/v1/conversation-retention';
const proposal = (assistantId: string, enabled: boolean, expectedRevision = 0) => ({schemaVersion: '1.0.0', operation: 'set', assistantId, enabled, expectedRevision, retention: 'untilDeletion', bodyScope: 'textAndTranscripts'});
const policy = (f: Awaited<ReturnType<typeof fixture>>) => f.request(f.owner, retentionPath + '?assistantId=' + f.assistantId);
const apply = (f: Awaited<ReturnType<typeof fixture>>, enabled: boolean, revision = 0) => f.request(f.owner, retentionPath, proposal(f.assistantId, enabled, revision));
function observe(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, text: string, state: 'accepted' | 'completed' = 'completed') {
  f.advance(Math.max(1, Date.now() - f.time() + 1));return f.internal.durableConversations.observe(f.scope(), {entryId: randomUUID(), turnId: randomUUID(), conversationId, speaker: 'human', modality: 'text', state, occurredAt: new Date(f.time()).toISOString(), expectedRevision: 0, text, attribution: 'authenticatedTypedOwner'});
}
async function commandLock(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await (await f.request(f.owner, '/api/runtime/v1/audience/personal-session')).json(), selected = readSessionEndpoint(f.internal.database, f.owner.sessionId);
  const response = await f.request(f.owner, '/api/runtime/v1/audience/personal-session', {operation: 'lock', operationId: randomUUID(), declarationId: randomUUID(), expectedAudienceRevision: state.revision, expectedPersonalSessionEpoch: state.personalSessionEpoch, expectedSessionRevision: selected.revision, endpointId: selected.endpoint!.endpointId, expectedEndpointRevision: selected.endpoint!.configurationRevision});assert.equal(response.status, 200);
}

async function active(f: Awaited<ReturnType<typeof fixture>>, consent = false, manual = true) {
  const created = await f.request(f.owner, '/api/admin/v1/assistants', {displayName: 'Synthetic selected lifecycle'});assert.equal(created.status, 201);const assistant = await created.json();f.assistantId = assistant.assistantId;
  assert.equal((await f.request(f.owner, `/api/admin/v1/assistants/${f.assistantId}/activate`, {profileId: assistant.profile.profileId, expectedActiveRevision: null})).status, 200);
  const chat = await create(f);assert.equal((await select(f, chat.conversationId)).status, 200);if(manual)await unlock(f);
  if (consent) assert.equal((await apply(f, true)).status, 200);
  return chat.conversationId;
}
async function message(f: Awaited<ReturnType<typeof fixture>>, conversationId: string, userInput = 'Synthetic exact selected input', extra: Record<string, unknown> = {}) {return f.request(f.owner, '/api/runtime/v1/messages', {assistantId: f.assistantId, conversationId, userInput, ...extra});}
async function page(f: Awaited<ReturnType<typeof fixture>>, conversationId: string) {const response = await f.request(f.owner, route, envelope('page', {conversationId, direction: 'older', pageSize: 50}));assert.equal(response.status, 200);return (await response.json()).result.entries;}
const rows = (f: Awaited<ReturnType<typeof fixture>>, conversationId: string) => f.internal.database.connection.prepare('SELECT * FROM conversation_timeline WHERE conversation_id=? ORDER BY ordinal').all(conversationId);
async function waitFor(check: () => unknown) {const end = Date.now() + 2000;while (!check()) {if (Date.now() > end) assert.fail('Owned lifecycle metadata did not become available');await new Promise(resolve => setTimeout(resolve, 10));}}

// Fresh synthetic actual HTTP/Auth/history lifecycle. No retention-enabling POST.
async function reopen(f:Awaited<ReturnType<typeof fixture>>,enabled=true){
 await f.app.shutdown();const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(f.root,'test.sqlite'),artifactDirectory:join(f.root,'artifacts')};
 f.app=createLifestreamServer({config,host:'127.0.0.1',port:Number(new URL(f.base).port),localAuth:{stateDirectory:join(f.root,'auth')},...(enabled?{historyRetention:{mode:'localUserConsent',retention:'untilDeletion',journalInitialization:'initializeEmpty'},historyStateRoot:f.root} as Partial<ServerOptions>:{})});await f.app.start();
 f.internal=f.app as unknown as Internals;
}
test('future local messages save without opt-in, reload after restart, Archive preserves text and Delete removes only reviewed text',{timeout:20000},async t=>{
 const f=await fixture();t.after(async()=>{await f.app.shutdown();await f.close();});const conversationId=await active(f);
 const ownerPath=join(f.root,'auth','conversation-retention-policy','owner.json'),before=readFileSync(ownerPath),defaultPath=join(f.root,'auth','conversation-retention-policy','future-default.json'),cutoff=readFileSync(defaultPath);
 const initial=await policy(f);assert.equal(initial.status,200);const value=await initial.json();assert.equal(value.enabled,true);assert.equal(value.revision,0);assert.equal(value.reason,'futureMessagesUntilDeletionByDefault');
 t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(){yield {kind:'text',text:'Synthetic retained assistant response.'};yield {kind:'done'};});
 const reply=await message(f,conversationId,'Synthetic future saved user message.');assert.equal(reply.status,200);assert.match(await reply.text(),/interaction.completed/);
 const saved=await page(f,conversationId);assert.equal(saved.length,2);assert.deepEqual(saved.map((e:any)=>e.content.text),['Synthetic future saved user message.','Synthetic retained assistant response.']);assert.ok(saved.every((e:any)=>e.content.state==='retained'));
 assert.deepEqual(readFileSync(ownerPath),before,'Default does not invent or overwrite consent grants.');
 await reopen(f);await unlock(f);assert.deepEqual((await page(f,conversationId)).map((e:any)=>e.content),saved.map((e:any)=>e.content));assert.deepEqual(readFileSync(defaultPath),cutoff);assert.deepEqual(readFileSync(ownerPath),before);
 const revision=Number(f.internal.database.connection.prepare('SELECT revision FROM conversation_catalog WHERE conversation_id=?').get(conversationId)!.revision);
 const archived=await f.request(f.owner,route,envelope('archive',{conversationId,expectedRevision:revision}));assert.equal(archived.status,200);assert.deepEqual((await page(f,conversationId)).map((e:any)=>e.content),saved.map((e:any)=>e.content));
 const entry=(await page(f,conversationId))[0];const erased=await f.request(f.owner,route+'/erase',{producerPin:pin,conversationId,entryId:entry.entryId,expectedRevision:entry.revision,operationId:randomUUID(),idempotencyKey:randomUUID()});assert.equal(erased.status,200);
 const after=await page(f,conversationId);assert.equal(after[0].content.state,'redacted');assert.equal(after[0].content.text,undefined);assert.equal(after[1].content.text,'Synthetic retained assistant response.');
 assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.retained_text,null);
 await reopen(f);await unlock(f);assert.equal((await page(f,conversationId))[0].content.state,'redacted');
});
test('first future-default activation never backfills a previous unavailable lifecycle entry',{timeout:20000},async t=>{
 const f=await fixture(false);t.after(async()=>{await f.app.shutdown();await f.close();});const id=await active(f);const old=observe(f,id,'Synthetic old unavailable body','accepted');assert.equal(old.content.state,'unavailable');
 await reopen(f);await unlock(f);assert.equal((await (await policy(f)).json()).enabled,true);assert.equal((await page(f,id))[0].content.state,'unavailable');
 const context=f.internal.localAuth.hostSessionContext(f.owner.sessionId),scope={actorId:context.principalId,effectiveUserId:context.principalId,contextGeneration:context.effectiveContext!.generation,authorityCurrent:()=>{try{f.internal.localAuth.assertCurrent(context,false);return true;}catch{return false;}}};
 const next=f.internal.durableConversations.observe(scope,{entryId:old.entryId,turnId:old.turnId,conversationId:id,speaker:'human',modality:'text',state:'completed',occurredAt:new Date().toISOString(),expectedRevision:old.revision,text:'Must not reconstruct old text',attribution:'authenticatedTypedOwner'});assert.equal(next.content.state,'unavailable');
 assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(old.entryId)!.retained_text,null);
});
test('explicit disabled choice survives restart and withdrawal clears default-backed saved bodies',{timeout:20000},async t=>{
 const f=await fixture();t.after(async()=>{await f.app.shutdown();await f.close();});const id=await active(f);const saved=observe(f,id,'Synthetic default-backed body');assert.equal(saved.content.state,'retained');
 assert.equal((await apply(f,false)).status,200);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(saved.entryId)!.retained_text,null);
 const ownerPath=join(f.root,'auth','conversation-retention-policy','owner.json'),disabled=readFileSync(ownerPath);await reopen(f);await unlock(f);assert.equal((await (await policy(f)).json()).enabled,false);assert.deepEqual(readFileSync(ownerPath),disabled);
 t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(){yield {kind:'text',text:'Synthetic unsaved response'};yield {kind:'done'};});const response=await message(f,id,'Synthetic explicit-disabled future input');assert.equal(response.status,200);await response.text();const entries=await page(f,id);assert.equal(entries.at(-1).content.state,'unavailable');assert.equal(entries.at(-2).content.state,'unavailable');
});
test('future default does not become a delegated policy or grant when authenticated scope changes',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.shutdown();await f.close();});const id=await active(f),saved=observe(f,id,'Self future body');assert.equal(saved.content.state,'retained');
 const owner=f.internal.conversationRetentionOwner!,scope=f.scope(),ref=String(f.internal.database.connection.prepare('SELECT policy_ref FROM conversation_timeline WHERE entry_id=?').get(saved.entryId)!.policy_ref);
 assert.equal(owner.current(ref,{...scope,actorId:randomUUID()}),false);assert.equal(owner.current(ref,{...scope,authorityCurrent:()=>false}),false);assert.equal(owner.current(ref.replace(f.assistantId,randomUUID()),{...scope,effectiveUserId:randomUUID()}),false);
});

test('a changed future-default marker retires reads without changing consent or deleting saved bodies',async t=>{
 const f=await fixture();t.after(async()=>{await f.app.shutdown();await f.close();});const id=await active(f),entry=observe(f,id,'Synthetic cutoff custody body');assert.equal(entry.content.state,'retained');
 const ownerPath=join(f.root,'auth','conversation-retention-policy','owner.json'),before=readFileSync(ownerPath),path=join(f.root,'auth','conversation-retention-policy','future-default.json'),value=JSON.parse(readFileSync(path,'utf8'));value.policyId=randomUUID();writeFileSync(path,JSON.stringify(value));
 assert.equal(f.internal.conversationRetentionOwner!.current(String(f.internal.database.connection.prepare('SELECT policy_ref FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.policy_ref),f.scope()),false);
 assert.deepEqual(readFileSync(ownerPath),before);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.retained_text,'Synthetic cutoff custody body');
});

test('interrupted default withdrawal stays denied across restart and later re-enable without resurrecting old text',{timeout:20000},async t=>{
 const f=await fixture();t.after(async()=>{await f.app.shutdown();await f.close();});const id=await active(f),entry=observe(f,id,'Synthetic retired default body');assert.equal(entry.content.state,'retained');
 const repo=f.internal.durableConversations,withdraw=repo.withdrawPolicy;repo.withdrawPolicy=()=>{throw Error('Synthetic interrupted payload cleanup');};
 try{assert.equal((await apply(f,false)).status,503);}finally{repo.withdrawPolicy=withdraw;}
 assert.equal((await (await policy(f)).json()).enabled,false);assert.equal(f.internal.database.connection.prepare('SELECT retained_text FROM conversation_timeline WHERE entry_id=?').get(entry.entryId)!.retained_text,'Synthetic retired default body');
 await reopen(f);await unlock(f);assert.equal((await apply(f,true,1)).status,200);
 const old=(await page(f,id)).find((value:any)=>value.entryId===entry.entryId);assert.equal(old.content.state,'unavailable','Re-enabling future writes cannot restore a withdrawn default-backed body');assert.equal(old.content.text,undefined);
 t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(){yield {kind:'text',text:'Synthetic newly enabled response'};yield {kind:'done'};});const fresh=await message(f,id,'Synthetic newly enabled user text');assert.equal(fresh.status,200);await fresh.text();const entries=await page(f,id);assert.equal(entries.at(-1).content.state,'retained');assert.equal(entries.at(-2).content.state,'retained');
 assert.equal(entries.find((value:any)=>value.entryId===entry.entryId).content.state,'unavailable');
});
