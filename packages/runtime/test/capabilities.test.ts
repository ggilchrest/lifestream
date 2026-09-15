import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityResolver } from "../src/capabilities/resolver.ts";
import { CapabilitySnapshotCache } from "../src/capabilities/cache.ts";
import { FixtureCapabilityProvider } from "../../providers-fixture/src/capability/provider.ts";
import type { CapabilityDefinition, CapabilityInvocation, CapabilityCallContext } from "../src/capabilities/ports.ts";

const call=():CapabilityCallContext=>({requestId:"request",correlationId:"correlation",deadlineAt:new Date(Date.now()+5000).toISOString(),executionMode:"live",signal:new AbortController().signal,isCurrent:()=>true});
const authorityContextRef = { providerRef: "fixture-authority", contextId: "00000000-0000-4000-8000-000000000001", revision: 1 };
const scope = { assistantId: "assistant", endpointId: "endpoint", sessionId: "session", environment: "test", authorityContextRef };
const capability: CapabilityDefinition = { id: "notify", version: "1", inputSchema: { type: "object", required: ["message"] }, outputSchema: { type: "object" }, sideEffect: "irreversible", authorization: "required", idempotency: "idempotent", latencyClass: "fast", offlineAvailable: false, simulationSupported: true, route: "fixture.notify" };
const invocation = (input: unknown = { message: "hello" }): CapabilityInvocation => ({ ...scope, invocationId: "invocation", interactionId: "interaction", capabilityId: "notify", capabilityVersion: "1", snapshotId: "00000000-0000-4000-8000-000000000017", snapshotRevision: 1, input, idempotencyKey: "key" });

test("capability snapshot binds complete scope and current authority admission", async () => {
  const provider = new FixtureCapabilityProvider([capability]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), async (request) => ({ invocationId: request.invocationId, status: "admitted", grantRevision: 1 }), () => "2026-09-07T00:00:00.000Z");
  await resolver.snapshot(scope,call());
  assert.equal((await resolver.invoke(invocation(),call())).lifecycle, "succeeded");
  assert.equal(provider.invocationCount("invocation"), 1);
  assert.equal((await resolver.invoke({ ...invocation(), input: {} },call())).lifecycle, "denied");
  assert.equal(provider.invocationCount("invocation"), 1);
});

test("missing authority admission, changed authority, expiry, and unknown outcomes fail closed", async () => {
  const unknown: CapabilityDefinition = { ...capability, id: "unknown", idempotency: "unsupported" };
  const provider = new FixtureCapabilityProvider([unknown]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), async () => undefined, () => "2026-09-07T00:00:00.000Z");
  await resolver.snapshot(scope,call());
  assert.equal((await resolver.invoke({ ...invocation(), capabilityId: "unknown" },call())).lifecycle, "approvalRequired");
  resolver.invalidate(scope);
  assert.equal((await resolver.invoke({ ...invocation(), capabilityId: "unknown" },call())).lifecycle, "denied");
  assert.equal((await resolver.getInvocation({...scope,invocationId:"missing"},call())), undefined);
});

test("a changed session cannot reuse a cached snapshot", async () => {
  const provider = new FixtureCapabilityProvider([capability]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), async (request) => ({ invocationId: request.invocationId, status: "admitted", grantRevision: 1 }), () => "2026-09-07T00:00:00.000Z");
  await resolver.snapshot(scope,call());
  assert.equal((await resolver.invoke({ ...invocation(), sessionId: "different-session" },call())).lifecycle, "denied");
});

test("an admitted unsupported capability reports unknown and is not invoked twice", async () => {
  const unsupported: CapabilityDefinition = { ...capability, id: "unknown", idempotency: "unsupported" };
  const provider = new FixtureCapabilityProvider([unsupported]);
  const resolver = new CapabilityResolver(provider, new CapabilitySnapshotCache(), async (request) => ({ invocationId: request.invocationId, status: "admitted", grantRevision: 1 }), () => "2026-09-07T00:00:00.000Z");
  await resolver.snapshot(scope,call());
  const request = { ...invocation(), capabilityId: "unknown", invocationId: "unknown-invocation" };
  assert.equal((await resolver.invoke(request,call())).lifecycle, "outcomeUnknown");
  assert.equal((await resolver.invoke(request,call())).lifecycle, "outcomeUnknown");
  assert.equal(provider.invocationCount(request.invocationId), 1);
});

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const admitted=async(request:CapabilityInvocation)=>({invocationId:request.invocationId,status:'admitted' as const,grantRevision:1});
const resolverFor=(provider:FixtureCapabilityProvider,dispatch=admitted)=>new CapabilityResolver(provider,new CapabilitySnapshotCache(),dispatch,()=>"2026-09-07T00:00:00.000Z");
test('late discovery cannot overwrite a newer snapshot or survive scope invalidation',async()=>{
 const provider=new FixtureCapabilityProvider([capability]),original=provider.getSnapshot.bind(provider),first=deferred<void>();let count=0;
 provider.getSnapshot=async(request,context)=>{const order=++count;if(order===1)await first.promise;return {...await original(request,context),revision:order};};
 const resolver=resolverFor(provider),old=resolver.snapshot(scope,call());const latest=await resolver.snapshot(scope,call());assert.equal(latest.revision,2);first.resolve();await assert.rejects(old,/scopeChanged/);
 const second=deferred<void>();provider.getSnapshot=async(request,context)=>{await second.promise;return original(request,context);};const pending=resolver.snapshot(scope,call());resolver.invalidate(scope);second.resolve();await assert.rejects(pending,/scopeChanged/);
});
test('authority expiry or invalidation during delayed admission prevents provider invocation',async()=>{
 for(const invalidation of ['owner','cache']){
  const provider=new FixtureCapabilityProvider([capability]),gate=deferred<void>(),entered=deferred<void>();let current=true;
  const resolver=resolverFor(provider,async request=>{entered.resolve();await gate.promise;return admitted(request);});await resolver.snapshot(scope,call());
  const pending=resolver.invoke(invocation(),{...call(),isCurrent:()=>current});await entered.promise;
  if(invalidation==='owner')current=false;else resolver.invalidate(scope);gate.resolve();
  assert.equal((await pending).lifecycle,'denied');assert.equal(provider.invocationCount('invocation'),0);
 }
});
test('identical concurrent invocations share one admission and one dispatch',async()=>{
 const provider=new FixtureCapabilityProvider([capability]),gate=deferred<void>();let admissions=0;
 const resolver=resolverFor(provider,async request=>{admissions++;await gate.promise;return admitted(request);});await resolver.snapshot(scope,call());
 const first=resolver.invoke(invocation(),call()),second=resolver.invoke(invocation(),call());gate.resolve();
 assert.equal((await first).lifecycle,'succeeded');assert.equal((await second).lifecycle,'succeeded');assert.equal(admissions,1);assert.equal(provider.invocationCount('invocation'),1);
 assert.equal((await resolver.invoke(invocation(),call())).lifecycle,'succeeded');assert.equal(admissions,1,'status lookup precedes one-use admission');
});
test('lost effect responses remain unknown and are never automatically dispatched again',async()=>{
 const provider=new FixtureCapabilityProvider([capability]);let calls=0;
 provider.invoke=async()=>{calls++;throw new Error('PRIVATE_CONNECTION_DETAILS');};const resolver=resolverFor(provider);await resolver.snapshot(scope,call());
 const first=await resolver.invoke(invocation(),call()),second=await resolver.invoke(invocation(),call());assert.equal(first.lifecycle,'outcomeUnknown');assert.equal(second.lifecycle,'outcomeUnknown');assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(first),/PRIVATE_CONNECTION_DETAILS/);
});
test('scope loss after dispatch withholds output and preserves reconciliation uncertainty',async()=>{
 const provider=new FixtureCapabilityProvider([capability]);let current=true;
 provider.invoke=async request=>{current=false;return {invocationId:request.invocationId,lifecycle:'succeeded',output:'PRIVATE_LATE_OUTPUT'};};
 const resolver=resolverFor(provider);await resolver.snapshot(scope,call());const result=await resolver.invoke(invocation(),{...call(),isCurrent:()=>current});assert.equal(result.lifecycle,'outcomeUnknown');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_LATE_OUTPUT/);
});
test('caller cancellation bounds ignored cancellation and blocks late snapshot publication',async()=>{
 const provider=new FixtureCapabilityProvider([capability]),original=provider.getSnapshot.bind(provider),gate=deferred<void>(),controller=new AbortController();
 provider.getSnapshot=async(request,_context)=>{await gate.promise;return original(request,call());};const resolver=resolverFor(provider),pending=resolver.snapshot(scope,{...call(),signal:controller.signal});controller.abort();await assert.rejects(pending,/cancelled/);gate.resolve();await Promise.resolve();assert.equal((await resolver.invoke(invocation(),call())).lifecycle,'denied');
});
test('snapshot and status identities cannot cross owner scope and replay cannot dispatch',async()=>{
 const provider=new FixtureCapabilityProvider([capability]),resolver=resolverFor(provider);await resolver.snapshot(scope,call());
 assert.equal((await resolver.invoke(invocation(),{...call(),executionMode:'replay'})).lifecycle,'denied');assert.equal(provider.invocationCount('invocation'),0);
 await resolver.invoke(invocation(),call());assert.equal(await resolver.getInvocation({...scope,sessionId:'other',invocationId:'invocation'},call()),undefined);
 provider.getInvocation=async()=>({invocationId:'other',lifecycle:'succeeded',output:'FOREIGN'});await assert.rejects(()=>resolver.getInvocation({...scope,invocationId:'invocation'},call()),/invalidResponse/);
});

test('one deadline bounds a dispatched provider that ignores cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const provider=new FixtureCapabilityProvider([capability]),entered=deferred<void>();
 provider.invoke=async()=>{entered.resolve();return new Promise(()=>{});};const resolver=resolverFor(provider);await resolver.snapshot(scope,call());
 const pending=resolver.invoke(invocation(),call());await entered.promise;t.mock.timers.tick(5001);const result=await pending;assert.equal(result.lifecycle,'outcomeUnknown');assert.equal(result.reason,'timedOut');
});
test('input mutation while admission is pending cannot change the dispatched operation',async()=>{
 const provider=new FixtureCapabilityProvider([capability]),gate=deferred<void>(),entered=deferred<void>();let observed:unknown;
 const original=provider.invoke.bind(provider);provider.invoke=async(request,definition,context)=>{observed=request.input;assert.equal(request.dispatchReceipt?.invocationId,request.invocationId);return original(request,definition,context);};
 const resolver=resolverFor(provider,async request=>{entered.resolve();await gate.promise;return admitted(request);});await resolver.snapshot(scope,call());
 const source={message:'original'},pending=resolver.invoke(invocation(source),call());await entered.promise;source.message='changed';gate.resolve();assert.equal((await pending).lifecycle,'succeeded');assert.deepEqual(observed,{message:'original'});
});

test('a replay discovery snapshot cannot be promoted into live invocation authority',async()=>{
 const provider=new FixtureCapabilityProvider([capability]),resolver=resolverFor(provider);await resolver.snapshot(scope,{...call(),executionMode:'replay'});
 assert.equal((await resolver.invoke(invocation(),call())).lifecycle,'denied');assert.equal(provider.invocationCount('invocation'),0);
});
