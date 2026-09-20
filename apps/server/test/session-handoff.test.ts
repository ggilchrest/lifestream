import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createContractValidator} from '@lifestream/contracts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {FixtureInferenceProvider} from '@lifestream/runtime/inference/fixture';

async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'ls-handoff-'));t.after(()=>rm(root,{recursive:true,force:true}));const config=loadProfile('test');config.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};config.authority.authentication='local-password';const password=randomBytes(24).toString('hex'),installerToken=randomBytes(32).toString('hex'),sessionEnvironmentId=randomUUID(),options={config,sessionEnvironmentId,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}};
 let app=createLifestreamServer(options);await app.start();t.after(()=>app.shutdown());const port=app.address().port,base=`http://127.0.0.1:${port}`;
 type Client={headers:Record<string,string>;sessionId:string;principalId:string;request:(path:string,body?:unknown,headers?:Record<string,string>)=>Promise<Response>};
 const client=async(setup=false,username='owner'):Promise<Client>=>{
  const headers:Record<string,string>={origin:base,'content-type':'application/json'};const request=(path:string,body?:unknown,extra={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const response=await request('/api/auth/v1/'+(setup?'setup':'sign-in'),{username,password,...(setup?{installerToken}:{})});assert.equal(response.status,setup?201:200);headers.cookie=response.headers.get('set-cookie')!.split(';')[0]!;const {session}=await response.json();headers['x-lifestream-csrf']=session.csrfToken;return {headers,sessionId:session.sessionId,principalId:session.principalId,request};
 };
 const source=await client(true);const created=await(await source.request('/api/admin/v1/assistants',{displayName:'Synthetic handoff Assistant'})).json(),assistantId=created.assistantId;assert.equal((await source.request(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:created.profile.profileId,expectedActiveRevision:null})).status,200);
 const configure=async(c:Client,bindingKey=randomUUID())=>{assert.equal((await c.request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey})).status,200);assert.equal((await c.request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);};await configure(source);
 const handoff=(c:Client,operation:string,extra={})=>c.request('/api/runtime/v1/handoff',{assistantId,operation,...extra});
 const inspect=(c:Client)=>c.request('/api/runtime/v1/handoff?assistantId='+assistantId);
 const ready=async(c:Client)=>{const r=await handoff(c,'ready');assert.equal(r.status,200,await r.clone().text());return r.json();};
 const prepare=async(target:Client)=>{const r=await ready(target),p=await handoff(source,'prepare',{destinationReadinessId:r.readinessId});assert.equal(p.status,200,await p.clone().text());return p.json();};
 const commit=(review:any,headers={})=>source.request(`/api/runtime/v1/sessions/${source.sessionId}/handoff`,review.request,headers);
 return {get app(){return app;},config,base,source,client,configure,assistantId,handoff,inspect,ready,prepare,commit,sessionEnvironmentId,restart:async()=>{await app.shutdown();app=createLifestreamServer({...options,port});await app.start();}};
}

test('authenticated linked-session handoff transfers bounded dialogue once and preserves destination choices',{timeout:15000},async t=>{
 const f=await fixture(t),target=await f.client();await f.configure(target);
 const response=await f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'SYNTHETIC_HANDOFF_ORCHID'});assert.equal(response.status,200);assert.match(await response.text(),/interaction.completed/);
 const sourceBefore=(f.app as any).database.connection.prepare('SELECT * FROM sessions WHERE id=?').get(f.source.sessionId),targetBefore=await(await target.request('/api/runtime/v1/session-context')).json();
 const reviewed=await f.prepare(target);assert.ok(reviewed.dialogueEntries>=1);assert.doesNotMatch(JSON.stringify(reviewed),/SYNTHETIC_HANDOFF_ORCHID/);assert.equal((await f.commit(reviewed,{'x-lifestream-csrf':'wrong'})).status,403);
 const result=await f.commit(reviewed),body=await result.json();assert.equal(result.status,200,JSON.stringify(body));assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/HandoffResponse',body).valid,true);
 assert.equal(body.result.destinationSession.conversationId,sourceBefore.conversation_id);assert.equal(body.result.destinationSession.sessionId,target.sessionId);assert.equal(body.result.destinationSession.environmentId,f.sessionEnvironmentId);assert.equal(body.result.authorization.grantsTransferred,false);assert.equal(body.result.newLease,null);
 assert.equal((await f.commit(reviewed)).status,200,'exact lost-response replay');assert.equal((await f.commit({...reviewed,request:{...reviewed.request,correlationId:randomUUID()}})).status,409);
 const after=await(await target.request('/api/runtime/v1/session-context')).json();assert.equal(after.revision,targetBefore.revision+1);assert.equal(after.endpoint.endpointId,targetBefore.endpoint.endpointId);assert.equal(after.endpoint.privacyClass,targetBefore.endpoint.privacyClass);
 for(const path of ['messages','tts','stt'])assert.equal((await f.source.request('/api/runtime/v1/'+path,{assistantId:f.assistantId,userInput:'ended'})).status,409);
 assert.equal((await f.source.request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,409);
 assert.equal((await f.handoff(target,'ready')).status,409,'transferred destination is no longer unused');
 let sections='';t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(request:any){sections=JSON.stringify(request.sections);yield {kind:'text',text:'Synthetic continued reply.'};yield {kind:'done'};});
 const continued=await target.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Continue here.'});assert.match(await continued.text(),/interaction.completed/);assert.match(sections,/SYNTHETIC_HANDOFF_ORCHID/);
 const rows=(f.app as any).database.connection.prepare('SELECT * FROM session_handoff_records').all();assert.equal(rows.length,1);assert.doesNotMatch(JSON.stringify(rows),/SYNTHETIC_HANDOFF_ORCHID/);assert.equal((f.app as any).database.connection.prepare('SELECT count(*) AS n FROM automatic_memory_work').get().n,0,'history import does not enqueue memory');
 await f.restart();await f.source.request('/api/runtime/v1/audience',{mode:'solo',seconds:300});assert.equal((await f.commit(reviewed)).status,200,'durable receipt replay after restart');await target.request('/api/runtime/v1/audience',{mode:'solo',seconds:300});sections='';await(await target.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'After restart.'})).text();assert.doesNotMatch(sections,/SYNTHETIC_HANDOFF_ORCHID/,'handoff does not silently persist raw dialogue');
});

test('handoff rejects changed privacy, busy endpoints, forged review and reused destinations',{timeout:15000},async t=>{
 const f=await fixture(t),target=await f.client();await f.configure(target);
 const same=await f.ready(f.source);assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:same.readinessId})).status,409);
 const ready=await f.ready(target);assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:randomUUID()})).status,409);assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:ready.readinessId,principalId:randomUUID()})).status,422);
 await f.handoff(target,'cancel');assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:ready.readinessId})).status,409);
 const stale=await f.prepare(target);await target.request('/api/runtime/v1/audience',{mode:'shared'});const failed=await f.commit(stale);assert.equal(failed.status,409);const failure=await failed.json();assert.equal(failure.status,'failed');assert.equal(createContractValidator().validate('https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/HandoffResponse',failure).valid,true);
 assert.equal((await(await f.source.request('/api/runtime/v1/session-context')).json()).revision,1);await target.request('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const review=await f.prepare(target),lease=(f.app as any).audioOwnership.acquire(target.sessionId,(await(await target.request('/api/runtime/v1/session-context')).json()).endpoint.endpointId,randomUUID(),new Date(Date.now()+60000).toISOString());assert.equal((await f.commit(review)).status,409);(f.app as any).audioOwnership.release(lease);
 let enter:()=>void=()=>{},release:()=>void=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});t.after(release);t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(){enter();await gate;yield {kind:'text',text:'Synthetic held turn.'};yield {kind:'done'};});
 const r=await f.ready(target),pending=f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'A held synthetic turn.'});await entered;assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:r.readinessId})).status,409);release();await(await pending).text();
 await(await target.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Destination now used.'})).text();assert.equal((await f.handoff(target,'ready')).status,409);
});

test('handoff audit failure rolls back both sessions and volatile dialogue',{timeout:15000},async t=>{
 const f=await fixture(t),target=await f.client();await f.configure(target);await(await f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'SYNTHETIC_ROLLBACK_ORCHID'})).text();const review=await f.prepare(target),db=(f.app as any).database.connection;
 db.exec("CREATE TRIGGER synthetic_handoff_failure BEFORE INSERT ON session_handoff_records BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");assert.equal((await f.commit(review)).status,503);assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get(f.source.sessionId).status,'active');assert.equal(db.prepare('SELECT revision FROM sessions WHERE id=?').get(target.sessionId).revision,1);assert.equal(db.prepare('SELECT count(*) AS n FROM session_handoff_records').get().n,0);db.exec('DROP TRIGGER synthetic_handoff_failure');
 let input='';t.mock.method(FixtureInferenceProvider.prototype,'generate',async function*(request:any){input=JSON.stringify(request.sections);yield {kind:'text',text:'Retained source.'};yield {kind:'done'};});await(await f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'Continue at source.'})).text();assert.match(input,/SYNTHETIC_ROLLBACK_ORCHID/);
 const fresh=await f.prepare(target);assert.equal((await f.commit(fresh)).status,200);
});

test('two reviewed sources cannot both commit into one destination; readiness does not survive restart',{timeout:15000},async t=>{
 const f=await fixture(t),target=await f.client(),other=await f.client();await f.configure(target);await f.configure(other);
 const r=await f.ready(target),first=await(await f.handoff(f.source,'prepare',{destinationReadinessId:r.readinessId})).json(),second=await(await f.handoff(other,'prepare',{destinationReadinessId:r.readinessId})).json();
 assert.equal((await f.commit(first)).status,200);const failed=await other.request(`/api/runtime/v1/sessions/${other.sessionId}/handoff`,second.request);assert.equal(failed.status,409);assert.equal((await failed.json()).status,'failed');assert.equal((f.app as any).database.connection.prepare('SELECT status FROM sessions WHERE id=?').get(other.sessionId).status,'active');
 const next=await f.client();await f.configure(next);const ready=await f.ready(next);await f.restart();await other.request('/api/runtime/v1/audience',{mode:'solo',seconds:300});assert.equal((await f.handoff(other,'prepare',{destinationReadinessId:ready.readinessId})).status,409);await next.request('/api/runtime/v1/audience',{mode:'solo',seconds:300});assert.equal((await(await f.inspect(next)).json()).ready,null);
});

test('handoff rechecks current administration, source dialogue and endpoint identity',{timeout:15000},async t=>{
 const f=await fixture(t),target=await f.client();await f.configure(target);const first=await f.prepare(target);await(await f.source.request('/api/runtime/v1/messages',{assistantId:f.assistantId,userInput:'A later accepted turn invalidates that review.'})).text();assert.equal((await f.commit(first)).status,409);
 const next=await f.prepare(target),session=f.source;assert.ok(session.principalId);
 assert.equal((await f.source.request('/api/auth/v1/permissions',{principalId:session.principalId,assistantId:f.assistantId,administer:false})).status,200);assert.equal((await f.commit(next)).status,403);assert.equal((await f.inspect(target)).status,422);assert.equal((f.app as any).database.connection.prepare('SELECT status FROM sessions WHERE id=?').get(f.source.sessionId).status,'active');
 assert.equal((await f.source.request('/api/auth/v1/permissions',{principalId:session.principalId,assistantId:f.assistantId,administer:true})).status,200);
 const sourceBinding=(f.app as any).database.connection.prepare('SELECT binding_key FROM endpoint_bindings WHERE endpoint_id=(SELECT endpoint_id FROM sessions WHERE id=?)').get(f.source.sessionId).binding_key;
 const sameEndpoint=await f.client();await f.configure(sameEndpoint,sourceBinding);const ready=await f.ready(sameEndpoint);assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:ready.readinessId})).status,409);
});

test('Assistant administration permission does not delegate another principal’s handoff or receipts',{timeout:15000},async t=>{
 const f=await fixture(t),guestPassword=randomBytes(24).toString('hex'),provisioned=await f.source.request('/api/auth/v1/accounts',{username:'guest',password:guestPassword});assert.equal(provisioned.status,201);const guestId=(await provisioned.json()).principalId;assert.equal((await f.source.request('/api/auth/v1/permissions',{principalId:guestId,assistantId:f.assistantId,administer:true})).status,200);
 const signed=await f.source.request('/api/auth/v1/sign-in',{username:'guest',password:guestPassword}),signedBody=await signed.json(),headers={origin:f.base,'content-type':'application/json',cookie:signed.headers.get('set-cookie')!.split(';')[0]!,'x-lifestream-csrf':signedBody.session.csrfToken};const guest={sessionId:signedBody.session.sessionId,principalId:guestId,headers,request:(path:string,body?:unknown)=>fetch(f.base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})})};await f.configure(guest);const ready=await f.ready(guest);assert.equal((await(await f.inspect(f.source)).json()).destinations.length,0);assert.equal((await f.handoff(f.source,'prepare',{destinationReadinessId:ready.readinessId})).status,409);
 const target=await f.client();await f.configure(target);const review=await f.prepare(target);assert.equal((await f.commit(review)).status,200);assert.deepEqual((await(await f.inspect(guest)).json()).records,[]);assert.equal((await guest.request(`/api/runtime/v1/sessions/${f.source.sessionId}/handoff`,review.request)).status,403);
});

test('input bodies arriving after the source ended cannot open speech or transcription',{timeout:15000},async t=>{
 const f=await fixture(t),target=await f.client();await f.configure(target);const review=await f.prepare(target),pending=[];
 for(const path of ['tts','stt']){
  let responseStatus:(status:number)=>void=()=>{},started:()=>void=()=>{};const status=new Promise<number>(r=>{responseStatus=r;}),entered=new Promise<void>(r=>{started=r;});(f.app as any).server.once('request',started);
  const request=httpRequest(f.base+'/api/runtime/v1/'+path,{method:'POST',headers:{...f.source.headers,'transfer-encoding':'chunked'}},response=>{response.resume();response.on('end',()=>responseStatus(response.statusCode!));});request.on('error',()=>responseStatus(0));t.after(()=>request.destroy());request.flushHeaders();await entered;pending.push({request,status});
 }
 assert.equal((await f.commit(review)).status,200);for(const {request,status} of pending){request.end(JSON.stringify({text:'Late speech.',audioInputId:randomUUID(),frames:[{sampleCount:1}]}));assert.equal(await status,409);}
});
