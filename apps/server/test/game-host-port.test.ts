import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GAME_HOST_PROTOCOL as protocol,gameHostDigest} from '@lifestream/contracts/game-host';
import {Database} from '../../../packages/storage-sqlite/src/database.ts';
import {GameHostDispatchRepository} from '../../../packages/storage-sqlite/src/game-host-dispatch.ts';
import {GameHostPort,GameHostError} from '../src/runtime/game-host-port.ts';
import type {GameHostJoin,GameHostOptions} from '../src/runtime/game-host-port.ts';
import {fixture} from './fixtures/game-host.ts';
function host(f:ReturnType<typeof fixture>,patch:Partial<GameHostOptions>={}){
 const metadata={protocol,hostId:randomUUID(),scope:f.input.request.scope,pinsDigest:f.input.request.payload.expectedPinsDigest,providerRef:'scripted:guarded',sourceRevision:'b'.repeat(64)};
 let current=true,native=true,join:GameHostJoin|undefined;
 const actor={principalId:metadata.scope.principalId,sessionId:metadata.scope.contextBinding.sessionId,isCurrent:()=>current};
 const {protocol:_,...binding}=metadata;
 const options:GameHostOptions={maxAttachments:2,maxDurationMs:10000,createRepository:()=>f.repository,resolveAttachment:()=>binding,bindingCurrent:()=>current,controllerCurrent:()=>current,boundary:{sourceAvailable:()=>current,acceptAction:()=>native,acceptObservation:()=>native,admitRelease:async()=>current},onAttached:j=>join=j,...patch};
 const port=new GameHostPort(f.db,options);let attached;try{attached=port.attach(actor,metadata);}catch(error){port.close();throw error;}
 const poll=()=>port.next(actor,{protocol,attachmentId:attached.attachmentId},new AbortController().signal);
 const run=()=>join!.runController(f.input,{signal:f.controller.signal,current:f.ports.current,usageFor:f.ports.usageFor});
 return {port,actor,metadata,attached,poll,run,join:()=>join!,withdraw:()=>current=false,native:(v:boolean)=>native=v};
}
test('actual prepared coordinator reserves, durable claim precedes delivery, final entry CAS is once, qualified receipt settles',async t=>{
 const f=fixture();t.after(()=>f.db.close());const h=host(f);t.after(()=>h.port.close());const pending=h.run(),event=await h.poll();assert.equal(event.kind,'command');if(event.kind!=='command')throw Error();
 assert.equal(f.db.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state,'claimed');assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');
 const admission={protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest};assert.equal(h.port.admit(h.actor,admission).admitted,true);assert.equal(f.db.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state,'entered');assert.throws(()=>h.port.admit(h.actor,admission),(e:unknown)=>e instanceof GameHostError&&e.status===409);
 const result=await f.rawAdapter.applyController(event.request as never);const completion={...admission,resultDigest:gameHostDigest(result),result};assert.equal(h.port.complete(h.actor,completion).accepted,true);
 const done=await pending;assert.equal(done.state,'settled');assert.equal(done.reservationHeld,false);assert.equal(done.playAuthority,false);assert.equal(f.calls(),1);assert.equal(f.repository.get(f.owner,f.input.request.scope.runId)!.used.frames,2);
 assert.throws(()=>h.port.complete(h.actor,completion));assert.equal((await h.run()).state,'suppressed');assert.equal(f.calls(),1);
});
for(const kind of ['cancelBeforeAdmission','lostAdmissionAck','scopeAfterDelivery','wrongResult','unqualifiedReceipt','lostResult'] as const)test('host '+kind+' retains uncertainty and forbids redispatch',async t=>{
 const f=fixture();t.after(()=>f.db.close());const h=host(f);t.after(()=>h.port.close());const pending=h.run(),event=await h.poll();assert.equal(event.kind,'command');if(event.kind!=='command')throw Error();const admission={protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest};
 if(kind!=='cancelBeforeAdmission'&&kind!=='scopeAfterDelivery')h.port.admit(h.actor,admission);
 if(kind==='scopeAfterDelivery'){h.withdraw();assert.throws(()=>h.port.admit(h.actor,admission));}
 else if(kind==='wrongResult'){const result=await f.rawAdapter.applyController(event.request as never);result.requestId=randomUUID();assert.throws(()=>h.port.complete(h.actor,{...admission,resultDigest:gameHostDigest(result),result}));f.controller.abort();}
 else if(kind==='unqualifiedReceipt'){h.native(false);const result=await f.rawAdapter.applyController(event.request as never);h.port.complete(h.actor,{...admission,resultDigest:gameHostDigest(result),result});}
 else f.controller.abort();
 const done=await pending;assert.equal(done.state,'requiresReconciliation');assert.equal(done.reservationHeld,true);assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');assert.equal((await h.run()).state,'suppressed');
 if(kind!=='scopeAfterDelivery'&&kind!=='unqualifiedReceipt'){const cancel=await h.poll();assert.equal(cancel.kind,'cancel');if(cancel.kind==='cancel')assert.equal(cancel.cancellationId,event.request.cancellationId);}
});
test('one poll and command; cancellation reaches a parallel poll without replay',async t=>{
 const f=fixture();t.after(()=>f.db.close());const h=host(f);t.after(()=>h.port.close());const waiting=h.poll();await assert.rejects(h.poll(),e=>e instanceof GameHostError&&e.status===409);const running=h.run(),event=await waiting;assert.equal(event.kind,'command');const cancellation=h.poll();f.controller.abort();assert.equal((await cancellation).kind,'cancel');assert.equal((await running).state,'requiresReconciliation');
});
test('foreign authenticated actor and altered source metadata cannot reuse attachment',async t=>{
 const f=fixture();t.after(()=>f.db.close());const h=host(f);t.after(()=>h.port.close());assert.throws(()=>h.port.detach({...h.actor,principalId:randomUUID()},{protocol,attachmentId:h.attached.attachmentId}),e=>e instanceof GameHostError&&e.status===403);assert.throws(()=>h.port.attach(h.actor,{...h.metadata,sourceRevision:'c'.repeat(64)}),e=>e instanceof GameHostError&&e.status===503);
});
test('unconfigured source or missing receipt qualifier never grants native entry',async t=>{
 const f=fixture();t.after(()=>f.db.close());assert.throws(()=>host(f,{resolveAttachment:()=>null}),e=>e instanceof GameHostError&&e.status===503);
 const h=host(f,{boundary:{sourceAvailable:()=>true}});t.after(()=>h.port.close());const done=await h.run();assert.equal(done.state,'requiresReconciliation');assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);assert.equal(f.calls(),0);
});
test('direct adapter cannot bypass existing coordinator reservation',async t=>{
 const f=fixture();t.after(()=>f.db.close());const h=host(f);t.after(()=>h.port.close());await assert.rejects(h.join().adapter.applyController(f.input.request,{signal:f.controller.signal,isCurrent:()=>true}));assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);assert.equal(f.calls(),0);
});
test('durable claim rolls back on authority withdrawal after write',t=>{
 const f=fixture();t.after(()=>f.db.close());assert.equal(f.repository.reserveController(f.owner,f.input.request),true);const repo=new GameHostDispatchRepository(f.db,f.repository);let checks=0;const identity={attachmentId:randomUUID(),hostId:randomUUID(),commandId:randomUUID(),requestDigest:gameHostDigest(f.input.request),sourceRevision:'b'.repeat(64)};
 assert.throws(()=>repo.claim(f.owner,f.input.request,identity,()=>++checks<3));assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,0);assert.equal(f.db.connection.prepare('PRAGMA synchronous').get()!.synchronous,1);
});
test('lost acknowledgement survives SQLite close/reopen and blocks another dispatch in the run',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ls-host-durable-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'db.sqlite'),f=fixture({databasePath:path}),repo=new GameHostDispatchRepository(f.db,f.repository),identity={attachmentId:randomUUID(),hostId:randomUUID(),commandId:randomUUID(),requestDigest:gameHostDigest(f.input.request),sourceRevision:'b'.repeat(64)};
 assert.equal(f.repository.reserveController(f.owner,f.input.request),true);assert.equal(repo.claim(f.owner,f.input.request,identity,()=>true),true);assert.equal(repo.enter(f.owner,f.input.request,identity,()=>true),true);assert.equal(repo.enter(f.owner,f.input.request,identity,()=>true),false);f.db.close();
 const reopened=new Database({path});t.after(()=>reopened.close());reopened.migrate();assert.equal(reopened.connection.prepare('SELECT state FROM game_host_dispatch').get()!.state,'entered');assert.equal(reopened.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');
 const repository=new (f.repository.constructor as typeof import('../../../packages/storage-sqlite/src/game-activity.ts').ActivityCheckpointRepository)(reopened,f.options),dispatch=new GameHostDispatchRepository(reopened,repository);assert.equal(dispatch.claim(f.owner,f.input.request,{...identity,commandId:randomUUID(),attachmentId:randomUUID()},()=>true),false);
});
test('FULL synchronous commit is scoped, restores defaults and rejects async transactions',t=>{
 const db=new Database({path:':memory:'});t.after(()=>db.close());db.exec('CREATE TABLE synthetic (value INTEGER)');assert.equal(db.connection.prepare('PRAGMA synchronous').get()!.synchronous,1);db.durableTransaction(tx=>{assert.equal(db.connection.prepare('PRAGMA synchronous').get()!.synchronous,2);tx.run('INSERT INTO synthetic VALUES(1)');});assert.equal(db.connection.prepare('PRAGMA synchronous').get()!.synchronous,1);assert.throws(()=>db.durableTransaction(tx=>{tx.run('INSERT INTO synthetic VALUES(2)');return Promise.resolve();}));assert.equal(db.connection.prepare('SELECT count(*) AS n FROM synthetic').get()!.n,1);assert.equal(db.connection.prepare('PRAGMA synchronous').get()!.synchronous,1);
});
test('mutating coordinator ports after delivery fences result and retains reservation',async t=>{
 const f=fixture();t.after(()=>f.db.close());const h=host(f);t.after(()=>h.port.close());const ports={signal:f.controller.signal,current:f.ports.current,usageFor:f.ports.usageFor};const pending=h.join().runController(f.input,ports),event=await h.poll();if(event.kind!=='command')throw Error();assert.ok(Object.isFrozen(event));assert.ok(Object.isFrozen(h.join().adapter));ports.current=()=>true;assert.throws(()=>h.port.admit(h.actor,{protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest}));assert.equal((await pending).state,'requiresReconciliation');assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');
});
test('deadline fences delivered action and preserves durable uncertainty',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.input.request.deadlineAt=new Date(Date.now()+150).toISOString();const h=host(f);t.after(()=>h.port.close());const pending=h.run(),event=await h.poll();if(event.kind!=='command')throw Error();assert.ok(Date.parse(event.expiresAt)<=Date.parse(f.input.request.deadlineAt));assert.equal((await pending).state,'requiresReconciliation');assert.equal(f.db.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'reserved');assert.throws(()=>h.port.admit(h.actor,{protocol,attachmentId:event.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest}));assert.equal(f.calls(),0);
});
test('an unresolved native host cannot bypass uncertainty by changing run identity',t=>{
 const f=fixture();t.after(()=>f.db.close());const repo=new GameHostDispatchRepository(f.db,f.repository),hostId=randomUUID(),identity={attachmentId:randomUUID(),hostId,commandId:randomUUID(),requestDigest:gameHostDigest(f.input.request),sourceRevision:'b'.repeat(64)};assert.equal(f.repository.reserveController(f.owner,f.input.request),true);assert.equal(repo.claim(f.owner,f.input.request,identity,()=>true),true);
 const next=fixture({database:f.db}),other=new GameHostDispatchRepository(f.db,next.repository);assert.equal(next.repository.reserveController(next.owner,next.input.request),true);assert.equal(other.claim(next.owner,next.input.request,{...identity,attachmentId:randomUUID(),commandId:randomUUID(),requestDigest:gameHostDigest(next.input.request)},()=>true),false);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM game_host_dispatch').get()!.n,1);
});
