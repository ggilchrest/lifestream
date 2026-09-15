import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PwceCapabilityDiscovery } from '../src/composition/pwce-capabilities.ts';
import { pwceIdentity } from '../src/composition/pwce-identity.ts';
import { createLifestreamServer } from '../src/index.ts';
import { loadProfile } from '../src/config/loader.ts';
import { Database } from '@lifestream/storage-sqlite';
import { EXPECTED_PWCE_PROFILE, EXPECTED_PWCE_ARTIFACTS, EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } from '../../../packages/providers-pwce/src/client.ts';
import { EXPECTED_PWCE_CAPABILITY_BUNDLE as bundle } from '../../../packages/providers-pwce/src/capability-bundle.ts';
const descriptor=bundle.capabilities[0], operations=['context.getPreparedInputs','context.query','evidence.get','events.subscribe','authority.evaluate','authority.authorizeDispatch','authority.getGrants','capabilities.getSnapshot','capabilities.invoke','capabilities.getInvocation','trace.publish','health.get'];
const json=value=>new Response(JSON.stringify(value));
const call=()=>({requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),executionMode:'live',signal:new AbortController().signal,isCurrent:()=>true});
const owner=()=>({assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),principalId:randomUUID(),conversationId:randomUUID(),interactionTraceId:randomUUID(),revision:'1',audienceKnown:true,isCurrent:()=>true});
function gateway(t){
 const originalFetch=globalThis.fetch, requests=[],streams=new Map(),snapshots=new Map();
 const state={hook:async()=>{},badAuthority:false,badSchema:false,badSite:null,sequence:0};
 const profile={endpoint:'http://pwce.synthetic.invalid',worldRef:'world.personal.v1',executionEnvironmentRef:'test',siteRefs:['home.one','home.two'],principalRef:'agent.fixture',lifestreamEnvironmentId:randomUUID(),tokenSecretRef:'gateway',timeoutMs:5000,maximumPromptBytes:4096};
 t.mock.method(globalThis,'fetch',async(url,init={})=>{
  const u=new URL(String(url));if(u.origin!==profile.endpoint)return originalFetch(url,init);
  const body=init.body?JSON.parse(String(init.body)):null;requests.push({path:u.pathname,body});await state.hook(body?.operation??u.pathname);
  if(u.pathname.endsWith('/profile'))return json({...EXPECTED_PWCE_PROFILE,schemaStatus:'published',operationCatalog:operations.map(operation=>({operation}))});
  if(u.pathname==='/gateway/v1/bundle')return json({bundleId:EXPECTED_PWCE_PROFILE.bundleId,bundleVersion:EXPECTED_PWCE_PROFILE.bundleVersion,bundleDigest:EXPECTED_PWCE_PROFILE.schemaDigest,artifacts:EXPECTED_PWCE_ARTIFACTS,generatedClient:{path:'src/gateway/generated-client.js',sha256:EXPECTED_PWCE_GENERATED_CLIENT_SHA256}});
  if(u.pathname==='/gateway/v1/authority')return json({authorityContextRef:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),siteRefs:state.badAuthority?['foreign']:body.siteRefs});
  if(u.pathname==='/gateway/v1/capability-contracts')return json(bundle);
  if(u.pathname.startsWith('/gateway/v1/capability-contracts/')){
   const input=u.pathname.endsWith(descriptor.inputSchemaArtifact.sha256),artifact=input?descriptor.inputSchemaArtifact:descriptor.resultSchemaArtifact;
   return json({artifact,schemaJson:state.badSchema?'{}':readFileSync(new URL(`./fixtures/pwce-light-${input?'input':'result'}.schema.json`,import.meta.url),'utf8')});
  }
  if(u.pathname==='/gateway/v1/request'){
   const envelope={profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:body.requestId,correlationId:body.correlationId,worldRef:body.worldRef,executionEnvironmentRef:body.executionEnvironmentRef};
   if(body.operation==='events.subscribe')return json({...envelope,principalRef:profile.principalRef,siteRef:body.siteRef,events:[],nextCursor:body.afterCursor,resyncRequired:false,hasMore:false});
   assert.equal(body.operation,'capabilities.getSnapshot');
   if(!snapshots.has(body.authorityContextRef))snapshots.set(body.authorityContextRef,{snapshotRef:randomUUID(),principalRef:profile.principalRef,siteRefs:profile.siteRefs,sourceRevision:0,invalidationSequence:0,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:[{...descriptor,available:true,authorization:'grant_required'}],availability:'configured',limitations:[]});
   return json({...envelope,...snapshots.get(body.authorityContextRef)});
  }
  assert.equal(u.pathname,'/gateway/v1/events');const site=u.searchParams.get('siteRef');
  if(site===state.badSite)return new Response('unavailable',{status:503});
  let controller;const stream=new ReadableStream({start(c){controller=c;streams.set(c,{site});},cancel(){streams.delete(controller);}});
  return new Response(stream,{headers:{'content-type':'text/event-stream'}});
 });
 const emit=type=>{const raw={eventId:randomUUID(),type,cursor:String(++state.sequence),sourceRevision:state.sequence,affectedRef:null,watch:{siteRefs:[],principalRefs:[profile.principalRef]},reason:'synthetic_change',occurredAt:new Date().toISOString(),correlationId:randomUUID()};for(const controller of streams.keys())controller.enqueue(new TextEncoder().encode(`id: ${raw.cursor}\nevent: ${type}\ndata: ${JSON.stringify(raw)}\n\n`));};
 const discovery=new PwceCapabilityDiscovery(profile,'synthetic-agent-token');t.after(()=>discovery.close());
 return {profile,discovery,requests,streams,state,emit};
}

test('PWCE discovery validates exact public schemas and preserves opaque authenticated identity',async t=>{
 const f=gateway(t),o=owner(),result=await f.discovery.discover(o,call());
 assert.equal(result.status,'available');assert.equal(result.tools[0].capabilityId,'pwce.home.light.set-level');assert.equal(result.tools[0].inputSchema.properties.parameters.properties.level.maximum,1);
 assert.equal(result.actionAdministration,'unavailable');assert.equal(result.grantsAuthority,false);assert.equal(result.dispatchStarted,false);
 const authority=f.requests.find(r=>r.path.endsWith('/authority')).body;assert.deepEqual(authority,{...pwceIdentity(f.profile.lifestreamEnvironmentId,o),siteRefs:f.profile.siteRefs});assert.ok(!JSON.stringify(authority).includes(o.principalId));
 assert.equal(f.streams.size,2);await f.discovery.discover(o,call());assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);
 assert.ok(f.requests.every(r=>!['authority.authorizeDispatch','capabilities.invoke'].includes(r.body?.operation)));
});

test('unknown audience, expired owner, invalid local identity and cancellation transmit no scoped request',async t=>{
 const f=gateway(t);for(const extra of [{audienceKnown:false},{isCurrent:()=>false},{assistantId:'foreign'}])await assert.rejects(f.discovery.discover({...owner(),...extra},call()));
 const c=call();const controller=new AbortController();controller.abort();c.signal=controller.signal;await assert.rejects(f.discovery.discover(owner(),c));assert.equal(f.requests.length,0);
});

test('every configured site must establish its stream before discovery succeeds',async t=>{
 const f=gateway(t);f.state.badSite='home.two';await assert.rejects(f.discovery.discover(owner(),call()));assert.equal(f.requests.some(r=>r.body?.operation==='capabilities.getSnapshot'),false);
});

test('foreign authority scope and changed schema bytes cannot become available tools',async t=>{
 const f=gateway(t);f.state.badAuthority=true;await assert.rejects(f.discovery.discover(owner(),call()));f.state.badAuthority=false;f.state.badSchema=true;await assert.rejects(f.discovery.discover(owner(),call()));
});

test('invalidation during a catalog read removes custody and rejects the late result',async t=>{
 const f=gateway(t);let changed=false;f.state.hook=async phase=>{if(phase==='capabilities.getSnapshot'&&!changed){changed=true;f.emit('capabilities.invalidated');await new Promise(resolve=>setImmediate(resolve));}};
 await assert.rejects(f.discovery.discover(owner(),call()));assert.equal(changed,true);
});

test('owner withdrawal and close fence in-flight authority replies and release subscriptions',async t=>{
 const f=gateway(t);let current=true;f.state.hook=async phase=>{if(phase==='/gateway/v1/authority')current=false;};await assert.rejects(f.discovery.discover({...owner(),isCurrent:()=>current},call()));assert.equal(f.streams.size,0);
 f.state.hook=async()=>{};await f.discovery.discover(owner(),call());f.discovery.close();await assert.rejects(f.discovery.discover(owner(),call()));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.streams.size,0);
});

async function http(t){
 const f=gateway(t),root=mkdtempSync(join(tmpdir(),'ls-pwce-discovery-')),config=loadProfile('test'),secret='PWCE_SYNTHETIC_DISCOVERY_'+randomBytes(8).toString('hex');
 process.env[secret]='synthetic-agent-token';t.after(()=>delete process.env[secret]);config.authority.authentication='local-password';config.providers.world='pwce';config.providers.capability='pwce';config.authority.provider='pwce';config.secretRefs={gateway:{kind:'env',name:secret}};config.pwceProfile=f.profile;config.storage={databasePath:join(root,'db.sqlite'),artifactDirectory:join(root,'artifacts')};
 const installerToken=randomBytes(24).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'safety'),installerToken}});await app.start();const base=`http://127.0.0.1:${app.address().port}`,headers={origin:base,'content-type':'application/json'};
 const send=async(path,body,extra={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await send('/api/auth/v1/setup',{username:'owner',password:'Synthetic-'+randomBytes(24).toString('hex'),installerToken});assert.equal(setup.status,201);headers.cookie=setup.cookie;headers['x-lifestream-csrf']=setup.body.session.csrfToken;
 const assistant=await send('/api/admin/v1/assistants',{displayName:'Synthetic PWCE discovery'});assert.equal(assistant.status,201);const path=`/api/authority/v1/assistants/${assistant.body.assistantId}/tools`;
 const db=new Database({path:config.storage.databasePath});t.after(async()=>{await app.shutdown();db.close();rmSync(root,{recursive:true,force:true});});
 return {...f,send,path,db,app,config};
}

test('authenticated HTTP discovery requires audience and cannot mint local grants or execute',async t=>{
 const f=await http(t);assert.equal((await f.send(f.path)).status,503);assert.equal((await f.send(f.path,undefined,{cookie:''})).status,401);
 assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 const result=await f.send(f.path);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.providerRef,'pwce');assert.equal(result.body.tools.length,1);
 assert.equal((await f.send(f.path+'?scope=foreign')).status,422);assert.equal((await f.send(f.path.replace(/assistants\/[^/]+/,'assistants/'+randomUUID()))).status,403);
 assert.equal((await f.send('/api/authority/v1/grants')).status,503);assert.equal((await f.send(f.path+'/pwce.home.light.set-level/prepare',{})).status,503);
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM canonical_grants').get().count,0);assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS count FROM pwce_admission_custody').get().count,0);
});

test('HTTP audience withdrawal during discovery rejects the late response',async t=>{
 const f=await http(t);await f.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.state.hook=async phase=>{if(phase==='capabilities.getSnapshot'){entered();await gate;}};
 const pending=f.send(f.path);await started;await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});release();assert.equal((await pending).status,503);
});


test('concurrent discovery shares one authority setup and current site subscriptions',async t=>{
 const f=gateway(t),o=owner();const results=await Promise.all([f.discovery.discover(o,call()),f.discovery.discover(o,call())]);
 assert.ok(results.every(r=>r.tools.length===1));assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);assert.equal(f.streams.size,2);
});

test('capacity is bounded and withdrawn owners release their slots',async t=>{
 const f=gateway(t);let current=true;await f.discovery.discover({...owner(),isCurrent:()=>current},call());
 for(let i=1;i<16;i++)await f.discovery.discover(owner(),call());
 await assert.rejects(f.discovery.discover(owner(),call()));assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,16);
 current=false;await f.discovery.discover(owner(),call());assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,17);
});

test('logout during HTTP discovery cannot release tools',async t=>{
 const f=await http(t);await f.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.state.hook=async phase=>{if(phase==='capabilities.getSnapshot'){entered();await gate;}};
 const pending=f.send(f.path);await started;await f.send('/api/auth/v1/sign-out',{});release();assert.equal((await pending).status,503);assert.equal((await f.send(f.path)).status,401);
});
