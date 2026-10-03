import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {gameHostMessage,parseGameHostFramePath,gameHostFramePath,gameHostDigest} from '../../../packages/contracts/src/game-host.ts';
const {DesktopGameHostSessionBroker,trustedGameHostSender}=createRequire(import.meta.url)('../game-host-session-broker.cjs');
import {inspectGamePng} from '../../../packages/providers-bizhawk/src/frame-custody.ts';
import {frameFixture} from '../../../packages/providers-bizhawk/test/game-host-frame-fixtures.ts';
const origin='http://127.0.0.1:43182',protocol='lifestream.game-host.v1',time=Date.parse('2026-10-02T08:00:00Z');
const nativeEvidenceVersion='lifestream.native-game-evidence.v1';
function fixture(baseTime=time){
 const time=baseTime;
 const id=()=>randomUUID(),scope={assistantId:id(),principalId:id(),relationshipId:id(),environmentId:id(),activityId:id(),runId:id(),activityEpoch:1,timelineId:id(),timelineRevision:1,campaignId:id(),observationDomain:'simulatedGame',contextBinding:{conversationId:id(),sessionId:id(),endpointId:id(),participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef:'synthetic-broker-fixture'}};
 const attach={protocol,hostId:id(),scope,pinsDigest:'a'.repeat(64),providerRef:'fixture',sourceRevision:'b'.repeat(64)},endpoint={endpointId:scope.contextBinding.endpointId,ownership:'personal',privacyClass:'personal',health:'healthy'},binding={revision:1,endpoint,runtimeSourceRevision:'c'.repeat(64)},authentication={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,owner:true,adminExpiresAt:new Date(time+30000).toISOString(),csrfToken:'SYNTHETIC_TEST_ONLY_NOT_A_CREDENTIAL_1234567890'};
 let now=time,changed=false,failed=false,fences=0,transport;const calls=[],status=[],attachmentId=id(),context={conversationId:scope.contextBinding.conversationId,revision:1,endpoint,runtimeSelfContext:{audienceScope:'authenticatedSession',sourceRevision:binding.runtimeSourceRevision}};
 const partition={async fetch(url,init){calls.push({url,init});if(failed)return new Response('{}',{status:401,headers:{'content-type':'application/json'}});let body;
  if(url===origin+'/api/auth/v1/session')body=authentication;
  else if(url===origin+'/api/runtime/v1/session-context')body={...context,ended:changed};
  else if(url===origin+'/api/runtime/v1/game-host/attach')body={protocol,attachmentId,expiresAt:new Date(time+60000).toISOString(),pollMs:1000,maxMessageBytes:131072};
  else if(url===origin+'/api/runtime/v1/game-host/next')body={protocol,kind:'idle',attachmentId,expiresAt:new Date(time+60000).toISOString()};
  else throw Error('unexpected route');
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json','set-cookie':'SYNTHETIC_NEVER_FORWARDED'}});
 }};
 const broker=new DesktopGameHostSessionBroker({partition,gameHostMessage,parseGameHostFramePath,inspectGamePng,now:()=>now,onStatus:s=>status.push(s)});
 return {broker,partition,attach,binding,authentication,context,calls,status,attachmentId,start:(extra={})=>broker.start({attach,binding,...extra,expiresAt:new Date(time+60000).toISOString(),driverFactory:async options=>{transport=options;return {async fence(){fences++;}};}}),get transport(){return transport;},get fences(){return fences;},set changed(v){changed=v;},set failed(v){failed=v;},set now(v){now=v;}};
}
test('trusted main uses existing session, caches CSRF, and returns only typed JSON',async()=>{
 const f=fixture();try{await f.start();f.now=time+40000;const response=await f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach),headers:{cookie:'IGNORED',authorization:'IGNORED'}});assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.url,'');assert.equal((await response.json()).attachmentId,f.attachmentId);assert.equal(f.calls.filter(x=>x.url.endsWith('/api/auth/v1/session')).length,1);const post=f.calls.at(-1);assert.deepEqual(Object.keys(post.init.headers).sort(),['content-type','origin','x-lifestream-csrf']);assert.equal(post.init.headers.origin,origin);assert.equal(post.init.redirect,'error');assert.equal(post.init.credentials,'include');assert.equal(JSON.stringify(f.broker.status()).includes(f.authentication.csrfToken),false);assert.equal(JSON.stringify(f.broker.status()).includes(f.attach.scope.principalId),false);}finally{await f.broker.stop();}assert.equal(f.fences,1);assert.equal(f.broker.status().pauseConfirmed,false);
});

test('opted-in stop preserves one bounded historical receipt through the same partition without rechecking audience',async()=>{
 const f=fixture();f.attach.nativeEvidenceVersion=nativeEvidenceVersion;
 const fetch=f.partition.fetch;let transport,receipt,callsAtFence;
 f.partition.fetch=async(url,init)=>{
  if(url===origin+'/api/runtime/v1/game-host/shutdown'){f.calls.push({url,init});return new Response(JSON.stringify({protocol,attachmentId:f.attachmentId,recorded:true,nativeShutdownConfirmed:false}),{headers:{'content-type':'application/json'}});}
  return fetch(url,init);
 };
 await f.broker.start({attach:f.attach,binding:f.binding,expiresAt:new Date(time+60000).toISOString(),driverFactory:async options=>{
  transport=options;return {async fence(){
   callsAtFence=f.calls.length;f.context.runtimeSelfContext.audienceScope='unknown';
   await assert.rejects(transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/next',{method:'POST',body:JSON.stringify({protocol,attachmentId:f.attachmentId})}));
   const message={protocol,attachmentId:f.attachmentId,nativeEvidenceVersion,evidence:null};
   receipt=await (await transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/shutdown',{method:'POST',body:JSON.stringify(message)})).json();
   await assert.rejects(transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/shutdown',{method:'POST',body:JSON.stringify(message)}));
  }};
 }});
 await transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)});
 await f.broker.stop();assert.equal(receipt.nativeShutdownConfirmed,false);assert.equal(f.calls.length,callsAtFence+1);
 const post=f.calls.at(-1);assert.equal(post.init.credentials,'include');assert.equal(post.init.headers['x-lifestream-csrf'],f.authentication.csrfToken);assert.equal(post.init.headers.origin,origin);assert.equal(f.broker.status().authenticated,false);
});

for(const mode of ['legacy','wrongAttachment','expired'] )test('historical broker receipt refuses '+mode+' before partition ingress',async()=>{
 const f=fixture();if(mode!=='legacy')f.attach.nativeEvidenceVersion=nativeEvidenceVersion;
 let transport,callsAtFence;
 await f.broker.start({attach:f.attach,binding:f.binding,expiresAt:new Date(time+60000).toISOString(),driverFactory:async options=>{
  transport=options;return {async fence(){
   callsAtFence=f.calls.length;if(mode==='expired')f.now=time+5001;
   const message={protocol,attachmentId:mode==='wrongAttachment'?randomUUID():f.attachmentId,nativeEvidenceVersion,evidence:null};
   await assert.rejects(transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/shutdown',{method:'POST',body:JSON.stringify(message)}));
  }};
 }});
 await transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)});
 await f.broker.stop();assert.equal(f.calls.length,callsAtFence);assert.equal(f.broker.status().enabled,false);
});

for(const mode of ['fetch','body'])test('historical receipt abort bounds a stalled '+mode+' without retry',{timeout:2000},async()=>{
 const f=fixture();f.attach.nativeEvidenceVersion=nativeEvidenceVersion;const fetch=f.partition.fetch;let entered;
 const started=new Promise(resolve=>{entered=resolve;});
 f.partition.fetch=async(url,init)=>{
  if(url.endsWith('/shutdown')){f.calls.push({url,init});entered();return mode==='fetch'?new Promise(()=>{}):new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});}
  return fetch(url,init);
 };
 await f.start();try{
  await f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)});
  const controller=new AbortController(),pending=f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/shutdown',{method:'POST',body:JSON.stringify({protocol,attachmentId:f.attachmentId,nativeEvidenceVersion,evidence:null}),signal:controller.signal});
  await started;controller.abort();await assert.rejects(pending);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/shutdown')).length,1);
 }finally{await f.broker.stop();}
});
test('transport rejects arbitrary origins, paths, query, schemas and mutated attach',async()=>{
 const f=fixture();await f.start();try{for(const url of ['http://example.org/api/runtime/v1/game-host/next',origin+'/api/auth/v1/accounts',origin+'/api/runtime/v1/game-host/next?x=1','file:///C:/secret',origin+'/api/runtime/v1/game-host/next#x'])await assert.rejects(f.transport.fetchAuthenticated(url,{method:'POST',body:'{}'}));await assert.rejects(f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify({...f.attach,providerRef:'other'})}));assert.equal(f.calls.length,2);}finally{await f.broker.stop();}
});
test('session change, auth loss and hard expiry fence the trusted driver',async()=>{
 for(const change of ['changed','failed','now']){const f=fixture();await f.start();await f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)});f[change]=change==='now'?time+60001:true;await assert.rejects(f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/next',{method:'POST',body:JSON.stringify({protocol,attachmentId:f.attachmentId})}));await f.broker.stop();assert.equal(f.fences,1);assert.equal(f.broker.status().authenticated,false);assert.equal(f.broker.status().enabled,false);}
});
test('fresh administrative auth and immutable deadline are required at initial attach',async()=>{
 const expired=fixture();expired.authentication.adminExpiresAt=new Date(time-1).toISOString();await assert.rejects(expired.start());assert.equal(expired.transport,undefined);const wrong=fixture();wrong.authentication.sessionId=randomUUID();await assert.rejects(wrong.start());assert.equal(wrong.transport,undefined);
 const late=fixture();await assert.rejects(late.broker.start({attach:late.attach,binding:late.binding,expiresAt:'2026-10-02T14:00:00.001Z',driverFactory:async()=>({fence:async()=>{}})}));assert.equal(late.calls.length,0);
});
test('reopened action windows retain finite sessions and exact expiry fencing',async()=>{
 const f=fixture(Date.parse('2026-10-02T15:00:00Z'));
 await f.start();assert.equal(f.broker.status().enabled,true);
 f.now=Date.parse('2026-10-02T15:01:00Z');
 assert.equal(f.broker.status().enabled,false);await f.broker.stop();assert.equal(f.fences,1);
 const long=fixture(Date.parse('2026-10-02T15:00:00Z'));
 await assert.rejects(long.broker.start({attach:long.attach,binding:long.binding,expiresAt:'2026-10-02T15:10:00.001Z',driverFactory:async()=>({fence:async()=>{}})}));assert.equal(long.calls.length,0);
});

test('readiness checks the supplied partition and never exports credentials or starts a driver',async()=>{
 const f=fixture();const result=await f.broker.readiness();
 assert.equal(result.ready,true);assert.equal(result.sessionId,f.authentication.sessionId);assert.equal(result.endpointId,f.attach.scope.contextBinding.endpointId);
 assert.equal(JSON.stringify(result).includes(f.authentication.csrfToken),false);assert.equal(f.broker.status().enabled,false);assert.equal(f.transport,undefined);
 assert.deepEqual(f.calls.map(call=>new URL(call.url).pathname),['/api/auth/v1/session','/api/runtime/v1/session-context']);
 f.failed=true;assert.equal((await f.broker.readiness()).authenticated,false);
 const expired=fixture();expired.authentication.adminExpiresAt=new Date(time-1).toISOString();assert.equal((await expired.broker.readiness()).ready,false);
 const changed=fixture();changed.changed=true;assert.equal((await changed.broker.readiness()).contextCurrent,false);
});
test('renderer IPC accepts only the exact main frame, contents and origin',()=>{
 const frame={url:origin+'/control/'},contents={mainFrame:frame},window={webContents:contents,isDestroyed:()=>false};assert.equal(trustedGameHostSender({sender:contents,senderFrame:frame},window,origin),true);assert.equal(trustedGameHostSender({sender:contents,senderFrame:{url:frame.url}},window,origin),false);assert.equal(trustedGameHostSender({sender:{},senderFrame:frame},window,origin),false);frame.url='https://example.org';assert.equal(trustedGameHostSender({sender:contents,senderFrame:frame},window,origin),false);
});

for(const [mode,reason] of [['audience','audience_unavailable'],['conversation','conversation_unavailable'],['owner','owner_required'],['administration','administration_expired'],['endpoint','context_unavailable']])test('readiness and both admission paths agree on '+mode,async()=>{
 const f=fixture();
 if(mode==='audience')f.context.runtimeSelfContext.audienceScope='unknown';
 if(mode==='conversation')f.context.conversationId=null;
 if(mode==='owner')f.authentication.owner=false;
 if(mode==='administration')f.authentication.adminExpiresAt='not-a-date';
 if(mode==='endpoint')f.context.endpoint.health='unavailable';
 const readiness=await f.broker.readiness();assert.equal(readiness.ready,false);assert.equal(readiness.blockingReason,reason);
 await assert.rejects(f.broker.sessionBinding(),error=>error.code===reason);
 await assert.rejects(f.start(),error=>error.code===reason);assert.equal(f.transport,undefined);
 assert.equal(f.calls.some(call=>call.init.method!=='GET'),false);assert.equal(JSON.stringify(readiness).includes(f.authentication.csrfToken),false);
});
test('protected audience fences an active transport even if a source digest is erroneously unchanged',async()=>{
 const f=fixture();await f.start();try{await f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)});
 f.context.runtimeSelfContext.audienceScope='unknown';await assert.rejects(f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/next',{method:'POST',body:JSON.stringify({protocol,attachmentId:f.attachmentId})}));assert.equal(f.broker.status().enabled,false);
 }finally{await f.broker.stop();}assert.equal(f.fences,1);
});
test('stop during pending authentication cannot reactivate the broker or create a driver',async()=>{
 const f=fixture(),fetch=f.partition.fetch;let resume;
 f.partition.fetch=async(url,init)=>{if(url.endsWith('/api/auth/v1/session'))await new Promise(resolve=>{resume=resolve;});return fetch(url,init);};
 const started=f.start();await new Promise(resolve=>setImmediate(resolve));await f.broker.stop('stop');resume();
 await assert.rejects(started);assert.equal(f.transport,undefined);assert.equal(f.broker.status().enabled,false);assert.equal(f.broker.status().authenticated,false);
});

test('only the current attachment can use the privileged transport',async()=>{
 const f=fixture();await f.start();try{await f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)});const calls=f.calls.length;await assert.rejects(f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/next',{method:'POST',body:JSON.stringify({protocol,attachmentId:randomUUID()})}));await assert.rejects(f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)}));assert.equal(f.calls.length,calls);}finally{await f.broker.stop();}
});
test('oversize authenticated responses fail closed and fence the driver',async()=>{
 const f=fixture();await f.start();f.partition.fetch=async()=>new Response(JSON.stringify({value:'x'.repeat(131072)}),{headers:{'content-type':'application/json'}});await assert.rejects(f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/attach',{method:'POST',body:JSON.stringify(f.attach)}));await f.broker.stop();assert.equal(f.fences,1);assert.equal(f.broker.status().authenticated,false);
});
test('main controls deny subframe stop and hold close until bounded driver fencing',async()=>{
 const {installGameHostControls}=createRequire(import.meta.url)('../game-host-controls.cjs'),f=fixture();await f.start();
 const handlers=new Map(),ipcMain={handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)},frame={url:origin+'/control/'},window=new EventEmitter(),notifications=[];let destroyed=false,prevented=false;
 window.webContents={mainFrame:frame,send:(name,value)=>notifications.push({name,value})};window.isDestroyed=()=>destroyed;window.close=()=>{let cancelled=false;window.emit('close',{preventDefault(){cancelled=true;prevented=true;}});if(!cancelled){destroyed=true;window.emit('closed');}};
 const controls=installGameHostControls({ipcMain,window,origin});controls.bindBroker(f.broker);assert.throws(()=>controls.bindBroker(f.broker));
 assert.equal((await handlers.get('game-host-stop')({sender:window.webContents,senderFrame:{url:frame.url}})).state,'disabled');assert.equal(f.fences,0);
 assert.equal((await handlers.get('game-host-status')({sender:window.webContents,senderFrame:frame})).enabled,true);window.close();assert.equal(prevented,true);await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.fences,1);assert.equal(destroyed,true);assert.equal(handlers.size,0);assert.equal(JSON.stringify(notifications).includes(f.authentication.csrfToken),false);
});


const frameTransfer={purpose:'simulatedGame/gameFramebuffer',maximumFrames:1,maximumBytes:2097152,maximumLongEdge:1024,maximumAgeMs:30000};
async function frameBroker(){
 const f=fixture(Date.now()),image=frameFixture(150000);f.now=Date.now();
 const request=structuredClone(image.request);request.scope=f.attach.scope;request.payload.expectedPinsDigest=f.attach.pinsDigest;
 const result=structuredClone(image.result);result.requestId=request.requestId;result.correlationId=request.correlationId;result.providerRef=f.attach.providerRef;result.outcome.payload.observation.scope=f.attach.scope;result.outcome.payload.observation.pinsDigest=f.attach.pinsDigest;
 const command={...image.command,attachmentId:f.attachmentId,request,requestDigest:gameHostDigest(request),expiresAt:request.deadlineAt};
 const completion={protocol,attachmentId:f.attachmentId,commandId:command.commandId,requestDigest:command.requestDigest,resultDigest:gameHostDigest(result),result};
 const fetch=f.partition.fetch;let delivered=false;
 f.partition.fetch=async(url,init)=>{const path=new URL(url).pathname,route=path.slice('/api/runtime/v1/game-host/'.length).split('/')[0];if(['next','admit','frame','result'].includes(route)){
  f.calls.push({url,init});const body=route==='frame'?Buffer.from(init.body):JSON.parse(init.body);let reply;
  if(route==='next'){if(delivered)throw Error('Already delivered');delivered=true;reply=command;}
  if(route==='admit')reply={...body,admitted:true,expiresAt:command.expiresAt};
  if(route==='frame'){assert.deepEqual(body,image.png);body.fill(0);reply={accepted:true};}
  if(route==='result')reply={protocol,attachmentId:body.attachmentId,commandId:body.commandId,resultDigest:body.resultDigest,accepted:true};
  return new Response(JSON.stringify(reply),{headers:{'content-type':'application/json'}});
 }return fetch(url,init);};
 const post=(route,body)=>f.transport.fetchAuthenticated(origin+'/api/runtime/v1/game-host/'+route,{method:'POST',body:JSON.stringify(body)}),upload=(path=gameHostFramePath(command,result.outcome.payload.observation.screenshots[0].mediaRef),png=image.png)=>f.transport.fetchAuthenticated(origin+path,{method:'POST',body:png,headers:{'content-type':'image/png'}});
 await f.start({frameTransfer});await post('attach',f.attach);return {f,image,command,completion,post,upload};
}
test('finite raw custody lane binds one admitted observe, rejects replay and requires byte-correlated result',async()=>{
 const {f,image,command,completion,post,upload}=await frameBroker();try{
  const before=f.calls.length;await assert.rejects(upload());assert.equal(f.calls.length,before);
  await post('next',{protocol,attachmentId:f.attachmentId});await assert.rejects(upload());
  await post('admit',{protocol,attachmentId:f.attachmentId,commandId:command.commandId,requestDigest:command.requestDigest});await assert.rejects(post('result',completion));assert.equal(f.calls.some(call=>call.url.endsWith('/result')),false);
  const uploaded=await (await upload()).json();assert.deepEqual(uploaded,{accepted:true});assert.ok(image.png.length>131072);await assert.rejects(upload());
  const foreign=structuredClone(completion);foreign.result.outcome.payload.observation.screenshots[0].sha256='f'.repeat(64);foreign.resultDigest=gameHostDigest(foreign.result);await assert.rejects(post('result',foreign));await post('result',completion);
  assert.equal(f.calls.filter(call=>call.url.includes('/game-host/frame/')).length,1);assert.ok(f.calls.find(call=>call.url.includes('/game-host/frame/')).init.body.every(byte=>byte===0));
 }finally{await f.broker.stop();}
});
test('frame opt-in, request identity, malformed bytes and current context remain independent gates',async()=>{
 const disabled=fixture(Date.now());await disabled.start();try{const before=disabled.calls.length;const f=frameFixture();await assert.rejects(disabled.transport.fetchAuthenticated(origin+gameHostFramePath(f.command,f.result.outcome.payload.observation.screenshots[0].mediaRef),{method:'POST',body:f.png,headers:{'content-type':'image/png'}}));assert.equal(disabled.calls.length,before);}finally{await disabled.broker.stop();}
 for(const mode of ['command','attachment','digest','context','bytes','source']){const {f,image,command,post,upload}=await frameBroker();try{
  await post('next',{protocol,attachmentId:f.attachmentId});await post('admit',{protocol,attachmentId:f.attachmentId,commandId:command.commandId,requestDigest:command.requestDigest});
  let path=gameHostFramePath(command,image.result.outcome.payload.observation.screenshots[0].mediaRef),png=image.png;
  if(mode==='command')path=path.replace(command.commandId,randomUUID());if(mode==='attachment')path=path.replace(command.attachmentId,randomUUID());if(mode==='digest')path=path.replace(command.requestDigest,'f'.repeat(64));if(mode==='context')f.changed=true;if(mode==='bytes')png=Buffer.alloc(70);if(mode==='source')f.now=Date.parse(command.expiresAt)+1;
  await assert.rejects(upload(path,png),mode);assert.equal(f.calls.some(call=>call.url.includes('/game-host/frame/')),false,mode);
 }finally{await f.broker.stop();}}
});
