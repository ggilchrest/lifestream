import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createContractValidator } from '@lifestream/contracts';
import { CanonicalProviderBoundary } from '@lifestream/runtime/ports/provider-boundary';
import { PwceInvalidationStreams } from '../src/invalidation-streams.ts';
import { PwceCapabilityCatalog, PWCE_LIGHT_CAPABILITY_ID } from '../src/capability-catalog.ts';
import { PwceCallScope, readEventStream } from '../src/transport.ts';
import { EXPECTED_PWCE_CAPABILITY_BUNDLE as bundle } from '../src/capability-bundle.ts';
const validator=createContractValidator();
const collect=async source=>{const values=[];for await(const event of source)values.push(event);return values;};
const end=()=>({id:null,event:'resync.required',data:JSON.stringify({reason:'stream_lifetime_exceeded'})});
const frame=(raw)=>({id:raw.cursor,event:raw.type,data:JSON.stringify(raw)});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}){
  const scope={assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),environmentId:randomUUID(),conversationId:randomUUID(),interactionTraceId:null,authorityContextRef:{providerRef:'pwce.synthetic',contextId:randomUUID(),revision:1}};
  const binding={authorityContextRef:randomUUID(),principalRef:'agent.synthetic',siteRefs:['home.one','home.two'],worldRef:'world.personal.v1',executionEnvironmentRef:'test',identity:{assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic'}};
  const state={current:true,hostCurrent:true,sent:[],opened:[],produced:0,resolve:async()=>binding,replay:async request=>({events:[],nextCursor:request.afterCursor,resyncRequired:false,hasMore:false}),produce:async function*(){yield end();}};
  const snapshot={snapshotRef:randomUUID(),principalRef:binding.principalRef,siteRefs:binding.siteRefs,sourceRevision:0,invalidationSequence:0,issuedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:[{...bundle.capabilities[0],available:true,authorization:'grant_required'}],availability:'configured',limitations:[]};
  const client={
    capabilityContracts:async()=>bundle,
    request:async request=>{state.sent.push(structuredClone(request));const envelope={profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,worldRef:request.worldRef,executionEnvironmentRef:request.executionEnvironmentRef};return {...envelope,...(request.operation==='capabilities.getSnapshot'?snapshot:{principalRef:binding.principalRef,siteRef:request.siteRef,...await state.replay(request)})};},
    subscribeInvalidations:(authority,site,options)=>{state.opened.push(structuredClone({authority,site,scope:options.scope,afterCursor:options.afterCursor}));return (async function*(){if(state.connected!==false)options.onReady?.();yield*state.produce(site,options);})();}
  };
  const catalog=new PwceCapabilityCatalog({providerRef:'pwce.synthetic',client,resolve:()=>state.resolve(),isCurrent:()=>state.hostCurrent});
  const streams=new PwceInvalidationStreams({providerRef:'pwce.synthetic',client,catalog,resolve:()=>state.resolve(),isCurrent:()=>state.hostCurrent,...options});
  const controller=new AbortController(),context={signal:controller.signal,isCurrent:()=>state.current};
  const request=(kind='capability')=>({schemaVersion:'1.0.0',operation:kind==='capability'?'CapabilityProvider.subscribeInvalidations':'AuthorityProvider.subscribeInvalidations',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope:structuredClone(scope),idempotencyKey:null,payload:{providerRef:'pwce.synthetic',afterSequence:null,sourceRevision:null}});
  const subscribe=(kind='capability',q=request(kind))=>kind==='capability'?streams.subscribeCapabilities(q,context):streams.subscribeAuthority(q,context);
  const eventCache=new Map();
  const event=(n=1,type='capabilities.invalidated',extra={})=>{const key=JSON.stringify([n,type,extra]);if(!eventCache.has(key))eventCache.set(key,{eventId:randomUUID(),type,cursor:String(n),sourceRevision:n,affectedRef:null,watch:{siteRefs:[],principalRefs:[binding.principalRef]},reason:'synthetic_change',occurredAt:new Date(Date.now()-1).toISOString(),correlationId:randomUUID(),...extra});return structuredClone(eventCache.get(key));};
  const warm=async()=>{const q=request();q.operation='CapabilityProvider.getSnapshot';q.payload={requestedCapabilityIds:[]};return (await catalog.getSnapshot(q,context)).outcome.payload;};
  return {scope,binding,state,catalog,streams,controller,context,request,subscribe,event,warm};
}
function conform(events,kind='capability'){
  assert.ok(events.length);const first=events[0];
  events.forEach((e,i)=>{assert.equal(e.sequence,i);assert.equal(e.streamId,first.streamId);assert.ok(validator.validate(`https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/${kind==='capability'?'Capability':'Authority'}InvalidationEvent`,e).valid);});
  assert.equal(events.at(-1).kind,'terminal');
}

test('both canonical boundaries accept scoped multi-site events, duplicate suppression and explicit EOF',async()=>{
  for(const kind of ['capability','authority']){
    const f=fixture(),raw=f.event(4),snapshot=await f.warm();
    f.state.produce=async function*(){yield frame(raw);yield frame(raw);yield end();};
    const boundary=new CanonicalProviderBoundary({providerRef:'pwce.synthetic'}),method=(q)=>f.subscribe(kind,q);
    const provider=kind==='capability'?boundary.capability({subscribeInvalidations:method}):boundary.authority({subscribeInvalidations:method});
    const q=f.request(kind),events=await collect(provider.subscribeInvalidations(q,f.context));conform(events,kind);
    assert.equal(events.length,2);assert.equal(events[0].payload.eventId,raw.eventId);assert.deepEqual(events[0].payload.scope,f.scope);
    assert.equal(events.at(-1).outcome.status,'succeeded');assert.equal(events.at(-1).outcome.payload.sourceRevision.highWaterMark,'4');
    assert.deepEqual(f.state.opened.map(x=>x.site).sort(),['home.one','home.two']);assert.equal(f.catalog.retained(snapshot.snapshotId,f.scope),undefined);
    const proof=f.streams.readEventEvidence(raw.eventId,f.scope,f.context);assert.deepEqual(proof.source,raw);assert.deepEqual(proof.binding,f.binding);
    proof.source.reason='changed';assert.equal(f.streams.readEventEvidence(raw.eventId,f.scope,f.context).source.reason,'synthetic_change');
  }
});

test('filtered cursor jumps and cross-site arrival order remain valid; resume uses the lowest acknowledged cursor',async()=>{
  const f=fixture();f.state.produce=async function*(site){if(site==='home.one'){yield frame(f.event(5));yield frame(f.event(12));}else{await tick();yield frame(f.event(3));}yield end();};
  const events=await collect(f.subscribe());conform(events);assert.equal(events.at(-1).outcome.status,'succeeded');
  assert.equal(events.at(-1).outcome.payload.lastSequence,2);assert.equal(events.at(-1).outcome.payload.sourceRevision.highWaterMark,'3');
  const q=f.request();q.payload.sourceRevision=events.at(-1).outcome.payload.sourceRevision;q.payload.afterSequence=3;f.state.produce=async function*(){yield end();};
  await collect(f.subscribe('capability',q));assert.deepEqual(f.state.opened.slice(-2).map(x=>x.afterCursor),['3','3']);
  q.payload.afterSequence=2;assert.throws(()=>f.subscribe('capability',q),{code:'invalid_cursor'});
});

test('exact older duplicates do not regress the safe resume cursor',async()=>{
  const f=fixture(),one=f.event(1),two=f.event(9);f.state.produce=async function*(){yield frame(one);yield frame(two);yield frame(one);yield end();};
  const events=await collect(f.subscribe());assert.equal(events.length,3);assert.equal(events.at(-1).outcome.payload.sourceRevision.highWaterMark,'9');
});

test('an explicit replay gap emits a refresh signal and opens SSE at the actual returned watermark',async()=>{
  const f=fixture();f.state.replay=async()=>({events:[],nextCursor:'20',resyncRequired:true,hasMore:false});
  const events=await collect(f.subscribe());conform(events);assert.equal(events.filter(e=>e.kind==='data').length,2);
  assert.ok(events.slice(0,-1).every(e=>e.payload.reason==='gap'));assert.deepEqual(f.state.opened.map(x=>x.afterCursor),['20','20']);
  assert.equal(events.at(-1).outcome.payload.sourceRevision.highWaterMark,'20');
});

test('paged replay is drained before SSE and quiet-site watermarks are preserved',async()=>{
  const f=fixture(),one=f.event(2),two=f.event(7);
  f.state.replay=async q=>q.afterCursor==='0'?{events:[one],nextCursor:'2',resyncRequired:false,hasMore:true}:{events:[two],nextCursor:'10',resyncRequired:false,hasMore:false};
  const events=await collect(f.subscribe());assert.equal(events.length,3);assert.equal(events.at(-1).outcome.payload.sourceRevision.highWaterMark,'10');
  assert.deepEqual(f.state.opened.map(x=>x.afterCursor),['10','10']);
});

test('malformed or foreign replay cannot establish a successful stream',async()=>{
  for(const patch of [{principalRef:'other'},{worldRef:'other'},{siteRef:'other'},{nextCursor:'-1'},{events:[],hasMore:true},{events:[{}]},{events:[{}],resyncRequired:true}]){
    const f=fixture();f.state.replay=async()=>({events:[],nextCursor:'0',resyncRequired:false,hasMore:false,...patch});
    const events=await collect(f.subscribe());conform(events);assert.notEqual(events.at(-1).outcome.status,'succeeded');assert.equal(f.state.opened.length,0);
  }
});

test('conflicting duplicate identities across site connections fail and discard catalog custody',async()=>{
  const f=fixture(),raw=f.event(1),snapshot=await f.warm();f.state.produce=async function*(site){yield frame({...raw,reason:site});yield end();};
  const events=await collect(f.subscribe());conform(events);assert.equal(events.at(-1).outcome.error.code,'event_identity_changed');assert.equal(f.catalog.retained(snapshot.snapshotId,f.scope),undefined);
});

test('regressed cursors, malformed JSON, duplicate keys, foreign scope and future events fail safely',async()=>{
  for(const change of ['regress','duplicate-key','foreign','future','uuid','oversize','unknown']){
    const f=fixture(),raw=f.event(5);f.state.produce=async function*(){
      if(change==='regress'){yield frame(raw);yield frame(f.event(3));}
      else if(change==='duplicate-key')yield {id:'5',event:raw.type,data:JSON.stringify(raw).replace('"cursor":"5"','"cursor":"4","cur\\u0073or":"5"')};
      else if(change==='oversize')yield {id:'5',event:raw.type,data:' '.repeat(65537)};
      else yield frame({...raw,...(change==='foreign'?{watch:{siteRefs:['other'],principalRefs:[]}}:change==='future'?{occurredAt:new Date(Date.now()+50000).toISOString()}:change==='uuid'?{eventId:'bad'}:{type:'unknown'})});
      yield end();
    };
    const events=await collect(f.subscribe());conform(events);assert.notEqual(events.at(-1).outcome.status,'succeeded',change);
  }
});

test('unexpected EOF and data after a terminal cannot masquerade as successful completion',async()=>{
  for(const late of [false,true]){const f=fixture();f.state.produce=async function*(){if(late){yield end();yield frame(f.event());}};const events=await collect(f.subscribe());conform(events);assert.equal(events.at(-1).outcome.error.code,late?'invalid_terminal':'unexpected_eof');}
});

test('expiry and resync control frames disclose refresh or lost authority instead of success',async()=>{
  for(const reason of ['authority_context_expired','authority_context_invalidated','authentication_failed','cursor_expired']){
    const f=fixture();f.state.produce=async function*(){yield {event:'resync.required',id:null,data:JSON.stringify({reason})};};
    const events=await collect(f.subscribe('authority'));conform(events,'authority');assert.notEqual(events.at(-1).outcome.status,'succeeded');
    assert.ok(events.some(e=>e.kind==='data'&&e.payload.reason===(reason==='authority_context_expired'?'expired':reason==='cursor_expired'?'gap':'providerChanged')));
  }
});

test('context and action notifications advance source cursors without inventing authority facts',async()=>{
  const f=fixture();f.state.produce=async function*(){yield frame(f.event(2,'context.invalidated'));yield frame(f.event(4,'action.updated'));yield end();};
  const events=await collect(f.subscribe('authority'));conform(events,'authority');assert.equal(events.length,1);assert.equal(events[0].outcome.payload.sourceRevision.highWaterMark,'4');
});

test('return cancels an outstanding read from an uncooperative source without cancelling its parent',async()=>{
  const f=fixture();f.state.produce=()=>({next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{}),[Symbol.asyncIterator](){return this;}});
  const source=f.subscribe(),pending=source.next();while(!f.state.opened.length)await tick();
  const done=source.return();await pending;assert.equal((await done).done,true);assert.equal(f.controller.signal.aborted,false);
});

test('bounded rollover releases physical stream capacity even if a consumer stops pulling',async()=>{
  const f=fixture({maximumSiteStreams:2,watchDurationMs:40});f.state.produce=async function*(){yield frame(f.event());await new Promise(()=>{});};
  const abandoned=f.subscribe();await abandoned.next();await new Promise(resolve=>setTimeout(resolve,80));
  f.state.produce=async function*(){yield end();};const events=await collect(f.subscribe());assert.equal(events.at(-1).outcome.status,'succeeded');await abandoned.return();
});

test('site capacity is explicit and never silently omits a bound site',async()=>{
  const f=fixture({maximumSiteStreams:1});const events=await collect(f.subscribe());assert.equal(events.at(-1).outcome.error.code,'stream_capacity');assert.equal(f.state.sent.length,0);assert.equal(f.state.opened.length,0);
});

test('queue backpressure still invalidates catalog state before a consumer requests the next frame',async()=>{
  const f=fixture({queueCapacity:1,watchDurationMs:1000});f.binding.siteRefs.splice(1);
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
  f.state.produce=async function*(){yield frame(f.event(1));entered();await gate;yield frame(f.event(2));yield frame(f.event(3));await new Promise(()=>{});};
  const source=f.subscribe();await source.next();await waiting;const snapshot=await f.warm();assert.ok(f.catalog.retained(snapshot.snapshotId,f.scope));release();
  while(f.catalog.retained(snapshot.snapshotId,f.scope))await tick();
  assert.equal(f.catalog.retained(snapshot.snapshotId,f.scope),undefined);await source.return();
});

test('quiet owner withdrawal terminates streams and withholds evidence from a former scope',async()=>{
  const f=fixture();f.state.produce=async function*(){yield frame(f.event());await new Promise(()=>{});};
  const source=f.subscribe(),first=await source.next();f.state.hostCurrent=false;
  const rest=await collect(source);assert.equal(rest.at(-1).outcome.error.code,'scope_changed');assert.equal(f.streams.readEventEvidence(first.value.payload.eventId,f.scope,f.context),undefined);
});

test('request snapshots and host mode validation prevent caller mutation and cross-mode reads',async()=>{
  const f=fixture(),q=f.request(),original=structuredClone(q),stream=f.subscribe('capability',q);q.scope.sessionId=randomUUID();q.payload.afterSequence=99;
  const events=await collect(stream);assert.equal(events[0].requestId,original.requestId);assert.deepEqual(f.state.opened.map(x=>x.afterCursor),['0','0']);
  const bad=f.request();bad.executionMode='replay';const failed=await collect(f.subscribe('capability',bad));assert.equal(failed.at(-1).outcome.error.code,'execution_mode_mismatch');
  assert.throws(()=>f.subscribe('capability',{...f.request(),extra:true}),{code:'invalid_request'});
});

test('original evidence is bounded, cloned and accessible only under its current exact scope',async()=>{
  const f=fixture({evidenceCapacity:1}),first=f.event(1),second=f.event(2);f.state.produce=async function*(){yield frame(first);yield frame(second);yield end();};
  await collect(f.subscribe());assert.equal(f.streams.readEventEvidence(first.eventId,f.scope,f.context),undefined);
  assert.ok(f.streams.readEventEvidence(second.eventId,f.scope,f.context));assert.equal(f.streams.readEventEvidence(second.eventId,{...f.scope,sessionId:randomUUID()},f.context),undefined);
  assert.equal(f.streams.readEventEvidence(second.eventId,f.scope,{...f.context,signal:AbortSignal.abort()}),undefined);
});

test('resubscription preserves original event IDs and rejects changed bytes under the same ID',async()=>{
  const f=fixture(),raw=f.event(4);f.state.produce=async function*(){yield frame(raw);yield end();};
  assert.equal((await collect(f.subscribe())).length,2);
  const repeated=await collect(f.subscribe());assert.equal(repeated.length,2);assert.equal(repeated[0].payload.eventId,raw.eventId);assert.equal(repeated.at(-1).outcome.status,'succeeded');
  f.state.produce=async function*(){yield frame({...raw,reason:'changed'});yield end();};
  const failed=await collect(f.subscribe());assert.equal(failed.at(-1).outcome.error.code,'event_identity_changed');
  assert.equal(f.streams.readEventEvidence(raw.eventId,f.scope,f.context).source.reason,'synthetic_change');
});

test('a bounded attempt that never connects every site cannot claim stream success',async()=>{
  let ready=0;const f=fixture({watchDurationMs:30,onReady:()=>{ready++;}});f.state.connected=false;f.state.produce=()=>({next:()=>new Promise(()=>{}),return:()=>Promise.resolve({done:true}),[Symbol.asyncIterator](){return this;}});
  const events=await collect(f.subscribe());assert.equal(events.at(-1).outcome.error.code,'stream_unavailable');assert.equal(ready,0);
});

test('host readiness covers all sites and the associated signal closes with the stream',async()=>{
  let ready=0,signal;const f=fixture({onReady:(scope,owned)=>{assert.deepEqual(scope,f.scope);ready++;signal=owned;}});
  await collect(f.subscribe());assert.equal(ready,1);assert.equal(signal.aborted,true);
});

test('one global cursor cannot identify different events on separate site streams',async()=>{
  const f=fixture(),raw=f.event(5);f.state.produce=async function*(site){yield frame({...raw,eventId:site==='home.one'?raw.eventId:randomUUID()});yield end();};
  const events=await collect(f.subscribe());conform(events);assert.equal(events.at(-1).outcome.error.code,'cursor_identity_changed');
});

test('both canonical ports cover the complete 128-site binding without dropping sites or duplicating events',async()=>{
  let ready=0;const f=fixture({onReady:()=>{ready++;}});f.binding.siteRefs.splice(0,2,...Array.from({length:128},(_,i)=>`home.s${i}`));
  const raw=f.event(7);f.state.produce=async function*(){yield frame(raw);yield end();};
  const [events,authority]=await Promise.all([collect(f.subscribe()),collect(f.subscribe('authority'))]);conform(events);conform(authority,'authority');assert.equal(events.length,2);assert.equal(authority.length,2);assert.equal(f.state.opened.length,256);assert.equal(new Set(f.state.opened.map(x=>x.site)).size,128);assert.equal(ready,2);
});

test('transport readiness occurs only after valid SSE headers and before a quiet stream has data',async()=>{
  let ready=0;const bad=new PwceCallScope(1000);
  await assert.rejects(readEventStream(new Response('no events',{headers:{'content-type':'application/json'}}),bad,()=>{ready++;}).next(),{code:'malformed_response'});bad.close();assert.equal(ready,0);
  const scope=new PwceCallScope(1000),body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': quiet\n\n'));}});
  const source=readEventStream(new Response(body,{headers:{'content-type':'text/event-stream'}}),scope,()=>{ready++;}),pending=source.next();
  await tick();assert.equal(ready,1);scope.close();await assert.rejects(pending,{code:'cancelled'});
});

test('parallel logical capability and authority subscribers each receive the producer notification',async()=>{
  const f=fixture(),raw=f.event(6);f.state.produce=async function*(){yield frame(raw);yield frame(raw);yield end();};
  const [capability,authority]=await Promise.all([collect(f.subscribe()),collect(f.subscribe('authority'))]);
  for(const events of [capability,authority]){assert.equal(events.length,2);assert.equal(events[0].payload.eventId,raw.eventId);assert.equal(events.at(-1).outcome.status,'succeeded');}
});
