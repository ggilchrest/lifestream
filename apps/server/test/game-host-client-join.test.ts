import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_BASE_PATH} from '@lifestream/contracts/game-host';
import {WindowsGameHostClient,GameHostClientError,guardGameActivityAdapter} from '@lifestream/providers-bizhawk';
import type {GameHostFenceContext} from '@lifestream/providers-bizhawk';
import {GameHostPort} from '../src/runtime/game-host-port.ts';
import type {GameHostJoin} from '../src/runtime/game-host-port.ts';
import {handleGameHostHttp} from '../src/runtime/game-host-http.ts';
import {fixture} from './fixtures/game-host.ts';

// Actual coordinator, SQLite CAS and HTTP envelopes. Authentication/source/native
// evidence remain explicitly synthetic; local-auth route fences have their own
// Linux-qualified tests. This creates no runtime account, key, ROM or model call.
for(const scenario of ['qualifiedReceipt','lostAdmissionAck','lostResultAck','nativeQualifierWithdrawn']as const)test('joined Windows client/backend '+scenario,{timeout:10000},async()=>{
 const f=fixture(),hostId=randomUUID(),metadata={protocol,hostId,scope:f.input.request.scope,pinsDigest:f.input.request.payload.expectedPinsDigest,providerRef:'scripted:guarded',sourceRevision:'b'.repeat(64)},actor={principalId:metadata.scope.principalId,sessionId:metadata.scope.contextBinding.sessionId,isCurrent:()=>true};
 const {protocol:_,...binding}=metadata;let join!:GameHostJoin,coordinated!:ReturnType<GameHostJoin['runController']>,nativeQualified=true,closed=0;
 const requests:string[]=[],fences:GameHostFenceContext[]=[],states:string[]=[],controller=new AbortController();
 const port=new GameHostPort(f.db,{maxAttachments:1,maxDurationMs:10000,createRepository:()=>f.repository,resolveAttachment:()=>binding,bindingCurrent:()=>true,controllerCurrent:()=>true,
  boundary:{sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>true,reconcileEffect:async()=>false,admitRelease:async()=>true},
  onAttached:value=>{join=value;coordinated=join.runController(f.input,{signal:f.controller.signal,current:f.ports.current,usageFor:f.ports.usageFor});void coordinated.catch(()=>{});}});
 const server=createServer((request,response)=>{void handleGameHostHttp(port,request,response,request.url!,()=>actor);});server.listen({host:'127.0.0.1',port:0,exclusive:true});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
 const client=new WindowsGameHostClient({attach:metadata,httpTimeoutMs:3000,sessionDurationMs:5000,shutdownTimeoutMs:100,
  isScopeCurrent:()=>true,sourceIsQualified:()=>true,
  nativeBoundary:{providerRef:'scripted:guarded',maxDurationMs:10000,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>nativeQualified,reconcileEffect:async()=>false,admitRelease:async()=>true},
  openNative:async boundary=>({adapter:guardGameActivityAdapter(f.rawAdapter,boundary),close:()=>closed++}),shutdownExactOldLease:async context=>{fences.push(context);},
  fetchAuthenticated:async(url,init)=>{
   const path=new URL(url).pathname;assert.equal(url,'http://127.0.0.1:43182'+path);assert.ok(path.startsWith(GAME_HOST_BASE_PATH+'/'));const route=path.split('/').at(-1)!;requests.push(route);
   if(route==='admit'){states.push(String(f.db.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state));assert.equal(states.at(-1),'claimed');assert.equal(f.calls(),0);}
   const response=await fetch(base+path,init);
   if(route==='admit'){states.push(String(f.db.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state));assert.equal(states.at(-1),'entered');if(scenario==='nativeQualifierWithdrawn')nativeQualified=false;}
   if(route==='admit'&&scenario==='lostAdmissionAck'||route==='result'&&scenario==='lostResultAck'){await response.body?.cancel();throw Error('Synthetic missing acknowledgment after actual server processing');}
   if(route==='result')setTimeout(()=>controller.abort(),10);
   // The fixture reroutes only within its injected trusted transport. Preserve
   // the requested fixed URL for the client's redirect/origin enforcement.
   return new Response(response.body,{status:response.status,headers:response.headers});
  }});
 try{
  await assert.rejects(client.run(controller.signal),e=>e instanceof GameHostClientError);const done=await coordinated;
  assert.deepEqual(states,['claimed','entered']);assert.equal(requests.filter(x=>x==='attach').length,1);assert.equal(requests.filter(x=>x==='admit').length,1);assert.equal(closed,1);assert.equal(fences.length,1);assert.equal(client.snapshot.pauseConfirmation,'unconfirmed');
  const reservation=f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!;
  if(scenario==='qualifiedReceipt'||scenario==='lostResultAck'){
   assert.equal(f.calls(),1);assert.equal(done.state,'settled');assert.equal(done.reservationHeld,false);assert.equal(reservation.state,'settled');assert.equal(f.repository.get(f.owner,f.input.request.scope.runId)!.used.frames,2);assert.equal(client.snapshot.acceptedIngress,scenario==='qualifiedReceipt'?1:0);assert.equal(requests.filter(x=>x==='result').length,1);
  }else{
   assert.equal(done.state,'requiresReconciliation');assert.equal(done.reservationHeld,true);assert.equal(reservation.state,'reserved');assert.equal(client.snapshot.acceptedIngress,0);assert.equal(requests.filter(x=>x==='result').length,0);assert.equal(f.calls(),scenario==='lostAdmissionAck'?0:1);
  }
  assert.equal((await join.runController(f.input,{signal:f.controller.signal,current:f.ports.current,usageFor:f.ports.usageFor})).state,'suppressed');assert.equal(requests.filter(x=>x==='admit').length,1);
 }finally{controller.abort();port.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.db.close();}
});
