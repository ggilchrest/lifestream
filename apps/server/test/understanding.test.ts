import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm,copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Database } from "../../../packages/storage-sqlite/src/database.ts";
import { createContractValidator } from "../../../packages/contracts/src/validator.ts";
import { extensionSettings } from "../../../tests/fixtures/extension-settings.ts";
import { createLifestreamServer } from "../src/index.ts";
import { loadProfile } from "../src/config/loader.ts";

const source=()=>({sourceRef:"source:quartz-manual",sourceFamily:"family:quartz-manual",sourceRevision:"revision:1",topicRef:"topic:quartz",policyRef:"policy:synthetic-supplied",retrievedAt:new Date().toISOString(),reliability:"unknown",reliabilityBasis:"Selected synthetic source; no independent corroboration.",content:"Quartz sensors use the test calibration identifier QTZ_MARKER_482. The ending is withheld.",claims:[{claimId:randomUUID(),text:"Quartz sensors use the test calibration identifier QTZ_MARKER_482.",sourceRefs:["source:quartz-manual"],qualifier:"attributed",versionScope:"synthetic revision 1",spoilerClass:"none",contradictionRefs:[]}],aliasClaims:[],knowledgeGaps:["Independent accuracy has not been established."]});

test("supplied-source Discovery reaches actual prepared input and owner privacy survives database restore",async t=>{
 const root=await mkdtemp(join(tmpdir(),"ls-discovery-path-"));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile("test");config.authority.authentication="local-password";config.storage={databasePath:join(root,"state.sqlite"),artifactDirectory:join(root,"artifacts")};
 const installerToken=randomUUID(),password=randomUUID()+randomUUID(),options={config,localAuth:{stateDirectory:join(root,"safety"),installerToken}};
 let app=createLifestreamServer(options);await app.start();t.after(()=>app.shutdown());let base=`http://127.0.0.1:${app.address().port}`;
 const headers:Record<string,string>={origin:base,"content-type":"application/json"};
 const request=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?"GET":"POST",headers,body:body===undefined?undefined:JSON.stringify(body)});
 const api=async(path:string,body?:unknown)=>{const res=await request(path,body);return {status:res.status,body:await res.json() as any};};
 const setup=await request("/api/auth/v1/setup",{username:"owner",password,installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get("set-cookie")!.split(";")[0]!;headers["x-lifestream-csrf"]=(await setup.json() as any).session.csrfToken;
 const assistant=(await api("/api/admin/v1/assistants",{displayName:"Synthetic Discovery Review"})).body;
 await api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 const relationship=(await api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).body.relationship;
 const prefix=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationshipId}`,path=prefix+"/understanding/v1",validator=createContractValidator();
 const discovery=async(body:Record<string,unknown>)=>{const result=await api(path,{schemaVersion:"1.0.0",...body});assert.equal(validator.validate("https://lifestream.dev/contracts/understanding-api/1.0.0",result.body).valid,true,JSON.stringify(result));return result;};
 const prepare={operation:"prepare",idempotencyKey:"prepare-quartz",topicRef:"topic:quartz",purpose:"briefRebuild",evidenceRefs:[],sources:[source()]};
 assert.equal((await discovery(prepare)).status,409,"disabled configuration cannot prepare");
 const settings={...extensionSettings.understanding,enabled:true,policyRefs:["policy:synthetic-supplied"]};
 const draft=await discovery({operation:"draft",idempotencyKey:"discovery-settings",expectedActiveConfigurationId:null,settings});assert.equal(draft.status,201);
 const revision=draft.body.records[0];assert.equal((await discovery({operation:"activate",idempotencyKey:"discovery-activate",configurationId:revision.configurationId,expectedRevision:revision.revision,confirmed:true})).status,200);
 assert.equal((await discovery({...prepare,idempotencyKey:"false-claim",sources:[{...source(),content:"Unrelated source text"}]})).status,409);
 const accepted=await discovery(prepare);assert.equal(accepted.status,202,JSON.stringify(accepted));
 let inspect:any;
 for(let attempt=0;attempt<40;attempt++){inspect=await discovery({operation:"inspect"});if(inspect.body.records.some((r:any)=>r.workId===accepted.body.records[0].workId&&["published","cancelled","failed"].includes(r.state)))break;await new Promise(resolve=>setTimeout(resolve,25));}
 const work=inspect.body.records.find((r:any)=>r.workId===accepted.body.records[0].workId);assert.equal(work.state,"published",JSON.stringify(work));
 const brief=inspect.body.records.find((r:any)=>r.recordType==="topicBrief");assert.ok(brief);assert.equal(brief.sources[0].reliability,"unknown");assert.equal(brief.claims[0].qualifier,"attributed");
 assert.equal((await discovery(prepare)).body.records[0].workId,work.workId,"retry cannot launch another job");
 assert.equal((await discovery({...prepare,idempotencyKey:"duplicate-snapshot"})).status,409);
 await api("/api/runtime/v1/session-context",{expectedRevision:0,mode:"text",audienceScope:"authenticatedSession"});
 const prompt=async(userInput:string)=>{const response=await request("/api/runtime/v1/messages",{assistantId:assistant.assistantId,relationshipId:relationship.relationshipId,userInput,inspect:true,fullPromptPreview:true});assert.equal(response.status,200);const text=await response.text();assert.match(text,/event: interaction.completed/);return text;};
 const actual=await prompt("Explain quartz sensor calibration.");assert.match(actual,/QTZ_MARKER_482/);assert.match(actual,/Optional sourced context/);
 assert.doesNotMatch(await prompt("Actually, not quartz; explain basalt."),/QTZ_MARKER_482/);
 const backup=join(root,"before-forgetting.sqlite"),connection=new Database({path:config.storage.databasePath});await connection.backup(backup);connection.close();
 const forgetRequest={operation:"disposition",idempotencyKey:"forget-quartz",recordId:brief.briefId,expectedRevision:brief.revision,decision:"excludeSource",reason:"Exclude this selected synthetic source."};
 const forgotten=await discovery(forgetRequest);assert.equal(forgotten.status,200,JSON.stringify(forgotten));
 assert.equal((await discovery(forgetRequest)).status,200,"privacy retry succeeds after its brief was erased");
 assert.equal((await discovery({...forgetRequest,reason:"Different request"})).status,409,"changed retry is rejected");
 assert.doesNotMatch(await prompt("Explain quartz sensor calibration."),/QTZ_MARKER_482/);
 assert.equal((await discovery({...prepare,idempotencyKey:"blocked-reimport"})).status,409);
 const renamed=source();renamed.sourceRef="source:renamed-copy";renamed.claims=renamed.claims.map(claim=>({...claim,sourceRefs:[renamed.sourceRef]}));
 assert.equal((await discovery({...prepare,idempotencyKey:"blocked-renamed-reimport",sources:[renamed]})).status,409,"excluded source content cannot be revived by changing its identifier");
 const db=new Database({path:config.storage.databasePath});assert.equal((db.connection.prepare("SELECT count(*) AS n FROM understanding_artifacts").get() as any).n,0);assert.equal((db.connection.prepare("SELECT count(*) AS n FROM understanding_projection").get() as any).n,0);assert.equal((db.connection.prepare("SELECT count(*) AS n FROM understanding_work WHERE payload_json IS NOT NULL").get() as any).n,0);db.close();
 await app.shutdown();await copyFile(backup,config.storage.databasePath);app=createLifestreamServer(options);await app.start();base=`http://127.0.0.1:${app.address().port}`;headers.origin=base;delete headers.cookie;delete headers["x-lifestream-csrf"];
 const login=await request("/api/auth/v1/sign-in",{username:"owner",password,totp:""});assert.equal(login.status,200);headers.cookie=login.headers.get("set-cookie")!.split(";")[0]!;headers["x-lifestream-csrf"]=(await login.json() as any).session.csrfToken;
 assert.equal((await discovery({operation:"inspect"})).body.records.filter((r:any)=>r.recordType==="topicBrief").length,0);
 assert.equal((await discovery({...prepare,idempotencyKey:"restore-cannot-reimport"})).status,409);
 assert.equal((await discovery(forgetRequest)).status,200,"privacy retry remains available after database restoration");
});

test("Discovery cancellation and runtime closure fence late preparation without replay",async t=>{
 const {DiscoveryAdministration}=await import('../src/admin/understanding.ts');
 const {understandingDigest}=await import('../../../packages/storage-sqlite/src/understanding.ts');
 const db=new Database({path:':memory:'});db.migrate();
 const scope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()},configurationId=randomUUID();let publications=0;
 const admin=new DiscoveryAdministration(db,{snapshot:()=>({boundary:understandingDigest('synthetic-current'),configuration:{configurationId,revision:1,extensions:{understanding:{...extensionSettings.understanding,enabled:true,policyRefs:['policy:synthetic-supplied']}}} as any}),evidenceAllowed:()=>true,sourceAllowed:()=>true,forget:()=> 'missing',changed:()=>{publications++;}});
 const request={schemaVersion:'1.0.0',operation:'prepare',idempotencyKey:'cancel-source',topicRef:'topic:quartz',purpose:'briefRebuild',evidenceRefs:[],sources:[source()]};
 const admitted=admin.handle(scope,request,()=>true);assert.equal(admitted.status,202,JSON.stringify(admitted));const work=(admitted.body.records as any[])[0];
 const cancel={schemaVersion:'1.0.0',operation:'cancel',idempotencyKey:'cancel-retry',workId:work.workId,expectedRevision:1};
 assert.equal(admin.handle(scope,cancel,()=>true).status,200);assert.equal(admin.handle(scope,cancel,()=>true).status,200);
 assert.equal(admin.handle(scope,{...cancel,expectedRevision:2},()=>true).status,409);
 assert.equal(admin.handle(scope,{...request,idempotencyKey:'close-source',sources:[source()]},()=>true).status,202);
 admin.close();assert.equal(admin.repository.list(scope,understandingDigest('synthetic-current')).filter(r=>r.state==='cancelled').length,2);db.close();
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(publications,0,'closed runtime cannot publish a late result or touch a closed database');
});

test("optional Discovery index failure leaves ordinary input selection available",async t=>{
 const {DiscoveryAdministration}=await import('../src/admin/understanding.ts');const {understandingDigest}=await import('../../../packages/storage-sqlite/src/understanding.ts');
 const db=new Database({path:':memory:'});db.migrate();t.after(()=>db.close());
 const scope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()};
 const admin=new DiscoveryAdministration(db,{snapshot:()=>({boundary:understandingDigest('current'),configuration:{extensions:{understanding:{...extensionSettings.understanding,enabled:true}}} as any}),evidenceAllowed:()=>true,sourceAllowed:()=>true,forget:()=> 'missing',changed:()=>{}});t.after(()=>admin.close());
 admin.repository.select=()=>{throw new Error('Synthetic index unavailable');};
 assert.equal(admin.select(scope,'quartz','authenticatedSession',8192).content,'');
});
