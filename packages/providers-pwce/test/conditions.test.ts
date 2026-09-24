import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PwceConditionClient} from '../src/conditions.ts';
import type {PwceCondition,PwceConditionIdentity,PwceConditionOptions,PwceConditionSelectors} from '../src/conditions.ts';
import {EXPECTED_PWCE_CONDITION_BUNDLE as contract} from '../src/condition-bundle.ts';
import {EXPECTED_PWCE_PROFILE,EXPECTED_PWCE_ARTIFACTS,EXPECTED_PWCE_GENERATED_CLIENT_SHA256} from '../src/client.ts';

const operations=['context.getPreparedInputs','context.query','evidence.get','events.subscribe','authority.evaluate','authority.authorizeDispatch','authority.getGrants','capabilities.getSnapshot','capabilities.invoke','capabilities.getInvocation','trace.publish','health.get'];
const profile={...EXPECTED_PWCE_PROFILE,schemaStatus:'published',operationCatalog:operations.map(operation=>({operation}))};
const core={bundleId:profile.bundleId,bundleVersion:profile.bundleVersion,bundleDigest:profile.schemaDigest,artifacts:EXPECTED_PWCE_ARTIFACTS,generatedClient:{path:'src/gateway/generated-client.js',sha256:EXPECTED_PWCE_GENERATED_CLIENT_SHA256}};
const identity=():PwceConditionIdentity=>({assistantRef:'assistant.one',endpointRef:'endpoint.one',participantRefs:['owner'],audienceRef:'solo'});
function fixture(options:Partial<PwceConditionOptions>={}){
  const now=Date.now(),at=new Date(now).toISOString();
  const condition:PwceCondition={conditionRef:'pwce:condition:'+'a'.repeat(64),revision:1,sourceRef:'source.demo',worldRef:'world.personal.v1',siteRef:'home.one',zoneRef:'zone.demo',eventClass:'fixture.critical',sourceRevision:1,status:'open',transition:'open',severity:'critical',summary:'Synthetic critical condition.',occurredAt:at,receivedAt:at,updatedAt:at,freshUntil:new Date(now+30000).toISOString(),expiresAt:new Date(now+60000).toISOString(),freshness:'fresh',basis:'synthetic',qualification:{state:'qualified',confidence:0.9,limitations:['Synthetic input only.'],evidenceRefs:['opaque:pending:one']}};
  const calls:{path:string;body:Record<string,unknown>|null;headers:Headers}[]=[];
  const state={current:true,drift:false,hook:async(_path:string)=>{},mutate:(_response:Record<string,unknown>)=>{},status:200};
  const fetchImpl:typeof fetch=async(url,init)=>{
    const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:null;
    calls.push({path,body,headers:new Headers(init?.headers)});await state.hook(path);
    if(path===contract.routes.bundle)return Response.json(state.drift?{...contract,bundleDigest:'wrong'}:contract);
    if(path==='/gateway/v1/profile')return Response.json(profile);
    if(path==='/gateway/v1/bundle')return Response.json(core);
    if(path==='/gateway/v1/authority')return Response.json({authorityContextRef:randomUUID()});
    if(path===contract.routes.request){
      if(state.status!==200)return Response.json({code:'authority_denied',message:'Foreign private detail that must remain unprinted.',retryable:false,correlationId:'synthetic'}, {status:state.status});
      const response:Record<string,unknown>={profileId:contract.profileId,profileVersion:contract.profileVersion,operation:body!.operation,status:'ok',evaluatedAt:at,conditions:body!.operation==='acknowledge'?[]:[structuredClone(condition)],nextCursor:1,hasMore:false,resyncReason:null,acknowledgment:body!.operation==='acknowledge'?{conditionRef:body!.conditionRef,revision:body!.revision,acknowledgedAt:at}:null};
      state.mutate(response);return Response.json(response);
    }
    throw Error('Unexpected route');
  };
  const client=new PwceConditionClient({baseUrl:'http://fixture',token:'synthetic-condition-token',siteRef:'home.one',worldRef:'world.personal.v1',replay:true,fetchImpl,...options});
  return {client,condition,calls,state,current:()=>state.current};
}
test('condition snapshots preserve qualified facts and bind exact producer contract and current identity',async()=>{
  const f=fixture(),result=await f.client.snapshot(identity(),f.current,undefined,{sourceRef:'source.demo',zoneRef:'zone.demo'});
  assert.equal(result.replay,true);assert.deepEqual(result.conditions,[f.condition]);assert.equal(result.acknowledgment,null);
  const request=f.calls.find(call=>call.path===contract.routes.request)!;
  assert.equal(request.headers.get('x-pwce-condition-contract'),contract.bundleDigest);
  assert.deepEqual(Object.fromEntries(['assistantRef','endpointRef','participantRefs','audienceRef'].map(key=>[key,request.body![key]])),identity());
  assert.equal(request.body!.sourceRef,'source.demo');assert.equal(request.body!.executionEnvironmentRef,'normal');
  assert.equal(f.calls.some(call=>/dispatch|capture|media|subscribe/.test(call.path)),false);
});
test('changes retain successive revisions and explicit resync without hiding gaps',async()=>{
  const f=fixture();f.state.mutate=response=>{response.conditions=[{...f.condition,freshness:'stale'},{...f.condition,revision:2,sourceRevision:2,status:'resolved',transition:'resolve'}];response.nextCursor=2;};
  const changed=await f.client.changes(0,identity(),f.current);assert.deepEqual(changed.conditions.map(c=>[c.revision,c.status,c.freshness]),[[1,'open','stale'],[2,'resolved','fresh']]);
  f.state.mutate=response=>{Object.assign(response,{status:'resyncRequired',resyncReason:'cursorAhead',conditions:[],nextCursor:2});};
  const resync=await f.client.changes(200,identity(),f.current);assert.equal(resync.status,'resyncRequired');assert.equal(resync.conditions.length,0);assert.equal(resync.resyncReason,'cursorAhead');
});
test('acknowledgment is an explicit exact-revision consumer receipt with no condition resolution',async()=>{
  const f=fixture();const result=await f.client.acknowledge(f.condition.conditionRef,1,identity(),f.current);
  assert.deepEqual(result.acknowledgment,{conditionRef:f.condition.conditionRef,revision:1,acknowledgedAt:f.condition.occurredAt});
  assert.equal(result.conditions.length,0);assert.equal(f.calls.filter(call=>call.path===contract.routes.request).length,1);
  f.state.mutate=response=>{(response.acknowledgment as Record<string,unknown>).revision=2;};
  await assert.rejects(f.client.acknowledge(f.condition.conditionRef,1,identity(),f.current),{code:'invalid_condition_acknowledgment'});
});
test('contract drift, unknown fields, foreign scope and invalid lifecycle cannot become usable conditions',async()=>{
  const drift=fixture();drift.state.drift=true;await assert.rejects(drift.client.snapshot(identity(),drift.current),{code:'incompatible_condition_contract'});
  assert.equal(drift.calls.some(c=>c.path===contract.routes.request),false);
  for(const patch of [
    {worldRef:'world.foreign'}, {siteRef:'site.foreign'}, {sourceRef:'source.foreign'}, {rawMedia:'forbidden'},
    {status:'resolved',transition:'open'}, {freshUntil:'2000-01-01T00:00:00.000Z'},
    {freshUntil:'2099-01-01T00:00:00.000Z'}, {status:'expired',transition:'expire',freshness:'fresh'},
    {qualification:{state:'qualified',confidence:1,limitations:[],evidenceRefs:[],allowSpeech:true}}
  ]){
    const f=fixture();Object.assign(f.condition,patch);await assert.rejects(f.client.snapshot(identity(),f.current,undefined,{sourceRef:'source.demo'}),undefined,JSON.stringify(patch));
  }
  const duplicate=fixture();duplicate.state.mutate=response=>{response.conditions=[duplicate.condition,duplicate.condition];};await assert.rejects(duplicate.client.snapshot(identity(),duplicate.current),{code:'invalid_condition_revision'});
});
test('closed envelopes, operation binding and nonprogressing cursors fail rather than report incomplete success',async()=>{
  for(const patch of [{extra:true},{operation:'acknowledge'},{hasMore:true,nextCursor:0},{nextCursor:0},{resyncReason:'cursorExpired'},{status:'resyncRequired',resyncReason:null}]){
    const f=fixture();f.state.mutate=response=>Object.assign(response,patch);await assert.rejects(f.client.changes(0,identity(),f.current),undefined,JSON.stringify(patch));
  }
  const stale=fixture();stale.state.mutate=response=>{response.nextCursor=0;};await assert.rejects(stale.client.changes(1,identity(),stale.current),{code:'invalid_condition_cursor'});
  const partial=fixture();partial.state.mutate=response=>{response.hasMore=true;};await assert.rejects(partial.client.snapshot(identity(),partial.current),{code:'incomplete_condition_snapshot'});
});
test('synthetic qualification is explicitly isolated while uncertainty remains visible',async()=>{
  const live=fixture({replay:false});await assert.rejects(live.client.snapshot(identity(),live.current),{code:'synthetic_condition_requires_replay'});
  live.condition.basis='derived';live.condition.qualification={state:'uncertain',confidence:null,limitations:['Coverage is incomplete.'],evidenceRefs:[]};live.condition.severity='warning';
  const result=await live.client.snapshot(identity(),live.current);assert.equal(result.replay,false);assert.equal(result.conditions[0]!.qualification.state,'uncertain');assert.equal(result.conditions[0]!.severity,'warning');
});
test('selectors and identities cannot override operation, authority or constructor scope',async()=>{
  for(const input of [null,{sourceRef:'source.demo',worldRef:'world.foreign'},{zoneRef:'zone.demo',operation:'acknowledge'}]){
    const f=fixture();await assert.rejects(f.client.snapshot(identity(),f.current,undefined,input as PwceConditionSelectors));assert.equal(f.calls.length,0);
  }
  const f=fixture();await assert.rejects(f.client.snapshot({...identity(),authorityContextRef:'injected'} as PwceConditionIdentity,f.current));assert.equal(f.calls.length,0);
  await assert.rejects(f.client.changes(-1,identity(),f.current));await assert.rejects(f.client.changes(0,identity(),f.current,undefined,{},101));await assert.rejects(f.client.acknowledge('invalid',0,identity(),f.current));assert.equal(f.calls.length,0);
});
test('current host scope fences every operation and caller identity is snapshotted before awaits',async()=>{
  const f=fixture(),id=identity(),selectors={sourceRef:'source.demo'};f.state.hook=async path=>{if(path===contract.routes.bundle){id.participantRefs.push('foreign');selectors.sourceRef='foreign';}};
  await f.client.snapshot(id,f.current,undefined,selectors);const body=f.calls.find(c=>c.path===contract.routes.request)!.body!;assert.deepEqual(body.participantRefs,['owner']);assert.equal(body.sourceRef,'source.demo');
  for(const path of [contract.routes.bundle,'/gateway/v1/authority',contract.routes.request]){
    const revoked=fixture();revoked.state.hook=async currentPath=>{if(currentPath===path)revoked.state.current=false;};await assert.rejects(revoked.client.snapshot(identity(),revoked.current),{code:'scope_invalidated'});
  }
  const blocked=fixture();blocked.state.current=false;await assert.rejects(blocked.client.snapshot(identity(),blocked.current),{code:'scope_invalidated'});assert.equal(blocked.calls.length,0);
});
test('cancellation and finite deadlines fence a transport that ignores abort',async()=>{
  const f=fixture(),controller=new AbortController();f.state.hook=async path=>{if(path===contract.routes.request)controller.abort();};await assert.rejects(f.client.snapshot(identity(),f.current,controller.signal),{code:'cancelled'});
  const stalled=fixture({requestTimeoutMs:50});stalled.state.hook=async()=>new Promise(()=>{});await assert.rejects(stalled.client.snapshot(identity(),stalled.current),{code:'deadline_exceeded'});
});
test('authoritative denial is preserved with a safe error and cannot become empty success',async()=>{
  const f=fixture();f.state.status=403;await assert.rejects(f.client.snapshot(identity(),f.current),error=>{assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/private detail|synthetic-condition-token/);return true;});
});
test('permitted large pages validate every record without weakening the total response ceiling',async()=>{
  const f=fixture();f.state.mutate=response=>{response.conditions=Array.from({length:100},(_,index)=>({...f.condition,conditionRef:'pwce:condition:'+index.toString(16).padStart(64,'0'),summary:'x'.repeat(1024),qualification:{...f.condition.qualification,evidenceRefs:Array.from({length:16},(_,n)=>String(n).padEnd(128,'e'))}}));response.nextCursor=100;};
  const response=await f.client.snapshot(identity(),f.current);assert.equal(response.conditions.length,100);assert.ok(Buffer.byteLength(JSON.stringify(response))>131072);
  f.state.mutate=response=>{response.conditions=[{...f.condition,summary:'x'.repeat(contract.maximumResponseBytes)}];};await assert.rejects(f.client.snapshot(identity(),f.current),{code:'invalid_condition_response'});
});
