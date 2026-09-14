import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifestreamServer } from "../src/index.ts";
import { loadConfig } from "../src/config/loader.ts";
import { createContractValidator } from "../../../packages/contracts/src/validator.ts";

// Independently authored synthetic settings; no private fixtures.
const settings = {
  initiative: { preset: "reserved", proactiveness: 2, dimensions: { initiative: 2, warmth: 5, curiosity: 3, followThrough: 3, persistence: 0 }, allowedContexts: [], endpointIds: [], allowedModalities: [], allowedKinds: [], consentRefs: [], tuning: { openingsPerHour: 0, openingsPerDay: 0, minimumGapSeconds: 1200, checkInIntervalSeconds: 0, arrivalDwellSeconds: 10, meaningfulAbsenceSeconds: 600, arrivalTtlSeconds: 90, checkInTtlSeconds: 120, followUpTtlSeconds: 300, pendingPerRelationship: 4, pendingPerRuntime: 16, generationCallsPerOpportunity: 1, concurrentSocialCalls: 1, generationMaxTokens: 160, generationDeadlineSeconds: 10, inferenceCallsPerRelationshipHour: 12, inferenceCallsPerRuntimeHour: 24, automaticRetries: 0, dedupRetentionSeconds: 86400 }, adaptation: { enabled: false, maximumDeferralSeconds: 0 } },
  understanding: { enabled: false, researchMode: "providedOnly", researchDepth: "brief", approvedTopicRefs: [], policyRefs: [], excludedSourceRefs: [], excludedTopicRefs: [], spoilerPolicy: "avoid", progressBoundaryRef: null, explorationShare: 0.2, budget: { jobsPerDay: 8, pendingJobsPerRuntime: 16, concurrentJobs: 1, externalRequestsPerJob: 4, documentsPerJob: 4, inputBytesPerJob: 2097152, sourceTokensPerJob: 16000, jobDeadlineSeconds: 120, fetchDeadlineSeconds: 10, analysisCallsPerJob: 2, outputTokensPerCall: 2048, automaticRetries: 0, workerCpuChunkMs: 50, workerMemoryMiB: 256, pendingJobTtlSeconds: 86400, briefFreshnessSeconds: 86400, enrichmentTokens: 512, selectedItems: 4, optionalSelectionDeadlineMs: 10 } }
};

test("extension configurations use one parent lifecycle, atomic retries, scope fences and restart persistence", async t => {
  const root = await mkdtemp(join(tmpdir(), "lifestream-extension-settings-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const config = loadConfig({defaults:{profile:"test",providers:{inference:"fixture",memory:"fixture",stt:"fixture",tts:"fixture",world:"fixture",capability:"fixture",renderer:"fixture",clock:"fixture"},storage:{databasePath:join(root,"state.sqlite"),artifactDirectory:join(root,"artifacts")},authority:{provider:"fixture",authentication:"fixture"},secretRefs:{}},profile:{},environment:{},cli:{}});
  let app = createLifestreamServer({config}); await app.start();t.after(()=>app.shutdown());
  let base = `http://127.0.0.1:${app.address().port}`;
  const actor = randomUUID();
  const headers = () => ({"content-type":"application/json","x-lifestream-fixture-session":"extension-review","x-lifestream-fixture-principal":actor,origin:base});
  const post = async (path:string, body:unknown) => {const response=await fetch(base+path,{method:"POST",headers:headers(),body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
  const assistant=await post("/api/admin/v1/assistants",{displayName:"Synthetic Extension Review"});
  const prefix=`/api/admin/v1/assistants/${assistant.body.assistantId}/relationships`;
  const relationship=await post(prefix,{userId:actor});assert.equal(relationship.status,201);
  const path=`${prefix}/${relationship.body.relationship.relationshipId}`;
  const validator=createContractValidator();
  const extension=async(kind:string,body:Record<string,unknown>)=>{const result=await post(`${path}/${kind}/v1`,{schemaVersion:"1.0.0",...body});assert.equal(validator.validate(`https://lifestream.dev/contracts/${kind}-api/1.0.0`,result.body).valid,true,JSON.stringify(result));return result;};
  const first=await extension("initiative",{operation:"draft",idempotencyKey:"first",expectedActiveConfigurationId:null,settings:settings.initiative});assert.equal(first.status,201);
  const original=first.body.records[0];assert.equal(original.lifecycle,"draft");assert.equal(first.body.activeConfigurationId,null);
  const reordered=await extension("initiative",{settings:settings.initiative,expectedActiveConfigurationId:null,idempotencyKey:"first",operation:"draft"});assert.deepEqual(reordered,first);
  const conflict=await extension("initiative",{operation:"draft",idempotencyKey:"first",expectedActiveConfigurationId:null,settings:{...settings.initiative,proactiveness:3}});assert.equal(conflict.status,409);
  assert.equal((await extension("initiative",{operation:"activate",idempotencyKey:"no-confirm",configurationId:original.configurationId,expectedRevision:original.revision,confirmed:false})).status,422);
  const activation=await extension("initiative",{operation:"activate",idempotencyKey:"activate-first",configurationId:original.configurationId,expectedRevision:original.revision,confirmed:true});assert.equal(activation.status,200);assert.equal(activation.body.activeStateChanged,true);
  const discovery=await extension("understanding",{operation:"draft",idempotencyKey:"discovery",expectedActiveConfigurationId:original.configurationId,settings:settings.understanding});assert.equal(discovery.status,201);
  const next=discovery.body.records[0];
  const parallel=await extension("initiative",{operation:"draft",idempotencyKey:"parallel",expectedActiveConfigurationId:original.configurationId,settings:settings.initiative});assert.equal(parallel.status,201);
  const preview=await extension("understanding",{operation:"preview",configurationId:next.configurationId});assert.equal(preview.body.activeStateChanged,false);assert.equal(preview.body.activeConfigurationId,original.configurationId);
  assert.equal((await extension("understanding",{operation:"activate",idempotencyKey:"activate-discovery",configurationId:next.configurationId,expectedRevision:next.revision,confirmed:true})).status,200);
  assert.equal((await extension("initiative",{operation:"activate",idempotencyKey:"stale",configurationId:parallel.body.records[0].configurationId,expectedRevision:parallel.body.records[0].revision,confirmed:true})).status,409);
  const inspect=await extension("initiative",{operation:"inspect"});assert.equal(inspect.body.records.find((r:any)=>r.lifecycle==="active").configurationId,next.configurationId);
  const rollback=await extension("initiative",{operation:"rollback",idempotencyKey:"rollback",configurationId:original.configurationId,expectedRevision:original.revision});assert.equal(rollback.status,201);assert.equal(rollback.body.activeConfigurationId,next.configurationId);
  const legacy=await post(`${path}/configurations`,{preset:"concise",idempotencyKey:"legacy"});assert.equal(legacy.status,201);assert.equal(legacy.body.configuration.extensions,undefined);
  const legacyAttached=await extension("understanding",{operation:"preview",configurationId:legacy.body.configuration.configurationId});assert.deepEqual(legacyAttached.body.records[0].budget,settings.understanding.budget);
  assert.equal((await post(`${path}/configurations/${legacy.body.configuration.configurationId}/activate`,{idempotencyKey:"legacy-unconfirmed",expectedRevision:legacy.body.configuration.revision})).status,200);
  const alien=await fetch(`${base}${path}/initiative/v1`,{method:"POST",headers:{...headers(),"x-lifestream-fixture-principal":randomUUID()},body:JSON.stringify({schemaVersion:"1.0.0",operation:"inspect"})});assert.equal(alien.status,404);
  const noauth=await fetch(`${base}${path}/initiative/v1`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({schemaVersion:"1.0.0",operation:"inspect"})});assert.equal(noauth.status,401);
  await app.shutdown();app=createLifestreamServer({config});await app.start();base=`http://127.0.0.1:${app.address().port}`;
  const restored=await extension("understanding",{operation:"inspect"});assert.equal(restored.body.activeConfigurationId,legacy.body.configuration.configurationId);assert.equal(restored.body.records.find((r:any)=>r.lifecycle==="active").enabled,false);
  assert.deepEqual(await extension("initiative",{operation:"draft",idempotencyKey:"first",expectedActiveConfigurationId:null,settings:settings.initiative}),first);
});

test("extension administration uses real local authentication, CSRF and transactional failure fencing", async t => {
  const { loadProfile } = await import("../src/config/loader.ts");
  const { Database } = await import("../../../packages/storage-sqlite/src/database.ts");
  const root=await mkdtemp(join(tmpdir(),"lifestream-protected-extensions-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=loadProfile("test");config.authority.authentication="local-password";config.storage={databasePath:join(root,"state.sqlite"),artifactDirectory:join(root,"artifacts")};
  const installerToken=randomUUID();const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,"safety"),installerToken}});await app.start();t.after(()=>app.shutdown());
  const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,"content-type":"application/json"};
  const send=async(path:string,body:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:"POST",headers:{...headers,...extra},body:JSON.stringify(body)});
  const setup=await send("/api/auth/v1/setup",{username:"owner",password:randomUUID()+randomUUID(),installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get("set-cookie")!.split(";")[0]!;headers["x-lifestream-csrf"]=(await setup.json() as any).session.csrfToken;
  const assistant=await (await send("/api/admin/v1/assistants",{displayName:"Synthetic Protected Review"})).json() as any;
  const rel=await (await send(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).json() as any;
  const path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${rel.relationship.relationshipId}/understanding/v1`;
  const draft={schemaVersion:"1.0.0",operation:"draft",idempotencyKey:"atomic-failure",expectedActiveConfigurationId:null,settings:settings.understanding};
  assert.equal((await send(path,draft,{"x-lifestream-csrf":"wrong"})).status,403);
  assert.equal((await send(path,draft,{origin:"https://untrusted.invalid"})).status,403);
  assert.equal((await send(path,{...draft,authority:true})).status,422);
  const db=new Database({path:config.storage.databasePath});t.after(()=>db.close());
  db.exec("CREATE TRIGGER reject_extension_retry BEFORE INSERT ON assistant_relationship_idempotency WHEN NEW.idempotency_key='atomic-failure' BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END;");
  assert.equal((await send(path,draft)).status,409);
  const count=()=> (db.connection.prepare("SELECT count(*) AS n FROM assistant_relationship_configurations").get() as {n:number}).n;
  assert.equal(count(),0,"failed retry persistence must roll back the draft too");
  db.exec("DROP TRIGGER reject_extension_retry");
  const saved=await send(path,draft);assert.equal(saved.status,201);const value=(await saved.json() as any).records[0];assert.equal(count(),1);
  const activate={schemaVersion:"1.0.0",operation:"activate",configurationId:value.configurationId,expectedRevision:value.revision,confirmed:true,idempotencyKey:"atomic-activation"};
  db.exec("CREATE TRIGGER reject_extension_activation BEFORE INSERT ON assistant_relationship_idempotency WHEN NEW.idempotency_key='atomic-activation' BEGIN SELECT RAISE(ABORT,'synthetic persistence failure'); END;");
  assert.equal((await send(path,activate)).status,409);
  const afterFailure=await (await send(path,{schemaVersion:"1.0.0",operation:"inspect"})).json() as any;assert.equal(afterFailure.activeConfigurationId,null);assert.equal(afterFailure.records[0].lifecycle,"draft");
  db.exec("DROP TRIGGER reject_extension_activation");assert.equal((await send(path,activate)).status,200);
  assert.equal((await send(path,{...activate,expectedRevision:999})).status,409);
  await send("/api/auth/v1/sign-out",{});assert.equal((await send(path,{schemaVersion:"1.0.0",operation:"inspect"})).status,401);
});
