import { PwceActionJournal } from '../src/authority/pwce-action-journal.ts';
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
   if(body.operation==='authority.evaluate')return json({...envelope,outcome:state.previewDenied?'denied':body.approvalRequired?'approval_required':'allowed',...(body.approvalRequired?{}:{capabilityRef:descriptor.capabilityRef,effectClass:descriptor.effectClass}),rationaleCodes:['synthetic_policy'],requirements:body.approvalRequired?['runtime_human_approval']:[],limitations:[]});
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
 return {profile,discovery,requests,streams,snapshots,state,emit};
}

test('PWCE discovery validates exact public schemas and preserves opaque authenticated identity',async t=>{
 const f=gateway(t),o=owner(),result=await f.discovery.discover(o,call());
 assert.equal(result.status,'available');assert.equal(result.tools[0].capabilityId,'pwce.home.light.set-level');assert.equal(result.tools[0].inputSchema.properties.parameters.properties.level.maximum,1);
 assert.equal(result.actionAdministration,'providerReview');assert.equal(result.grantsAuthority,false);assert.equal(result.dispatchStarted,false);
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
 return {...f,send,path,db,app,config,local:app.localAuth.context(setup.cookie.split("=")[1],base),csrfToken:headers["x-lifestream-csrf"]};
}

test('authenticated HTTP discovery requires audience and cannot mint local grants or execute',async t=>{
 const f=await http(t);assert.equal((await f.send(f.path)).status,503);assert.equal((await f.send(f.path,undefined,{cookie:''})).status,401);
 assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 const result=await f.send(f.path);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.providerRef,'pwce');assert.equal(result.body.tools.length,1);
 assert.equal((await f.send(f.path+'?scope=foreign')).status,422);assert.equal((await f.send(f.path.replace(/assistants\/[^/]+/,'assistants/'+randomUUID()))).status,403);
 assert.equal((await f.send('/api/authority/v1/grants')).status,422);assert.equal((await f.send(f.path+'/pwce.home.light.set-level/prepare',{})).status,422);
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


test('host reattaches the exact original catalog after watcher/host closure without acquiring authority',async t=>{
 const f=gateway(t),o=owner(),original=await f.discovery.withCatalog(o,call(),async lease=>structuredClone(lease.record));
 f.discovery.close();const reopened=new PwceCapabilityDiscovery(f.profile,'synthetic-agent-token');t.after(()=>reopened.close());
 let invoked=0;const result=await reopened.withCatalog(o,call(),async lease=>{invoked++;assert.deepEqual(lease.record,original);assert.equal(lease.context.isCurrent(original.scope),true);return 'same review';},original);
 assert.equal(result,'same review');assert.equal(invoked,1);assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);assert.equal(f.streams.size,2);
});

test('foreign or changed host review scope cannot reconnect or issue replacement authority',async t=>{
 const f=gateway(t),o=owner(),original=await f.discovery.withCatalog(o,call(),async lease=>structuredClone(lease.record));f.discovery.close();
 for(const changed of [{principalId:randomUUID()},{assistantId:randomUUID()},{endpointId:randomUUID()},{sessionId:randomUUID()},{revision:'changed'},{conversationId:randomUUID()},{interactionTraceId:randomUUID()}]){
  const reopened=new PwceCapabilityDiscovery(f.profile,'synthetic-agent-token');t.after(()=>reopened.close());const before=f.requests.length;
  await assert.rejects(reopened.withCatalog({...o,...changed},call(),async()=>assert.fail('foreign review executed'),original));assert.equal(f.requests.length,before);
 }
 assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);
});

test('a changed producer snapshot cannot silently replace the reviewed action catalog',async t=>{
 const f=gateway(t),o=owner(),original=await f.discovery.withCatalog(o,call(),async lease=>structuredClone(lease.record));f.discovery.close();
 f.snapshots.get(original.binding.authorityContextRef).snapshotRef=randomUUID();
 const reopened=new PwceCapabilityDiscovery(f.profile,'synthetic-agent-token');t.after(()=>reopened.close());
 await assert.rejects(reopened.withCatalog(o,call(),async()=>assert.fail('changed review executed'),original));assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);
});

test('lost original producer authority does not trigger authority reissuance',async t=>{
 const f=gateway(t),o=owner(),original=await f.discovery.withCatalog(o,call(),async lease=>structuredClone(lease.record));f.discovery.close();
 f.state.hook=async operation=>{if(operation==='events.subscribe')throw new Error('synthetic authority no longer exists');};
 const reopened=new PwceCapabilityDiscovery(f.profile,'synthetic-agent-token');t.after(()=>reopened.close());
 await assert.rejects(reopened.withCatalog(o,call(),async()=>assert.fail('lost authority executed'),original));assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);
});

test('reconnecting after invalidation cannot revive an older pending host operation',async t=>{
 const f=gateway(t),o=owner();let entered,release,original,oldSignal;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const pending=f.discovery.withCatalog(o,call(),async lease=>{original=structuredClone(lease.record);oldSignal=lease.context.signal;entered();await gate;return 'late';});await reached;
 f.emit('capabilities.invalidated');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(oldSignal.aborted,true);
 const fresh=await f.discovery.withCatalog(o,call(),async lease=>lease.record,original);assert.deepEqual(fresh,original);assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,1);
 release();await assert.rejects(pending);
});

const preparationBody=()=>({idempotencyKey:randomUUID(),capabilityVersion:'1.0.0',input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.4}}});
const preparationPath=f=>f.path+'/pwce.home.light.set-level/prepare';
const inspectPath=(f,id)=>f.path+'/invocations/'+id+'/preparation';
async function prepareAudience(f){assert.equal((await f.send('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);}

test('authenticated PWCE preparation retains exact input, original provider preview and retry identity without grants',async t=>{
 const f=await http(t);await prepareAudience(f);const body=preparationBody(),first=await f.send(preparationPath(f),body);
 assert.equal(first.status,201,JSON.stringify(first));assert.equal(first.body.grantsAuthority,false);assert.equal(first.body.dispatchStarted,false);assert.equal(first.body.confirmationAvailable,false);
 assert.deepEqual(first.body.input,body.input);assert.equal(first.body.preparation.currentPreview.authorityKind,'external');assert.equal(first.body.preparation.currentPreview.disposition,'authorized');
 const repeat=await f.send(preparationPath(f),body);assert.equal(repeat.status,200,JSON.stringify(repeat));assert.equal(repeat.body.preparation.invocationId,first.body.preparation.invocationId);assert.equal(repeat.body.preparation.confirmationDigest,first.body.preparation.confirmationDigest);assert.deepEqual(repeat.body.preparation.originalPreview,first.body.preparation.originalPreview);
 const inspected=await f.send(inspectPath(f,first.body.preparation.invocationId));assert.equal(inspected.status,200);assert.deepEqual(inspected.body.input,body.input);
 const conflict=await f.send(preparationPath(f),{...body,input:{...body.input,parameters:{level:0.9}}});assert.equal(conflict.status,409);
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_action_preparations').get().n,1);
 for(const table of ['canonical_grants','canonical_preparations','pwce_admission_custody','pwce_invocation_custody'])assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
 assert.ok(f.requests.every(r=>!['authority.authorizeDispatch','capabilities.invoke'].includes(r.body?.operation)));
});

test('PWCE preparation rejects invented approval fields, invalid input, authentication and CSRF failures',async t=>{
 const f=await http(t);await prepareAudience(f);const body=preparationBody(),before=f.requests.length;
 for(const extra of [{approvalRef:'invented'},{approved:true},{requestedClass:'allowOnce'},{authorityContextRef:randomUUID()}])assert.equal((await f.send(preparationPath(f),{...body,...extra})).status,422);
 assert.equal(f.requests.length,before);assert.equal((await f.send(preparationPath(f),body,{'x-lifestream-csrf':'wrong'})).status,403);assert.equal((await f.send(preparationPath(f),body,{cookie:''})).status,401);
 assert.equal((await f.send(preparationPath(f),{...body,input:{...body.input,parameters:{level:4}}})).status,422);assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_action_preparations').get().n,0);
});

test('audience withdrawal during a PWCE preview prevents durable preparation and late disclosure',async t=>{
 const f=await http(t);await prepareAudience(f);let entered,release;const reached=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.state.hook=async phase=>{if(phase==='authority.evaluate'){entered();await gate;}};
 const pending=f.send(preparationPath(f),preparationBody());await reached;await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});release();const result=await pending;assert.ok(result.status>=400);
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_action_preparations').get().n,0);assert.equal(result.body.preparation,undefined);
});

test('retained PWCE preparation survives an actual host restart with no authority replacement',async t=>{
 const f=await http(t);await prepareAudience(f);const body=preparationBody(),first=await f.send(preparationPath(f),body);assert.equal(first.status,201,JSON.stringify(first));
 const count=f.requests.filter(r=>r.path.endsWith('/authority')).length,port=f.app.address().port;await f.app.shutdown();
 const reopened=createLifestreamServer({config:f.config,port,localAuth:{stateDirectory:join(f.config.storage.artifactDirectory,'../safety')}});await reopened.start();t.after(()=>reopened.shutdown());
 const inspect=await f.send(inspectPath(f,first.body.preparation.invocationId));assert.equal(inspect.status,200,JSON.stringify(inspect));assert.equal(inspect.body.preparation.confirmationDigest,first.body.preparation.confirmationDigest);assert.equal(f.requests.filter(r=>r.path.endsWith('/authority')).length,count);
});

test('retained PWCE preparation rejects corruption, foreign Assistant access and later owner changes',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody());assert.equal(first.status,201,JSON.stringify(first));const id=first.body.preparation.invocationId;
 assert.ok([403,404].includes((await f.send(inspectPath(f,id).replace(/assistants\/[^/]+/,'assistants/'+randomUUID()))).status));
 f.db.connection.prepare("UPDATE pwce_action_preparations SET sha256='corrupt'").run();assert.equal((await f.send(inspectPath(f,id))).status,503);
 await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});assert.ok((await f.send(inspectPath(f,id))).status>=400);
});

test('failed PWCE preparation persistence cannot report a retained review',async t=>{
 const f=await http(t);await prepareAudience(f);f.db.exec("CREATE TRIGGER reject_pwce_preparation BEFORE INSERT ON pwce_action_preparations BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
 const result=await f.send(preparationPath(f),preparationBody());assert.ok(result.status>=500);assert.equal(result.body.preparation,undefined);assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_action_preparations').get().n,0);
});

test('parallel initial PWCE preparation submissions select one durable review',async t=>{
 const f=await http(t);await prepareAudience(f);const body=preparationBody(),results=await Promise.all([f.send(preparationPath(f),body),f.send(preparationPath(f),body)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].body.preparation.invocationId,results[1].body.preparation.invocationId);assert.equal(results[0].body.preparation.confirmationDigest,results[1].body.preparation.confirmationDigest);assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_action_preparations').get().n,1);
});

test('expired PWCE preparation requires a new review and does not acquire replacement authority',async t=>{
 const f=await http(t);await prepareAudience(f);const body=preparationBody(),first=await f.send(preparationPath(f),body);assert.equal(first.status,201,JSON.stringify(first));const before=f.requests.length,now=Date.now();
 const clock=t.mock.method(Date,'now',()=>now+120000);
 try{const result=await f.send(inspectPath(f,first.body.preparation.invocationId));assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.body.preparation,undefined);assert.equal(f.requests.length,before);}finally{clock.mock.restore();}
});


test('confirmed PWCE review validates exact digest and CSRF before exposing a bounded fresh preview',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody()),r=first.body.preparation,assistantId=r.owner.assistantId;
 const confirm=(body,operation,csrf=f.csrfToken)=>f.app.pwcePreparation.withConfirmedReview(assistantId,r.invocationId,f.local,csrf,body,call(),operation);
 const body={idempotencyKey:first.body.idempotencyKey,confirmationDigest:r.confirmationDigest};let reached=0,savedFence;
 for(const value of [{...body,approved:true},{...body,confirmationDigest:'0'.repeat(64)},{...body,idempotencyKey:randomUUID()}])await assert.rejects(confirm(value,async()=>{reached++;}));
 await assert.rejects(confirm(body,async()=>{reached++;},'wrong'));assert.equal(reached,0);
 const before=f.requests.filter(r=>r.body?.operation==='authority.evaluate').length;
 assert.equal(await confirm(body,async proof=>{reached++;proof.assertCurrent();savedFence=proof.assertCurrent;assert.equal(proof.record.confirmationDigest,r.confirmationDigest);assert.equal(proof.evidence.decision.disposition,'authorized');assert.equal(proof.request.payload.invocationId,r.invocationId);return 'reviewed';}),'reviewed');
 assert.equal(reached,1);assert.throws(()=>savedFence());assert.equal(f.requests.filter(r=>r.body?.operation==='authority.evaluate').length,before+1);
 assert.ok(f.requests.every(r=>!['authority.authorizeDispatch','capabilities.invoke'].includes(r.body?.operation)));
});

test('confirmation rejects late results and fences a callback after current audience is withdrawn',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody()),r=first.body.preparation;
 await assert.rejects(f.app.pwcePreparation.withConfirmedReview(r.owner.assistantId,r.invocationId,f.local,f.csrfToken,{idempotencyKey:first.body.idempotencyKey,confirmationDigest:r.confirmationDigest},call(),async proof=>{
  await f.send('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});assert.throws(()=>proof.assertCurrent());return 'late';
 }));
 assert.equal(f.db.connection.prepare('SELECT COUNT(*) AS n FROM pwce_admission_custody').get().n,0);
});


test('confirmation cannot substitute an earlier authorized preview after PWCE denies the action',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody()),r=first.body.preparation;f.state.previewDenied=true;let reached=false;
 await assert.rejects(f.app.pwcePreparation.withConfirmedReview(r.owner.assistantId,r.invocationId,f.local,f.csrfToken,{idempotencyKey:first.body.idempotencyKey,confirmationDigest:r.confirmationDigest},call(),async()=>{reached=true;}));
 assert.equal(reached,false);const retained=JSON.parse(f.db.connection.prepare('SELECT payload_json FROM pwce_action_preparations').get().payload_json);assert.equal(retained.originalPreview.decision.disposition,'authorized');assert.equal(retained.confirmationDigest,r.confirmationDigest);
});

test('revocation while confirmation awaits a fresh preview prevents entry to the dispatch callback',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody()),r=first.body.preparation;let reached=false;
 f.state.hook=async phase=>{if(phase==='authority.evaluate'){f.emit('authority.revoked');await new Promise(resolve=>setImmediate(resolve));}};
 await assert.rejects(f.app.pwcePreparation.withConfirmedReview(r.owner.assistantId,r.invocationId,f.local,f.csrfToken,{idempotencyKey:first.body.idempotencyKey,confirmationDigest:r.confirmationDigest},call(),async()=>{reached=true;}));assert.equal(reached,false);
});


test('HTTP confirmation cannot activate dispatch without explicit dispatcher and journal configuration',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody()),r=first.body.preparation,path=f.path+'/invocations/'+r.invocationId+'/confirm';
 const result=await f.send(path,{idempotencyKey:first.body.idempotencyKey,confirmationDigest:r.confirmationDigest});assert.equal(result.status,503);assert.equal(result.body.code,'pwce_dispatch_not_configured');
 assert.equal((await f.send(path)).status,405);assert.equal((await f.send(path+'?override=true',{})).status,422);
 assert.ok(f.requests.every(r=>!['authority.authorizeDispatch','capabilities.invoke'].includes(r.body?.operation)));
});

test('confirmed action cannot use another deployment journal',async t=>{
 const f=await http(t);await prepareAudience(f);const first=await f.send(preparationPath(f),preparationBody()),r=first.body.preparation,root=mkdtempSync(join(tmpdir(),'ls-foreign-journal-'));
 const journal=new PwceActionJournal({stateDirectory:root,deploymentId:randomUUID(),create:true});t.after(()=>{journal.close();rmSync(root,{recursive:true,force:true});});
 await assert.rejects(f.app.pwcePreparation.dispatchConfirmed(r.owner.assistantId,r.invocationId,f.local,f.csrfToken,{idempotencyKey:first.body.idempotencyKey,confirmationDigest:r.confirmationDigest},call(),journal,{}),{code:'pwce_journal_deployment_mismatch'});
 assert.equal(journal.admissions.read(first.body.idempotencyKey),undefined);assert.equal(journal.invocations.read(r.invocationId),undefined);
});


test('historical scope reads retain expired original catalog without acquiring or refreshing authority',async t=>{
 const f=gateway(t),o=owner(),original=await f.discovery.withCatalog(o,call(),async lease=>lease.record);f.discovery.close();
 const restored=new PwceCapabilityDiscovery(f.profile,'synthetic-agent-token');t.after(()=>restored.close());const now=Date.now(),clock=t.mock.method(Date,'now',()=>now+120000),before=f.requests.length;
 try{
  const result=await restored.withHistoricalScope(o,call(),original,async lease=>{assert.ok(Date.parse(lease.record.snapshot.expiresAt)<Date.now());assert.equal(lease.catalog.retained(original.snapshot.snapshotId,original.scope),undefined);lease.catalog.assertReadScope(original,original.scope,original.executionMode,lease.context);return lease.record;});assert.deepEqual(result,original);
  const added=f.requests.slice(before);assert.ok(added.some(r=>r.body?.operation==='events.subscribe'));assert.ok(added.every(r=>!r.path.endsWith('/authority')&&!['capabilities.getSnapshot','authority.evaluate','authority.authorizeDispatch','capabilities.invoke'].includes(r.body?.operation)));
  await assert.rejects(restored.withCatalog(o,call(),async()=>assert.fail('expired snapshot reached execution lease'),original));
 }finally{clock.mock.restore();}
});

test('historical scope refuses foreign owners and cancels late results on invalidation',async t=>{
 const f=gateway(t),o=owner(),original=await f.discovery.withCatalog(o,call(),async lease=>lease.record),before=f.requests.length;
 await assert.rejects(f.discovery.withHistoricalScope({...o,principalId:randomUUID()},call(),original,async()=>assert.fail('foreign historical read')));assert.equal(f.requests.length,before);
 await assert.rejects(f.discovery.withHistoricalScope(o,call(),original,async()=>{f.emit('authority.revoked');await new Promise(resolve=>setImmediate(resolve));return 'late';}));
});
