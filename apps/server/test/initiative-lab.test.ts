import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {createContractValidator} from '@lifestream/contracts';
import {runInitiativeLab} from '../src/admin/initiative-lab-worker.ts';
import {InitiativeLab} from '../src/admin/initiative-lab.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';
const pause=()=>new Promise<void>(r=>setTimeout(r,30));

test('pinned Initiative Lab runs the same shared runtime sequence with a behavioral gradient and unchanged selected input',async()=>{
 const selected=structuredClone(extensionSettings.initiative),before=JSON.stringify(selected),first=await runInitiativeLab(selected),second=await runInitiativeLab(selected);
 assert.equal(JSON.stringify(selected),before);assert.equal(first.scenarioRevision,second.scenarioRevision);assert.deepEqual(first.variants,second.variants);
 assert.deepEqual(first.variants.map(v=>v.openings),[0,2,7,0]);assert.deepEqual(first.variants.map(v=>v.calls),[0,2,7,0]);assert.equal(first.variants.every(v=>v.rows.length===12),true);
 for(const v of first.variants){for(const minute of [15,25]){const row=v.rows.find(r=>r.minute===minute)!;assert.equal(row.state,'suppressed');assert.ok(row.reasons.includes(minute===15?'quiet':'privacyInsufficient'));}}
 const high=first.variants[2]!;assert.equal(high.distinctTopics,7);assert.equal(high.rows.find(r=>r.minute===10)!.state,'notAdmitted');assert.equal(high.rows.find(r=>r.minute===50)!.state,'notAdmitted');
 assert.ok(first.records.length<=128&&first.explanations.length<=64);assert.equal(JSON.stringify(first.records).includes('Synthetic opening.'),false);
 const validator=createContractValidator();for(const row of first.records)assert.equal(validator.validate(`https://lifestream.dev/contracts/relational-initiative/1.0.0#/$defs/${row.recordType==='configuration'?'RelationalInitiativeConfiguration':row.recordType==='opportunity'?'RelationalOpportunity':'RelationalInitiativeOutcome'}`,row).valid,true,JSON.stringify(row));
 const speech={...selected,preset:'custom',proactiveness:11,dimensions:{...selected.dimensions,initiative:11},endpointIds:[randomUUID()],consentRefs:['PRIVATE_CONSENT_REF'],allowedContexts:['privateAvailable'],allowedModalities:['speech'],allowedKinds:['arrivalReturn','groundedFollowUp','availableCheckIn'],tuning:{...selected.tuning,openingsPerHour:8,openingsPerDay:32,minimumGapSeconds:300}};
 const restricted=await runInitiativeLab(speech);assert.equal(restricted.variants[3]!.calls,0);assert.equal(restricted.variants[3]!.openings,0);assert.equal(JSON.stringify(restricted).includes('PRIVATE_CONSENT_REF'),false);
});

test('bounded worker cache binds owner, revision and expiry; shutdown prevents later reuse',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const lab=new InitiativeLab();try{
  const entry=lab.readOrStart('owner-one','revision-one',extensionSettings.initiative);assert.equal(lab.readOrStart('owner-one','revision-one',extensionSettings.initiative),entry);assert.throws(()=>lab.readOrStart('owner-two','revision-one',extensionSettings.initiative),/running/u);
  for(let n=0;n<250&&!entry.report&&!entry.error;n++)await pause();assert.equal(entry.error,undefined);assert.ok(entry.report);assert.equal(lab.readOrStart('owner-one','revision-one',extensionSettings.initiative),entry);
  // A completed report is not returned for a changed boundary or another owner.
  await pause();t.mock.timers.setTime(entry.expires+1);const expired=lab.readOrStart('owner-one','revision-one',extensionSettings.initiative);assert.notEqual(expired,entry);assert.equal(expired.report,undefined);
  for(let n=0;n<250&&!expired.report&&!expired.error;n++)await pause();assert.equal(expired.error,undefined);assert.ok(expired.report);await pause();const fresh=lab.readOrStart('owner-one','revision-two',extensionSettings.initiative);assert.notEqual(fresh,expired);assert.equal(fresh.report,undefined);
 }finally{lab.close();}assert.throws(()=>lab.readOrStart('owner-one','revision-one',extensionSettings.initiative),/closed/u);
});

test('protected comparison reviews a draft without activation, real provider work or durable Initiative records',{timeout:20000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'initiative-lab-api-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomUUID(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const send=async(path:string,body:unknown,extra:Record<string,string>={})=>{const response=await fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any,headers:response.headers};};
 const setup=await send('/api/auth/v1/setup',{username:'owner',password:randomUUID()+randomUUID(),installerToken});headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=setup.body.session.csrfToken;
 const a=(await send('/api/admin/v1/assistants',{displayName:'Synthetic Lab Review'})).body,rel=(await send(`/api/admin/v1/assistants/${a.assistantId}/relationships`,{})).body.relationship,path=`/api/admin/v1/assistants/${a.assistantId}/relationships/${rel.relationshipId}/initiative/v1`;
 const draft=await send(path,{schemaVersion:'1.0.0',operation:'draft',idempotencyKey:randomUUID(),expectedActiveConfigurationId:null,settings:extensionSettings.initiative});assert.equal(draft.status,201);const selected=draft.body.records[0],request={schemaVersion:'1.0.0',operation:'compare',configurationId:selected.configurationId,scenario:'initiative-gradient-v1'};
 const db=new Database({path:config.storage.databasePath});t.after(()=>db.close());const before=String(db.connection.prepare('SELECT payload_json FROM assistant_relationship_configurations').get()!.payload_json);let liveCalls=0;(app as any).providers.inference={async *generate(){liveCalls++;throw new Error('Live provider must not be called');}};
 assert.equal((await send(path,request,{cookie:''})).status,401);assert.equal((await send(path,request,{'x-lifestream-csrf':'wrong'})).status,403);assert.equal((await send(path,{...request,scenario:'forged'})).status,422);assert.equal((await send(path,{...request,configurationId:randomUUID()})).status,404);
 let result=await send(path,request);assert.equal(result.status,202);for(let n=0;n<250&&result.status===202;n++){await pause();result=await send(path,request);}assert.equal(result.status,200,JSON.stringify(result));assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/initiative-api/1.0.0',result.body).valid,true,JSON.stringify(result));
 assert.equal(result.body.activeStateChanged,false);assert.equal(result.body.activeConfigurationId,null);assert.equal(result.body.delivery,null);assert.equal(liveCalls,0);assert.equal(String(db.connection.prepare('SELECT payload_json FROM assistant_relationship_configurations').get()!.payload_json),before);
 for(const table of ['initiative_delivery','initiative_inference_calls','initiative_expression'])assert.equal(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
 assert.equal((await send(path,{schemaVersion:'1.0.0',operation:'inspect'})).body.records[0].lifecycle,'draft');assert.deepEqual((await send(path,request)).body,result.body);
 await send('/api/auth/v1/sign-out',{});assert.equal((await send(path,request)).status,401);
});
