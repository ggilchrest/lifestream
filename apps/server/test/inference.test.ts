import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { InferenceChunk, InferenceProvider } from "@lifestream/runtime/inference";
import { streamMessage } from "../src/runtime/inference.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureInferenceProvider } from "@lifestream/runtime/inference/fixture";
import { createLifestreamServer } from "../src/index.ts";
import { loadProfile } from "../src/config/loader.ts";
import type { InferenceRequest } from "@lifestream/runtime/inference";
import {randomUUID} from 'node:crypto';
import {VisualObservationStore} from '@lifestream/runtime/perception/observation';
import {createPreparedTurnBinding} from '@lifestream/runtime/inference/prompt';
import type {VisualScope} from '@lifestream/runtime/perception/port';
import type {HostRuntimeInput} from '../src/runtime/inference.ts';

test("a new typed turn refreshes nearly expired prepared context without weakening active-turn fences", async t => {
  const {randomBytes}=await import('node:crypto');
  const root=await mkdtemp(join(tmpdir(),'ls-context-expiry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
  const installerToken=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());
  const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={'content-type':'application/json',origin:base};
  const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.ok(response.ok);return response.json() as Promise<Record<string,any>>;};
  const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers,body:JSON.stringify({username:'owner',password:randomBytes(32).toString('hex'),installerToken})});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=(await setup.json() as any).session.csrfToken;
  const a=await post('/api/admin/v1/assistants',{displayName:'Synthetic expiry check'});await post(`/api/admin/v1/assistants/${a.assistantId}/activate`,{profileId:a.profile.profileId,expectedActiveRevision:null});
  const {relationship}=await post(`/api/admin/v1/assistants/${a.assistantId}/relationships`,{});await post('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
  const start=Date.now();t.mock.timers.enable({apis:['Date'],now:start});let advanceMs=0;
  t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(){if(advanceMs)t.mock.timers.setTime(Date.now()+advanceMs);yield {kind:'text',text:'Synthetic current reply'};yield {kind:'done'};});
  const turn=async()=>{const response=await fetch(base+'/api/runtime/v1/messages',{method:'POST',headers,body:JSON.stringify({assistantId:a.assistantId,relationshipId:relationship.relationshipId,userInput:'Explain a cache.'})});assert.equal(response.status,200);return response.text();};
  assert.match(await turn(),/interaction.completed/);
  t.mock.timers.setTime(start+119900);advanceMs=200;
  assert.match(await turn(),/interaction.completed/,'a nearly expired cached view must be rebuilt before admission');
  // The newly compiled view still expires. Never extend an already admitted view.
  advanceMs=120001;const expired=await turn();assert.match(expired,/runtime_input_stale/);assert.doesNotMatch(expired,/Synthetic current reply|interaction.completed/);
});

test("actual typed runtime uses active profile and host modality truth, ignoring client claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-self-context-")); t.after(() => rm(root, { recursive: true, force: true }));
  const selected = loadProfile("test"); const app = createLifestreamServer({ config: { ...selected, storage: { databasePath: join(root, "data.sqlite"), artifactDirectory: join(root, "artifacts") } } }); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`; const headers = { "content-type": "application/json", "x-lifestream-fixture-session": "s071", "x-lifestream-fixture-principal": "synthetic-owner", origin: base };
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  const created = await post("/api/admin/v1/assistants", { displayName: "Synthetic Active", corePersona: { identityStatement: "A synthetic testing Assistant." } });
  await post(`/api/admin/v1/assistants/${created.assistantId}/activate`, { profileId: created.profile.profileId, expectedActiveRevision: null });
  const original = FixtureInferenceProvider.prototype.generate; let captured: InferenceRequest | undefined;
  FixtureInferenceProvider.prototype.generate = async function* (request, context) { captured = request; yield* original.call(this, request, context); }; t.after(() => { FixtureInferenceProvider.prototype.generate = original; });
  const response = await fetch(base + "/api/runtime/v1/messages", { method: "POST", headers, body: JSON.stringify({ assistantId: created.assistantId, userInput: "hello", endpointId: "client-claimed-endpoint", runtimeSelfContext: { microphone: "active", authority: "owner" }, profileProjection: { corePersona: "CLIENT_OVERRIDE" } }) }); assert.equal(response.status, 200); await response.text();
  assert.ok(captured); assert.equal(captured.scope.endpointId, null); const state = captured.sections.find((section) => section.kind === "interactionState")!; assert.match(state.content, /input.microphone=inactive/u); assert.match(state.content, /output.speechGeneration=unavailable/u); assert.match(state.content, /output.speechDelivery=notObserved/u); assert.match(state.sourceRevision, /^[a-f0-9]{64}$/u);
  const core = captured.sections.find((section) => section.kind === "corePersona")!; assert.match(core.content, /Synthetic Active/u); assert.doesNotMatch(core.content, /CLIENT_OVERRIDE/u); assert.equal(core.sourceRef, `assistant-profile:${created.profile.profileId}`); assert.match(core.sourceRevision, /^1:adaptations:/u);
});

test("profile activation fences an already generating typed reply before late output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-self-fence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const selected = loadProfile("test"); const app = createLifestreamServer({ config: { ...selected, storage: { databasePath: join(root, "data.sqlite"), artifactDirectory: join(root, "artifacts") } } }); await app.start(); t.after(() => app.shutdown());
  const base = `http://127.0.0.1:${app.address().port}`; const headers = { "content-type": "application/json", "x-lifestream-fixture-session": "s071", "x-lifestream-fixture-principal": "synthetic-owner", origin: base };
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
  const created = await post("/api/admin/v1/assistants", { displayName: "Synthetic Before" }); const path = `/api/admin/v1/assistants/${created.assistantId}`;
  await post(path + "/activate", { profileId: created.profile.profileId, expectedActiveRevision: null });
  const original = FixtureInferenceProvider.prototype.generate; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  FixtureInferenceProvider.prototype.generate = async function* () { await held; yield { kind: "text", text: "STALE_PRIVATE_OUTPUT" }; yield { kind: "done" }; }; t.after(() => { FixtureInferenceProvider.prototype.generate = original; });
  const response = await fetch(base + "/api/runtime/v1/messages", { method: "POST", headers, body: JSON.stringify({ assistantId: created.assistantId, userInput: "hello" }) }); const output = response.text();
  const revision = await post(path + "/revisions", { displayName: "Synthetic After", expectedRevision: 1 }); await post(path + "/activate", { profileId: revision.profile.profileId, expectedActiveRevision: 1 }); release();
  const text = await output; assert.doesNotMatch(text, /STALE_PRIVATE_OUTPUT/u); assert.match(text, /runtime_input_stale/u); assert.doesNotMatch(text, /event: interaction.completed/u);
});

test("typed stream admits one terminal and rejects missing or thrown provider completion", async (t) => {
  for (const mode of ["duplicate", "missing", "throw"] as const) {
    const provider: InferenceProvider = { async *generate(): AsyncIterable<InferenceChunk> { yield { kind: "text", text: "synthetic" }; if (mode === "throw") throw new Error("private provider diagnostics must not escape"); if (mode === "duplicate") { yield { kind: "done" }; yield { kind: "text", text: "late" }; yield { kind: "done" }; } } };
    const server = createServer((_request, response) => { void streamMessage(response, provider, { userInput: "synthetic" }, "session", new AbortController().signal); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`); const body = await response.text();
    assert.equal([...body.matchAll(/event: interaction\.(?:completed|error)/gu)].length, 1); assert.doesNotMatch(body, /private provider diagnostics|"late"/u);
    assert.match(body, mode === "duplicate" ? /event: interaction\.completed/u : /event: interaction\.error/u);
  }
});

test("real-authenticated ordinary turns use one scoped view, reviewed corrections and safe audience fallback", async t => {
  const { randomBytes,randomUUID }=await import('node:crypto'); const root=await mkdtemp(join(tmpdir(),'ls-prepared-relationship-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=loadProfile('test');config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};config.authority.authentication='local-password';const installerToken=randomBytes(32).toString('hex');const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());
  const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={'content-type':'application/json',origin:base};
  const post=async(path:string,body:unknown)=>{const response=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:response.status,body:await response.json() as Record<string,any>};};
  const setup=await fetch(base+'/api/auth/v1/setup',{method:'POST',headers,body:JSON.stringify({username:'owner',password:randomBytes(32).toString('hex'),installerToken})});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const session=await setup.json() as Record<string,any>;headers['x-lifestream-csrf']=session.session.csrfToken;
  assert.equal((await post('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
  const create=async(content:string)=>{const assistant=(await post('/api/admin/v1/assistants',{displayName:'Synthetic Context Assistant'})).body;await post(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});const relationship=(await post(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).body.relationship;const path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationshipId}`;const candidate=(await post(path+'/candidates',{content,source:'synthetic-convention',sourceFamily:randomUUID(),uncertainty:'low',contextUse:'baseline',expectedRevision:1,idempotencyKey:randomUUID()})).body.candidate;assert.equal((await post(path+`/candidates/${candidate.candidateId}/decision`,{decision:'approved',expectedRevision:2,idempotencyKey:randomUUID()})).status,200);return assistant.assistantId as string;};
  const one=await create('Use exactly two short sentences unless the current request asks otherwise.'),two=await create('Prefer a short numbered explanation unless the current request asks otherwise.');
  const captured:InferenceRequest[]=[];const original=FixtureInferenceProvider.prototype.generate;FixtureInferenceProvider.prototype.generate=async function*(request,context){captured.push(request);yield* original.call(this,request,context);};t.after(()=>{FixtureInferenceProvider.prototype.generate=original;});
  const turn=async(assistantId:string,userInput='Explain recursion.')=>{const response=await fetch(base+'/api/runtime/v1/messages',{method:'POST',headers,body:JSON.stringify({assistantId,userInput,memory:'SPOOFED_SOURCE_MUST_NOT_ENTER',preparedRelationshipContext:{approvedBaseline:['SPOOFED_PRIVATE_VIEW']}})});assert.equal(response.status,200);const result=await response.text();assert.match(result,/interaction.completed/);return captured.at(-1)!.sections.find(section=>section.kind==='preparedMemory')!;};
  const first=await turn(one),warm=await turn(one),other=await turn(two);assert.match(first.content,/exactly two short sentences/);assert.equal(first.contentDigest,warm.contentDigest);assert.match(other.content,/short numbered explanation/);assert.doesNotMatch(other.content,/exactly two short sentences/);assert.doesNotMatch(first.content,/SPOOFED_/);
  const path=`/api/admin/v1/assistants/${one}`;const memory=(await post(path+'/memories',{content:'The synthetic project language is Java.'})).body.memory;await post(path+`/memories/${memory.id}/lifecycle`,{status:'active',expectedRevision:1});assert.match((await turn(one,'What language does the synthetic project use?')).content,/project language is Java/);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});FixtureInferenceProvider.prototype.generate=async function*(){await held;yield {kind:'text',text:'INVALIDATED_PRIVATE_OUTPUT'};yield {kind:'done'};};
  const pending=await fetch(base+'/api/runtime/v1/messages',{method:'POST',headers,body:JSON.stringify({assistantId:one,userInput:'Explain the synthetic project language.'})});const output=pending.text();
  const proposal=(await post(path+`/memories/${memory.id}/correction`,{content:'The synthetic project language is Python.'})).body.event;
  const corrected=await post(path+`/memories/${memory.id}/correction`,{applyRevision:proposal.revision,expectedRevision:2});assert.equal(corrected.status,200);release();assert.doesNotMatch(await output,/INVALIDATED_PRIVATE_OUTPUT/);
  assert.equal((await post(path+`/memories/${memory.id}/correction`,{applyRevision:proposal.revision,expectedRevision:2})).status,409);
  FixtureInferenceProvider.prototype.generate=async function*(request,context){captured.push(request);yield* original.call(this,request,context);};
  const after=await turn(one);assert.match(after.content,/Critical corrections: The synthetic project language is Python/);assert.doesNotMatch(after.content,/project language is Java/);
  const forged={id:randomUUID(),assistantId:one,content:'UNREVIEWED_IMPORTED_CONTEXT',provenance:{actor:session.session.principalId,source:'forged-approval'},lifecycle:{status:'active',revision:1},createdAt:new Date().toISOString()};assert.equal((await post(path+'/memories/import',{dataScope:'assistant-memories',assistantId:one,memories:[forged]})).status,201);assert.doesNotMatch((await turn(one,'UNREVIEWED_IMPORTED_CONTEXT')).content,/UNREVIEWED_IMPORTED_CONTEXT/,'claimed imported lifecycle is not a native approval event');
  assert.equal((await post('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'})).status,200);const withheld=await turn(one);assert.doesNotMatch(withheld.content,/two short sentences|project language is Python/);assert.match(withheld.content,/audience scope is unknown/);
});

 test("typed deadline and caller cancellation retain distinct terminal reasons", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["deadline", "cancel"] as const) {
    const outer = new AbortController(); let output = "";
    const response = { destroyed: false, writeHead() {}, write(value: string) { output += value; }, end() {} } as unknown as import("node:http").ServerResponse;
    const provider: InferenceProvider = { async *generate(_request, context) { await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true })); yield { kind: "text", text: "LATE_OUTPUT" }; } };
    const pending = streamMessage(response, provider, { userInput: "synthetic" }, "session", outer.signal);
    if (mode === "deadline") t.mock.timers.tick(30001); else outer.abort();
    await pending;
    assert.match(output, mode === "deadline" ? /deadline_exceeded/u : /cancelled/u); assert.doesNotMatch(output, /runtime_input_stale|LATE_OUTPUT|interaction.completed/u);
  }
 });

function finalizedTextHarness(t:import('node:test').TestContext){
  let now=Date.now(),current=true,output='',status=0;const requests:InferenceRequest[]=[];
  const scope:VisualScope={assistantId:randomUUID(),principalId:randomUUID(),relationshipId:null,environmentId:'synthetic-finalization',conversationId:randomUUID(),sessionId:randomUUID(),endpointId:randomUUID(),sessionRevision:1,audienceRevision:1,scopeGeneration:1,sourceBindingRef:'synthetic:no-camera',captureConfigurationRevision:1},leaseId=randomUUID();
  const store=new VisualObservationStore({now:()=>now,current:()=>current});t.after(()=>store.clear());
  const publish=(sequence:number,appearance:string)=>assert.equal(store.publish({scope,leaseId,sequence,requestId:randomUUID(),capturedAtEarliestMs:now-100,capturedAtLatestMs:now-50,receivedAtMs:now-30,interpretedAtMs:now,provider:{id:'synthetic-visual',version:'1'},observations:[{observationId:'scene-'+sequence,frameIds:[randomUUID()],appearance,inference:null,confidence:null,limitations:['Synthetic fixture only.']}]}),true);
  publish(1,'ORIGINAL_SYNTHETIC_SCENE');
  const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{assistantId:scope.assistantId,principalId:scope.principalId,relationshipId:null,conversationId:scope.conversationId,sessionId:scope.sessionId,endpointId:scope.endpointId},conversation:'[]',sourceRevisions:{runtime:'runtime-1',conversation:'conversation-1'}});
  const view=store.prepare({scope,leaseId,viewId:binding.viewId,revision:binding.revision,invalidationKey:binding.invalidationKey,conversation:binding.conversation,explicitQuestion:true,allowAside:false});assert.ok(view);
  const input:HostRuntimeInput={assistantId:scope.assistantId,endpointId:scope.endpointId,preparedTurnBinding:binding,preparedVisualContext:view,conversation:{read:()=>binding.conversation,remember(){}},runtimeSelfContext:{sourceRevision:'runtime-1',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'activeForSession'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',limitations:['No live input.']},isCurrent:()=>current&&store.isCurrent(view)};
  const response={destroyed:false,writeHead(code:number){status=code;},write(value:string){output+=value;return true;},end(value?:string){if(value)output+=value;}} as unknown as import('node:http').ServerResponse;
  const provider:InferenceProvider={async *generate(request){requests.push(request);yield {kind:'text',text:'SAFE_SYNTHETIC_REPLY'};yield {kind:'done'};}};
  return {input,view,requests,run:()=>streamMessage(response,provider,{assistantId:scope.assistantId,endpointId:scope.endpointId,userInput:'What is visible?'},scope.sessionId,new AbortController().signal,undefined,input.runtimeSelfContext,input),output:()=>output,status:()=>status,withdraw:()=>{current=false;},expire:()=>{now=view.expiresAtMs;},newScene:()=>{now+=100;publish(2,'NEWER_SYNTHETIC_SCENE');}};
}

test('typed inference callback cannot change the sealed sections or manifest delivered to the provider',async t=>{
  const f=finalizedTextHarness(t);let seen:InferenceRequest|undefined,before='';const mutations:boolean[]=[];
  f.input.onInferenceRequest=request=>{
    seen=request;before=JSON.stringify(request);
    mutations.push(Reflect.set(request.sections[7]!,'content','FORGED_CALLBACK_SCENE'),Reflect.set(request.manifest.sections[7]!,'contentDigest','forged'),Reflect.set(request,'sections',[]),Reflect.set(request.scope,'endpointId','forged'));
    throw Error('Synthetic bookkeeping failure');
  };
  await f.run();assert.equal(f.requests.length,1);assert.equal(f.requests[0],seen);assert.deepEqual(mutations,[false,false,false,false]);assert.equal(JSON.stringify(f.requests[0]),before);
  assert.ok(Object.isFrozen(seen)&&Object.isFrozen(seen.sections)&&Object.isFrozen(seen.manifest.sections));assert.match(f.output(),/interaction.completed/);assert.doesNotMatch(f.output(),/FORGED_CALLBACK_SCENE|Synthetic bookkeeping failure/);
});

test('typed authority revocation inside onInferenceRequest prevents provider admission and output',async t=>{
  const f=finalizedTextHarness(t);f.input.onInferenceRequest=()=>{f.withdraw();};await f.run();
  assert.equal(f.requests.length,0);assert.doesNotMatch(f.output(),/SAFE_SYNTHETIC_REPLY|message.delta|interaction.completed/);assert.match(f.output(),/runtime_context_changed|runtime_input_stale/);
});

test('typed delayed world preparation cannot admit a revoked or expired visual and audience scope',async t=>{
  for(const loss of ['authority','visualExpiry','world'] as const){
    const f=finalizedTextHarness(t);let release!:()=>void,entered!:()=>void,worldCurrent=true;
    const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    f.input.prepareWorld=async()=>{entered();await gate;return {context:{content:'SYNTHETIC_WORLD',sourceRef:'pwce:synthetic',sourceRevision:'world-1'},isCurrent:()=>worldCurrent,isSnapshotCurrent:()=>worldCurrent};};
    const pending=f.run();await started;if(loss==='authority')f.withdraw();else if(loss==='visualExpiry')f.expire();else worldCurrent=false;release();await pending;
    assert.equal(f.requests.length,0,loss);assert.equal(f.status(),409);assert.doesNotMatch(f.output(),/SAFE_SYNTHETIC_REPLY|message.delta|interaction.completed/);
  }
});

test('typed finalization joins awaited world context to the originally selected still-current visual view',async t=>{
  const f=finalizedTextHarness(t);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  f.input.prepareWorld=async()=>{entered();await gate;return {context:{content:'SYNTHETIC_WORLD_AFTER_WAIT',sourceRef:'pwce:synthetic',sourceRevision:'world-2'},isCurrent:()=>true,isSnapshotCurrent:()=>true};};
  const pending=f.run();await started;f.newScene();release();await pending;assert.equal(f.requests.length,1);
  const request=f.requests[0]!,conversation=request.sections.find(section=>section.kind==='conversation')!,world=request.sections.find(section=>section.kind==='worldContext')!;
  assert.equal(conversation.content,f.view.conversationContent);assert.match(conversation.content,/ORIGINAL_SYNTHETIC_SCENE/);assert.doesNotMatch(conversation.content,/NEWER_SYNTHETIC_SCENE/);assert.equal(world.content,'SYNTHETIC_WORLD_AFTER_WAIT');assert.equal(world.sourceRevision,'world-2');
  for(const section of [conversation,world])assert.deepEqual(request.manifest.sections.find(item=>item.kind===section.kind),{kind:section.kind,sourceRevision:section.sourceRevision,sourceRef:section.sourceRef,contentDigest:section.contentDigest,redaction:section.redaction,tokenCount:section.tokenCount});
  assert.ok(Object.isFrozen(request));
});

test('typed bookkeeping cannot admit a request after its deadline before the timer runs',async t=>{
  const start=Date.now();t.mock.timers.enable({apis:['Date'],now:start});
  const f=finalizedTextHarness(t);f.input.onInferenceRequest=()=>t.mock.timers.setTime(start+30001);
  await f.run();assert.equal(f.requests.length,0);assert.match(f.output(),/deadline_exceeded/);assert.doesNotMatch(f.output(),/SAFE_SYNTHETIC_REPLY|message.delta|interaction.completed/);
});
