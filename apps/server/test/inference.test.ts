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
