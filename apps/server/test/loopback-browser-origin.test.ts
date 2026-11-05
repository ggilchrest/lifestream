import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import {request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {WebSocket} from 'ws';
import {captureLoopbackBrowserOrigin,normalizeLoopbackBrowserRequest} from '../src/runtime/loopback-browser-origin.ts';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
const alias='http://localhost:59445',canonical='http://127.0.0.1:43182';
const secret=()=>randomBytes(32).toString('base64url');
function request(host='localhost:59445',origin:string|undefined=alias,peer='127.0.0.1'){
 const headers={host,...(origin===undefined?{}:{origin})};return {headers,rawHeaders:Object.entries(headers).flat(),socket:{remoteAddress:peer}} as IncomingMessage;
}
test('browser origin is one exact explicit HTTP loopback authority',()=>{
 assert.equal(captureLoopbackBrowserOrigin(undefined),undefined);
 for(const origin of [alias,'http://127.0.0.1:12345','http://[::1]:65535'])assert.equal(captureLoopbackBrowserOrigin(origin),origin);
 for(const origin of [null,{},'*','http://localhost','https://localhost:59445','http://localhost:0','http://localhost:65536','http://localhost:059445','http://localhost:59445/','http://localhost:59445/path','http://localhost:59445?x=1','http://localhost:59445#x','http://user@localhost:59445','http://127.1:59445','http://127.0.0.2:59445','http://localhost.evil:59445','http://0.0.0.0:59445','http://[::]:59445','http://LOCALHOST:59445',' http://localhost:59445','http://localhost:59445\n','http://localhost:59445\r\n'])assert.throws(()=>captureLoopbackBrowserOrigin(origin));
});
test('only pinned alias on an actual loopback socket is normalized without trusting forwarding headers',()=>{
 for(const peer of ['127.0.0.1','127.0.0.2','::1','::ffff:127.0.0.1']){
  const r=request(undefined,alias,peer);
  r.headers['x-forwarded-host']='evil.invalid';r.headers['x-forwarded-proto']='https';
  assert.equal(normalizeLoopbackBrowserRequest(r,canonical,alias,true),alias);assert.equal(r.headers.host,'127.0.0.1:43182');assert.equal(r.headers.origin,canonical);
 }
 const read=request();delete read.headers.origin;read.rawHeaders=['host','localhost:59445'];normalizeLoopbackBrowserRequest(read,canonical,alias,false);assert.equal(read.headers.origin,undefined);
 const canonicalRequest=request('127.0.0.1:43182',canonical),copy=structuredClone(canonicalRequest.headers);assert.equal(normalizeLoopbackBrowserRequest(canonicalRequest,canonical,alias,true),undefined);assert.deepEqual(canonicalRequest.headers,copy);
 const unconfigured=request();normalizeLoopbackBrowserRequest(unconfigured,canonical,undefined,true);assert.equal(unconfigured.headers.host,'localhost:59445');
});
test('alias mismatch, mixed origins, duplicate headers and non-loopback peer stay denied',()=>{
 for(const r of [request('localhost:59446'),request('evil.invalid:59445'),request(undefined,canonical),request(undefined,'https://evil.invalid'),request(undefined,'null'),request(undefined,alias,'192.168.1.1'),request(undefined,alias,'::ffff:192.168.1.1'),request(undefined,alias,'localhost')]){
  r.headers['x-forwarded-for']='127.0.0.1';r.headers['x-forwarded-host']='localhost:59445';const before={...r.headers};assert.throws(()=>normalizeLoopbackBrowserRequest(r,canonical,alias,true),{code:'origin_rejected'});assert.deepEqual(r.headers,before);
 }
 const missing=request();delete missing.headers.origin;missing.rawHeaders=['host','localhost:59445'];assert.throws(()=>normalizeLoopbackBrowserRequest(missing,canonical,alias,true),{code:'origin_rejected'});
 for(const key of ['host','origin']){const duplicate=request();duplicate.rawHeaders.push(key,key==='host'?'evil.invalid':alias);assert.throws(()=>normalizeLoopbackBrowserRequest(duplicate,canonical,alias,false),{code:'origin_rejected'});}
});
test('changing ports require an explicit wildcard for one literal loopback hostname',()=>{
 for(const host of ['localhost','127.0.0.1','[::1]']){
  const policy=`http://${host}:*`;assert.equal(captureLoopbackBrowserOrigin(policy),policy);
  for(const port of [1,80,59445,61607,65535]){
   const origin=`http://${host}:${port}`,r=request(`${host}:${port}`,origin);
   assert.equal(normalizeLoopbackBrowserRequest(r,canonical,policy,true),origin);
   assert.equal(r.headers.host,'127.0.0.1:43182');assert.equal(r.headers.origin,canonical);
  }
 }
 for(const policy of ['*','http://*:*','http://*.localhost:*','http://127.*:*','http://127.0.0.2:*','http://0.0.0.0:*','http://[::]:*','https://localhost:*','http://LOCALHOST:*','http://localhost:*/','http://localhost:*?x=1','http://localhost:*#x','http://user@localhost:*',' http://localhost:*','http://localhost:*\n'])assert.throws(()=>captureLoopbackBrowserOrigin(policy));
});
test('dynamic ports reject foreign authorities, malformed ports, mixed origins and ambiguous headers',()=>{
 const policy='http://localhost:*';
 for(const host of ['127.0.0.1:61607','[::1]:61607','localhost.evil:61607','LOCALHOST:61607','localhost','localhost:','localhost:0','localhost:65536','localhost:061607','localhost:+61607','localhost:61607.0','localhost:61607/path','user@localhost:61607']){
  const r=request(host,`http://${host}`),before={...r.headers};
  assert.throws(()=>normalizeLoopbackBrowserRequest(r,canonical,policy,true),{code:'origin_rejected'},host);assert.deepEqual(r.headers,before);
 }
 for(const origin of [alias,'http://127.0.0.1:61607','https://localhost:61607','https://evil.invalid','null']){
  const r=request('localhost:61607',origin);assert.throws(()=>normalizeLoopbackBrowserRequest(r,canonical,policy,false),{code:'origin_rejected'});
 }
 for(const peer of ['192.168.1.1','::ffff:192.168.1.1','localhost',undefined]){
  const r=request('localhost:61607','http://localhost:61607');Object.defineProperty(r.socket,'remoteAddress',{value:peer});
  r.headers['x-forwarded-for']='127.0.0.1';r.headers['x-forwarded-host']='localhost:61607';r.headers['x-forwarded-proto']='http';
  assert.throws(()=>normalizeLoopbackBrowserRequest(r,canonical,policy,true),{code:'origin_rejected'});
 }
 for(const name of ['host','origin']){
  const r=request('localhost:61607','http://localhost:61607');r.rawHeaders.push(name.toUpperCase(),name==='host'?'localhost:61607':'http://localhost:61607');
  assert.throws(()=>normalizeLoopbackBrowserRequest(r,canonical,policy,false),{code:'origin_rejected'});
 }
 const absentHost=request('localhost:61607','http://localhost:61607');absentHost.rawHeaders=['Origin','http://localhost:61607'];
 assert.throws(()=>normalizeLoopbackBrowserRequest(absentHost,canonical,policy,false),{code:'origin_rejected'});
 const read=request('localhost:61607','http://localhost:61607');delete read.headers.origin;read.rawHeaders=['Host','localhost:61607'];
 assert.throws(()=>normalizeLoopbackBrowserRequest(read,canonical,policy,true),{code:'origin_rejected'});
 assert.equal(normalizeLoopbackBrowserRequest(read,canonical,policy,false),'http://localhost:61607');assert.equal(read.headers.origin,undefined);
 const forwarded=request('localhost:61607','http://localhost:61607');forwarded.headers['x-forwarded-host']='evil.invalid';forwarded.headers['x-forwarded-proto']='https';
 assert.equal(normalizeLoopbackBrowserRequest(forwarded,canonical,policy,true),'http://localhost:61607');
});
async function fixture(t:TestContext,enabled:boolean|string=true){
 const root=await mkdtemp(join(tmpdir(),'loopback-browser-origin-')),config=loadProfile('test'),installerToken=secret();
 config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};config.authority.authentication='local-password';
 const app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken},...(enabled?{loopbackBrowserOrigin:typeof enabled==='string'?enabled:alias}:{})});await app.start();
 t.after(async()=>{await app.shutdown();await rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.address().port}`;
 const send=(path:string,headers:Record<string,string>|string[]={},body?:unknown,method=body===undefined?'GET':'POST')=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;text:string}>((resolve,reject)=>{
  const req=httpRequest(base+path,{method,headers:Array.isArray(headers)?['content-type','application/json',...headers]:{'content-type':'application/json',...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,text}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
 });
 return {app,base,send,installerToken};
}
test('real HTTP alias preserves canonical sessions and CSRF while rejecting other browser origins',{timeout:15000},async t=>{
 const f=await fixture(t),browser={host:'localhost:59445',origin:alias},canonicalHeaders={host:new URL(f.base).host,origin:f.base};
 assert.equal((await f.send('/daily/')).status,200);assert.equal((await f.send('/daily/',{host:'localhost:59445'})).status,200);
 for(const headers of [{host:'localhost:59446',origin:alias},{...browser,origin:f.base},{...canonicalHeaders,origin:alias},{...browser,origin:'https://evil.invalid'},{host:'evil.invalid','x-forwarded-host':'localhost:59445','x-forwarded-for':'127.0.0.1',origin:alias}])assert.equal((await f.send('/daily/',headers)).status,403);
 assert.equal((await f.send('/api/admin/v1/assistants',browser,{displayName:'Unauthenticated'})).status,401);
 const credentials={username:'synthetic-owner',password:secret(),installerToken:f.installerToken};
 assert.equal((await f.send('/api/auth/v1/setup',{host:'localhost:59445'},credentials)).status,403);
 const setup=await f.send('/api/auth/v1/setup',browser,credentials);assert.equal(setup.status,201,setup.text);
 const session=JSON.parse(setup.text).session,cookie=setup.headers['set-cookie']![0]!.split(';')[0]!,authenticated={...browser,cookie,'x-lifestream-csrf':session.csrfToken};
 assert.equal(f.app.database.connection.prepare('SELECT origin FROM local_sessions WHERE session_id=?').get(session.sessionId)!.origin,f.base);
 assert.match(setup.headers['set-cookie']![0]!,/HttpOnly; SameSite=Strict/);
 for(const headers of [authenticated,{...canonicalHeaders,cookie}]){const response=await f.send('/api/auth/v1/session',headers);assert.equal(response.status,200,response.text);assert.equal(JSON.parse(response.text).sessionId,session.sessionId);}
 assert.equal((await f.send('/api/admin/v1/assistants',{...browser,cookie},{displayName:'Missing CSRF'})).status,403);
 assert.equal((await f.send('/api/admin/v1/assistants',{...authenticated,'x-lifestream-csrf':'wrong'},{displayName:'Wrong CSRF'})).status,403);
 assert.equal((await f.send('/api/admin/v1/assistants',{host:'localhost:59445',cookie,'x-lifestream-csrf':session.csrfToken},{displayName:'Missing Origin'})).status,403);
 assert.equal((await f.send('/api/admin/v1/assistants',authenticated,{displayName:'Alias authenticated fixture'})).status,201);
 const signed=await f.send('/api/auth/v1/sign-in',browser,{username:credentials.username,password:credentials.password});assert.equal(signed.status,200,signed.text);
 const next=JSON.parse(signed.text).session;assert.equal(f.app.database.connection.prepare('SELECT origin FROM local_sessions WHERE session_id=?').get(next.sessionId)!.origin,f.base);
});
test('real HTTP without explicit alias retains canonical-only behavior',{timeout:10000},async t=>{
 const f=await fixture(t,false);assert.equal((await f.send('/daily/')).status,200);assert.equal((await f.send('/daily/',{host:'localhost:59445',origin:alias})).status,403);
});
test('real HTTP retains sign-in sessions and CSRF across changing local browser ports',{timeout:15000},async t=>{
 const f=await fixture(t,'http://localhost:*'),ports=[59445,61607,50321];
 const browser=(port:number)=>({host:`localhost:${port}`,origin:`http://localhost:${port}`});
 const credentials={username:'synthetic-owner',password:secret(),installerToken:f.installerToken};
 const setup=await f.send('/api/auth/v1/setup',browser(ports[0]!),credentials);assert.equal(setup.status,201,setup.text);
 const session=JSON.parse(setup.text).session,cookie=setup.headers['set-cookie']![0]!.split(';')[0]!;
 assert.equal(f.app.database.connection.prepare('SELECT origin FROM local_sessions WHERE session_id=?').get(session.sessionId)!.origin,f.base);
 assert.match(setup.headers['set-cookie']![0]!,/HttpOnly; SameSite=Strict/);
 for(const port of ports){
  const headers=browser(port),authenticated={...headers,cookie,'x-lifestream-csrf':session.csrfToken};
  assert.equal((await f.send('/daily/',{host:headers.host})).status,200);
  assert.equal((await f.send('/daily/',headers)).status,200);
  const restored=await f.send('/api/auth/v1/session',{...headers,cookie});assert.equal(restored.status,200,restored.text);assert.equal(JSON.parse(restored.text).sessionId,session.sessionId);
  assert.equal((await f.send('/api/admin/v1/assistants',headers,{displayName:'Unauthenticated'})).status,401);
  assert.equal((await f.send('/api/admin/v1/assistants',{...headers,cookie},{displayName:'Missing CSRF'})).status,403);
  assert.equal((await f.send('/api/admin/v1/assistants',{...authenticated,'x-lifestream-csrf':'wrong'},{displayName:'Wrong CSRF'})).status,403);
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){
   const rejected=await f.send('/api/admin/v1/assistants',{host:headers.host,cookie,'x-lifestream-csrf':session.csrfToken},undefined,method);
   assert.equal(rejected.status,403,method);assert.equal(JSON.parse(rejected.text).code,'origin_rejected',method);
  }
  assert.equal((await f.send('/api/admin/v1/assistants',authenticated,{displayName:`Port ${port}`})).status,201);
 }
 const changed=browser(ports[1]!);
 for(const headers of [
  {...changed,origin:alias},
  {...changed,origin:'https://evil.invalid'},
  {...changed,origin:'null'},
  {host:'localhost:65536',origin:'http://localhost:65536'},
  {host:'localhost:061607',origin:'http://localhost:061607'},
  {host:'localhost:0',origin:'http://localhost:0'},
  {host:'127.0.0.1:61607',origin:'http://127.0.0.1:61607'},
  {host:'evil.invalid:61607',origin:'http://evil.invalid:61607','x-forwarded-host':'localhost:61607','x-forwarded-for':'127.0.0.1'},
 ])assert.equal((await f.send('/api/admin/v1/assistants',{...headers,cookie,'x-lifestream-csrf':session.csrfToken},{displayName:'Rejected origin'})).status,403);
 for(const duplicate of [['Host','localhost:61607'],['Origin','http://localhost:61607']]){
  const headers=['Host','localhost:61607','Origin','http://localhost:61607','Cookie',cookie,'x-lifestream-csrf',session.csrfToken,...duplicate];
  assert.equal((await f.send('/api/admin/v1/assistants',headers,{displayName:'Duplicate browser header'})).status,403);
 }
 const signed=await f.send('/api/auth/v1/sign-in',browser(ports[2]!),{username:credentials.username,password:credentials.password});assert.equal(signed.status,200,signed.text);
 const next=JSON.parse(signed.text).session,nextCookie=signed.headers['set-cookie']![0]!.split(';')[0]!;
 assert.equal(f.app.database.connection.prepare('SELECT origin FROM local_sessions WHERE session_id=?').get(next.sessionId)!.origin,f.base);
 const restored=await f.send('/api/auth/v1/session',{...browser(ports[0]!),cookie:nextCookie});assert.equal(restored.status,200,restored.text);assert.equal(JSON.parse(restored.text).sessionId,next.sessionId);
});
test('real WebSocket upgrades enforce exact alias origin and original cookie authentication',{timeout:15000},async t=>{
 const f=await fixture(t),browser={host:'localhost:59445',origin:alias},setup=await f.send('/api/auth/v1/setup',browser,{username:'synthetic-owner',password:secret(),installerToken:f.installerToken});assert.equal(setup.status,201);
 const cookie=setup.headers['set-cookie']![0]!.split(';')[0]!;
 // Readiness fixtures intentionally expose no audio adapters. Supply inert ports
 // only to reach the real upgrade owner; this test sends no audio or model work.
 f.app.providers.stt={async *transcribe(){assert.fail('No audio work in origin test');}} as any;
 f.app.providers.tts={async *synthesize(){assert.fail('No speech work in origin test');}} as any;
 const upgrade=(headers:Record<string,string>,query='')=>new Promise<boolean>((resolve,reject)=>{
  const socket=new WebSocket(f.base.replace('http:','ws:')+'/api/runtime/v1/audio'+query,{headers});let opened=false;
  const timer=setTimeout(()=>{socket.terminate();reject(Error('WebSocket fixture did not settle'));},2000);
  socket.on('error',()=>{});socket.once('open',()=>{opened=true;socket.close();});socket.once('close',()=>{clearTimeout(timer);resolve(opened);});
 });
 assert.equal(await upgrade({...browser,cookie}),true);assert.equal(await upgrade({origin:f.base,cookie}),true);
 assert.equal(await upgrade({...browser,cookie},'?origin='+encodeURIComponent(alias)),true);
 for(const headers of [{...browser,cookie,origin:f.base},{...browser,cookie,origin:'https://evil.invalid'},{host:'localhost:59445',cookie},{...browser,cookie,host:'localhost:59446'},browser])assert.equal(await upgrade(headers),false);
 assert.equal(await upgrade({...browser,cookie},'?origin='+encodeURIComponent(f.base)),false);
});
test('real WebSocket upgrades bind changed ports to their actual origin and retain session revocation',{timeout:15000},async t=>{
 const f=await fixture(t,'http://localhost:*'),browser=(port:number)=>({host:`localhost:${port}`,origin:`http://localhost:${port}`});
 const setup=await f.send('/api/auth/v1/setup',browser(59445),{username:'synthetic-owner',password:secret(),installerToken:f.installerToken});assert.equal(setup.status,201);
 const cookie=setup.headers['set-cookie']![0]!.split(';')[0]!;
 f.app.providers.stt={async *transcribe(){assert.fail('No audio work in origin test');}} as any;
 f.app.providers.tts={async *synthesize(){assert.fail('No speech work in origin test');}} as any;
 const upgrade=(headers:Record<string,string|string[]>,queryOrigin?:string)=>new Promise<boolean>((resolve,reject)=>{
  const query=queryOrigin===undefined?'':'?origin='+encodeURIComponent(queryOrigin);
  const socket=new WebSocket(f.base.replace('http:','ws:')+'/api/runtime/v1/audio'+query,{headers});let opened=false;
  const timer=setTimeout(()=>{socket.terminate();reject(Error('WebSocket fixture did not settle'));},2000);
  socket.on('error',()=>{});socket.once('open',()=>{opened=true;socket.close();});socket.once('close',()=>{clearTimeout(timer);resolve(opened);});
 });
 for(const port of [59445,61607,50321]){
  const headers={...browser(port),cookie};assert.equal(await upgrade(headers),true);assert.equal(await upgrade(headers,headers.origin),true);
 }
 const changed={...browser(61607),cookie};
 assert.equal(await upgrade(changed,alias),false);assert.equal(await upgrade(changed,f.base),false);
 for(const headers of [
  {...changed,origin:alias},
  {...changed,origin:'https://evil.invalid'},
  {host:'localhost:61607',cookie},
  {...changed,host:'127.0.0.1:61607'},
  {...changed,host:'localhost:65536',origin:'http://localhost:65536'},
  {...changed,origin:[changed.origin,changed.origin]},
  browser(61607),
 ])assert.equal(await upgrade(headers),false);
 const session=JSON.parse(setup.text).session;
 const signedOut=await f.send('/api/auth/v1/sign-out',{...browser(59445),cookie,'x-lifestream-csrf':session.csrfToken},{});assert.equal(signedOut.status,200,signedOut.text);
 assert.equal((await f.send('/api/auth/v1/session',changed)).status,401);
 assert.equal((await f.send('/api/admin/v1/assistants',{...browser(50321),cookie,'x-lifestream-csrf':session.csrfToken},{displayName:'Revoked session'})).status,401);
 assert.equal(await upgrade(changed,changed.origin),false);
 assert.equal(await upgrade({...browser(50321),cookie}),false);
});
