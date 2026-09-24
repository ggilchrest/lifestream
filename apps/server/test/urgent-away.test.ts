import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {Database,UrgentAwayRepository} from '@lifestream/storage-sqlite';
import type {PwceCondition,PwceConditionResponse} from '@lifestream/providers-pwce';
import type {CapabilityProvider,CapabilityDefinition,CapabilityInvocationResult,AdmittedCapabilityInvocation} from '@lifestream/runtime/capabilities/ports';
import type {AuthorityDispatcher} from '@lifestream/runtime/capabilities/resolver';
import {UrgentAttentionRuntime,type UrgentAttentionFacts} from '../src/runtime/urgent-attention.ts';
import {UrgentAwayRuntime,URGENT_AWAY_INPUT_SCHEMA,URGENT_AWAY_OUTPUT_SCHEMA,URGENT_AWAY_SIMULATION_NOTICE,type UrgentAwayDestination,type UrgentAwaySource} from '../src/runtime/urgent-away.ts';

const scope={principalId:'owner',assistantId:'assistant',endpointId:'away-endpoint'};
const binding={sourceRef:'source',eventClass:'critical-condition',worldRef:'world',siteRef:'site',zoneRef:'zone',label:'PRIVATE_LOCATION_LABEL'};
const capabilityScope={assistantId:scope.assistantId,endpointId:scope.endpointId,sessionId:'message-session',environment:'test',authorityContextRef:{providerRef:'test-authority',contextId:'existing-context',revision:1}};
const capability:CapabilityDefinition={id:'notify',version:'1',route:'synthetic.notify',inputSchema:URGENT_AWAY_INPUT_SCHEMA,outputSchema:URGENT_AWAY_OUTPUT_SCHEMA,sideEffect:'irreversible',authorization:'required',idempotency:'idempotent',latencyClass:'bounded',offlineAvailable:false,simulationSupported:true};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};};
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'bounded observation timed out');await new Promise(resolve=>setTimeout(resolve,5));}}

// Synthetic condition transport and no-network capability adapter. The real
// resolver, current-authority checks, policy runtime, and SQLite journal run.
function fixture(t:TestContext){
 const db=new Database({path:':memory:'});db.migrate();const clock={value:Date.now()},state={authorized:true,evidence:false,current:true,audienceRevision:1,sessionRevision:1,authorizationRevision:1};
 const facts=():UrgentAttentionFacts=>({scope:{...scope},sessionId:capabilityScope.sessionId,sessionRevision:state.sessionRevision,audienceRevision:state.audienceRevision,authorizationRevision:state.authorizationRevision,authorized:state.authorized,privateAudience:true,attentionSuitable:true,outputReady:true});
 const policy=new UrgentAttentionRuntime(db,{bindings:[binding],allowSynthetic:true,now:()=>new Date(clock.value)});
 const condition=(patch:Partial<PwceCondition>={}):PwceCondition=>({conditionRef:'condition',revision:1,sourceRef:'source',worldRef:'world',siteRef:'site',zoneRef:'zone',eventClass:'critical-condition',sourceRevision:1,status:'open',transition:'open',severity:'critical',summary:'PRIVATE_UNTRUSTED_PROSE',occurredAt:new Date(clock.value-100).toISOString(),receivedAt:new Date(clock.value).toISOString(),updatedAt:new Date(clock.value).toISOString(),freshUntil:new Date(clock.value+60000).toISOString(),expiresAt:new Date(clock.value+120000).toISOString(),freshness:'fresh',basis:'synthetic',qualification:{state:'qualified',confidence:1,limitations:['PRIVATE_LIMITATION'],evidenceRefs:['pwce:incident:opaque']},...patch});
 const sourceState={snapshots:0,changes:0,cursor:0,baseline:[] as PwceCondition[],events:[] as PwceCondition[],fail:false,resync:false};
 const response=(operation:'snapshot'|'changes',conditions:PwceCondition[]):PwceConditionResponse=>({profileId:'synthetic',profileVersion:'1.0.0',operation,status:sourceState.resync?'resyncRequired':'ok',evaluatedAt:new Date(clock.value).toISOString(),conditions,nextCursor:sourceState.cursor,hasMore:false,resyncReason:sourceState.resync?'cursorExpired':null,acknowledgment:null,replay:true});
 const source:UrgentAwaySource={snapshot:async()=>{sourceState.snapshots++;if(sourceState.fail)throw Error('PRIVATE_SOURCE_ERROR');return response('snapshot',sourceState.baseline);},changes:async()=>{sourceState.changes++;if(sourceState.fail)throw Error('PRIVATE_SOURCE_ERROR');const events=sourceState.events.splice(0);sourceState.cursor+=events.length;return response('changes',events);}};
 const invocations:AdmittedCapabilityInvocation[]=[],calls={snapshot:0,status:0,dispatch:0};let definition=capability;
 let dispatch:AuthorityDispatcher=async request=>({invocationId:request.invocationId,status:'admitted',grantRevision:1});
 let invoke:CapabilityProvider['invoke']=async request=>({invocationId:request.invocationId,lifecycle:'succeeded',output:{schemaVersion:'1.0.0',accepted:true,receiptRef:'PRIVATE_OPAQUE_RECEIPT'}});
 const provider:CapabilityProvider={getSnapshot:async request=>{calls.snapshot++;return {...request,snapshotId:'snapshot',revision:1,expiresAt:new Date(clock.value+60000).toISOString(),capabilities:[definition]};},getInvocation:async()=>{calls.status++;return undefined;},invoke:async(request,definition,context)=>{
  const row=new UrgentAwayRepository(db).find(scope,'operator-destination',request.input&&typeof request.input==='object'?(request.input as {conditionRef:string}).conditionRef:'');
  assert.equal(row?.state,'attempted','attempt committed before effectful adapter entry');assert.ok(row?.attemptedAt);assert.equal(request.dispatchReceipt?.status,'admitted');invocations.push(request);return invoke(request,definition,context);
 }};
 const destination:UrgentAwayDestination={destinationRef:'operator-destination',revision:1,scope,identity:{assistantRef:scope.assistantId,endpointRef:scope.endpointId,participantRefs:[scope.principalId],audienceRef:'authorized-destination'},capabilityScope,capabilityId:capability.id,capabilityVersion:capability.version,capabilityRoute:capability.route,provider,dispatch:(...args)=>{calls.dispatch++;return dispatch(...args);},facts,current:()=>state.current,evidenceReferencesAllowed:()=>state.evidence};
 const create=(destinations=[destination])=>new UrgentAwayRuntime(db,{runtime:policy,source,destinations,now:()=>new Date(clock.value),pollIntervalMs:30000});
 const runtime=create();const all=[runtime];t.after(()=>{for(const item of all)item.close();db.close();});
 const configure=(changes:Partial<{bypassQuietHours:boolean;quietHours:null|{timeZone:string;startMinute:number;endMinute:number};modality:'text'|'speech';snoozedUntil:string|null}>={})=>policy.configure(scope,{expectedRevision:policy.settings(scope).revision,rules:[{sourceRef:'source',eventClass:'critical-condition',enabled:true,bypassQuietHours:changes.bypassQuietHours??false}],quietHours:changes.quietHours??null,modality:changes.modality??'text',snoozedUntil:changes.snoozedUntil??null});
 const start=async()=>{runtime.start();await until(()=>runtime.inspect(scope).destinations[0]!.connected);};
 const emit=async(patch:Partial<PwceCondition>={})=>{sourceState.events.push(condition(patch));await runtime.tick();};
 const terminal=async()=>{await until(()=>{const row=runtime.inspect(scope).deliveries[0];return !!row&&!['reserved','attempted'].includes(row.state);});return runtime.inspect(scope).deliveries[0]!;};
 return {db,clock,state,policy,runtime,all,source,sourceState,invocations,calls,destination,create,configure,start,emit,terminal,condition,response,setDefinition:(value:CapabilityDefinition)=>definition=value,setDispatch:(value:AuthorityDispatcher)=>dispatch=value,setInvoke:(value:CapabilityProvider['invoke'])=>invoke=value};
}

test('default off causes no source read or dispatch; destination settings cannot share a local endpoint',async t=>{
 const f=fixture(t);f.runtime.start();await f.runtime.tick();assert.equal(f.sourceState.snapshots,0);assert.equal(f.calls.snapshot,0);assert.equal(f.invocations.length,0);
 f.policy.configure({...scope,endpointId:'interactive'},{expectedRevision:0,rules:[{sourceRef:'source',eventClass:'critical-condition',enabled:true,bypassQuietHours:false}],quietHours:null,modality:'text',snoozedUntil:null});
 await f.runtime.tick();assert.equal(f.sourceState.snapshots,0);
 assert.throws(()=>f.create([f.destination,{...f.destination,destinationRef:'second'}]),/Away delivery unavailable/);
 assert.throws(()=>f.create([f.destination,{...f.destination,scope:{...scope,endpointId:'second'}}]),/Away delivery unavailable/);
 assert.throws(()=>f.create([{...f.destination,capabilityScope:{...capabilityScope,endpointId:'foreign'}}]),/Away delivery unavailable/);
});
test('unattended new condition uses durable existing authority dispatch and fixed redacted notice',async t=>{
 const f=fixture(t);f.configure();await f.start();await f.emit();const row=await f.terminal();
 assert.equal(row.state,'accepted');assert.ok(row.attemptedAt);assert.ok(row.acceptedAt);assert.equal(row.acknowledgedAt,null);assert.equal(f.calls.dispatch,1);assert.equal(f.invocations.length,1);
 assert.equal(row.receiptDigest,createHash('sha256').update('PRIVATE_OPAQUE_RECEIPT').digest('hex'));
 const input=f.invocations[0]!.input as Record<string,unknown>;assert.equal(input.message,URGENT_AWAY_SIMULATION_NOTICE);assert.deepEqual(input.evidenceRefs,[]);assert.doesNotMatch(JSON.stringify(input),/PRIVATE_/);
 assert.doesNotMatch(JSON.stringify(f.runtime.inspect(scope)),/PRIVATE_|dispatchReceipt|"provider":|authorityContextRef/);
 const local=f.policy.inspect(scope).deliveries[0]!;assert.equal(local.stage,'cancelled');assert.equal(local.endpointAcceptedAt,null);assert.equal(local.playbackCompletedAt,null);assert.equal(local.acknowledgedAt,null);
 const ack=f.runtime.acknowledge(scope,row.id,row.revision);assert.ok(ack.acknowledgedAt);assert.equal(ack.state,'accepted');
 assert.throws(()=>f.runtime.acknowledge({...scope,principalId:'other'},row.id,ack.revision),/away_dispatch_not_found/);
 assert.deepEqual(f.runtime.inspect({...scope,principalId:'other'}).deliveries,[]);
});
test('baseline, repeated revisions, resolution and restart never replay or resend an episode',async t=>{
 const f=fixture(t);f.sourceState.baseline=[f.condition({conditionRef:'baseline'})];f.configure();await f.start();await f.emit({conditionRef:'baseline',revision:2,transition:'update'});assert.equal(f.calls.snapshot,0);
 await f.emit();await f.terminal();await f.emit({revision:2,transition:'update'});await f.emit({revision:3,transition:'resolve',status:'resolved'});assert.equal(f.invocations.length,1);
 f.runtime.close();const next=f.create();f.all.push(next);f.sourceState.baseline=[];next.start();await until(()=>next.inspect(scope).destinations[0]!.connected);
 f.sourceState.events.push(f.condition({revision:4,transition:'update'}));await next.tick();assert.equal(f.invocations.length,1);assert.equal(next.inspect(scope).deliveries[0]!.state,'accepted');
});
test('temporarily missing authority and changed privacy epochs restore only through a new baseline',async t=>{
 const f=fixture(t);f.configure();f.state.current=false;f.runtime.start();await f.runtime.tick();assert.equal(f.sourceState.snapshots,0);
 f.state.current=true;f.sourceState.baseline=[f.condition({conditionRef:'offline'})];await f.runtime.tick();assert.equal(f.sourceState.snapshots,1);await f.emit({conditionRef:'offline',revision:2,transition:'update'});assert.equal(f.invocations.length,0);
 f.state.audienceRevision++;f.runtime.reconcile();f.sourceState.baseline=[f.condition({conditionRef:'epoch'})];await f.runtime.tick();assert.equal(f.sourceState.snapshots,2);await f.emit({conditionRef:'epoch',revision:2,transition:'update'});assert.equal(f.invocations.length,0);
 await f.emit();assert.equal((await f.terminal()).state,'accepted');
});
test('settings changing during source I/O discard its old response and establish a fresh baseline',async t=>{
 const f=fixture(t),gate=deferred<PwceConditionResponse>();f.configure();await f.start();f.source.changes=async()=>gate.promise;
 const pending=f.runtime.tick();f.configure();f.runtime.reconcile();gate.resolve(f.response('changes',[f.condition()]));await pending;assert.equal(f.calls.snapshot,0);
 f.sourceState.baseline=[f.condition()];await f.runtime.tick();assert.equal(f.sourceState.snapshots,2);assert.equal(f.runtime.inspect(scope).destinations[0]!.connected,true);assert.equal(f.invocations.length,0);
});
test('source errors and resync requests fence effects without unchanged retries',async t=>{
 for(const kind of ['fail','resync'] as const)await t.test(kind,async t=>{const f=fixture(t);f.configure();await f.start();f.sourceState[kind]=true;await f.runtime.tick();assert.equal(f.runtime.inspect(scope).destinations[0]!.connected,false);const reads=f.sourceState.changes;await f.runtime.tick();assert.equal(f.sourceState.changes,reads);
  f.sourceState[kind]=false;f.configure();f.sourceState.baseline=[f.condition()];await f.runtime.tick();assert.equal(f.runtime.inspect(scope).destinations[0]!.connected,true);await f.emit({revision:2,transition:'update'});assert.equal(f.invocations.length,0);
 });
});
test('existing source, severity, freshness, quiet, snooze and synthetic policy remain authoritative',async t=>{
 for(const [name,patch] of Object.entries({stale:{freshness:'stale'},noncritical:{severity:'warning'},foreign:{zoneRef:'foreign'},unqualified:{qualification:{state:'uncertain',confidence:null,limitations:[],evidenceRefs:[]}},resolved:{status:'resolved',transition:'resolve'}}))await t.test(name,async t=>{const f=fixture(t);f.configure();await f.start();await f.emit(patch as Partial<PwceCondition>);assert.equal(f.calls.snapshot,0);assert.equal(f.invocations.length,0);});
 const f=fixture(t);f.configure({snoozedUntil:new Date(f.clock.value+30000).toISOString()});await f.start();await f.emit();assert.equal(f.calls.snapshot,0);
 const minute=new Date(f.clock.value).getUTCHours()*60+new Date(f.clock.value).getUTCMinutes();f.configure({quietHours:{timeZone:'UTC',startMinute:minute,endMinute:(minute+5)%1440}});await f.runtime.tick();await f.emit({conditionRef:'quiet'});assert.equal(f.calls.snapshot,0);
 f.configure({bypassQuietHours:true,quietHours:{timeZone:'UTC',startMinute:minute,endMinute:(minute+5)%1440}});await f.runtime.tick();await f.emit({conditionRef:'bypass'});assert.equal((await f.terminal()).state,'accepted');
});
test('absent, denied and previously uncertain authority never call an effectful provider',async t=>{
 for(const mode of ['absent','denied','unknown'] as const)await t.test(mode,async t=>{const f=fixture(t);f.setDispatch(async request=>mode==='absent'?undefined:{invocationId:request.invocationId,status:mode,grantRevision:1});f.configure();await f.start();await f.emit();const row=await f.terminal();assert.equal(row.state,mode==='absent'?'approvalRequired':mode==='unknown'?'unknown':'denied');assert.equal(row.attemptedAt,null);assert.equal(row.acceptedAt,null);assert.equal(f.invocations.length,0);if(mode==='unknown')assert.equal(row.reason,'admission_uncertain');});
});
test('revocation during delayed authority admission cancels before provider I/O',async t=>{
 const f=fixture(t),gate=deferred<void>(),entered=deferred<void>();f.setDispatch(async request=>{entered.resolve();await gate.promise;return {invocationId:request.invocationId,status:'admitted',grantRevision:1};});f.configure();await f.start();await f.emit();await entered.promise;
 f.state.authorized=false;f.runtime.reconcile();gate.resolve();const row=await f.terminal();assert.equal(row.attemptedAt,null);assert.equal(row.acceptedAt,null);assert.equal(f.invocations.length,0);
});
test('post-attempt cancellation, lost response and invalid output remain unknown without automatic resend',async t=>{
 for(const mode of ['scope','lost','invalid'] as const)await t.test(mode,async t=>{const f=fixture(t);f.setInvoke(async request=>{if(mode==='scope')f.state.authorized=false;if(mode==='lost')throw Error('PRIVATE_PROVIDER_ERROR');return {invocationId:request.invocationId,lifecycle:'succeeded',output:mode==='invalid'?{accepted:true,private:'PRIVATE_PROVIDER_OUTPUT'}:{schemaVersion:'1.0.0',accepted:true,receiptRef:null}};});f.configure();await f.start();await f.emit();const row=await f.terminal();assert.equal(row.state,'unknown');assert.ok(row.attemptedAt);assert.equal(row.acceptedAt,null);assert.equal(row.acknowledgedAt,null);assert.doesNotMatch(JSON.stringify(row),/PRIVATE_/);
  f.state.authorized=true;await f.runtime.tick();await f.emit({revision:2,transition:'update'});assert.equal(f.invocations.length,1);
 });
});
test('resolution cancels a provider that ignores abort; late success cannot become acceptance',async t=>{
 const f=fixture(t),gate=deferred<CapabilityInvocationResult>(),entered=deferred<string>();f.setInvoke(async request=>{entered.resolve(request.invocationId);return gate.promise;});f.configure();await f.start();await f.emit();const id=await entered.promise;
 await f.emit({revision:2,status:'resolved',transition:'resolve'});const row=await f.terminal();assert.equal(row.state,'unknown');gate.resolve({invocationId:id,lifecycle:'succeeded',output:{schemaVersion:'1.0.0',accepted:true,receiptRef:null}});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.runtime.inspect(scope).deliveries[0]!.state,'unknown');assert.equal(f.invocations.length,1);
});
test('only explicit schema-valid acceptance is accepted and raw provider fields never persist',async t=>{
 for(const [name,result] of Object.entries({rejected:{lifecycle:'succeeded',output:{schemaVersion:'1.0.0',accepted:false,receiptRef:null}},failed:{lifecycle:'failed',reason:'PRIVATE_ERROR'},started:{lifecycle:'started'},wrongIdentity:{lifecycle:'succeeded',invocationId:'foreign',output:{schemaVersion:'1.0.0',accepted:true,receiptRef:null}}}))await t.test(name,async t=>{const f=fixture(t);f.setInvoke(async request=>({invocationId:request.invocationId,...result}) as CapabilityInvocationResult);f.configure();await f.start();await f.emit();const row=await f.terminal();assert.equal(row.state,name==='rejected'?'denied':name==='failed'?'failed':'unknown');assert.equal(row.acceptedAt,null);assert.doesNotMatch(JSON.stringify(row),/PRIVATE_/);});
});
test('destination contract must be exactly typed and effectful with required authority and idempotency',async t=>{
 for(const patch of [{route:'other'},{authorization:'none'},{sideEffect:'none'},{idempotency:'unsupported'},{inputSchema:{type:'object'}},{outputSchema:{type:'object'}}])await t.test(JSON.stringify(patch),async t=>{const f=fixture(t);f.setDefinition({...capability,...patch} as CapabilityDefinition);f.configure();await f.start();await f.emit();assert.equal((await f.terminal()).reason,'delivery_contract_invalid');assert.equal(f.calls.dispatch,0);assert.equal(f.invocations.length,0);});
});
test('evidence references require current separate disclosure and remain opaque non-URL data',async t=>{
 const f=fixture(t);f.state.evidence=true;f.configure();await f.start();await f.emit();await f.terminal();assert.deepEqual((f.invocations[0]!.input as {evidenceRefs:string[]}).evidenceRefs,['pwce:incident:opaque']);
 await f.emit({conditionRef:'url',qualification:{state:'qualified',confidence:1,limitations:[],evidenceRefs:['https://private.invalid/media']}});await until(()=>f.runtime.inspect(scope).deliveries.some(r=>r.conditionRef==='url'&&r.state==='denied'));assert.equal(f.invocations.length,1);
});
test('evidence permission revocation while authority admission waits prevents dispatch',async t=>{
 const f=fixture(t),gate=deferred<void>(),entered=deferred<void>();f.state.evidence=true;f.setDispatch(async request=>{entered.resolve();await gate.promise;return {invocationId:request.invocationId,status:'admitted',grantRevision:1};});f.configure();await f.start();await f.emit();await entered.promise;f.state.evidence=false;f.runtime.reconcile();gate.resolve();assert.equal((await f.terminal()).attemptedAt,null);assert.equal(f.invocations.length,0);
});
test('new destination registration cannot inherit local output consent, bypass or snooze',t=>{
 const f=fixture(t),other={...scope,endpointId:'formerly-local'};
 f.policy.configure(other,{expectedRevision:0,rules:[{sourceRef:'source',eventClass:'critical-condition',enabled:true,bypassQuietHours:true}],modality:'text',quietHours:null,snoozedUntil:new Date(f.clock.value+30000).toISOString()});
 const registered=f.create([{...f.destination,destinationRef:'new-destination',scope:other,identity:{...f.destination.identity,endpointRef:other.endpointId},capabilityScope:{...capabilityScope,endpointId:other.endpointId}}]);f.all.push(registered);
 const settings=f.policy.settings(other);assert.ok(settings.rules.every(r=>!r.enabled&&!r.bypassQuietHours));assert.equal(settings.snoozedUntil,null);assert.equal(settings.revision,2);
});
test('same destination restart preserves explicit consent; changed destination revision or route disables it',async t=>{
 for(const patch of [{revision:2},{capabilityRoute:'different.route'},{destinationRef:'different-destination'},{capabilityScope:{...capabilityScope,authorityContextRef:{...capabilityScope.authorityContextRef,revision:2}}}])await t.test(JSON.stringify(patch),t=>{
  const f=fixture(t);f.configure({bypassQuietHours:true});const consent=f.policy.settings(scope).revision;
  const same=f.create();f.all.push(same);assert.equal(f.policy.settings(scope).revision,consent);assert.equal(f.policy.settings(scope).rules[0]!.enabled,true);
  const changed=f.create([{...f.destination,...patch}]);f.all.push(changed);assert.equal(f.policy.settings(scope).revision,consent+1);assert.ok(f.policy.settings(scope).rules.every(r=>!r.enabled&&!r.bypassQuietHours));
 });
});
test('rebinding fences an already running worker even after the new binding is explicitly enabled',async t=>{
 const f=fixture(t);f.configure();await f.start();const changed=f.create([{...f.destination,revision:2}]);f.all.push(changed);f.configure();
 await f.runtime.tick();assert.equal(f.runtime.inspect(scope).destinations[0]!.reason,'scope_unavailable');await f.emit();assert.equal(f.calls.snapshot,0);assert.equal(f.invocations.length,0);
 assert.deepEqual(f.runtime.inspect({...scope,endpointId:'another-route'}).deliveries,[]);assert.equal(f.runtime.inspect({...scope,endpointId:'another-route'}).configured,false);
});
test('existing uncertain provider status records no invented local attempt and cannot be resent',async t=>{
 const f=fixture(t);f.destination.provider.getInvocation=async request=>({invocationId:request.invocationId,lifecycle:'outcomeUnknown'});f.configure();await f.start();await f.emit();const row=await f.terminal();assert.equal(row.state,'unknown');assert.equal(row.reason,'admission_uncertain');assert.equal(row.attemptedAt,null);assert.equal(f.calls.dispatch,0);assert.equal(f.invocations.length,0);
 await f.emit({revision:2,transition:'update'});assert.equal(f.invocations.length,0);
});
test('disable, snooze, expiry and host stop fence pending effects and preserve no-attempt truth',async t=>{
 for(const mode of ['disable','snooze','expiry','stop'] as const)await t.test(mode,async t=>{
  const f=fixture(t),gate=deferred<void>(),entered=deferred<void>();f.setDispatch(async request=>{entered.resolve();await gate.promise;return {invocationId:request.invocationId,status:'admitted',grantRevision:1};});f.configure();await f.start();await f.emit();await entered.promise;
  if(mode==='disable')f.policy.control(scope,{action:'disable',expectedRevision:f.policy.settings(scope).revision});
  if(mode==='snooze')f.policy.control(scope,{action:'snooze',expectedRevision:f.policy.settings(scope).revision,until:new Date(f.clock.value+30000).toISOString()});
  if(mode==='expiry')f.clock.value+=61000;
  if(mode==='stop')f.runtime.close();else f.runtime.reconcile();gate.resolve();const row=await f.terminal();assert.equal(row.attemptedAt,null);assert.equal(row.acceptedAt,null);assert.equal(f.invocations.length,0);
 });
});
test('reservation and attempt custody failures prevent provider entry without inventing an attempt',async t=>{
 for(const phase of ['reserve','attempt'] as const)await t.test(phase,async t=>{
  const f=fixture(t);f.db.connection.exec(phase==='reserve'?"CREATE TRIGGER fail_reserve BEFORE INSERT ON urgent_away_dispatches BEGIN SELECT RAISE(ABORT,'PRIVATE_CUSTODY_ERROR'); END;":"CREATE TRIGGER fail_attempt BEFORE UPDATE ON urgent_away_dispatches WHEN NEW.state='attempted' BEGIN SELECT RAISE(ABORT,'PRIVATE_CUSTODY_ERROR'); END;");
  f.configure();await f.start();await f.emit();
  if(phase==='reserve'){assert.equal(f.runtime.inspect(scope).deliveries.length,0);assert.equal(f.runtime.inspect(scope).destinations[0]!.lastDispatchReason,'journal_unavailable');}
  else{const row=await f.terminal();assert.equal(row.state,'failed');assert.equal(row.attemptedAt,null);}
  assert.equal(f.invocations.length,0);assert.doesNotMatch(JSON.stringify(f.runtime.inspect(scope)),/PRIVATE_CUSTODY_ERROR/);assert.equal(f.policy.inspect(scope).deliveries[0]!.stage,'cancelled');
 });
});
test('unknown outcome remains unknown across process restart and updated source revisions',async t=>{
 const f=fixture(t);f.setInvoke(async()=>{throw Error('PRIVATE_LOST_REPLY');});f.configure();await f.start();await f.emit();assert.equal((await f.terminal()).state,'unknown');f.runtime.close();
 const next=f.create();f.all.push(next);next.start();await until(()=>next.inspect(scope).destinations[0]!.connected);f.sourceState.events.push(f.condition({revision:2,transition:'update'}));await next.tick();assert.equal(next.inspect(scope).deliveries[0]!.state,'unknown');assert.equal(next.inspect(scope).deliveries[0]!.acknowledgedAt,null);assert.equal(f.invocations.length,1);
});

test('an observed-basis condition in a replay envelope still emits a simulation notice',async t=>{
 const f=fixture(t);f.configure();await f.start();await f.emit({basis:'observed'});assert.equal((await f.terminal()).state,'accepted');assert.equal((f.invocations[0]!.input as {message:string}).message,URGENT_AWAY_SIMULATION_NOTICE);
});

test('critical bursts have at most eight in-flight effects and retain truthful suppressed metadata',async t=>{
 const f=fixture(t),gate=deferred<void>();f.setInvoke(async request=>{await gate.promise;return {invocationId:request.invocationId,lifecycle:'succeeded',output:{schemaVersion:'1.0.0',accepted:true,receiptRef:null}};});f.configure();await f.start();
 f.sourceState.events=Array.from({length:20},(_,i)=>f.condition({conditionRef:'burst.'+i}));await f.runtime.tick();await until(()=>f.invocations.length===8);assert.equal(f.calls.dispatch,8);assert.equal(f.policy.inspect(scope).conditions.filter(row=>row.reasons.includes('output_unavailable')).length,12);gate.resolve();await until(()=>f.runtime.inspect(scope).deliveries.every(row=>row.state==='accepted'));
});
