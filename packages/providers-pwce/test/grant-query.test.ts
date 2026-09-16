import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {PwceGrantQuery} from '../src/grant-query.ts';
import {PwceCapabilityCatalog} from '../src/capability-catalog.ts';
import {EXPECTED_PWCE_CAPABILITY_BUNDLE as bundle} from '../src/capability-bundle.ts';
import {createContractValidator} from '@lifestream/contracts';
const validator=createContractValidator();
function fixture(capacity=256){
 const scope={assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),environmentId:randomUUID(),conversationId:null,interactionTraceId:null,authorityContextRef:{providerRef:'pwce',contextId:randomUUID(),revision:1}};
 const binding={authorityContextRef:randomUUID(),principalRef:'agent.synthetic',siteRefs:['home.one'],worldRef:'world.synthetic',executionEnvironmentRef:'test',identity:{assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['human.synthetic'],audienceRef:'audience.synthetic'}};
 const snapshot={snapshotRef:randomUUID(),principalRef:binding.principalRef,siteRefs:binding.siteRefs,sourceRevision:1,invalidationSequence:1,issuedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:[{...bundle.capabilities[0],available:true,authorization:'grant_required'}],availability:'configured',limitations:[]};
 const state={current:true,hook:async(_phase)=>{},grants:{principalRef:binding.principalRef,siteRefs:['home.one'],capabilityRefs:['home.light.set_level'],sourceRevision:'a'.repeat(64),limitations:[]}},sent=[];
 const client={capabilityContracts:async()=>bundle,request:async r=>{sent.push(structuredClone(r));await state.hook(r.operation);return {profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:r.requestId,correlationId:r.correlationId,worldRef:r.worldRef,executionEnvironmentRef:r.executionEnvironmentRef,...structuredClone(r.operation==='authority.getGrants'?state.grants:snapshot)};}};
 const catalog=new PwceCapabilityCatalog({providerRef:'pwce',client,resolve:async()=>binding,isCurrent:()=>state.current});
 const query=new PwceGrantQuery({providerRef:'pwce',client,catalog,capacity,resolve:async(r,signal)=>{await state.hook('resolve');const result=await catalog.getSnapshot({...r,operation:'CapabilityProvider.getSnapshot',payload:{requestedCapabilityIds:[]}},{signal,isCurrent:()=>state.current});return catalog.retained(result.outcome.payload.snapshotId,r.scope);}});
 const request=()=>({schemaVersion:'1.0.0',operation:'AuthorityProvider.getGrants',requestId:randomUUID(),correlationId:randomUUID(),cancellationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),executionMode:'normal',scope:structuredClone(scope),idempotencyKey:null,payload:{states:[],page:{limit:1,cursor:null}}});
 const context={signal:new AbortController().signal,isCurrent:()=>state.current};return {query,catalog,state,sent,request,context,binding};
}
test('external permission query preserves producer summary and original evidence without inventing local grants',async()=>{
 const f=fixture(),request=f.request(),result=await f.query.getGrants(request,f.context),payload=result.outcome.payload;
 assert.equal(validator.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/GrantQueryResult',result).valid,true);
 assert.deepEqual(payload.grants,[]);assert.equal(payload.nextCursor,null);assert.deepEqual(payload.externalSummary.scope,request.scope);assert.deepEqual(payload.externalSummary.capabilityRefs,['home.light.set_level']);assert.equal(payload.sourceRevision.revision,'a'.repeat(64));
 const wire=f.sent.find(r=>r.operation==='authority.getGrants');assert.deepEqual(wire.participantRefs,f.binding.identity.participantRefs);assert.equal(wire.authorityContextRef,f.binding.authorityContextRef);
 assert.ok(f.sent.every(r=>['capabilities.getSnapshot','authority.getGrants'].includes(r.operation)));
 const bytes=await f.query.readEvidence(payload.externalSummary.evidenceRef,request,f.context);assert.equal(createHash('sha256').update(bytes).digest('hex'),payload.externalSummary.evidenceRef.sha256);assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).siteRefs,['home.one']);bytes[0]=0;assert.notEqual((await f.query.readEvidence(payload.externalSummary.evidenceRef,request,f.context))[0],0);
});
test('empty producer permission summary remains explicit and lifecycle filters cannot fabricate grant rows',async()=>{
 const f=fixture();f.state.grants.capabilityRefs=[];f.state.grants.limitations=['No effect permission'];const result=await f.query.getGrants(f.request(),f.context);assert.deepEqual(result.outcome.payload.externalSummary.capabilityRefs,[]);assert.deepEqual(result.outcome.payload.externalSummary.limitations,['No effect permission']);
 for(const change of [r=>r.payload.states=['revoked'],r=>r.payload.page.cursor='invented']){const g=fixture(),r=g.request();change(r);await assert.rejects(g.query.getGrants(r,g.context),{code:'unsupported_query'});assert.equal(g.sent.length,0);}
});
test('malformed, unbounded and foreign producer summaries never escape as current views',async()=>{
 for(const patch of [{principalRef:'foreign'},{siteRefs:['home.other']},{siteRefs:['home.one','home.one']},{capabilityRefs:['x','x']},{sourceRevision:'1'},{capabilityRefs:['x'.repeat(129)]},{capabilityRefs:Array.from({length:101},(_,i)=>String(i))},{limitations:['x'.repeat(501)]},{worldRef:'foreign'},{executionEnvironmentRef:'live'},{requestId:randomUUID()},{extra:true}]){const f=fixture();Object.assign(f.state.grants,patch);await assert.rejects(f.query.getGrants(f.request(),f.context),{code:'invalid_response'});}
});
test('current scope and original catalog are rechecked after each awaited operation',async()=>{
 for(const phase of ['resolve','authority.getGrants','capabilities.getSnapshot']){const f=fixture();f.state.hook=async p=>{if(p===phase)f.state.current=false;};await assert.rejects(f.query.getGrants(f.request(),f.context));}
 const f=fixture();f.state.hook=async p=>{if(p==='authority.getGrants')f.catalog.invalidateAll();};await assert.rejects(f.query.getGrants(f.request(),f.context),{code:'scope_changed'});
});
test('evidence is bound to the exact query, reference and current original authority',async()=>{
 const f=fixture(),request=f.request(),result=await f.query.getGrants(request,f.context),ref=result.outcome.payload.externalSummary.evidenceRef;
 const other=structuredClone(request);other.scope.sessionId=randomUUID();await assert.rejects(f.query.readEvidence(ref,other,f.context),{code:'evidence_unavailable'});await assert.rejects(f.query.readEvidence({...ref,sha256:'0'.repeat(64)},request,f.context),{code:'evidence_unavailable'});f.state.current=false;await assert.rejects(f.query.readEvidence(ref,request,f.context));
});
test('concurrent summary reads cannot overflow evidence custody or replace the successful original',async()=>{
 const f=fixture(1),requests=[f.request(),f.request()],results=await Promise.allSettled(requests.map(r=>f.query.getGrants(r,f.context)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const i=results.findIndex(r=>r.status==='fulfilled');assert.ok(await f.query.readEvidence(results[i].value.outcome.payload.externalSummary.evidenceRef,requests[i],f.context));
});
test('caller mutation, cancellation and stalled resolver preserve bounded original requests',async()=>{
 const f=fixture(),request=f.request(),original=structuredClone(request);let release;const gate=new Promise(resolve=>release=resolve);f.state.hook=async p=>{if(p==='resolve')await gate;};const pending=f.query.getGrants(request,f.context);request.scope.sessionId=randomUUID();release();assert.deepEqual((await pending).outcome.payload.externalSummary.scope,original.scope);
 const g=fixture(),controller=new AbortController();controller.abort();await assert.rejects(g.query.getGrants(g.request(),{...g.context,signal:controller.signal}),{code:'cancelled'});g.state.hook=async()=>new Promise(()=>{});const r=g.request();r.deadlineAt=new Date(Date.now()+40).toISOString();await assert.rejects(g.query.getGrants(r,g.context),{code:'deadline_exceeded'});assert.equal(g.sent.length,0);
});
