// Real original host owners and temporary local account state; no production inputs.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from '@lifestream/storage-sqlite';
import {createLifestreamServer} from '../dist/index.js';
import {loadProfile} from '../dist/config/loader.js';
import {LocalAuthentication} from '../dist/auth/local-auth.js';
import {readSessionEndpoint,reviseSessionEndpoint} from '../dist/runtime/session-context.js';
const secret=()=> 'Synthetic-'+randomBytes(24).toString('hex');
const path='/api/auth/v1/daily-session';
async function fixture(endpointClass='desktopCompanion'){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'daily-session-http-'));chmodSync(root,0o700);const mask=process.umask(0o077);let now=Date.now();
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now}});await app.start();const base=`http://127.0.0.1:${app.address().port}`;let cookie='',csrf='',reference='';
 const request=(route:string,body?:unknown,headers:Record<string,string>={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json',cookie,'x-lifestream-csrf':csrf,...(reference?{'x-lifestream-user-context':reference}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
 const setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password:secret(),installerToken});assert.equal(setup.status,201);cookie=setup.headers.get('set-cookie')!.split(';')[0]!;const {session}=await setup.json();csrf=session.csrfToken;
 const current=await(await request('/api/auth/v1/user-context')).json();reference=current.contextRef;
 const selected=await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass,bindingKey:randomUUID()});assert.equal(selected.status,200);
 const internal=app as unknown as {database:Database;localAuth:LocalAuthentication;durableConversationRepository?:unknown};
 return {app,base,session,internal,request,advance:(ms:number)=>{now+=ms;},reference:()=>reference,setReference:(value:string)=>{reference=value;},current:async()=>{const response=await fetch(base+'/api/auth/v1/user-context',{headers:{origin:base,cookie},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);return response.json();},close:async()=>{await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});}};
}

test('aged self Daily bootstrap is read-only and remains available under real Lock while original administration stays expired',async()=>{
 const f=await fixture();try{
  const before=await(await f.request('/api/auth/v1/session')).json(),activity=f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity;
  const state=await(await f.request('/api/runtime/v1/audience/personal-session')).json();assert.equal(state.privateAllowed,false);
  f.advance(31*60*1000);assert.equal((await f.request('/api/auth/v1/session')).status,403);
  const response=await f.request(path);assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);const value=await response.json();assert.deepEqual(Object.keys(value).sort(),['adminExpiresAt','csrfToken','owner','principalId','sessionId']);assert.deepEqual(value,before);
  assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity,activity);assert.equal(f.internal.durableConversationRepository,undefined);
  assert.equal((await f.request('/api/admin/v1/assistants',{displayName:'Must stay privileged'})).status,403);assert.throws(()=>f.internal.localAuth.isSystemAdministrator(f.internal.localAuth.hostSessionContext(f.session.sessionId)),(error:any)=>error.status===403&&error.code==='administration_freshness_required');
  assert.equal((await f.request(path,{})).status,405);assert.equal((await f.request(path+'?other='+randomUUID())).status,422);assert.equal((await f.request(path,undefined,{origin:'https://wrong.example'})).status,403);assert.equal((await f.request(path,undefined,{'x-lifestream-user-context':randomUUID()})).status,409);
  const selected=readSessionEndpoint(f.internal.database,f.session.sessionId),locked=await f.request('/api/runtime/v1/audience/personal-session',{operation:'lock',operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:state.revision,expectedPersonalSessionEpoch:state.personalSessionEpoch,expectedSessionRevision:selected.revision,endpointId:selected.endpoint!.endpointId,expectedEndpointRevision:selected.endpoint!.configurationRevision});assert.equal(locked.status,200);assert.equal((await f.request(path)).status,200);
  assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);assert.equal((await f.request(path)).status,401);
 }finally{await f.close();}
});

test('Daily fallback denies foreign endpoint custody and nonpersonal lanes without changing original fresh Console session',async()=>{
 for(const endpointClass of ['desktopCompanion','personalCompanion']){const f=await fixture(endpointClass);try{
  assert.equal((await f.request('/api/auth/v1/session')).status,200);
  if(endpointClass==='personalCompanion'){assert.equal((await f.request(path)).status,403);continue;}
  assert.equal((await f.request(path)).status,200);const selected=readSessionEndpoint(f.internal.database,f.session.sessionId);f.internal.database.connection.prepare('DELETE FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').run(f.session.principalId,selected.endpoint!.endpointId);assert.equal((await f.request(path)).status,403);assert.equal((await f.request('/api/auth/v1/session')).status,200);
 }finally{await f.close();}}
});

test('fresh original act-as bootstrap remains available, while Daily denies proxy and expired old references and admits only the new current self reference',async()=>{
 const f=await fixture();try{
  const created=await f.request('/api/auth/v1/accounts',{username:'synthetic-target',password:secret()});assert.equal(created.status,201);const member=await created.json(),auth=f.internal.localAuth,initial=auth.hostSessionContext(f.session.sessionId);
  auth.effectiveSubjects.execute(initial,{schemaVersion:'1.0.0',operation:'startContext',operationId:randomUUID(),expectedGeneration:initial.effectiveContext!.generation,payload:{targetUserId:member.principalId}});
  const acting=await f.current();assert.equal(acting.impersonating,true);f.setReference(acting.contextRef);assert.equal((await f.request('/api/auth/v1/session')).status,200);assert.equal((await f.request(path)).status,403);
  f.advance(31*60*1000);assert.equal((await f.request('/api/auth/v1/session')).status,403);assert.equal((await f.request(path)).status,409);const returned=await f.current();assert.equal(returned.impersonating,false);assert.equal(returned.context.effectiveUserId,f.session.principalId);assert.notEqual(returned.contextRef,acting.contextRef);f.setReference(returned.contextRef);const restored=await f.request(path);assert.equal(restored.status,200);assert.equal((await restored.json()).principalId,f.session.principalId);
 }finally{await f.close();}
});

test('final original Csrf source callback cannot publish bootstrap after actual endpoint revision changes',async()=>{
 const f=await fixture(),auth=f.internal.localAuth,renew=auth.renewCsrf;try{
  auth.renewCsrf=function(context,administration){const token=renew.call(this,context,administration),selected=readSessionEndpoint(f.internal.database,f.session.sessionId);reviseSessionEndpoint(f.internal.database,f.session.sessionId,{expectedRevision:selected.revision,mode:'text',audienceScope:'unknown'},true,f.session.principalId);return token;};
  assert.equal((await f.request(path)).status,403);
 }finally{auth.renewCsrf=renew;await f.close();}
});
