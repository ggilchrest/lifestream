import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {GAME_HOST_PROTOCOL as protocol,gameHostDigest} from '@lifestream/contracts/game-host';
import {ActivityCheckpointRepository} from '../../../packages/storage-sqlite/src/game-activity.ts';
import {scriptedGameBounds} from '../../../packages/runtime/test/fixtures/game-policy.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {fixture} from './fixtures/game-host.ts';
import type {GameHostOptions,GameHostJoin} from '../src/runtime/game-host-port.ts';
const secret=()=>`synthetic-${randomBytes(24).toString('hex')}`;
async function setup(t:import('node:test').TestContext,enabled=true){
 const root=await mkdtemp(join(tmpdir(),'ls-host-http-'));t.after(()=>rm(root,{recursive:true,force:true}));let now=Date.now(),qualified=true,hostJoin:GameHostJoin|undefined;const environmentId=randomUUID(),installerToken=secret();
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const gameHost:GameHostOptions={maxAttachments:2,maxDurationMs:10000,createRepository:database=>new ActivityCheckpointRepository(database,{maxRuns:4,maxReservations:8,maxControllerReservations:8,maxCheckpointBytes:32768,scopeCurrent:()=>qualified,quarantined:()=>false,policyFor:()=>({enabled:true,revision:1,retentionMs:3600000,bounds:structuredClone(scriptedGameBounds)}),allowCreate:()=>true,checkpointCurrent:()=>qualified,transitionCurrent:()=>true,planningCurrent:()=>qualified,usageCurrent:()=>qualified,controllerCurrent:()=>qualified,controllerUsageCurrent:()=>qualified}),resolveAttachment:(_actor,metadata)=>{const {protocol:_,...binding}=metadata;return qualified?binding:null;},bindingCurrent:()=>qualified,controllerCurrent:()=>qualified,boundary:{sourceAvailable:()=>qualified,acceptAction:()=>qualified,acceptObservation:()=>qualified}};
 gameHost.onAttached=value=>hostJoin=value;
 const app=createLifestreamServer({config,sessionEnvironmentId:environmentId,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now},audiencePrivacy:{sourceIds:[]},...(enabled?{gameHost}:{})});await app.start();t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const request=(path:string,input:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
 const enrollment=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:secret(),installerToken});assert.equal(enrollment.status,201);headers.cookie=enrollment.headers.get('set-cookie')!.split(';')[0]!;const {session}=await enrollment.json() as {session:{principalId:string;sessionId:string;csrfToken:string}};headers['x-lifestream-csrf']=session.csrfToken;
 assert.equal((await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);assert.equal((await request('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
 const created=await request('/api/admin/v1/assistants',{displayName:'Synthetic Host Fixture'});assert.equal(created.status,201);const {assistantId}=await created.json() as {assistantId:string};const relationshipResponse=await request(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relationshipResponse.status,201);const {relationship}=await relationshipResponse.json() as {relationship:{relationshipId:string}};
 const stored=app.database.connection.prepare('SELECT conversation_id,endpoint_id FROM sessions WHERE id=?').get(session.sessionId)!;
 const f=fixture({database:app.database,scope:{assistantId,principalId:session.principalId,relationshipId:relationship.relationshipId,environmentId,contextBinding:{conversationId:stored.conversation_id as string,sessionId:session.sessionId,endpointId:stored.endpoint_id as string,participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef:'synthetic-current-permission'}}});
 const metadata={protocol,hostId:randomUUID(),scope:f.input.request.scope,pinsDigest:f.input.request.payload.expectedPinsDigest,providerRef:'scripted:guarded',sourceRevision:'b'.repeat(64)},path='/api/runtime/v1/game-host/';
 return {app,headers,request,metadata,path,f,session,hostJoin:()=>hostJoin!,now:(value:number)=>now=value,advance:(ms:number)=>now+=ms,withdraw:()=>qualified=false};
}
test('host HTTP is disabled by default even for an existing authenticated owner',async t=>{const s=await setup(t,false),response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'game_host_disabled'});assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);});
test('chunked HTTP ingress applies the byte cap before JSON parsing and remains usable',async t=>{
 const s=await setup(t),url=`http://127.0.0.1:${s.app.address().port}${s.path}attach`;
 const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(url,{method:'POST',headers:s.headers},response=>{response.resume();response.once('end',()=>resolve(response.statusCode!));});req.once('error',reject);req.write('x'.repeat(70000));req.end('x'.repeat(70000));});assert.equal(status,413);assert.equal((await s.request(s.path+'attach',s.metadata)).status,200);assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);
});
test('host HTTP uses real local auth, strict origin/CSRF, closed bounds and owned actor/session/endpoint/relationship',async t=>{
 const s=await setup(t);assert.equal((await s.request(s.path+'attach',s.metadata,{cookie:''})).status,401);assert.equal((await s.request(s.path+'attach',s.metadata,{origin:'https://synthetic-invalid.example'})).status,403);assert.equal((await s.request(s.path+'attach',s.metadata,{'x-lifestream-csrf':'synthetic-wrong'})).status,403);
 assert.equal((await s.request(s.path+'attach',{...s.metadata,scope:{...s.metadata.scope,principalId:randomUUID()}})).status,403);assert.equal((await s.request(s.path+'attach',{...s.metadata,scope:{...s.metadata.scope,relationshipId:randomUUID()}})).status,403);assert.equal((await s.request(s.path+'attach',{...s.metadata,scope:{...s.metadata.scope,contextBinding:{...s.metadata.scope.contextBinding,endpointId:randomUUID()}}})).status,403);
 assert.equal((await s.request(s.path+'attach',{...s.metadata,credential:'synthetic'})).status,400);assert.equal((await s.request(s.path+'attach',{...s.metadata,extra:'x'.repeat(131072)})).status,413);
 const response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const attached=await response.json() as {attachmentId:string};assert.equal((await s.request(s.path+'attach',s.metadata)).status,409);
 const activity=s.app.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(s.session.sessionId)!.admin_last_activity;
 s.advance(1_800_000);assert.equal((await s.request(s.path+'next',{protocol,attachmentId:attached.attachmentId})).status,200);assert.equal(s.app.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(s.session.sessionId)!.admin_last_activity,activity);assert.equal((await s.request(s.path+'attach',{...s.metadata,hostId:randomUUID()})).status,401);
 assert.equal((await s.request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await s.request(s.path+'next',{protocol,attachmentId:attached.attachmentId})).status,401);
});
for(const changed of ['permission','endpoint','relationship','source'] as const)test('host HTTP fences '+changed+' withdrawal without native dispatch',async t=>{
 const s=await setup(t),response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200);const attached=await response.json() as {attachmentId:string};
 if(changed==='permission')s.app.database.connection.prepare('UPDATE local_assistant_permissions SET administer=0 WHERE principal_id=? AND assistant_id=?').run(s.session.principalId,s.metadata.scope.assistantId);
 if(changed==='endpoint')assert.equal((await s.request('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'})).status,200);
 if(changed==='relationship')s.app.database.connection.prepare('UPDATE assistant_relationships SET payload_json=? WHERE relationship_id=?').run(JSON.stringify({status:'skipped'}),s.metadata.scope.relationshipId);
 if(changed==='source')s.withdraw();
 assert.ok([403,410].includes((await s.request(s.path+'next',{protocol,attachmentId:attached.attachmentId})).status));assert.equal(s.app.database.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);
});
for(const completed of [true,false])test('authenticated HTTP prepared controller '+(completed?'settles qualified receipt':'retains entered reservation after sign-out'),async t=>{
 const s=await setup(t);const response=await s.request(s.path+'attach',s.metadata);assert.equal(response.status,200);const attachment=await response.json() as {attachmentId:string};
 const pending=s.hostJoin().runController(s.f.input,{signal:s.f.controller.signal,current:s.f.ports.current,usageFor:s.f.ports.usageFor});
 const next=await s.request(s.path+'next',{protocol,attachmentId:attachment.attachmentId});assert.equal(next.status,200);const event=await next.json() as import('@lifestream/contracts/game-host').GameHostCommand;assert.equal(event.kind,'command');assert.equal(s.app.database.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state,'claimed');
 const admission={protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest};assert.equal((await s.request(s.path+'admit',admission)).status,200);assert.equal((await s.request(s.path+'admit',admission)).status,409);
 if(completed){const result=await s.f.rawAdapter.applyController(event.request as never);assert.equal((await s.request(s.path+'result',{...admission,result,resultDigest:gameHostDigest(result)})).status,200);assert.equal((await pending).state,'settled');}
 else{assert.equal((await s.request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await s.request(s.path+'admit',admission)).status,401);assert.equal((await pending).state,'requiresReconciliation');assert.equal(s.app.database.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');assert.equal(s.f.calls(),0);}
});
