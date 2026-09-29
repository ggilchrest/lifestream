import test from 'node:test';
import assert from 'node:assert/strict';
import {PwceWorldContext} from '../src/composition/pwce-world.ts';
import {prepareHostWorld,type HostRuntimeInput} from '../src/runtime/inference.ts';
import {unavailableWorldContext} from '@lifestream/runtime/context/world';
import {createProviderRegistry} from '../src/composition/providers.ts';
import {loadProfile} from '../src/config/loader.ts';
import {PwceContextSession} from '@lifestream/providers-pwce';
const profile={endpoint:'http://127.0.0.1:1',worldRef:'world.synthetic',executionEnvironmentRef:'replay' as const,siteRefs:['home.one'],principalRef:'agent.fixture',lifestreamEnvironmentId:'deployment.synthetic',tokenSecretRef:'gateway',timeoutMs:1000,maximumPromptBytes:4096};
const owner=()=>({assistantId:'assistant',principalId:'principal',sessionId:'session',endpointId:'endpoint',audienceKnown:true,revision:'revision',isCurrent:()=>true});
test('unknown audience, missing endpoint and stale owner never contact PWCE',async t=>{
 const saved=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected network');};t.after(()=>{globalThis.fetch=saved;});
 const world=new PwceWorldContext(profile,'synthetic-token');t.after(()=>world.close());
 for(const change of [{audienceKnown:false},{endpointId:null},{isCurrent:()=>false}]){
  const lease=await world.prepare({...owner(),...change},new AbortController().signal);assert.match(lease.context.content,/unavailable/);
 }
 assert.equal(calls,0);world.close();const closed=await world.prepare(owner(),new AbortController().signal);assert.equal(closed.isCurrent(),false);assert.equal(calls,0);
});
test('missing referenced credential is unavailable without leaking or substituting grants',()=>{
 const config=loadProfile('local-dev');config.providers.inference='fixture';delete config.inferenceProfile;
 config.providers.world='pwce';config.providers.capability='pwce';config.authority.provider='pwce';config.secretRefs={gateway:{kind:'env',name:'PWCE_TEST_MISSING_CREDENTIAL_4F70'}};config.pwceProfile=profile;
 const registry=createProviderRegistry(config);assert.equal(registry.world,undefined);assert.equal(registry.providers.world?.status,'unavailable');assert.equal(registry.providers.capability?.status,'unavailable');
 assert.doesNotMatch(JSON.stringify(registry.providers),/PWCE_TEST_MISSING_CREDENTIAL/);
});
const input=()=>({assistantId:'assistant',runtimeSelfContext:{} as HostRuntimeInput['runtimeSelfContext'],isCurrent:()=>true} satisfies HostRuntimeInput);
test('preparation admission and subsequent snapshot validity fence different phases',async()=>{
 let admit=true,snapshot=true;const host:HostRuntimeInput={...input(),prepareWorld:async()=>({context:unavailableWorldContext('provider_unavailable'),isCurrent:()=>admit,isSnapshotCurrent:()=>snapshot})};
 await prepareHostWorld(host,new AbortController().signal);assert.ok(host.preparedWorldContext);admit=false;assert.equal(host.admitWorld?.(),false);assert.equal(host.isCurrent(),true);snapshot=false;assert.equal(host.isCurrent(),false);
});
test('aborted preparation ignores late results from a provider that ignores cancellation',async()=>{
 const controller=new AbortController();let finish!:()=>void;
 const host:HostRuntimeInput={...input(),prepareWorld:async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {context:unavailableWorldContext('provider_unavailable'),isCurrent:()=>true,isSnapshotCurrent:()=>true};}};
 const pending=prepareHostWorld(host,controller.signal);controller.abort();await assert.rejects(pending,/cancel/);finish();await Promise.resolve();assert.equal(host.preparedWorldContext,undefined);
});

test('world materialization carries the earliest actual cache expiry across sites',async t=>{
 const now=Date.now(),siteRefs=['home.one','home.two'],world=new PwceWorldContext({...profile,siteRefs},'synthetic-token');t.after(()=>world.close());
 t.mock.method((world as any).client,'authority',async()=>({authorityContextRef:'authority.synthetic',expiresAt:new Date(now+60_000).toISOString(),siteRefs}));
 t.mock.method(PwceContextSession.prototype,'subscribeInvalidations',async function*(signal?:AbortSignal){await new Promise<void>(resolve=>{if(signal?.aborted)resolve();else signal?.addEventListener('abort',()=>resolve(),{once:true});});});
 let site=0;
 t.mock.method(PwceContextSession.prototype,'getPreparedInputs',async()=>{
  const index=site++,stamp=new Date(now).toISOString();
  return {expiresAt:new Date(now+(index===0?4_000:1_000)).toISOString(),isCurrent:()=>true,isSnapshotCurrent:()=>true,value:{profileId:'lifestream-pwce.v1',worldRef:'world.synthetic',environmentRef:'replay',siteRefs:[siteRefs[index]],authorityContextRef:'authority.synthetic',sourceRevision:`source:${index}`,asOf:stamp,evaluatedAt:stamp,receivedAt:stamp,authorityExpiresAt:new Date(now+60_000).toISOString(),requestId:`request:${index}`,correlationId:`correlation:${index}`,invalidationCursor:'0',knowledgeState:'unknown',queryMode:'prepared',items:[],history:[],matches:[],sources:[],limitations:['Synthetic cache test.'],hasMore:false,nextCursor:null}};
 });
 const lease=await world.prepare(owner(),new AbortController().signal);assert.equal(lease.context.freshUntil,new Date(now+1_000).toISOString());assert.equal(lease.context.sourceRef,'pwce:prepared-world');assert.equal(lease.isCurrent(),true);assert.equal(site,2);
});
