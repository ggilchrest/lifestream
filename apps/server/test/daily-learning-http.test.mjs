import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';
import {projectLearningOutcomes} from '../../daily-web/owners/learning-outcomes.js';

test('Daily learning projection consumes the real original inspection GET without enabling work or widening access',async t=>{
 const root=await mkdtemp(join(tmpdir(),'daily-learning-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 let modelCalls=0;const original=FixtureInferenceProvider.prototype.generate;FixtureInferenceProvider.prototype.generate=async function*(){modelCalls++;throw Error('This GET-only fixture must not generate');};t.after(()=>{FixtureInferenceProvider.prototype.generate=original;});
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${app.address().port}`;let cookie='',csrf='';
 const request=(path,body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const setup=await request('/api/auth/v1/setup',{username:'synthetic-learning-view',password,installerToken});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie').split(';')[0];const session=(await setup.json()).session;csrf=session.csrfToken;
 const created=await request('/api/admin/v1/assistants',{displayName:'Synthetic learning view'});assert.equal(created.status,201);const assistant=await created.json();
 assert.equal((await request(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null})).status,200);
 const relationshipResponse=await request(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{});assert.equal(relationshipResponse.status,201);const relationship=(await relationshipResponse.json()).relationship;
 const path=`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationshipId}/experience/v1`;
 const response=await request(path);assert.equal(response.status,200);const snapshot=await response.json();
 const view=projectLearningOutcomes(snapshot,{principalId:session.principalId,assistantId:assistant.assistantId,relationship:{id:relationship.relationshipId}});
 assert.equal(view.mode,'Off');assert.deepEqual(view.items,[]);assert.deepEqual(view.jobs,[]);assert.deepEqual(view.selections,[]);assert.equal(snapshot.state.configuration.enabled,false);assert.equal(snapshot.state.funnel.calls,0);assert.equal(modelCalls,0);
 const second=await (await request(path)).json();assert.equal(second.state.configuration.enabled,false);assert.equal(second.state.funnel.calls,0);assert.equal(second.state.revision,snapshot.state.revision);assert.equal(modelCalls,0);
 assert.equal((await request(path+'?unsupported=1')).status,422);const noAuth=await fetch(base+path,{headers:{origin:base}});assert.equal(noAuth.status,401);assert.equal((await fetch(base+path,{method:'DELETE',headers:{origin:base,cookie}})).status,405);assert.equal(modelCalls,0);
 for(const [path,file] of [['/daily/owners/learning-outcomes.js','../../daily-web/owners/learning-outcomes.js'],['/daily/app.js','../../daily-web/app.js']]){
  const asset=await request(path);assert.equal(asset.status,200);assert.equal(await asset.text(),await readFile(new URL(file,import.meta.url),'utf8'));
 }
});
