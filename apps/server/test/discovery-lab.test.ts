import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runDiscoveryInputLab} from '../src/admin/discovery-lab-worker.ts';
import {DiscoveryInputLab} from '../src/admin/discovery-lab.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {relationshipControlDefaults} from '../../../packages/runtime/src/context/builder.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';
import type {RelationshipConfiguration} from '../src/relationship-extensions.ts';
const settings={...extensionSettings.understanding,enabled:true,policyRefs:['policy:discovery-lab-v1']};
const configuration=():RelationshipConfiguration=>({configurationId:randomUUID(),relationshipId:randomUUID(),revision:1,status:'draft',preset:'balanced',controls:{...relationshipControlDefaults},createdAt:new Date().toISOString(),createdBy:'synthetic',extensions:{understanding:settings}});

test('Discovery Lab retains failing expectations and uses bounded canonical input across frozen variants',()=>{
 const c=configuration(),report=runDiscoveryInputLab(c);assert.equal(report.rows.length,18);assert.equal(report.canonicalRequestCount,18);assert.equal(report.providerCalls,0);
 for(const row of report.rows){assert.ok(row.checks.filter(check=>check.name.includes('bound')||check.name.includes('limit')).every(check=>check.pass));assert.ok(row.memory.includes('Missing imports do not establish dislike'));if(row.variant==='baseline')assert.doesNotMatch(row.memory,/discovery-candidate:/);}
 const failed=report.rows.find(row=>row.id==='ambiguous-pair'&&row.variant==='enabled')!;assert.ok(failed.checks.some(check=>!check.pass),'unsupported preference-aware disambiguation must remain a failed input expectation');
 for(const id of ['current-domain','current-correction','source-detail','heldout-alternate','heldout-mineral'])assert.ok(report.rows.filter(row=>row.id===id).every(row=>row.checks.every(check=>check.pass)),id);
 const excluded=runDiscoveryInputLab({...c,extensions:{understanding:{...settings,excludedTopicRefs:['topic:basalt']}}});const mineral=excluded.rows.find(row=>row.id==='heldout-mineral'&&row.variant==='selected')!;assert.doesNotMatch(mineral.memory,/BASALT_DETAIL_573/);assert.equal(mineral.checks.find(check=>check.name==='expected contextual detail')!.pass,false,'exclusion must not fabricate expected inclusion');
 const disabled=runDiscoveryInputLab({...c,extensions:{understanding:{...settings,enabled:false}}});assert.ok(disabled.rows.filter(row=>row.variant==='selected').every(row=>row.selectedItems===0));assert.equal(disabled.scenarioRevision,report.scenarioRevision);
});

test('Discovery Lab caps concurrent workers and fails truthfully after interruption',async t=>{
 const lab=new DiscoveryInputLab();t.after(()=>lab.close());const c=configuration(),first=lab.readOrStart('scope-a','boundary',c);assert.equal(lab.readOrStart('scope-a','boundary',c),first);assert.throws(()=>lab.readOrStart('scope-b','boundary',c),/already running/);
 await (lab as any).worker.terminate();assert.match(lab.readOrStart('scope-a','boundary',c).error!,/without a report/);lab.close();assert.throws(()=>lab.readOrStart('scope-a','boundary',c),/closed/);
});

test('protected Discovery comparison has no live artifact/configuration writes or provider calls and rejects foreign scope',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-discovery-lab-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};const installerToken=randomUUID(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const send=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}),api=async(path:string,body?:unknown)=>{const r=await send(path,body);return {status:r.status,body:await r.json() as any};};
 const setup=await send('/api/auth/v1/setup',{installerToken,username:'owner',password:randomUUID()+randomUUID()});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=(await setup.json() as any).session.csrfToken;
 const assistant=(await api('/api/admin/v1/assistants',{displayName:'Synthetic Lab'})).body;const relation=(await api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).body.relationship;
 const prefix=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relation.relationshipId}`,route=prefix+'/understanding/v1',discovery=(request:Record<string,unknown>)=>api(route,{schemaVersion:'1.0.0',...request});
 let providerCalls=0;(app as any).providers.inference.generate=async function*(){providerCalls++;throw new Error('Input Lab must not call a provider');};
 const draft=await discovery({operation:'draft',idempotencyKey:'draft',expectedActiveConfigurationId:null,settings});assert.equal(draft.status,201);const id=draft.body.records[0].configurationId;
 const db=new Database({path:config.storage.databasePath});t.after(()=>db.close());const snapshot=()=>['assistant_relationship_configurations','understanding_work','understanding_artifacts','understanding_projection','assistant_relationships'].map(table=>db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());const before=snapshot();
 const request={operation:'compare',configurationId:id,scenario:'understanding-demonstrations-v1'};let result=await discovery(request);assert.equal(result.status,202,JSON.stringify(result));assert.equal(result.body.executionMode,'simulation');
 for(let n=0;n<150&&result.status===202;n++){await new Promise(resolve=>setTimeout(resolve,20));result=await discovery(request);}assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.activeConfigurationId,null);assert.equal(result.body.activeStateChanged,false);assert.deepEqual(result.body.records,[]);assert.match(result.body.explanations[0].summary,/rows have failed input expectations/);assert.match(result.body.explanations[0].summary,/No model was called/);assert.ok(result.body.explanations.some((e:any)=>e.code==='lab:ambiguous-pair:enabled:checks'&&e.summary.includes('FAIL:')));assert.deepEqual(snapshot(),before);assert.equal(providerCalls,0);
 assert.equal((await discovery({...request,configurationId:randomUUID()})).status,404);assert.equal((await discovery({...request,prompt:'smuggle live input'})).status,422);
 const foreign=(await api('/api/admin/v1/assistants',{displayName:'Other scope'})).body,foreignRelation=(await api(`/api/admin/v1/assistants/${foreign.assistantId}/relationships`,{})).body.relationship;
 assert.equal((await api(`/api/admin/v1/assistants/${foreign.assistantId}/relationships/${foreignRelation.relationshipId}/understanding/v1`,{schemaVersion:'1.0.0',...request})).status,404);
 const cookie=headers.cookie;delete headers.cookie;assert.equal((await discovery(request)).status,401);headers.cookie=cookie!;
});
