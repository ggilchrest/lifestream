// Real local-password HTTP cookies, fresh synthetic state and synthetic package only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import type {Server} from 'node:http';
import type {Database} from '@lifestream/storage-sqlite';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import type {LocalAuthentication} from '../src/auth/local-auth.ts';
import {readSessionEndpoint,reviseSessionEndpoint} from '../src/runtime/session-context.ts';

const route='/api/runtime/v1/presentation',secret=()=> 'Synthetic-'+randomBytes(24).toString('hex');
async function fixture(endpointClass='desktopCompanion'){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'daily-auth-appearance-'));chmodSync(root,0o700);const mask=process.umask(0o077);let now=Date.now();
 const catalog=join(root,'catalog'),pack=join(catalog,'synthetic-appearance');mkdirSync(pack,{recursive:true});
 const bytes=Buffer.from(JSON.stringify({asset:{version:'2.0'},scenes:[{nodes:[0]}],nodes:[{name:'Synthetic'}],scene:0}));
 writeFileSync(join(pack,'model.gltf'),bytes);writeFileSync(join(catalog,'index.json'),JSON.stringify(['synthetic-appearance']));
 writeFileSync(join(pack,'manifest.json'),JSON.stringify({schemaVersion:'1.0.0',id:'synthetic-appearance',version:'1',label:'Synthetic appearance',renderer:'three-glb.v1',model:'model.gltf',resources:[{path:'model.gltf',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime:'model/gltf+json'}],framing:{distance:1.2,targetHeight:.5},animations:{},capabilities:{lipSync:'none',facialAnimation:false},fallback:'neutral'}));
 const config=loadProfile('test');config.authority.authentication='local-password';config.storage={databasePath:join(root,'test.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=secret(),password=secret(),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken,now:()=>now},presentationPackages:{directory:catalog}});
 try{
  await app.start();const base=`http://127.0.0.1:${app.address().port}`,headers:Record<string,string>={origin:base,'content-type':'application/json'};
  const request=(path:string,body?:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
  const setup=await request('/api/auth/v1/setup',{username:'synthetic-owner',password,installerToken});assert.equal(setup.status,201);const {session}=await setup.json();
  headers.cookie=setup.headers.get('set-cookie')!.split(';')[0]!;headers['x-lifestream-csrf']=session.csrfToken;
  const current=await(await request('/api/auth/v1/user-context')).json();headers['x-lifestream-user-context']=current.contextRef;
  const selected=await request('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',endpointClass,bindingKey:randomUUID()});assert.equal(selected.status,200);const initial=await selected.json();
  const privacy=async()=>{const response=await request('/api/runtime/v1/audience/personal-session');assert.equal(response.status,200);return response.json();};
  const command=(p:any,operation:'lock'|'unlock')=>({operation,operationId:randomUUID(),declarationId:randomUUID(),expectedAudienceRevision:p.revision,expectedPersonalSessionEpoch:p.personalSessionEpoch,expectedSessionRevision:initial.revision,endpointId:initial.endpoint.endpointId,expectedEndpointRevision:initial.endpoint.configurationRevision});
  if(endpointClass==='desktopCompanion')assert.equal((await request('/api/runtime/v1/audience/personal-session',command(await privacy(),'unlock'))).status,200);
  const listed=await(await request(route)).json();assert.equal(listed.packages.length,1);const item=listed.packages[0];
  const internal=app as unknown as {database:Database;localAuth:LocalAuthentication;server:Server};
  const snapshot=()=>internal.database.connection.prepare('SELECT * FROM presentation_selections ORDER BY principal_id,endpoint_id,scope_id').all();
  return {app,base,headers,request,session,initial,internal,privacy,command,snapshot,selection:(revision=0)=>({scope:'session',id:item.id,digest:item.digest,expectedRevision:revision}),age:()=>{now+=31*60*1000;},close:async()=>{await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});}};
 }catch(error){await app.shutdown();process.umask(mask);rmSync(root,{recursive:true,force:true});throw error;}
}

test('aged same-origin cookie saves and clears own appearance without extending administrator freshness',async()=>{
 const f=await fixture();try{
  const token=f.headers.cookie,activity=f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity;
  f.age();assert.equal((await f.request('/api/auth/v1/session')).status,403);assert.equal((await f.request('/api/auth/v1/daily-session')).status,200);
  const selected=await f.request(route,f.selection());assert.equal(selected.status,200);assert.equal(selected.headers.get('set-cookie'),null);assert.equal((await selected.json()).selection.override.id,'synthetic-appearance');
  const clear=await f.request(route,{operation:'clearSessionOverride',expectedRevision:1});assert.equal(clear.status,200);const value=await clear.json();assert.equal(value.selection.override,null);assert.equal(value.selection.overrideRevision,2);
  assert.equal(f.headers.cookie,token);assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity,activity);
  assert.equal((await f.request('/api/admin/v1/assistants',{displayName:'Must remain privileged'})).status,403);
  assert.equal((await f.request('/api/auth/v1/session')).status,403);
 }finally{await f.close();}
});

test('aged appearance still enforces cookie, origin, CSRF, package digest and revision',async()=>{
 const f=await fixture();try{
  f.age();const before=f.snapshot();
  assert.equal((await f.request(route,f.selection(),{cookie:''})).status,401);
  assert.equal((await f.request(route,f.selection(),{origin:'https://wrong.invalid'})).status,403);
  assert.equal((await f.request(route,f.selection(),{'x-lifestream-csrf':'wrong'})).status,403);
  assert.equal((await f.request(route,{...f.selection(),digest:'0'.repeat(64)})).status,409);
  assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.request(route,f.selection())).status,200);
  const saved=f.snapshot();assert.equal((await f.request(route,f.selection())).status,409);assert.deepEqual(f.snapshot(),saved);
 }finally{await f.close();}
});

test('appearance rejects effective-other and stale reference without changing actor or target selections',async()=>{
 const f=await fixture();try{
  const created=await f.request('/api/auth/v1/accounts',{username:'synthetic-target',password:secret()});assert.equal(created.status,201);const target=await created.json(),auth=f.internal.localAuth,actor=auth.hostSessionContext(f.session.sessionId),oldReference=f.headers['x-lifestream-user-context'];
  auth.effectiveSubjects.execute(actor,{schemaVersion:'1.0.0',operation:'startContext',operationId:randomUUID(),expectedGeneration:actor.effectiveContext!.generation,payload:{targetUserId:target.principalId}});
  const envelope=await(await fetch(f.base+'/api/auth/v1/user-context',{headers:{origin:f.base,cookie:f.headers.cookie},signal:AbortSignal.timeout(5000)})).json();
  f.headers['x-lifestream-user-context']=envelope.contextRef;const before=f.snapshot();
  const acting=await f.request(route,f.selection());assert.equal(acting.status,403);assert.equal((await acting.json()).code,'appearance_self_required');
  assert.equal((await f.request(route,f.selection(),{'x-lifestream-user-context':oldReference})).status,409);assert.deepEqual(f.snapshot(),before);
 }finally{await f.close();}
});

test('aged appearance cannot disclose or select a private package after Lock or endpoint custody loss',async()=>{
 const f=await fixture();try{
  f.age();const before=f.snapshot(),locked=await f.request('/api/runtime/v1/audience/personal-session',f.command(await f.privacy(),'lock'));assert.equal(locked.status,200);
  const catalog=await f.request(route);assert.equal(catalog.status,200);assert.deepEqual((await catalog.json()).packages,[]);
  assert.notEqual((await f.request(route,f.selection())).status,200);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.request('/api/runtime/v1/audience/personal-session',f.command(await f.privacy(),'unlock'))).status,200);
  assert.equal((await f.privacy()).privateAllowed,true);
  f.internal.database.connection.prepare('DELETE FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').run(f.session.principalId,f.initial.endpoint.endpointId);
  assert.notEqual((await f.request(route,f.selection())).status,200);assert.deepEqual(f.snapshot(),before);
 }finally{await f.close();}
});

for(const invalidate of ['logout','revoke','endpointRevision','expiryCustody'] as const)test(`pending aged appearance body is fenced after ${invalidate}`,async()=>{
 const f=await fixture();let send:ReturnType<typeof httpRequest>|undefined;try{
  if(invalidate!=='expiryCustody')f.age();
  const before=f.snapshot(),body=JSON.stringify(invalidate==='expiryCustody'?{scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0}:f.selection());let observed!:()=>void;const received=new Promise<void>(resolve=>{observed=resolve;});
  f.internal.server.once('request',request=>request.once('data',observed));
  const result=new Promise<number>((resolve,reject)=>{send=httpRequest(f.base+route,{method:'POST',headers:{...f.headers,'content-length':String(Buffer.byteLength(body))}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});send.on('error',reject);});
  send!.write(body.slice(0,10));await received;
  if(invalidate==='logout')assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);
  else if(invalidate==='revoke')f.internal.localAuth.logout(f.internal.localAuth.hostSessionContext(f.session.sessionId));
  else if(invalidate==='expiryCustody'){f.age();f.internal.database.connection.prepare('DELETE FROM endpoint_bindings WHERE principal_id=? AND endpoint_id=?').run(f.session.principalId,f.initial.endpoint.endpointId);}
  else{const current=readSessionEndpoint(f.internal.database,f.session.sessionId);reviseSessionEndpoint(f.internal.database,f.session.sessionId,{expectedRevision:current.revision,mode:'text',audienceScope:'unknown'},true,f.session.principalId);}
  send!.end(body.slice(10));assert.notEqual(await result,200);assert.deepEqual(f.snapshot(),before);
  if(invalidate==='logout'||invalidate==='revoke')assert.equal((await f.request('/api/auth/v1/daily-session')).status,401);
 }finally{send?.destroy();await f.close();}
});


test('fresh non-Daily appearance request cannot carry administrator permission across expiry during its body',async()=>{
 const f=await fixture('personalCompanion');let send:ReturnType<typeof httpRequest>|undefined;try{
  assert.equal((await f.request('/api/auth/v1/session')).status,200);
  const before=f.snapshot(),body=JSON.stringify({scope:'session',id:'neutral',digest:'neutral-v1',expectedRevision:0});let observed!:()=>void;const received=new Promise<void>(resolve=>{observed=resolve;});
  f.internal.server.once('request',request=>request.once('data',observed));
  const result=new Promise<number>((resolve,reject)=>{send=httpRequest(f.base+route,{method:'POST',headers:{...f.headers,'content-length':String(Buffer.byteLength(body))}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});send.on('error',reject);});
  send!.write(body.slice(0,10));await received;f.age();send!.end(body.slice(10));
  assert.notEqual(await result,200);assert.deepEqual(f.snapshot(),before);assert.equal((await f.request('/api/auth/v1/session')).status,403);
 }finally{send?.destroy();await f.close();}
});

const settingsRoute='/api/runtime/v1/session-context';
const settingsSnapshot=(f:Awaited<ReturnType<typeof fixture>>)=>({session:f.internal.database.connection.prepare('SELECT * FROM sessions WHERE id=?').get(f.session.sessionId),settings:f.internal.database.connection.prepare('SELECT * FROM session_endpoint_settings WHERE session_id=?').get(f.session.sessionId)});

test('aged self Session Save changes only ordinary settings and preserves expired administrator activity',async()=>{
 const f=await fixture();try{
  const activity=f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity;
  f.age();const save=await f.request(settingsRoute,{expectedRevision:f.initial.revision,mode:'text',audienceScope:'unknown'});assert.equal(save.status,200);const value=await save.json();assert.equal(value.revision,f.initial.revision+1);assert.equal(value.endpoint.privacyClass,'public');assert.equal(save.headers.get('set-cookie'),null);
  assert.equal((await f.request('/api/runtime/v1/audience/personal-session')).status,403,'Public disclosure cannot expose the personal-session owner');
  const restore=await f.request(settingsRoute,{expectedRevision:value.revision,mode:'text',audienceScope:'authenticatedSession'});assert.equal(restore.status,200);assert.equal((await restore.json()).revision,value.revision+1);
  assert.equal((await f.privacy()).privateAllowed,false,'A normal settings Save must not grant a new private declaration');
  assert.equal(f.internal.database.connection.prepare('SELECT admin_last_activity FROM local_sessions WHERE session_id=?').get(f.session.sessionId)!.admin_last_activity,activity);
  assert.equal((await f.request('/api/auth/v1/session')).status,403);assert.equal((await f.request('/api/auth/v1/daily-session')).status,200);
 }finally{await f.close();}
});

test('aged Session Save rejects wrong CSRF, origin, absent cookie and stale reference without mutation',async()=>{
 const f=await fixture();try{
  f.age();const before=settingsSnapshot(f),body={expectedRevision:f.initial.revision,mode:'text',audienceScope:'unknown'};
  assert.equal((await f.request(settingsRoute,body,{'x-lifestream-csrf':'wrong'})).status,403);
  assert.equal((await f.request(settingsRoute,body,{origin:'https://wrong.invalid'})).status,403);
  assert.equal((await f.request(settingsRoute,body,{cookie:''})).status,401);
  assert.equal((await f.request(settingsRoute,body,{'x-lifestream-user-context':randomUUID()})).status,409);
  assert.deepEqual(settingsSnapshot(f),before);
  assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);
  assert.equal((await f.request(settingsRoute,body)).status,401);assert.deepEqual(settingsSnapshot(f),before);
 }finally{await f.close();}
});

for(const invalidate of ['logout','contextSwitch'] as const)test(`pending Session Save cannot mutate after ${invalidate}`,async()=>{
 const f=await fixture();let send:ReturnType<typeof httpRequest>|undefined;try{
  let target:any;
  if(invalidate==='contextSwitch'){const response=await f.request('/api/auth/v1/accounts',{username:'settings-target',password:secret()});assert.equal(response.status,201);target=await response.json();}
  else f.age();
  const before=settingsSnapshot(f),body=JSON.stringify({expectedRevision:f.initial.revision,mode:'text',audienceScope:'unknown'});let observed!:()=>void;const received=new Promise<void>(resolve=>{observed=resolve;});
  f.internal.server.once('request',request=>request.once('data',observed));
  const result=new Promise<number>((resolve,reject)=>{send=httpRequest(f.base+settingsRoute,{method:'POST',headers:{...f.headers,'content-length':String(Buffer.byteLength(body))}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});send.on('error',reject);});
  send!.write(body.slice(0,10));await received;
  if(invalidate==='logout')assert.equal((await f.request('/api/auth/v1/sign-out',{})).status,200);
  else{const auth=f.internal.localAuth,actor=auth.hostSessionContext(f.session.sessionId);auth.effectiveSubjects.execute(actor,{schemaVersion:'1.0.0',operation:'startContext',operationId:randomUUID(),expectedGeneration:actor.effectiveContext!.generation,payload:{targetUserId:target.principalId}});}
  const afterInvalidation=settingsSnapshot(f);assert.deepEqual(afterInvalidation.settings,before.settings);
  send!.end(body.slice(10));assert.notEqual(await result,200);assert.deepEqual(settingsSnapshot(f),afterInvalidation);
 }finally{send?.destroy();await f.close();}
});
