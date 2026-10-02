import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {createAuthenticatedGameTransport,GameControlFrameDecoder,encodeGameControlFrame} from '../src/transport.ts';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_BASE_PATH,gameHostDigest} from '@lifestream/contracts/game-host';
import type {GameHostCommand} from '@lifestream/contracts/game-host';
import type {GameActivityAdapter} from '../src/port.ts';
import {guardGameActivityAdapter} from '../src/provider.ts';
import {WindowsGameHostClient,GameHostClientError,type WindowsGameHostClientOptions,type GameHostFenceContext} from '../src/game-host-client.ts';
import {observe,action,observed,applied} from './game-host-fixtures.ts';
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const future=(ms=5000)=>new Date(Date.now()+ms).toISOString();
type Handler=(body:any,signal:AbortSignal)=>Promise<Response>|Response;
function harness(request=observe()){
 const attachmentId=randomUUID(),calls:{route:string;body:any}[]=[],order:string[]=[],fences:GameHostFenceContext[]=[],queue:Response[]=[];
 let pending:((r:Response)=>void)|undefined,polls=0,maxPolls=0,closeCount=0,current=true,qualified=true,nativeCalls=0;
 const command:GameHostCommand={protocol,kind:'command',attachmentId,commandId:randomUUID(),requestDigest:gameHostDigest(request),expiresAt:request.deadlineAt,request};
 const send=(value:unknown,status=200)=>{const r=value instanceof Response?value:response(value,status);if(pending){const resolve=pending;pending=undefined;resolve(r);}else queue.push(r);};
 const handlers:Record<string,Handler>={
  attach:()=>response({protocol,attachmentId,expiresAt:future(),pollMs:1000,maxMessageBytes:131072}),
  next:async(_body,signal)=>{polls++;maxPolls=Math.max(maxPolls,polls);try{if(queue.length)return queue.shift()!;return await new Promise<Response>((resolve,reject)=>{const abort=()=>{pending=undefined;reject(Error('Fixture aborted'));};pending=r=>{signal.removeEventListener('abort',abort);resolve(r);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}finally{polls--; }},
  admit:body=>{order.push('admit');return response({...body,admitted:true,expiresAt:command.expiresAt});},
  result:body=>{order.push('result');setTimeout(()=>send({error:'authentication_required'},401),5);return response({protocol,attachmentId,commandId:body.commandId,resultDigest:body.resultDigest,accepted:true});},
  detach:body=>response({...body,fenced:true})
 };
 const unavailable=async()=>{throw Error('Unimplemented fixture');};
 const raw:GameActivityAdapter={observe:async r=>{nativeCalls++;order.push('native');return observed(r);},applyController:async r=>{nativeCalls++;order.push('native');return applied(r);},releaseControls:unavailable,controlSave:unavailable};
 const options:WindowsGameHostClientOptions={attach:{protocol,hostId:randomUUID(),scope:request.scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-bridge',sourceRevision:'b'.repeat(64)},
  fetchAuthenticated:async(url,init)=>{assert.equal(url.startsWith('http://127.0.0.1:43182'+GAME_HOST_BASE_PATH+'/'),true);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(Object.keys(init.headers!).length,1);const route=url.split('/').at(-1)!;const body=JSON.parse(init.body as string);calls.push({route,body});return handlers[route]!(body,init.signal!);},
  isScopeCurrent:()=>current,sourceIsQualified:()=>qualified,
  nativeBoundary:{providerRef:'synthetic-bridge',maxDurationMs:10000,sourceAvailable:()=>qualified,acceptObservation:()=>qualified,acceptAction:()=>qualified,reconcileEffect:async()=>false,admitRelease:async()=>true},
  openNative:async boundary=>({adapter:guardGameActivityAdapter(raw,boundary),close:()=>{closeCount++;}}),
  shutdownExactOldLease:async context=>{fences.push(context);},httpTimeoutMs:1000,sessionDurationMs:10000,shutdownTimeoutMs:100};
 return {options,command,request,calls,order,fences,raw,handlers,send,get nativeCalls(){return nativeCalls;},get closeCount(){return closeCount;},get maxPolls(){return maxPolls;},set current(v:boolean){current=v;},set qualified(v:boolean){qualified=v;}};
}
async function run(h:ReturnType<typeof harness>,event:unknown=h.command){
 const client=new WindowsGameHostClient(h.options);h.send(event);await assert.rejects(client.run(),e=>e instanceof GameHostClientError);return client;
}
test('missing trusted ports stays inert and creates no attachment/native channel',async()=>{
 const client=new WindowsGameHostClient();assert.equal(client.snapshot.configured,false);await assert.rejects(client.run(),e=>e instanceof GameHostClientError&&e.code==='unconfigured');
 const h=harness();for(const key of ['fetchAuthenticated','isScopeCurrent','sourceIsQualified','openNative','shutdownExactOldLease'])assert.throws(()=>new WindowsGameHostClient({...h.options,[key]:undefined}as any));
 for(const key of ['sourceAvailable','acceptObservation','acceptAction','reconcileEffect','admitRelease'])assert.throws(()=>new WindowsGameHostClient({...h.options,nativeBoundary:{...h.options.nativeBoundary,[key]:undefined}}as any));assert.equal(h.calls.length,0);
});
test('actual native readiness is established before attach without an early effect claim',async()=>{
 const h=harness();let ready=false;
 h.options.nativeBoundary.sourceAvailable=()=>ready;
 h.options.openNative=async(boundary,context)=>{
  assert.equal(context.isCurrent(h.request.scope),true);assert.equal(h.calls.length,0);
  await assert.rejects(boundary.claimEffect!(action(),context));
  ready=true;return {adapter:guardGameActivityAdapter(h.raw,boundary),close:()=>{}};
 };
 const client=await run(h);assert.equal(client.snapshot.acceptedIngress,1);assert.equal(h.calls[0]?.route,'attach');
 const unavailable=harness();unavailable.options.nativeBoundary.sourceAvailable=()=>false;
 await run(unavailable);assert.equal(unavailable.calls.length,0);assert.equal(unavailable.nativeCalls,0);
});
test('native startup can exceed HTTP deadline without extending HTTP requests',async()=>{
 const h=harness(),open=h.options.openNative;h.options.nativeStartupTimeoutMs=2000;
 h.options.openNative=async(...args)=>{await new Promise(r=>setTimeout(r,1100));return open(...args);};
 const client=new WindowsGameHostClient(h.options),running=client.run();void running.catch(()=>{});
 await client.ready;assert.equal(client.snapshot.nativeConnected,true);assert.equal(client.snapshot.attached,true);
 client.close();await assert.rejects(running);
 const stalled=harness();stalled.options.nativeStartupTimeoutMs=2000;stalled.handlers.attach=()=>new Promise(()=>{});
 const timed=new WindowsGameHostClient(stalled.options);await assert.rejects(timed.run());assert.equal(timed.snapshot.reason,'transportLost');assert.equal(stalled.calls.length,1);
});

test('native startup deadline fences and closes a late connection before backend attach',async()=>{
 const h=harness(),open=h.options.openNative;h.options.nativeStartupTimeoutMs=20;
 h.options.openNative=async(...args)=>{await new Promise(r=>setTimeout(r,80));return open(...args);};
 const client=new WindowsGameHostClient(h.options);await assert.rejects(client.run());await assert.rejects(client.ready);
 await new Promise(r=>setTimeout(r,90));assert.equal(client.snapshot.reason,'transportLost');assert.equal(h.calls.length,0);assert.equal(h.closeCount,1);
 for(const value of [0,22001,Infinity])assert.throws(()=>new WindowsGameHostClient({...h.options,nativeStartupTimeoutMs:value}));
});

for(const kind of ['observe','action']as const)test(kind+' admits exactly once before native I/O and validates original completion',async()=>{
 const h=harness(kind==='action'?action():observe()),client=await run(h);assert.deepEqual(h.order,['admit','native','result']);assert.equal(h.maxPolls,1);assert.equal(h.nativeCalls,1);assert.equal(h.closeCount,1);assert.equal(client.snapshot.acceptedIngress,1);assert.equal(client.snapshot.pauseConfirmation,'unconfirmed');assert.equal(h.calls.filter(x=>x.route==='admit').length,1);assert.equal(h.calls.filter(x=>x.route==='detach').length,1);
 const completion=h.calls.find(x=>x.route==='result')!.body;assert.deepEqual(h.calls.find(x=>x.route==='admit')!.body,{protocol,attachmentId:h.command.attachmentId,commandId:h.command.commandId,requestDigest:h.command.requestDigest});assert.equal(completion.requestDigest,gameHostDigest(h.request));assert.equal(completion.resultDigest,gameHostDigest(completion.result));assert.equal(completion.result.requestId,h.request.requestId);
 if(kind==='action'){assert.deepEqual(h.fences[0]!.lastEnteredAction,h.request);assert.ok(Object.isFrozen(h.fences[0]!.lastEnteredAction!.payload));}
});
test('parallel poll cancels exact active operation and pursues captured old lease without accepting late result',async()=>{
 const h=harness(action());let finish!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>finish=r);
 h.raw.applyController=async r=>{entered();await held;return applied(r);};const client=new WindowsGameHostClient(h.options);h.send(h.command);const running=client.run();await started;
 h.send({protocol,kind:'cancel',attachmentId:h.command.attachmentId,commandId:h.command.commandId,requestDigest:h.command.requestDigest,cancellationId:h.request.cancellationId,reason:'cancelled'});
 await assert.rejects(running,e=>e instanceof GameHostClientError&&e.code==='cancelled');finish();await new Promise(r=>setTimeout(r,5));assert.equal(h.calls.filter(x=>x.route==='result').length,0);assert.equal(h.maxPolls,1);assert.deepEqual(h.fences[0]!.lastEnteredAction,h.request);assert.equal(h.closeCount,1);
});
for(const route of ['admit','result']as const)test('lost '+route+' acknowledgment never retries or redispatches',async()=>{
 const h=harness(action());h.handlers[route]=()=>{throw Error('Synthetic lost reply');};const client=await run(h);assert.equal(h.calls.filter(x=>x.route===route).length,1);assert.equal(h.calls.filter(x=>x.route==='attach').length,1);assert.equal(h.calls.filter(x=>x.route==='admit').length,1);assert.equal(h.nativeCalls,route==='admit'?0:1);assert.equal(client.snapshot.acceptedIngress,0);assert.equal(h.fences.length,1);
});
test('hung admission bounded timeout abandons a late valid reply without native entry',async()=>{
 const h=harness();let late!:(r:Response)=>void;h.handlers.admit=()=>new Promise(r=>late=r);const client=await run(h);late(response({protocol,attachmentId:h.command.attachmentId,commandId:h.command.commandId,requestDigest:h.command.requestDigest,admitted:true,expiresAt:h.command.expiresAt}));await new Promise(r=>setTimeout(r,5));assert.equal(client.snapshot.admissionAttempts,1);assert.equal(h.nativeCalls,0);
});
test('replayed consumed command is fenced without second admission',async()=>{
 const h=harness(action());h.handlers.result=body=>{setTimeout(()=>h.send(h.command),5);return response({protocol,attachmentId:h.command.attachmentId,commandId:body.commandId,resultDigest:body.resultDigest,accepted:true});};const c=await run(h);assert.equal(c.snapshot.reason,'invalidMessage');assert.equal(h.nativeCalls,1);assert.equal(h.calls.filter(x=>x.route==='admit').length,1);
});
for(const mode of ['attachment','command','digest','cancellation','scope','pins','save','simulation','extension']as const)test('unsupported or miscorrelated '+mode+' refuses native I/O',async()=>{
 const h=harness();const e:any=structuredClone(h.command);if(mode==='attachment')e.attachmentId=randomUUID();if(mode==='command'){e.kind='cancel';delete e.request;delete e.expiresAt;e.cancellationId=h.request.cancellationId;e.reason='cancelled';e.commandId=randomUUID();}if(mode==='digest')e.requestDigest='f'.repeat(64);if(mode==='cancellation'){e.kind='cancel';delete e.request;delete e.expiresAt;e.cancellationId=randomUUID();e.reason='cancelled';}if(mode==='scope')e.request.scope.timelineId=randomUUID();if(mode==='pins')e.request.payload.expectedPinsDigest='f'.repeat(64);if(mode==='save')e.request.operation='GameActivityAdapter.controlSave';if(mode==='simulation')e.request.executionMode='simulation';if(mode==='extension')e.expiresAt=future(20000);if(['scope','pins','save','simulation'].includes(mode))e.requestDigest=gameHostDigest(e.request);
 await run(h,e);assert.equal(h.nativeCalls,0);assert.equal(h.calls.filter(x=>x.route==='admit').length,0);
});
for(const mode of ['scope','source']as const)test(mode+' withdrawn after admission prevents native I/O',async()=>{
 const h=harness();h.handlers.admit=body=>{if(mode==='scope')h.current=false;else h.qualified=false;return response({...body,admitted:true,expiresAt:h.command.expiresAt});};await run(h);assert.equal(h.nativeCalls,0);assert.equal(h.calls.filter(x=>x.route==='admit').length,1);
});
for(const mode of ['expiredCommand','expiryDuringIO','expiredAdmission','extendedAdmission']as const)test(mode+' fences original work',async()=>{
 const h=harness();if(mode==='expiredCommand')h.command.expiresAt=new Date(0).toISOString();if(mode==='expiryDuringIO'){h.command.expiresAt=future(100);h.raw.observe=async()=>new Promise(()=>{});}if(mode==='expiredAdmission'||mode==='extendedAdmission')h.handlers.admit=body=>response({...body,admitted:true,expiresAt:mode==='expiredAdmission'?new Date(0).toISOString():future(30000)});
 await run(h);assert.equal(h.calls.filter(x=>x.route==='result').length,0);assert.equal(h.fences.length,1);
});
for(const mode of ['mismatchedAdmission','mismatchedResultAck','unqualifiedObservation','unqualifiedAction','wrongResultIdentity']as const)test(mode+' never becomes accepted native evidence',async()=>{
 const h=harness(mode==='unqualifiedAction'?action():observe());if(mode==='mismatchedAdmission')h.handlers.admit=body=>response({...body,commandId:randomUUID(),admitted:true,expiresAt:h.command.expiresAt});if(mode==='mismatchedResultAck')h.handlers.result=body=>response({protocol,attachmentId:h.command.attachmentId,commandId:randomUUID(),resultDigest:body.resultDigest,accepted:true});if(mode==='unqualifiedObservation')h.options.nativeBoundary.acceptObservation=()=>false;if(mode==='unqualifiedAction')h.options.nativeBoundary.acceptAction=()=>false;if(mode==='wrongResultIdentity')h.raw.observe=async r=>({...observed(r),requestId:randomUUID()});
 const c=await run(h);assert.equal(c.snapshot.acceptedIngress,0);assert.equal(h.calls.filter(x=>x.route==='result').length,mode==='mismatchedResultAck'?1:0);
});
for(const status of [400,401,403,404,409,410,413,503])test('HTTP '+status+' fences without retry',async()=>{
 const h=harness();h.handlers.attach=()=>response({error:'synthetic_denial'},status);const c=await run(h);assert.equal(c.snapshot.reason,'denied');assert.equal(h.calls.length,1);assert.equal(h.closeCount,1);assert.equal(h.nativeCalls,0);
});
for(const mode of ['length','stream','utf8','redirect','extra','contentType']as const)test('response '+mode+' is bounded/refused before native dispatch',async()=>{
 const h=harness();let cancelled=false;
 h.handlers.attach=()=>{if(mode==='length')return new Response('{}',{headers:{'content-type':'application/json','content-length':'131073'}});if(mode==='stream')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(70000));c.enqueue(new Uint8Array(70000));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}});if(mode==='utf8')return new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}});if(mode==='redirect'){const r=response({});Object.defineProperty(r,'redirected',{value:true});return r;}if(mode==='extra')return response({protocol,attachmentId:h.command.attachmentId,expiresAt:future(),pollMs:1000,maxMessageBytes:131072,token:'synthetic-forbidden'});return new Response('{}',{headers:{'content-type':'text/html'}});};await run(h);assert.equal(h.nativeCalls,0);assert.equal(h.closeCount,1);if(mode==='stream')assert.equal(cancelled,true);
});
test('rejected exact-old-lease shutdown intent blocks release admission',async()=>{
 const r=observe();const request={...r,operation:'GameActivityAdapter.releaseControls' as const,payload:{targetInputOwnerLeaseId:randomUUID(),reason:'policyChanged' as const,neutralButtons:{up:false,down:false,left:false,right:false,a:false,b:false,x:false,y:false,l:false,r:false,start:false,select:false}}};const h=harness(request as any);h.options.nativeBoundary.admitRelease=async()=>false;await run(h);assert.equal(h.calls.filter(x=>x.route==='admit').length,0);
});
test('release needs exact old-lease intent before remote entry and preserves stationary-frame evidence',async()=>{
 const r=observe(),lease=randomUUID(),request={...r,operation:'GameActivityAdapter.releaseControls' as const,payload:{targetInputOwnerLeaseId:lease,reason:'policyChanged' as const,neutralButtons:{up:false,down:false,left:false,right:false,a:false,b:false,x:false,y:false,l:false,r:false,start:false,select:false}}};
 const h=harness(request as any);h.options.nativeBoundary.admitRelease=async value=>{h.order.push('oldLeaseIntent');assert.equal(value.payload.targetInputOwnerLeaseId,lease);return true;};
 h.raw.releaseControls=async value=>{h.order.push('native');const time=new Date().toISOString();return {schemaVersion:'1.0.0',operation:value.operation,requestId:value.requestId,correlationId:value.correlationId,providerRef:'synthetic-bridge',completedAt:time,outcome:{status:'succeeded',error:null,payload:{targetInputOwnerLeaseId:lease,disposition:'neutralizedAndPaused',confirmedAt:time,emulatorPaused:true,buttonsNeutralized:true,pauseFrameNumber:10,verifiedFrameNumber:10,pauseConfirmedMonotonicMs:100,verifiedMonotonicMs:110,activityEpochAfterFence:2,confirmationSource:'adapterObserved',resumeRequiresFreshObservation:true}}};};
 const c=await run(h);assert.deepEqual(h.order,['oldLeaseIntent','admit','native','result']);assert.equal(c.snapshot.acceptedIngress,1);assert.equal(c.snapshot.pauseConfirmation,'unconfirmed');
});
test('a promise cannot masquerade as a strict native observation qualifier',async()=>{
 const h=harness();h.options.nativeBoundary.acceptObservation=(()=>Promise.resolve(true))as any;const c=await run(h);assert.equal(c.snapshot.acceptedIngress,0);assert.equal(h.calls.filter(x=>x.route==='result').length,0);
});
test('admission identities cannot be exchanged despite valid schema',async()=>{
 const h=harness();h.handlers.admit=body=>response({...body,requestDigest:'f'.repeat(64),admitted:true,expiresAt:h.command.expiresAt});await run(h);assert.equal(h.nativeCalls,0);
});
test('caller abort closes only owned connection and cleanup is bounded despite uncooperative shutdown',async()=>{
 const h=harness();h.options.shutdownExactOldLease=async()=>new Promise(()=>{});const controller=new AbortController(),client=new WindowsGameHostClient(h.options);const running=client.run(controller.signal);setTimeout(()=>controller.abort(),30);await assert.rejects(running);assert.equal(h.closeCount,1);assert.equal(client.snapshot.pauseConfirmation,'unconfirmed');
});
test('composed boundary admits after mutual native authentication and returns a correlated receipt over owned TCP',async()=>{
 const h=harness(),secret=Buffer.alloc(32,23),server=createServer();let peer:ReturnType<typeof connect>|undefined,transport:ReturnType<typeof createAuthenticatedGameTransport>|undefined;
 let joined!:(v:ReturnType<typeof createAuthenticatedGameTransport>)=>void,verified!:()=>void;
 const nativeJoined=new Promise<ReturnType<typeof createAuthenticatedGameTransport>>(r=>joined=r),peerVerified=new Promise<void>(r=>verified=r);
 h.options.openNative=async boundary=>{
  server.once('connection',socket=>{transport=createAuthenticatedGameTransport(socket,{pairingSecret:secret,scope:h.request.scope,pinsDigest:'a'.repeat(64),authenticationTimeoutMs:1000,sessionDurationMs:5000,boundary,onDisconnect:()=>{}});joined(transport);});
  server.listen({host:'127.0.0.1',port:0,exclusive:true});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');peer=connect(address.port,'127.0.0.1');peer.on('error',()=>{});
  let challenge='';const decoder=new GameControlFrameDecoder(text=>{const value=JSON.parse(text);
   if(value.type==='challenge'){challenge=text;peer!.write(encodeGameControlFrame(JSON.stringify({type:'authenticate',proof:createHmac('sha256',secret).update(text).digest('hex')})));}
   else if(value.type==='authenticated'){assert.equal(value.proof,createHmac('sha256',secret).update('lifestream-game-control/1 host '+challenge).digest('hex'));h.order.push('authenticated');verified();}
   else{h.order.push('native');assert.deepEqual(value,h.request);peer!.write(encodeGameControlFrame(JSON.stringify(observed(value))));}
  });peer.on('data',data=>decoder.push(data));const owned=await nativeJoined;await owned.ready;await peerVerified;
  return {adapter:owned.adapter,close:()=>{owned.close();peer!.destroy();}};
 };
 try{const c=await run(h);assert.deepEqual(h.order,['authenticated','admit','native','result']);assert.equal(c.snapshot.acceptedIngress,1);assert.equal(h.calls.filter(x=>x.route==='admit').length,1);assert.deepEqual(secret,Buffer.alloc(32,23));}
 finally{transport?.close();peer?.destroy();await new Promise<void>(resolve=>server.listening?server.close(()=>resolve()):resolve());secret.fill(0);}
});
