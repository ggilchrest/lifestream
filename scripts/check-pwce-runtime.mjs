import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createLifestreamServer} from '../apps/server/src/index.ts';
import {loadProfile} from '../apps/server/src/config/loader.ts';
import {FixtureInferenceProvider} from '../packages/runtime/dist/inference/fixture.js';
import {createContractValidator} from '../packages/contracts/dist/index.js';
const endpoint=process.env.PWCE_GATEWAY_URL,token=process.env.PWCE_GATEWAY_TOKEN;
if(!endpoint||!token||new URL(endpoint).hostname!=='127.0.0.1')throw new Error('An isolated loopback PWCE fixture and synthetic token are required.');
const root=await mkdtemp(join(tmpdir(),'ls-pwce-runtime-')),config=loadProfile('local-dev'),results=[];
config.providers.inference='fixture';delete config.inferenceProfile;
config.providers.world='pwce';config.providers.capability='pwce';config.authority={provider:'pwce',authentication:'local-password'};
config.secretRefs={gateway:{kind:'env',name:'PWCE_GATEWAY_TOKEN'}};
config.pwceProfile={endpoint,worldRef:'world.personal.v1',executionEnvironmentRef:'replay',siteRefs:['home.one','home.two'],principalRef:'agent.fixture',lifestreamEnvironmentId:randomUUID(),tokenSecretRef:'gateway',timeoutMs:1000,maximumPromptBytes:16384};
config.storage={databasePath:join(root,'data.sqlite'),artifactDirectory:join(root,'artifacts')};
// Only the disposable producer and this disposable consumer may receive traffic.
const originalFetch=globalThis.fetch,fixtureOrigin=new URL(endpoint).origin;
let consumerOrigin,denyGrantReads=false,blockedGrantReads=0;
globalThis.fetch=async(resource,init)=>{
 const url=new URL(resource instanceof Request?resource.url:String(resource));
 assert.ok(url.origin===fixtureOrigin||url.origin===consumerOrigin,'synthetic fixture must not contact another endpoint');
 if(denyGrantReads&&url.origin===fixtureOrigin&&url.pathname==='/gateway/v1/request'&&typeof init?.body==='string'&&JSON.parse(init.body).operation==='authority.getGrants'){
  blockedGrantReads++;throw new Error('synthetic grant transport unavailable');
 }
 return originalFetch(resource,init);
};
const installerToken=randomBytes(32).toString('hex'),app=createLifestreamServer({config,localAuth:{stateDirectory:join(root,'auth'),installerToken}});
const original=FixtureInferenceProvider.prototype.generate,requests=[];let entered,hold=false;
FixtureInferenceProvider.prototype.generate=async function*(request,context){requests.push(request);entered?.();if(hold)await delay(1500,undefined,{signal:context.signal});yield {kind:'text',text:'Synthetic answer'};yield {kind:'done'};};
try{
 await app.start();const base=`http://127.0.0.1:${app.address().port}`,headers={origin:base,'content-type':'application/json'};
 consumerOrigin=base;
 const request=(path,body)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
 const api=async(path,body)=>{const response=await request(path,body),data=await response.json();assert.ok(response.ok,`${response.status}: ${JSON.stringify(data)}`);return data;};
 const setup=await request('/api/auth/v1/setup',{username:'owner',password:randomBytes(32).toString('hex'),installerToken});headers.cookie=setup.headers.get('set-cookie').split(';')[0];headers['x-lifestream-csrf']=(await setup.json()).session.csrfToken;
 const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic World Review'});await api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});
 const message={assistantId:assistant.assistantId,userInput:'Describe the supplied world observations.',world:'FORGED_WORLD',preparedWorldContext:{content:'FORGED_WORLD'},capabilities:'FORGED_GRANT',fullPromptPreview:true};
 const stream=async()=>{const response=await request('/api/runtime/v1/messages',message),text=await response.text();assert.equal(response.status,200,text);return text;};
 let text=await stream();assert.match(text,/interaction.completed/);let world=requests.at(-1).sections.find(s=>s.kind==='worldContext');assert.match(world.content,/audience_unknown/);assert.doesNotMatch(JSON.stringify(requests.at(-1)),/FORGED_/);results.push('unknown audience withholds world; client overrides ignored');
 await api('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 text=await stream();assert.match(text,/interaction.completed/);world=requests.at(-1).sections.find(s=>s.kind==='worldContext');assert.equal(world.sourceRef,'pwce:prepared-world',world.content);assert.equal(world.trusted,false);
 const slices=JSON.parse(world.content).slices;assert.deepEqual(slices.map(s=>s.siteRefs),[['home.one'],['home.two']]);assert.ok(slices.every(s=>s.executionEnvironmentRef==='replay'));
 const items=slices.flatMap(s=>s.items);assert.equal(items.find(i=>i.subjectRef==='home.one::sensor.conflict').knowledgeState,'conflicted');assert.deepEqual(items.find(i=>i.subjectRef==='home.one::sensor.conflict').contradictions.map(i=>i.value),[false,true]);assert.equal(items.find(i=>i.subjectRef==='home.one::sensor.stale').knowledgeState,'stale');assert.equal(items.find(i=>i.subjectRef==='home.two::sensor.foreign').value,999);results.push('actual provider prompt preserves multiple sites, replay mode, conflicts and stale state');
 assert.match(text,/input.prompt-preview/);assert.ok(text.includes(world.sourceRevision));results.push('inspection reflects actual world source digest');
 const validator=createContractValidator(),grantResponse='https://lifestream.dev/contracts/runtime-api/1.0.0#/$defs/ListAuthorityGrantsResponse';
 const grantsPath='/api/authority/v1/grants?assistantId='+assistant.assistantId;
 const grantFailure=async(path,status,code)=>{
  const response=await request(path),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));
  const contract=validator.validate(grantResponse,body);assert.equal(contract.valid,true,JSON.stringify(contract));
  assert.equal(body.status,'failed');assert.equal(body.sourceRevision,null);assert.equal(body.result,null);assert.equal(body.error.code,code);assert.equal(body.error.retryable,status===503);
 };
 await grantFailure('/api/authority/v1/grants',422,'pwce_grant_query_unsupported');results.push('missing Assistant is rejected as malformed query, before permission discovery');
 const grantSummary=async()=>{
  const response=await request(grantsPath),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  const contract=validator.validate(grantResponse,body);assert.equal(contract.valid,true,JSON.stringify(contract));assert.equal(body.status,'succeeded');assert.equal(body.error,null);
  assert.deepEqual(body.result.grants,[]);assert.equal(body.result.nextCursor,null);assert.equal(body.result.sourceRevision.providerRef,'pwce');
  const summary=body.result.externalSummary;assert.equal(summary.authorityKind,'externalSummary');assert.equal(summary.providerRef,'pwce');assert.equal(summary.principalRef,'agent.fixture');
  assert.equal(summary.scope.assistantId,assistant.assistantId);assert.equal(summary.scope.environmentId,config.pwceProfile.lifestreamEnvironmentId);assert.equal(summary.executionEnvironmentRef,'replay');
  assert.deepEqual(summary.siteRefs,['home.one','home.two']);assert.deepEqual(summary.capabilityRefs,[]);
 };
 await grantSummary();results.push('properly scoped query returns actual producer summary, with no invented local grants');
 denyGrantReads=true;
 // Transport exceptions propagate through ProviderBoundaryError to canonicalAuthorityFailure.
 try{await grantFailure(grantsPath,503,'authority_unavailable');assert.equal(blockedGrantReads,1);}finally{denyGrantReads=false;}
 results.push('controlled producer grant-read outage returns canonical 503 with null result; no local grant fallback');
 await grantSummary();results.push('explicit retry after transport recovery reads the current producer summary');
 hold=true;text=await stream();assert.match(text,/interaction.completed/);results.push('admitted generation survives one-second cache reuse age');
 const started=new Promise(resolve=>{entered=resolve;});const active=stream();await started;entered=undefined;
 await api('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'});
 text=await active;assert.doesNotMatch(text,/event: message.delta/);assert.doesNotMatch(text,/interaction.completed/);assert.match(text,/interaction.error/);results.push('audience change cancels admitted world generation before output');
 await grantFailure(grantsPath,503,'pwce_capability_scope_unavailable');results.push('audience withdrawal also withholds the permission summary');
 hold=false;text=await stream();assert.match(requests.at(-1).sections.find(s=>s.kind==='worldContext').content,/audience_unknown/);assert.match(text,/interaction.completed/);results.push('next ordinary reply discloses unavailable world after audience withdrawal');
 console.log(JSON.stringify({status:'pass',fixture:true,liveEffects:false,checks:results.length,results},null,2));
}finally{FixtureInferenceProvider.prototype.generate=original;try{await app.shutdown();}finally{globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}}
