import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PwceTrustedDispatchClient } from '../src/dispatch.ts';
import { EXPECTED_PWCE_DISPATCH_BUNDLE as dispatchBundle } from '../src/dispatch-bundle.ts';
import { EXPECTED_PWCE_PROFILE, EXPECTED_PWCE_ARTIFACTS, EXPECTED_PWCE_GENERATED_CLIENT_SHA256 } from '../src/client.ts';
const token = 'synthetic-agent-token', dispatcherToken = 'synthetic-distinct-host-dispatcher-token';
const operations = ['context.getPreparedInputs','context.query','evidence.get','events.subscribe','authority.evaluate','authority.authorizeDispatch','authority.getGrants','capabilities.getSnapshot','capabilities.invoke','capabilities.getInvocation','trace.publish','health.get'];
const coreProfile = { ...EXPECTED_PWCE_PROFILE, schemaStatus:'published', operationCatalog:operations.map(operation=>({operation})) };
const coreBundle = { bundleId:coreProfile.bundleId,bundleVersion:coreProfile.bundleVersion,bundleDigest:coreProfile.schemaDigest,artifacts:EXPECTED_PWCE_ARTIFACTS,generatedClient:{path:'src/gateway/generated-client.js',sha256:EXPECTED_PWCE_GENERATED_CLIENT_SHA256} };
const input = () => ({requestId:'request.synthetic',correlationId:'correlation.synthetic',worldRef:'world.synthetic',executionEnvironmentRef:'test',parameters:{level:0.5}});
function fixture(overrides: { bundle?:unknown; response?:(request:Record<string,unknown>)=>unknown; fetch?:(path:string,init:RequestInit)=>Promise<Response|undefined>; timeout?:number } = {}) {
  const sent: {path:string;init:RequestInit}[] = [];
  const client = new PwceTrustedDispatchClient({baseUrl:'http://synthetic',token,dispatcherToken,requestTimeoutMs:overrides.timeout ?? 1000,fetchImpl:async (url,init) => {
    const path = new URL(String(url)).pathname; sent.push({path,init:init!});
    const custom = await overrides.fetch?.(path,init!); if (custom) return custom;
    const value = path.endsWith('/profile') ? coreProfile : path === '/gateway/v1/bundle' ? coreBundle : path.endsWith('/dispatch/bundle') ? overrides.bundle ?? dispatchBundle : { ...JSON.parse(String(init?.body)), status:'admitted' };
    return new Response(JSON.stringify(path.endsWith('/dispatch') && overrides.response ? overrides.response(value) : value));
  }});
  return {client,sent};
}

test('negotiates exact core and extension on every call and isolates dispatcher credentials', async () => {
  const f=fixture(); await f.client.authorizeDispatch('authority.synthetic',input()); await f.client.authorizeDispatch('authority.synthetic',input());
  assert.equal(f.sent.filter(x=>x.path.endsWith('/dispatch')).length,2);
  assert.equal(f.sent.filter(x=>x.path.endsWith('/dispatch/bundle')).length,2);
  for(const {path,init} of f.sent) {
    assert.equal(init.redirect,'error'); const headers=new Headers(init.headers);
    assert.equal(headers.get('authorization'),`Bearer ${token}`);
    assert.equal(headers.get('x-pwce-dispatcher-token'),path.includes('/dispatch')?dispatcherToken:null);
    assert.ok(!String(init.body).includes(token)); assert.ok(!String(init.body).includes(dispatcherToken));
  }
});

test('changed extension identity, artifact or core dependency stops before mutation', async () => {
  for(const patch of [{bundleDigest:'0'.repeat(64)},{bundleVersion:'2.0.0'},{artifacts:[]},{requiredGatewayBundle:{...dispatchBundle.requiredGatewayBundle,bundleDigest:'0'.repeat(64)}},{extra:true}]) {
    const f=fixture({bundle:{...dispatchBundle,...patch}});
    await assert.rejects(f.client.authorizeDispatch('authority.synthetic',input()),{code:'incompatible_dispatch_contract'});
    assert.equal(f.sent.some(x=>x.path.endsWith('/dispatch')),false);
  }
});

test('bound operations, authority and credential fields cannot be replaced', async () => {
  const f=fixture();
  for(const key of ['operation','authorityContextRef','token','dispatcherToken','profileId','profileVersion','dispatchProfileId','dispatchProfileVersion']) await assert.rejects(f.client.authorizeDispatch('authority.synthetic',{...input(),[key]:'replacement'}),{code:'invalid_request'});
  await assert.rejects(f.client.invoke('',input()),{code:'invalid_request'}); assert.equal(f.sent.length,0);
});

test('input is snapshotted before negotiation awaits', async () => {
  let release:()=>void; const gate=new Promise<void>(r=>{release=r;});
  const f=fixture({fetch:async path=>{if(path.endsWith('/profile'))await gate;return undefined;}});
  const body=input(), pending=f.client.authorizeDispatch('authority.synthetic',body); body.parameters.level=0.9; body.requestId='changed'; release!();
  const result=await pending; assert.deepEqual(result.parameters,{level:0.5}); assert.equal(result.requestId,'request.synthetic');
});

test('mismatched response identity cannot become an accepted disposition', async () => {
  for(const key of ['profileId','profileVersion','dispatchProfileId','dispatchProfileVersion','requestId','correlationId','worldRef','executionEnvironmentRef','status']) {
    const f=fixture({response:request=>({...request,[key]:null})});
    await assert.rejects(f.client.authorizeDispatch('authority.synthetic',input()),{code:'malformed_response'});
  }
});

test('failed invocation is not retried and raw transport or producer prose cannot disclose credentials', async () => {
  const f=fixture({fetch:async path=>{if(path.endsWith('/dispatch'))throw new Error(dispatcherToken);return undefined;}});
  await assert.rejects(f.client.invoke('authority.synthetic',input()),error=>error.code==='unavailable'&&!error.message.includes(dispatcherToken));
  assert.equal(f.sent.filter(x=>x.path.endsWith('/dispatch')).length,1);
  const denied=fixture({fetch:async path=>path.endsWith('/dispatch')?new Response(JSON.stringify({error:{code:'scope_denied',message:dispatcherToken}}),{status:403}):undefined});
  await assert.rejects(denied.client.invoke('authority.synthetic',input()),error=>error.code==='scope_denied'&&error.status===403&&error.source==='provider'&&!error.message.includes(dispatcherToken));
});

test('one deadline bounds negotiation including transports that ignore cancellation', async () => {
  const f=fixture({timeout:20,fetch:async path=>{if(path.endsWith('/dispatch/bundle'))await new Promise(()=>{});return undefined;}});
  await assert.rejects(f.client.authorizeDispatch('authority.synthetic',input()),{code:'deadline_exceeded'});
  assert.equal(f.sent.some(x=>x.path.endsWith('/dispatch')),false);
});

test('caller cancellation and oversized input stop before sending the action', async () => {
  const f=fixture(), controller=new AbortController(); controller.abort();
  await assert.rejects(f.client.invoke('authority.synthetic',input(),controller.signal),{code:'cancelled'});
  await assert.rejects(f.client.invoke('authority.synthetic',{...input(),parameters:{value:'x'.repeat(1_048_576)}}),{code:'limit_exceeded'});
  assert.equal(f.sent.some(x=>x.path.endsWith('/dispatch')),false);
});

test('dispatcher credential must be distinct, bounded and safe for a header', () => {
  for(const secret of [token,'short','x'.repeat(513),'x'.repeat(32)+'\n']) assert.throws(()=>new PwceTrustedDispatchClient({baseUrl:'http://synthetic',token,dispatcherToken:secret}),{code:'invalid_configuration'});
});


test('host scope withdrawal during transport negotiation stops both dispatch operations before POST',async()=>{
 for(const operation of ['authorizeDispatch','invoke']){
  let current=true;const f=fixture({fetch:async path=>{if(path.endsWith('/dispatch/bundle'))current=false;return undefined;}});
  await assert.rejects(f.client[operation]('authority.synthetic',input(),undefined,()=>current),{code:'scope_changed'});
  assert.ok(f.sent.some(x=>x.path.endsWith('/dispatch/bundle')));assert.equal(f.sent.some(x=>x.path.endsWith('/dispatch')),false);
 }
});

test('host send fence rejects nonboolean, asynchronous and throwing answers without leaking prose',async()=>{
 for(const guard of [()=>false,()=>undefined,()=>Promise.resolve(true),()=>Promise.reject(new Error('synthetic secret')),()=>{throw new Error('synthetic secret');}]){
  const f=fixture();await assert.rejects(f.client.invoke('authority.synthetic',input(),undefined,guard),error=>error.code==='scope_changed'&&!error.message.includes('synthetic secret'));assert.equal(f.sent.length,0);
 }
});

test('a valid host send fence is checked twice and never serialized',async()=>{
 let calls=0;const f=fixture();await f.client.invoke('authority.synthetic',input(),undefined,()=>{calls++;return true;});
 assert.equal(calls,2);const sent=f.sent.find(x=>x.path.endsWith('/dispatch'));assert.ok(sent);assert.ok(!String(sent.init.body).includes('isCurrent'));
});
