// Actual source launcher owners and local-password HTTP cookies; disposable data only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Database} from '@lifestream/storage-sqlite';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import type {LocalAuthentication} from '../src/auth/local-auth.ts';
import {readSessionEndpoint} from '../src/runtime/session-context.ts';

const route='/api/runtime/v1/daily-startup',secret=()=> 'Synthetic-'+randomBytes(24).toString('hex');
const privateName='PRIVATE_BOOTSTRAP_ASSISTANT_SENTINEL';
async function fixture(){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'daily-bootstrap-regression-'));chmodSync(root,0o700);const mask=process.umask(0o077);let now=Date.now();
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),password=secret(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now}});
 try{
  await app.start();const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
  const request=(path:string,body?:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  const setup=await request('/api/auth/v1/setup',{username:'synthetic-bootstrap',password,installerToken});assert.equal(setup.status,201);const setupSession=(await setup.json()).session;
  headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=setupSession.csrfToken;
  const created=await request('/api/admin/v1/assistants',{displayName:privateName});assert.equal(created.status,201);const assistant=await created.json();assert.equal((await request(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null})).status,200);
  assert.equal((await request('/api/auth/v1/sign-out',{})).status,200);
  const signed=await request('/api/auth/v1/sign-in',{username:'synthetic-bootstrap',password});assert.equal(signed.status,200);const session=(await signed.json()).session;
  headers.cookie=signed.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=session.csrfToken;
  assert.notEqual(session.sessionId,setupSession.sessionId);
  const envelope=await request('/api/auth/v1/user-context');assert.equal(envelope.status,200);headers['x-lifestream-user-context']=(await envelope.json()).contextRef;
  const internal=app as unknown as {database:Database;localAuth:LocalAuthentication;durableConversationRepository?:unknown};
  const snapshot=()=>({changes:internal.database.connection.prepare('SELECT total_changes() AS count').get()!.count,session:internal.database.connection.prepare('SELECT * FROM local_sessions WHERE session_id=?').get(session.sessionId),endpoint:readSessionEndpoint(internal.database,session.sessionId),bindings:internal.database.connection.prepare('SELECT * FROM endpoint_bindings ORDER BY principal_id,binding_key').all(),endpointCount:internal.database.connection.prepare('SELECT COUNT(*) AS count FROM interaction_endpoints').get()!.count,sessionCount:internal.database.connection.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count,historyOwner:internal.durableConversationRepository});
  const select=async(audienceScope='authenticatedSession',endpointClass='desktopCompanion')=>{const current=readSessionEndpoint(internal.database,session.sessionId);const response=await request('/api/runtime/v1/session-context',{expectedRevision:current.revision,mode:'text',audienceScope,endpointClass,bindingKey:randomUUID()});assert.equal(response.status,200);return response.json();};
  const privacy=async()=>{const response=await request('/api/runtime/v1/audience/personal-session');assert.equal(response.status,200);return response.json();};
  const declare=async(operation:'lock'|'unlock')=>{const p=await privacy(),selected=readSessionEndpoint(internal.database,session.sessionId);const response=await request('/api/runtime/v1/audience/personal-session',{operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:p.revision,expectedPersonalSessionEpoch:p.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint!.endpointId,expectedEndpointRevision:selected.endpoint!.configurationRevision});assert.equal(response.status,200);return response.json();};
  return {app,base,headers,request,session,assistant,internal,snapshot,select,privacy,declare,age:()=>{now+=31*60*1000;},close:async()=>{await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});}};
 }catch(error){await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}
function assertProtected(value:any,assistant:any){
 assert.equal(value.schemaVersion,'1.0.0');assert.equal(value.privateAllowed,false);assert.equal(value.protected,true);assert.equal(value.assistant,null);assert.deepEqual(value.relationships,[]);assert.equal(value.endpointConfiguration,null);assert.deepEqual(value.selection,{status:'unavailable',assistantId:null});
 assert.equal(value.session.conversation,null);assert.equal(value.session.selectedConversation,null);assert.equal(value.session.conversationId,null);assert.equal(value.session.ended,false);
 assert.doesNotMatch(JSON.stringify(value),new RegExp(privateName+'|'+assistant.assistantId+'|'+assistant.profile.profileId));
}
async function protected200(f:Awaited<ReturnType<typeof fixture>>){const before=f.snapshot(),response=await f.request(route);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('set-cookie'),null);const value=await response.json();assertProtected(value,f.assistant);assert.deepEqual(f.snapshot(),before,'Protected bootstrap must perform no DB writes, endpoint allocation, history initialization or admin refresh');return value;}

test('fresh real sign-in with no endpoint returns read-only protected revision-zero startup, including after admin expiry',async()=>{
 const f=await fixture();try{
  assert.deepEqual(readSessionEndpoint(f.internal.database,f.session.sessionId),{revision:0,endpoint:null});
  for(const aged of [false,true]){if(aged)f.age();const value=await protected200(f);assert.equal(value.session.revision,0);assert.equal(value.session.contextGeneration,0);assert.equal(value.session.endpoint,null);assert.equal(value.session.shellPreferenceScope.scope,null);}
  assert.equal((await f.request('/api/auth/v1/session')).status,403);assert.equal(f.internal.durableConversationRepository,undefined);
  const beforeSession=f.snapshot(),ordinary=await f.request('/api/auth/v1/daily-session');assert.equal(ordinary.status,200);assert.equal(ordinary.headers.get('set-cookie'),null);
  const recovered=await ordinary.json();assert.deepEqual(Object.keys(recovered).sort(),['adminExpiresAt','csrfToken','owner','principalId','sessionId']);assert.equal(recovered.sessionId,f.session.sessionId);assert.equal(recovered.principalId,f.session.principalId);assert.equal(recovered.adminExpiresAt,f.session.adminExpiresAt);assert.deepEqual(f.snapshot(),beforeSession,'Session recovery cannot create endpoints, unlock, write history or refresh administration');
  assert.equal((await f.request('/api/runtime/v1/daily-context')).status,403,'The metadata-only startup exception cannot relax private APIs');
  assert.equal((await f.request('/api/runtime/v1/daily-library?assistantId='+f.assistant.assistantId)).status,403);
 }finally{await f.close();}
});

test('unbound bootstrap still rejects bad cookies, foreign origins and genuinely revoked sessions',async()=>{
 const f=await fixture();try{
  const before=f.snapshot();for(const path of [route,'/api/auth/v1/daily-session']){assert.equal((await f.request(path,undefined,{cookie:''})).status,401);assert.equal((await f.request(path,undefined,{cookie:'lifestream_'+f.app.address().port+'=invalid'})).status,401);assert.equal((await f.request(path,undefined,{origin:'https://wrong.invalid'})).status,403);}assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);const revoked=f.snapshot();for(const path of [route,'/api/auth/v1/daily-session'])assert.equal((await f.request(path)).status,401);assert.deepEqual(f.snapshot(),revoked);
 }finally{await f.close();}
});

test('a current fresh proxy with no endpoint cannot use the self-only protected bootstrap exception',async()=>{
 const f=await fixture();try{
  const created=await f.request('/api/auth/v1/accounts',{username:'bootstrap-target',password:secret()});assert.equal(created.status,201);const target=await created.json(),auth=f.internal.localAuth,actor=auth.hostSessionContext(f.session.sessionId);
  auth.effectiveSubjects.execute(actor,{schemaVersion:'1.0.0',operation:'startContext',operationId:randomUUID(),expectedGeneration:actor.effectiveContext!.generation,payload:{targetUserId:target.principalId}});
  const envelope=await fetch(f.base+'/api/auth/v1/user-context',{headers:{origin:f.base,cookie:f.headers.cookie},signal:AbortSignal.timeout(5000)});assert.equal(envelope.status,200);f.headers['x-lifestream-user-context']=(await envelope.json()).contextRef;
  const before=f.snapshot();const response=await f.request(route);assert.equal(response.status,403);assert.doesNotMatch(await response.text(),new RegExp(privateName));assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.request('/api/auth/v1/daily-session')).status,403,'Content-free self session recovery cannot admit a proxy');assert.deepEqual(f.snapshot(),before);
 }finally{await f.close();}
});

test('a bound Withhold endpoint returns protected startup without exposing private Assistant metadata',async()=>{
 const f=await fixture();try{const selected=await f.select('unknown');f.age();const value=await protected200(f);assert.equal(value.session.revision,selected.revision);assert.equal(value.session.endpoint.endpointId,selected.endpoint.endpointId);assert.equal(value.session.endpoint.privacyClass,'public');const before=f.snapshot();assert.equal((await f.request('/api/auth/v1/daily-session')).status,200);assert.deepEqual(f.snapshot(),before);assert.equal((await f.request('/api/runtime/v1/daily-context')).status,403);}finally{await f.close();}
});

for(const custody of ['missing','foreign'] as const)test(`protected bootstrap cannot waive ${custody} endpoint ownership`,async()=>{
 const f=await fixture();try{
  const selected=await f.select('unknown');
  if(custody==='missing')f.internal.database.connection.prepare('DELETE FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').run(f.session.principalId,selected.endpoint.endpointId);
  else{const response=await f.request('/api/auth/v1/accounts',{username:'foreign-endpoint-owner',password:secret()});assert.equal(response.status,201);const target=await response.json();f.internal.database.connection.prepare('UPDATE endpoint_bindings SET principal_id=? WHERE principal_id=? AND endpoint_id=?').run(target.principalId,f.session.principalId,selected.endpoint.endpointId);}
  const before=f.snapshot(),response=await f.request(route);assert.equal(response.status,403);assert.doesNotMatch(await response.text(),new RegExp(privateName));assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.request('/api/auth/v1/daily-session')).status,403);assert.deepEqual(f.snapshot(),before);
 }finally{await f.close();}
});

test('Lock masks an existing private endpoint; Unlock preserves the normal active-Assistant startup',async()=>{
 const f=await fixture();try{
  const selected=await f.select();assert.equal((await f.declare('lock')).privateAllowed,false);const initial=await protected200(f);assert.equal(initial.session.endpoint.endpointId,selected.endpoint.endpointId);
  assert.equal((await f.declare('unlock')).privateAllowed,true);const before=f.snapshot(),response=await f.request(route);assert.equal(response.status,200);const value=await response.json();assert.equal(value.privateAllowed,true);assert.equal(value.protected,false);assert.equal(value.selection.status,'singleActiveAssistant');assert.equal(value.assistant.assistantId,f.assistant.assistantId);assert.equal(value.assistant.profiles[0].status,'active');assert.equal(value.endpointConfiguration.readOnly,true);assert.equal(value.session.endpoint.endpointId,selected.endpoint.endpointId);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.declare('lock')).privateAllowed,false);await protected200(f);
 }finally{await f.close();}
});

test('non-Daily endpoint classes remain outside the protected startup exception',async()=>{
 const f=await fixture();try{await f.select('unknown','personalCompanion');const before=f.snapshot();assert.equal((await f.request(route)).status,403);assert.equal((await f.request('/api/auth/v1/daily-session')).status,403);assert.deepEqual(f.snapshot(),before);}finally{await f.close();}
});
