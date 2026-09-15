import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PwceContextSession } from '../packages/providers-pwce/src/context-session.ts';
import { PwceGatewayClient } from '../packages/providers-pwce/src/client.ts';
import { mapPwceContextResponse, mapPwceEvidenceResponse } from '../packages/runtime/src/context/pwce-mapping.ts';

// Point only at scripts/gateway-fixture-server.mjs in the producing repository,
// with PWCE_FIXTURE_SCENARIO=qualified-context. Never loads producer internals.
const url=process.env.PWCE_GATEWAY_URL,token=process.env.PWCE_GATEWAY_TOKEN,historicalBoundary=process.env.PWCE_FIXTURE_HISTORICAL_BOUNDARY;
if(!url||!token||!historicalBoundary)throw new Error('The isolated PWCE context fixture URL, synthetic token and historical boundary are required.');
const client=new PwceGatewayClient({baseUrl:url,token});
const authority=await client.authority(['home.one']);
const correlationId=randomUUID(),results=[];
const scope=(selected=authority,siteRefs=['home.one'])=>({worldRef:'world.personal.v1',executionEnvironmentRef:'replay',authorityContextRef:selected.authorityContextRef,authorityExpiresAt:selected.expiresAt,siteRefs,requestId:randomUUID(),correlationId});
const envelope=b=>({profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',worldRef:b.worldRef,executionEnvironmentRef:b.executionEnvironmentRef,authorityContextRef:b.authorityContextRef,requestId:b.requestId,correlationId:b.correlationId});
async function query(mode,externalEntityId,extra={},binding=scope()){
 const request={...binding,mode,...(externalEntityId?{subjectRef:`home.one::${externalEntityId}`,property:'state'}:{}),...(mode==='asOf'?{asOf:historicalBoundary}:{}),...(extra.limit?{maxItems:extra.limit}:{})};
 const body={...envelope(binding),operation:mode==='prepared'?'context.getPreparedInputs':'context.query',siteRef:'home.one',...(mode==='prepared'?{}:{mode}),...(externalEntityId?{externalEntityId,property:'state'}:{}),...(mode==='asOf'?{asOf:historicalBoundary}:{}),...extra};
 return mapPwceContextResponse(await client.request(body),request);
}
const prepared=await query('prepared');
assert.equal(prepared.items.find(item=>item.subjectRef==='home.one::sensor.conflict').knowledgeState,'conflicted');
assert.equal(prepared.items.find(item=>item.subjectRef==='home.one::sensor.stale').knowledgeState,'stale');
assert.ok(prepared.items.every(item=>item.siteRef==='home.one'));results.push('prepared qualification and site isolation');
const current=await query('current','sensor.conflict');assert.deepEqual(current.items[0].contradictions.map(item=>item.value),[false,true]);results.push('current contradictory booleans');
const withheld=await query('current','sensor.conflict',{maxAgeMs:1});assert.equal(withheld.items[0].knowledgeState,'conflicted');assert.equal(Object.hasOwn(withheld.items[0],'value'),false);assert.ok(withheld.items[0].contradictions.every(item=>!Object.hasOwn(item,'value')));results.push('age restriction without conflict erasure');
const explained=await query('explain','sensor.conflict');assert.equal(explained.items[0].contradictions.length,2);results.push('explanation evidence');
const unknown=await query('explain','sensor.missing');assert.equal(unknown.items[0].knowledgeState,'unknown');assert.equal(Object.hasOwn(unknown.items[0],'value'),false);results.push('missing evidence stays unknown');
const historical=await query('history','sensor.history',{limit:1});assert.equal(historical.items.length,0);assert.equal(historical.history[0].value,0);assert.equal(historical.hasMore,true);results.push('history page separate from current facts');
const next=await query('history','sensor.history',{limit:1,cursor:historical.nextCursor});assert.equal(next.history[0].value,1);assert.equal(next.sourceRevision,historical.sourceRevision);results.push('stable source-bound continuation');
const asOf=await query('asOf','sensor.history',{limit:1});assert.equal(asOf.items[0].value,1);assert.equal(asOf.history[0].value,0);results.push('as-of independent from history page');
const search=await query('search',undefined,{text:'sensor.',limit:10});assert.equal(search.items.length,0);assert.equal(search.matches.length,3);results.push('entity matches separate from state');
const evidenceRef=current.items[0].evidenceRefs[0],evidenceScope=scope();
const evidence=mapPwceEvidenceResponse(await client.request({...envelope(evidenceScope),operation:'evidence.get',evidenceRef}),{...evidenceScope,evidenceRef});
assert.equal(evidence.item.value,false);assert.equal(evidence.integrityStatus,'producerReported');assert.equal(evidence.observationEnvironment.environmentClass,'test');assert.equal(evidence.environmentRef,'replay');results.push('scoped evidence and distinct observation environment');
const missingScope=scope(),missingRef='synthetic-missing';const missing=mapPwceEvidenceResponse(await client.request({...envelope(missingScope),operation:'evidence.get',evidenceRef:missingRef}),{...missingScope,evidenceRef:missingRef});assert.equal(missing.status,'unknown');assert.equal(missing.item,undefined);results.push('unknown evidence result');
const both=await client.authority(['home.one','home.two']);const bothScope=scope(both,['home.one','home.two']);
const multi=mapPwceContextResponse(await client.request({...envelope(bothScope),operation:'context.query',mode:'current',siteRefs:bothScope.siteRefs,externalEntityId:'sensor.history',property:'state'}),{...bothScope,mode:'current',property:'state',subjectsBySite:{'home.one':'home.one::sensor.history','home.two':'home.two::sensor.history'}});
assert.deepEqual(multi.items.map(item=>item.siteRef),['home.one','home.two']);assert.equal(multi.items[1].knowledgeState,'unknown');results.push('multi-site known and unknown subjects');
const foreign=await client.request({...envelope(scope(both,['home.two'])),operation:'context.query',mode:'current',siteRef:'home.two',externalEntityId:'sensor.foreign',property:'state'});
await assert.rejects(client.request({...envelope(scope()),operation:'evidence.get',evidenceRef:foreign.evidenceRefs[0]}),error=>error.code==='scope_denied');results.push('reference does not grant foreign evidence access');
const identity={assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic'};
const scopedAuthority=await client.authority(['home.one'],undefined,identity);
const subscriptionScope={...identity,worldRef:'world.personal.v1',executionEnvironmentRef:'replay',requestId:randomUUID(),correlationId};
for(const change of [{assistantRef:'assistant.other'},{endpointRef:'endpoint.other'},{participantRefs:[]},{audienceRef:'audience.other'},{worldRef:'world.other'}]){
 const stream=client.subscribeInvalidations(scopedAuthority.authorityContextRef,'home.one',{scope:{...subscriptionScope,...change}});
 await assert.rejects(stream.next(),error=>error.code==='scope_denied');
}
results.push('HTTP SSE rejects five foreign scope identities');
const response=await fetch(`${url}/gateway/v1/authority`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({siteRefs:['home.one'],ttlMs:500,...identity})});
assert.equal(response.status,201);const shortAuthority=await response.json();
const frames=[];
for await(const event of client.subscribeInvalidations(shortAuthority.authorityContextRef,'home.one',{scope:subscriptionScope}))frames.push(event);
assert.equal(frames.length,1);assert.equal(frames[0].event,'resync.required');assert.equal(JSON.parse(frames[0].data).reason,'authority_context_expired');
results.push('HTTP scoped SSE accepts exact identities and closes on quiet authority expiry');
let ownerCurrent=true;const operations=[];
const sessionClient=new PwceGatewayClient({baseUrl:url,token,fetchImpl:async(resource,init)=>{if(init?.body){const body=JSON.parse(String(init.body));if(body.operation)operations.push(body.operation);}return fetch(resource,init);}});
const session=new PwceContextSession(sessionClient,{...identity,worldRef:'world.personal.v1',executionEnvironmentRef:'replay',authorityContextRef:scopedAuthority.authorityContextRef,authorityExpiresAt:scopedAuthority.expiresAt,siteRef:'home.one',principalRef:'agent.fixture',sessionId:'session.synthetic',environmentId:'lifestream.synthetic'},{isCurrent:()=>ownerCurrent});
try{
 const first=await session.getPreparedInputs(),second=await session.getPreparedInputs();
 assert.equal(first.isCurrent(),true);assert.equal(second.isCurrent(),true);assert.equal(operations.filter(op=>op==='context.getPreparedInputs').length,1);assert.equal(operations.filter(op=>op==='events.subscribe').length,3);
 assert.equal(second.value.items.find(item=>item.subjectRef==='home.one::sensor.conflict').knowledgeState,'conflicted');results.push('mapped read-session cache reuse with fresh authority replay');
 const past=await session.queryContext({mode:'asOf',externalEntityId:'sensor.history',property:'state',asOf:historicalBoundary,limit:1});
 assert.equal(past.value.items[0].value,1);assert.equal(past.isCurrent(),true);results.push('historical session reads retain as-of validity separately from present time');
 const evidenceRef=first.value.items.find(item=>item.evidenceRefs.length).evidenceRefs[0];
 const one=await session.getEvidence(evidenceRef),two=await session.getEvidence(evidenceRef);assert.equal(one.value.status,'known');assert.equal(two.isCurrent(),true);assert.equal(operations.filter(op=>op==='evidence.get').length,2);results.push('session evidence expansion reauthorizes each read');
 ownerCurrent=false;assert.equal(first.isCurrent(),false);await assert.rejects(session.getPreparedInputs());results.push('host scope change fences cached and new session reads');
}finally{session.close();}
console.log(JSON.stringify({syntheticScenario:'qualified-context',liveEffects:false,casesPassed:results.length,checks:results}));
