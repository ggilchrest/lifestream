import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
console.log(JSON.stringify({syntheticScenario:'qualified-context',liveEffects:false,casesPassed:results.length,checks:results}));
