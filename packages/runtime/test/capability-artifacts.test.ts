import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { CapabilityResolver } from '../src/capabilities/resolver.ts';
import { CapabilityCall } from '../src/capabilities/call.ts';
import { ConfiguredCapabilitySchemas, encodeCapabilitySchema, resolveCapabilitySchema } from '../src/capabilities/schema-artifacts.ts';
import type { CapabilitySchemaStore } from '../src/capabilities/schema-artifacts.ts';
import { FixtureCapabilityProvider } from '../../providers-fixture/src/capability/provider.ts';
import type { CapabilityCallContext, CapabilityDefinition, CapabilityInvocation, CapabilityScope } from '../src/capabilities/ports.ts';
const call=():CapabilityCallContext=>({requestId:'request',correlationId:'correlation',deadlineAt:new Date(Date.now()+5000).toISOString(),executionMode:'live',signal:new AbortController().signal,isCurrent:()=>true});
const scope={assistantId:'assistant',endpointId:'endpoint',sessionId:'session',environment:'test',authorityContextRef:{providerRef:'fixture-authority',contextId:'00000000-0000-4000-8000-000000000001',revision:1}};
const capability:CapabilityDefinition={id:'fixture.sample',version:'1.0.0',inputSchema:{type:'object',required:['value'],properties:{value:{type:'string'}}},outputSchema:{type:'object',required:['fixture'],properties:{fixture:{const:true}},additionalProperties:false},sideEffect:'reversible',authorization:'required',idempotency:'idempotent',latencyClass:'fast',offlineAvailable:false,simulationSupported:false,route:'fixture'};
const invocation=():CapabilityInvocation=>({...scope,invocationId:'invocation',interactionId:'interaction',capabilityId:capability.id,capabilityVersion:capability.version,snapshotId:'00000000-0000-4000-8000-000000000017',snapshotRevision:1,idempotencyKey:'idempotency',input:{value:'SYNTHETIC_INPUT'}});
function setup() {
  const reads:CapabilityScope[]=[];
  let allowed=true,admissions=0;
  const schemas=FixtureCapabilityProvider.schemaArtifacts([capability],owner=>{reads.push(owner);return allowed&&owner.assistantId===scope.assistantId&&owner.sessionId===scope.sessionId;});
  const provider=new FixtureCapabilityProvider([capability],schemas);
  const create=(store:CapabilitySchemaStore|undefined=schemas)=>new CapabilityResolver(provider,undefined,async request=>{admissions++;return {invocationId:request.invocationId,status:'admitted',grantRevision:1};},undefined,store);
  return {schemas,provider,create,reads,admissions:()=>admissions,revoke:()=>{allowed=false;}};
}

test('a fresh resolver recovers schema-bound output without rediscovery, admission or invocation',async()=>{
  const e=setup(),first=e.create();await first.snapshot(scope,call());
  const result=await first.invoke(invocation(),call());assert.equal(result.lifecycle,'succeeded');assert.ok(result.outputSchema);
  const resumed=e.create();e.provider.getSnapshot=async()=>{throw new Error('status must not rediscover');};
  const recovered=await resumed.getInvocation({...scope,invocationId:'invocation'},call());assert.deepEqual(recovered,result);
  assert.equal(e.admissions(),1);assert.equal(e.provider.invocationCount('invocation'),1);
  assert.ok(e.reads.length>=5);
  assert.ok(e.reads.every(owner=>Object.keys(owner).sort().join(',')==='assistantId,authorityContextRef,endpointId,environment,sessionId'));
  assert.doesNotMatch(JSON.stringify(e.reads),/SYNTHETIC_INPUT/);
});

test('referenced schemas cannot silently fall back to inline definitions without a configured store',async()=>{
  const e=setup();const resolver=new CapabilityResolver(e.provider);
  await assert.rejects(()=>resolver.snapshot(scope,call()),/invalidResponse/);assert.equal(e.admissions(),0);
});

test('the output schema is reauthorized for every recovered result',async()=>{
  const e=setup(),first=e.create();await first.snapshot(scope,call());await first.invoke(invocation(),call());e.revoke();
  await assert.rejects(()=>e.create().getInvocation({...scope,invocationId:'invocation'},call()),/invalidResponse/);
  assert.equal(e.provider.invocationCount('invocation'),1);
});

test('revoked input schema access cannot consume admission using an earlier cached definition',async()=>{
  const e=setup(),resolver=e.create();await resolver.snapshot(scope,call());e.revoke();
  const result=await resolver.invoke(invocation(),call());assert.equal(result.lifecycle,'denied');assert.equal(e.admissions(),0);assert.equal(e.provider.invocationCount('invocation'),0);
});

test('scope loss while an artifact read is pending withholds its schema',async()=>{
  const record=encodeCapabilitySchema('urn:synthetic:scope',capability.inputSchema);let release!:()=>void,entered!:()=>void,current=true;
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const store=new ConfiguredCapabilitySchemas([record],async()=>{entered();await held;return true;});
  const context=new CapabilityCall({...call(),isCurrent:()=>current});
  const pending=resolveCapabilitySchema(record.artifact,scope,context,store);await started;current=false;release();
  try{await assert.rejects(pending,/scopeChanged|providerUnavailable/);}finally{context.close();}
});

test('configured pins reject metadata changes and mutable byte substitutions',async()=>{
  const record=encodeCapabilitySchema('urn:synthetic:pin',capability.outputSchema),store=new ConfiguredCapabilitySchemas([record],()=>true);
  const original=new Uint8Array(record.bytes);record.bytes.fill(0);
  const read=await store.read(record.artifact,scope,call());assert.deepEqual(read,original);read!.fill(1);
  assert.deepEqual(await store.read(record.artifact,scope,call()),original);
  for(const changed of [{sha256:'0'.repeat(64)},{byteLength:record.artifact.byteLength+1},{mediaType:'text/plain'},{schemaRef:'unconfigured'},{reference:'https://unconfigured.invalid/schema'}])assert.equal(await store.read({...record.artifact,...changed},scope,call()),undefined);
  const context=new CapabilityCall(call());try{await assert.rejects(()=>resolveCapabilitySchema(record.artifact,scope,context,{read:async()=>new Uint8Array([1,2,3])}),/invalidResponse/);}finally{context.close();}
});

test('schema artifact metadata uses the canonical closed ArtifactRef contract',()=>{
  const record=encodeCapabilitySchema('urn:synthetic:metadata',{type:'object'});
  for(const artifact of [{...record.artifact,sha256:'not-a-digest'},{...record.artifact,byteLength:-1},{...record.artifact,extra:'not-canonical'},{...record.artifact,mediaType:'text/plain'},{...record.artifact,schemaRef:'unconfigured'},{...record.artifact,reference:''}])assert.throws(()=>new ConfiguredCapabilitySchemas([{artifact,bytes:record.bytes}],()=>true),/invalidResponse/);
});

test('validly hashed malformed JSON is rejected before it can define a capability',async()=>{
  const bytes=new TextEncoder().encode('not-json'),artifact={reference:'urn:synthetic:invalid',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'application/schema+json',schemaRef:'https://json-schema.org/draft/2020-12/schema'};
  const store=new ConfiguredCapabilitySchemas([{artifact,bytes}],()=>true),context=new CapabilityCall(call());
  try{await assert.rejects(()=>resolveCapabilitySchema(artifact,scope,context,store),/invalidResponse/);}finally{context.close();}
});

test('inline schema disagreement and missing schema pairs invalidate discovery',async()=>{
  for(const changed of ['different','missing','null']){
    const e=setup(),original=e.provider.getSnapshot.bind(e.provider);
    e.provider.getSnapshot=async(request,context)=>{const result=await original(request,context);return {...result,capabilities:result.capabilities.map(definition=>{if(changed==='different')return {...definition,inputSchema:{type:'string'}};if(changed==='null')return {...definition,inputSchemaRef:null,outputSchemaRef:null} as unknown as CapabilityDefinition;const {outputSchemaRef,...remaining}=definition;return remaining;})};};
    await assert.rejects(()=>e.create().snapshot(scope,call()),/invalidResponse/);assert.equal(e.admissions(),0);
  }
});

test('changed or omitted output references cannot be substituted after dispatch',async()=>{
  for(const kind of ['omitted','changed']){
    const e=setup(),resolver=e.create(),original=e.provider.invoke.bind(e.provider);await resolver.snapshot(scope,call());
    e.provider.invoke=async(request,definition,context)=>{const result=await original(request,definition,context);if(kind==='changed')return {...result,outputSchema:{...result.outputSchema!,sha256:'0'.repeat(64)}};const {outputSchema,...remaining}=result;return remaining;};
    const result=await resolver.invoke(invocation(),call());assert.equal(result.lifecycle,'outcomeUnknown');assert.equal(e.provider.invocationCount('invocation'),1);
  }
});

test('reconstituted configured bytes recover the original schema despite later catalog change',async()=>{
  const e=setup(),resolver=e.create();await resolver.snapshot(scope,call());const result=await resolver.invoke(invocation(),call());const ref=result.outputSchema!;
  const bytes=await e.schemas.read(ref,scope,call());assert.ok(bytes);
  const stored=JSON.parse(JSON.stringify({artifact:ref,bytes:Array.from(bytes)}));
  const restored=new ConfiguredCapabilitySchemas([{artifact:stored.artifact,bytes:new Uint8Array(stored.bytes)}],owner=>owner.assistantId===scope.assistantId);
  e.provider.getSnapshot=async()=>{throw new Error('new catalog is irrelevant to historical output');};
  assert.deepEqual(await e.create(restored).getInvocation({...scope,invocationId:'invocation'},call()),result);
  assert.equal(e.provider.invocationCount('invocation'),1);
});

test('an unknown URL-like reference never initiates schema networking',async()=>{
  const record=encodeCapabilitySchema('https://unconfigured.invalid/schema',capability.inputSchema),store=new ConfiguredCapabilitySchemas([],()=>true),context=new CapabilityCall(call());
  const original=globalThis.fetch;let fetched=false;globalThis.fetch=async()=>{fetched=true;throw new Error('unconfigured network');};
  try{await assert.rejects(()=>resolveCapabilitySchema(record.artifact,scope,context,store),/invalidResponse/);assert.equal(fetched,false);}finally{globalThis.fetch=original;context.close();}
});

test('cold status lookup preserves every owner dimension before reading schema bytes',async()=>{
  const e=setup(),resolver=e.create();await resolver.snapshot(scope,call());await resolver.invoke(invocation(),call());const before=e.reads.length;
  for(const changed of [{assistantId:'other'},{endpointId:'other'},{sessionId:'other'},{environment:'other'},{authorityContextRef:{...scope.authorityContextRef,revision:2}}])assert.equal(await e.create().getInvocation({...scope,...changed,invocationId:'invocation'},call()),undefined);
  assert.equal(e.reads.length,before);assert.equal(e.provider.invocationCount('invocation'),1);
});

test('the original call deadline bounds a schema reader that ignores cancellation',async t=>{
  const record=encodeCapabilitySchema('urn:synthetic:deadline',capability.outputSchema);
  t.mock.timers.enable({apis:['setTimeout']});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const context=new CapabilityCall(call()),pending=resolveCapabilitySchema(record.artifact,scope,context,{read:async()=>{entered();return new Promise(()=>{});}});
  await started;t.mock.timers.tick(5001);
  try{await assert.rejects(pending,/timedOut/);}finally{context.close();}
});

test('boolean JSON Schemas retain their declared allow-all and deny-all semantics',async()=>{
  for(const inputSchema of [true,false]){
    const definition={...capability,inputSchema},schemas=FixtureCapabilityProvider.schemaArtifacts([definition],()=>true),provider=new FixtureCapabilityProvider([definition],schemas);
    let admissions=0;const resolver=new CapabilityResolver(provider,undefined,async request=>{admissions++;return {invocationId:request.invocationId,status:'admitted',grantRevision:1};},undefined,schemas);
    await resolver.snapshot(scope,call());const result=await resolver.invoke(invocation(),call());assert.equal(result.lifecycle,inputSchema?'succeeded':'denied');assert.equal(admissions,inputSchema?1:0);
  }
});
