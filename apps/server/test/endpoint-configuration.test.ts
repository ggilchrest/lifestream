import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {SessionHandoffService} from '../../../packages/runtime/src/endpoints/handoff.ts';
import {inspectEndpointConfiguration} from '../src/runtime/endpoint-configuration.ts';
import {reviseSessionEndpoint} from '../src/runtime/session-context.ts';
import {PresentationPackages,PresentationSelection} from '../src/admin/presentation-packages.ts';
import {SavedVoiceAdministration} from '../src/admin/saved-voices.ts';
import {loadProfile} from '../src/config/loader.ts';
import {createLifestreamServer} from '../src/index.ts';

test('effective endpoint snapshots preserve per-session precedence, pinned bytes and lease truth without mutation',()=>{
 const database=new Database({path:':memory:'});database.migrate();try{
 const config=loadProfile('test'),catalog=new PresentationPackages(),selection=new PresentationSelection(database),voices=new SavedVoiceAdministration(database),ownership=new SessionHandoffService(),bindingKey=randomUUID();
 const a=reviseSessionEndpoint(database,'one',{expectedRevision:0,mode:'text',audienceScope:'unknown',bindingKey},true,'owner');
 reviseSessionEndpoint(database,'two',{expectedRevision:0,mode:'audio',audienceScope:'authenticatedSession',bindingKey},true,'owner');
 selection.select('owner',a.endpoint!.endpointId,'one',{scope:'default',id:'neutral',digest:'neutral-v1',expectedRevision:0},catalog);
 selection.select('owner',a.endpoint!.endpointId,'two',{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0},catalog);
 const input={database,config,principalId:'owner',catalog,selection,voices,ownership,audience:{enforced:false},providers:{inference:{status:'healthy',fixture:true}}};
 const inspect=(sessionId:string)=>inspectEndpointConfiguration({...input,sessionId,privateContextAllowed:sessionId==='two'});
 const before=database.connection.prepare('SELECT total_changes() AS n').get();const first=inspect('one'),second=inspect('two');assert.equal(first.session.endpointId,second.session.endpointId);assert.equal(first.presentation.source,'endpointDefault');assert.equal(second.presentation.source,'sessionOverride');assert.deepEqual(first.modalities.negotiatedInput,['text']);assert.deepEqual(second.modalities.negotiatedInput,['text','audio']);assert.equal(first.disclosure.effectiveScope,'unknown');assert.equal(second.disclosure.effectiveScope,'authenticatedSession');assert.equal(first.handoff.administrationAvailable,false);assert.deepEqual(database.connection.prepare('SELECT total_changes() AS n').get(),before);
 assert.equal(inspect('one').sourceRevision,first.sourceRevision);
 const lease=ownership.acquire('two',a.endpoint!.endpointId,randomUUID(),new Date(Date.now()+60000).toISOString());assert.equal(inspect('two').audioOwnership.active,true);assert.equal(inspect('one').audioOwnership.active,false);ownership.release(lease);assert.equal(inspect('two').audioOwnership.active,false);
 database.connection.prepare("UPDATE presentation_selections SET package_id='missing-pack',package_digest=? WHERE scope_id='default'").run('f'.repeat(64));const changed=inspect('one');assert.equal(changed.presentation.available,false);assert.match(changed.presentation.reason!,/Explicit reselection/);assert.equal(changed.presentation.selected.digest,'f'.repeat(64));assert.notEqual(changed.sourceRevision,first.sourceRevision);assert.equal(inspect('two').presentation.available,true);
 const foreign=inspectEndpointConfiguration({...input,principalId:'other',sessionId:'unbound',privateContextAllowed:false});assert.equal(foreign.presentation.source,'neutralFallback');assert.equal(foreign.presentation.selected.id,'neutral');assert.equal(foreign.session.endpointId,null);
 }finally{database.close();}
});

test('actual configuration API enforces authentication, administration, audience and immutable inspection across restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ls-effective-http-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};config.authority.authentication='local-password';const password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex');let app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();t.after(()=>app.shutdown());const port=app.address().port,base=`http://127.0.0.1:${port}`;let cookie='',csrf='';
 const request=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json','x-lifestream-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const endpoint='/api/runtime/v1/endpoint-configuration';assert.equal((await request(endpoint)).status,401);
 const setup=await request('/api/auth/v1/setup',{username:'owner',password,installerToken});cookie=setup.headers.get('set-cookie')!.split(';')[0]!;csrf=(await setup.json()).session.csrfToken;
 assert.equal((await request(endpoint)).status,403);const bindingKey=randomUUID();assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'unknown',bindingKey})).status,200);assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
 const create=await(await request('/api/admin/v1/assistants',{displayName:'Synthetic inspector',voiceProfile:'saved-voice:missing-reference'})).json();assert.equal((await request(`/api/admin/v1/assistants/${create.assistantId}/activate`,{profileId:create.profile.profileId,expectedActiveRevision:null})).status,200);
 const path=endpoint+'?assistantId='+create.assistantId;const before=await(await request('/api/runtime/v1/session-context')).json();const actual=await request(path);assert.equal(actual.status,200);const value=await actual.json();assert.equal(value.assistant.profileRevision,1);assert.equal(value.voice.compatible,false);assert.match(value.voice.reason,/unavailable/);assert.equal(value.presentation.source,'neutralFallback');assert.equal(value.disclosure.effectiveScope,'unknown');assert.equal((await request(endpoint,{unexpected:true})).status,405);assert.equal((await request(endpoint+'?principalId=other')).status,422);assert.equal((await request(path+'&assistantId='+create.assistantId)).status,422);const after=await(await request('/api/runtime/v1/session-context')).json();assert.equal(after.revision,before.revision);assert.deepEqual(after.endpoint,before.endpoint);assert.equal(after.runtimeSelfContext.sourceRevision,before.runtimeSelfContext.sourceRevision);
 const ownerCookie=cookie,ownerCsrf=csrf;const memberPassword=randomBytes(24).toString('hex');assert.equal((await request('/api/auth/v1/accounts',{username:'member',password:memberPassword})).status,201);const member=await request('/api/auth/v1/sign-in',{username:'member',password:memberPassword});cookie=member.headers.get('set-cookie')!.split(';')[0]!;csrf=(await member.json()).session.csrfToken;assert.equal((await request(path)).status,403);cookie=ownerCookie;csrf=ownerCsrf;
 await request('/api/runtime/v1/audience',{mode:'shared'});const denied=await request(path);assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes('missing-reference'));
 await app.shutdown();app=createLifestreamServer({config,port,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});await app.start();assert.equal((await request(path)).status,403,'restart does not revive a manual audience declaration');await request('/api/runtime/v1/audience',{mode:'solo',seconds:300});const resumed=await(await request(path)).json();assert.equal(resumed.session.endpointId,value.session.endpointId);assert.equal(resumed.session.revision,value.session.revision);assert.equal(resumed.voice.compatible,false);assert.equal(resumed.presentation.source,'neutralFallback');
});
