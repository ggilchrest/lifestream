import {presenceTerminalCustodyRoles,createPresenceTerminalCustodyOwner,type PresenceTerminalCustodyOwners} from '../src/runtime/presence-terminal-custody.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database} from '@lifestream/storage-sqlite';
import {compileRelationshipContext} from '@lifestream/runtime/context';
import type {VisualScope} from '@lifestream/runtime/perception/port';
import {AudienceCoordinator} from '../src/runtime/audience.ts';
import {createCameraPresenceLifecycle,type CameraPresenceLifecyclePorts} from '../src/runtime/camera-presence-lifecycle.ts';
import type {CameraResourceLease} from '../src/runtime/production-camera-binding.ts';
import type {PresenceBinding,PresenceCameraSample,PresenceIdentitySample,PresenceAvailabilitySelection,PresenceAvailabilityWindow} from '../src/runtime/qualified-presence-source.ts';
import type {InitiativeHost,InitiativeOwner} from '../src/runtime/initiative-host.ts';
import {initiativePreset} from '../src/admin/initiative-policy.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';

// Resource, evidence, enrolled identity, inference and destination are explicit doubles.
// Real source reducers, audience, custody, Initiative policy and SQLite are exercised.
function fixture(t:TestContext,available=false,enforceAudience=true){
 // Explicit nonphysical participating owners. Production owner integration is separate.
 const custodyIssuers=Object.fromEntries(presenceTerminalCustodyRoles.map(role=>[role,createPresenceTerminalCustodyOwner(role)])) as Record<typeof presenceTerminalCustodyRoles[number],ReturnType<typeof createPresenceTerminalCustodyOwner>>;
 const terminalCustody=Object.freeze(Object.fromEntries(presenceTerminalCustodyRoles.map(role=>[role,custodyIssuers[role].handle]))) as PresenceTerminalCustodyOwners;
 const revokeCustody=(role:typeof presenceTerminalCustodyRoles[number])=>custodyIssuers[role].invalidate();

 let now=Date.now(),mono=1000,sequence=0,current=true,destination=true,consent=true,scopeCurrent=true;
 const scope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()},sessionId=randomUUID(),endpointId=randomUUID(),configurationId=randomUUID();
 const identity={principalId:scope.userId,sessionId,endpointId},sourceId='presence:lifecycle';
 let duringCurrent:(()=>void)|undefined;
 let enrollmentRevision=1,identitySource='enrollment:fixture',occupants=0,status:PresenceIdentitySample['status']='qualifiedAbsent';
 let binding:PresenceBinding={scope,sessionId,endpointId,siteRef:'fixture:site',zoneRef:'fixture:zone',resourceId:'exact:fixture-b600',cameraSourceId:'camera:fixture',identitySourceId:identitySource,enrollmentRef:'fixture:association',enrollmentRevision:1,captureLeaseId:'persistent:fixture',captureFence:'persistent:fence',configurationRevision:1};
 let camera:PresenceCameraSample|null=null,recognition:PresenceIdentitySample|null=null;
 const configuration={...structuredClone(extensionSettings.initiative),...scope,schemaVersion:'1.0.0',recordType:'configuration',configurationId,revision:1,parentConfigurationRevision:`${configurationId}:1`,lifecycle:'active',preset:'friendly',proactiveness:5,dimensions:initiativePreset(5),allowedContexts:['privateAvailable'],endpointIds:[endpointId],allowedModalities:['text'],allowedKinds:['arrivalReturn'],consentRefs:['fixture:purpose'],tuning:{...extensionSettings.initiative.tuning,openingsPerHour:2,openingsPerDay:8,checkInIntervalSeconds:1800}};
 let owner:InitiativeOwner={scope,configuration,profile:{assistantId:scope.assistantId,profileId:randomUUID(),revision:1,status:'active',adaptivePersonaPolicy:{dimensions:[]}},boundary:'fixture:owner',consentCurrent:true,evidenceRefs:[]};
 const db=new Database({path:':memory:'});db.migrate();db.exec('CREATE TABLE assistant_relationship_idempotency (idempotency_key TEXT PRIMARY KEY, relationship_id TEXT NOT NULL, operation TEXT NOT NULL, response_json TEXT NOT NULL)');
 const audience=new AudienceCoordinator({sourceIds:[sourceId,'presence:successor'],now:()=>now,monotonicMs:()=>mono});
 let acquisitions=0,outputs=0,generations=0,destinationReads=0;const resources=new Map<string,CameraResourceLease>();
 const broker={resource:(id:string)=>({resourceId:id,kind:'camera',health:'healthy',permissionStatus:'granted',capabilities:['capture']}),acquireLease(input:{resourceId:string;owner:string;operation:string;ttlMs:number}){if([...resources.values()].some(l=>l.status==='active'&&l.expiresAt>now))throw Error('resource_busy');acquisitions++;const lease={...input,leaseId:`resource:${acquisitions}`,fencingToken:`fence:${acquisitions}`,status:'active',expiresAt:now+input.ttlMs};resources.set(lease.leaseId,lease);return structuredClone(lease);},lease:(id:string)=>structuredClone(resources.get(id)!),assertLease(l:CameraResourceLease,f:string){const actual=resources.get(l.leaseId);if(!actual||actual.status!=='active'||actual.fencingToken!==f||actual.expiresAt<=now)throw Error('inactive');},releaseLease(input:{leaseId:string;fencingToken:string}){const l=resources.get(input.leaseId)!;broker.assertLease(l,input.fencingToken);l.status='released';},renewLease(input:{leaseId:string;fencingToken:string;ttlMs:number}){const l=resources.get(input.leaseId)!;broker.assertLease(l,input.fencingToken);l.expiresAt=now+input.ttlMs;return structuredClone(l);}};
 const visualScope:VisualScope={assistantId:scope.assistantId,principalId:scope.userId,relationshipId:scope.relationshipId,environmentId:scope.deploymentId,conversationId:sessionId,sessionId,endpointId,sessionRevision:1,audienceRevision:0,scopeGeneration:1,sourceBindingRef:'fixture:binding',captureConfigurationRevision:1};
 const destinationCurrent=()=>destination&&current&&scopeCurrent&&consent&&(!enforceAudience||audience.snapshot(identity).privateAllowed);
 const context:Parameters<InitiativeHost['receiveQualified']>[1]={owner:()=>owner,session:()=>({sessionId,conversationId:sessionId,revision:1,endpoint:{schemaVersion:'1.0.0',endpointId,endpointClass:'testHarness',locationRef:null,ownership:'fixture',inputModalities:['text'],outputModalities:['text'],privacyClass:'personal',presenceCapabilities:[],rendererCapabilities:null,handoffSupport:'none',speakerIdentity:'unavailable',health:'healthy',configurationRevision:1}}),authorized:destinationCurrent,signal:new AbortController().signal,emit:(_prefix,suffix)=>{assert.equal(destinationCurrent(),true);suffix();outputs++;},provider:{async *generate(){generations++;yield {kind:'text',text:'Synthetic lifecycle return.'};yield {kind:'done'};}},prepare:()=>({assistantId:scope.assistantId,endpointId,isCurrent:destinationCurrent,profileProjection:{sourceRef:'fixture:profile',sourceRevision:'profile:1',corePersona:'Synthetic.',adaptivePersona:'Fixed.'},preparedRelationshipContext:compileRelationshipContext({records:[],userInput:'',audienceScope:'authenticatedSession',profileRevision:'profile:1',relationshipRevision:`${scope.relationshipId}:1`,configurationRevision:`${configurationId}:1`,now}),runtimeSelfContext:{sourceRevision:'fixture:runtime',runtimeStatus:'ready',endpointId,endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},limitations:['Independent identity, destination and provider doubles.']}})};
 const ports:CameraPresenceLifecyclePorts={database:db,audience,sourceId,now:()=>now,camera:{broker,selection:()=>({resourceId:binding.resourceId,sourceBindingRef:visualScope.sourceBindingRef,configurationRevision:1,permission:'granted'}),scopeCurrent:()=>current&&scopeCurrent,hostLeaseCurrent:()=>false,now:()=>now,monotonicMs:()=>mono},presence:{binding:()=>binding,current:()=>{duringCurrent?.();return current&&scopeCurrent&&consent;},owner:()=>owner,camera:()=>camera,identity:()=>recognition,now:()=>now,monotonicMs:()=>mono},destination:()=>{destinationReads++;return destination?context:null;}};
 let duringAvailabilityCurrent:(()=>void)|undefined;let availabilityEnabled=false;const abortAvailability=new AbortController();const availability={terminalCustody,revision:1,signal:abortAvailability.signal,selection:(b:PresenceBinding,c:{configurationId:string;revision:number})=>({binding:structuredClone(b),initiativeConfigurationId:c.configurationId,initiativeConfigurationRevision:c.revision,sessionRevision:1}),read:(s:PresenceAvailabilitySelection):PresenceAvailabilityWindow|null=>availabilityEnabled?({windowId:'fixture:lifecycle-window',revision:1,selection:structuredClone(s),evidenceRef:'fixture:affirmative-window',availableFrom:now-1000,expiresAt:now+30000}):null,current:()=>{duringAvailabilityCurrent?.();return true;}};
 if(available){configuration.allowedKinds.push('availableCheckIn');ports.availability=availability;status='supported';occupants=1;}
 const lifecycle=createCameraPresenceLifecycle(ports)!;assert.ok(lifecycle);
 const publish=()=>{revokeCustody('producer');sequence++;camera={sourceId:binding.cameraSourceId,resourceId:binding.resourceId,captureLeaseId:binding.captureLeaseId,captureFence:binding.captureFence,sequence,observedAt:now,expiresAt:now+5000,evidenceRef:`fixture:camera:${sequence}`,coverageKnown:true,occupants};recognition={sourceId:identitySource,principalId:scope.userId,siteRef:binding.siteRef,zoneRef:binding.zoneRef,resourceId:binding.resourceId,enrollmentRef:binding.enrollmentRef,enrollmentRevision,sequence,observedAt:now,expiresAt:now+5000,evidenceRef:`fixture:identity:${sequence}`,status};};
 const advance=(ms=1000)=>{now+=ms;mono+=ms;publish();};
 const tick=async(ms=1000)=>{advance(ms);return lifecycle.refresh();};
 const arrival=async()=>{publish();await lifecycle.refresh();for(let i=0;i<600;i++)await tick();status='supported';occupants=1;await tick();for(let i=0;i<9;i++)await tick();publish();};
 t.after(()=>{lifecycle.close();audience.close();db.close();});
 return {revokeDuringCurrent:()=>{duringAvailabilityCurrent=()=>revokeCustody('host');},terminalCustody,revokeCustody,enableAvailability:()=>{revokeCustody('availability');availabilityEnabled=true;},abortAvailability,ports,lifecycle,context,audience,identity,resources,visualScope,scope,publish,tick,advance,arrival,counts:()=>({acquisitions,outputs,generations,destinationReads}),ready:()=>lifecycle.initiative.handle({schemaVersion:'1.0.0',operation:'outputReadiness',sessionId,modality:'text',ready:true},context),withdraw(kind:string){revokeCustody(kind==='enrollment'?'enrollment':kind==='scope'?'session':kind==='consent'?'retention':'host');if(kind==='scope')scopeCurrent=false;else if(kind==='consent')consent=false;else if(kind==='destination')destination=false;else if(kind==='resource')current=false;else if(kind==='source')identitySource='replacement:identity';else if(kind==='enrollment')enrollmentRevision++;else if(kind==='owner')owner={...owner,scope:{...scope,userId:randomUUID()}};else if(kind==='shared')occupants=2;else if(kind==='unknown')status='uncertain';else if(kind==='stale'){now+=5001;mono+=5001;}},closeOnCurrent(){duringCurrent=()=>lifecycle.close();},successorAudience(){audience.observe(identity,{sourceId:'presence:successor',evidenceRef:'fixture:successor',endpointId,principalId:scope.userId,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+5000).toISOString(),coverageKnown:true,ownerPresent:true,occupants:1});},changeSession(){binding={...binding,sessionId:randomUUID()};}};
}

test('default and partial lifecycle configuration is unavailable without calls or acquisition',()=>{
 assert.equal(createCameraPresenceLifecycle(),null);assert.equal(createCameraPresenceLifecycle(null),null);
 let calls=0;assert.equal(createCameraPresenceLifecycle({destination:()=>{calls++;return null;}}),null);assert.equal(calls,0);
});

test('one actual host preserves original readiness and SQLite dedup; construction does not capture',async t=>{
 const f=fixture(t);assert.equal(f.counts().acquisitions,0);assert.equal(f.counts().destinationReads,0);assert.equal(f.counts().generations,0);
 await f.arrival();assert.equal(f.audience.snapshot(f.identity).privateAllowed,true);await f.tick();assert.equal(f.counts().generations,0,'No automatic output readiness');
 const g=fixture(t);await g.arrival();await g.ready();await g.tick();assert.equal(g.counts().outputs,1);await g.lifecycle.refresh();assert.equal(g.counts().outputs,1);assert.equal(g.counts().generations,1);assert.equal(g.lifecycle.initiative.ledger.list(g.scope).length,1);
});

test('one in-flight pump retains exact Promise; close aborts original generation without closing shared audience',async t=>{
 const f=fixture(t);await f.arrival();await f.ready();let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 f.context.provider={async *generate(){enter();await gate;yield {kind:'text',text:'Late fixture.'};yield {kind:'done'};}};
 f.advance();const first=f.lifecycle.refresh(),second=f.lifecycle.refresh();assert.equal(first,second);await entered;
 f.successorAudience();f.lifecycle.close();assert.equal(f.audience.snapshot(f.identity).sourceId,'presence:successor');release();await first;assert.equal(f.counts().outputs,0);assert.equal((await f.lifecycle.refresh()).status,'unavailable');
});

test('original source/context checks withhold held generation on each current withdrawal',async t=>{
 for(const kind of ['scope','consent','destination','resource','source','enrollment','owner','shared','unknown','stale']){
  const f=fixture(t);await f.arrival();await f.ready();let entered=0;
  f.context.provider={async *generate(){entered++;yield {kind:'text',text:'Held candidate.'};f.withdraw(kind);if(kind!=='stale')f.publish();yield {kind:'done'};}};
  await f.tick();assert.equal(entered,1,kind);assert.equal(f.counts().outputs,0,kind);assert.notEqual(f.lifecycle.initiative.ledger.list(f.scope)[0]?.outcome.state,'emitted',kind);
 }
});

test('missing connected destination and source changes never create readiness; captured cleanup preserves successors',async t=>{
 const f=fixture(t);await f.arrival();f.withdraw('destination');assert.equal((await f.tick()).status,'noDestination');assert.equal(f.counts().generations,0);
 const old=f.lifecycle.camera.prepare(f.visualScope,new AbortController().signal);assert.equal(f.resources.get('resource:1')!.status,'active');
 f.lifecycle.camera.release(old);const successor=createCameraPresenceLifecycle(f.ports)!;t.after(()=>successor.close());successor.camera.prepare(f.visualScope,new AbortController().signal);
 f.successorAudience();f.lifecycle.close();assert.equal(f.resources.get('resource:1')!.status,'released');assert.equal(f.resources.get('resource:2')!.status,'active');assert.equal(f.audience.snapshot(f.identity).sourceId,'presence:successor');f.lifecycle.camera.release(old);assert.equal(f.resources.get('resource:2')!.status,'active');
});

test('binding change withdraws only previously published scope; a subsequent manual decision survives stop',async t=>{
 const f=fixture(t);await f.arrival();f.audience.declare(f.identity,'shared');f.lifecycle.close();assert.equal(f.audience.snapshot(f.identity).basis,'manual');assert.equal(f.audience.snapshot(f.identity).classification,'shared');
 const g=fixture(t);await g.arrival();g.changeSession();g.publish();await g.lifecycle.refresh();assert.equal(g.audience.snapshot(g.identity).privateAllowed,false);
});

test('a trusted current callback that closes the lifecycle cannot publish late evidence or enter a destination',async t=>{
 const f=fixture(t);f.publish();f.closeOnCurrent();
 assert.equal((await f.lifecycle.refresh()).status,'unavailable');assert.equal(f.audience.snapshot(f.identity).sourceId,null);assert.equal(f.counts().destinationReads,0);assert.equal(f.counts().outputs,0);
});


test('explicit affirmative availability forwards through the same lifecycle without absence or resource acquisition',async t=>{
 const f=fixture(t,true);f.publish();await f.lifecycle.refresh();await f.ready();f.enableAvailability();const result=await f.lifecycle.refresh();assert.equal(result.status,'processed');assert.deepEqual(f.counts(),{acquisitions:0,outputs:1,generations:1,destinationReads:1},JSON.stringify({result:result.result?.status,reasons:f.lifecycle.initiative.ledger.list(f.scope)[0]?.outcome.reasonCodes}));
 const row=f.lifecycle.initiative.ledger.list(f.scope)[0]!;assert.equal(row.opportunity.kind,'availableCheckIn');assert.equal(row.outcome.state,'emitted');await f.lifecycle.refresh();assert.equal(f.counts().outputs,1);
 f.abortAvailability.abort();assert.equal((await f.lifecycle.refresh()).status,'noOpportunity');assert.equal(f.audience.snapshot(f.identity).privateAllowed,true,'window withdrawal is not identity/absence evidence');
});

test('lifecycle forwarding denies a revoked participating owner without changing original presence',async t=>{const f=fixture(t,true);f.enableAvailability();await f.ready();f.publish();f.revokeDuringCurrent();assert.equal((await f.lifecycle.refresh()).status,'noOpportunity');assert.equal(f.audience.snapshot(f.identity).privateAllowed,true);assert.equal(f.counts().outputs,0);});


test('same source ENTRY custody retires after the original prepared-current callback and prevents delivery',async t=>{
 const f=fixture(t,true);f.publish();await f.lifecycle.refresh();await f.ready();f.enableAvailability();
 const prepare=f.context.prepare,provider=f.context.provider!;let preparedReads=0,withdrawn=false,generated=false;f.context.provider={async *generate(input,signal){for await(const event of provider.generate(input,signal)){if(event.kind==='done')generated=true;yield event;}}};f.context.prepare=()=>{const value=prepare();return {...value,isCurrent:()=>{preparedReads++;if(generated){withdrawn=true;f.revokeCustody('configuration');}return true;}};};
 const result=await f.lifecycle.refresh();assert.equal(result.status,'processed');assert.ok(preparedReads>=2);assert.equal(withdrawn,true);assert.equal(f.counts().generations,1);assert.equal(f.counts().outputs,0);assert.notEqual(f.lifecycle.initiative.ledger.list(f.scope)[0]?.outcome.state,'emitted');
});

// Authentication/current destination ownership does not itself grant disclosure.
for(const mode of ['lock','shared'] as const)test(`qualified arrival intersects current ${mode} audience before generation`,async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();f.audience.declare(f.identity,mode);
 assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);
 await f.tick();assert.equal(f.counts().generations,0);assert.equal(f.counts().outputs,0);
});

test('audience restriction during qualified generation prevents output even while destination remains authenticated',async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();let entered=0;
 f.context.provider={async *generate(){entered++;yield {kind:'text',text:'Synthetic private arrival.'};f.audience.declare(f.identity,'shared');yield {kind:'done'};}};
 await f.tick();assert.equal(entered,1);assert.equal(f.counts().outputs,0);
});

test('stale source still suppresses output with an authenticated destination',async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();let entered=0;
 f.context.provider={async *generate(){entered++;yield {kind:'text',text:'Synthetic stale arrival.'};f.withdraw('stale');yield {kind:'done'};}};
 await f.tick();assert.equal(entered,1);assert.equal(f.counts().outputs,0);
});

for(const restriction of ['audienceLock','audienceShared','audienceWithdrawn','audienceStale','sourceStale','destinationChanged','destinationRevisionChanged','destinationReadinessWithdrawn'] as const)test(`concurrent ${restriction} withdraws held arrival before output`,async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.context.provider={async *generate(){entered();await held;yield {kind:'text',text:'Synthetic held arrival.'};yield {kind:'done'};}};
 f.advance();const pending=f.lifecycle.refresh();await started;
 if(restriction==='audienceLock')f.audience.declare(f.identity,'lock');
 else if(restriction==='audienceShared')f.audience.declare(f.identity,'shared');
 else if(restriction==='audienceWithdrawn')f.audience.observe(f.identity,null);
 else if(restriction==='audienceStale'){
  const eventId=f.lifecycle.source.opportunityId()!;
  for(let n=0;n<6;n++){f.advance();f.lifecycle.source.poll();}
  assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);
  assert.ok(f.lifecycle.source.resolve(f.scope,f.identity.sessionId,eventId),'Physical-source fixture remains fresh; only audience publication expired');
 }
 else if(restriction==='destinationRevisionChanged'){
  const read=f.context.session;f.context.session=()=>{const session=read();return session?{...session,revision:session.revision+1}:undefined;};
 }
 else if(restriction==='destinationReadinessWithdrawn'){
  const result=await f.lifecycle.initiative.handle({schemaVersion:'1.0.0',operation:'outputReadiness',sessionId:f.identity.sessionId,modality:'text',ready:false},f.context);
  assert.equal(result?.status,200);
 }
 else f.withdraw(restriction==='sourceStale'?'stale':'destination');
 release();await pending;
 assert.equal(f.counts().outputs,0,restriction);
 assert.notEqual(f.lifecycle.initiative.ledger.list(f.scope)[0]?.outcome.state,'emitted',restriction);
 assert.equal(f.counts().acquisitions,0,'No sensor or capture acquisition');
});

test('destination authorization callback cannot revoke audience and still admit generation',async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();let authorizationReads=0;
 f.context.authorized=()=>{authorizationReads++;f.audience.declare(f.identity,'shared');return true;};
 await f.tick();assert.ok(authorizationReads>0);assert.equal(f.counts().generations,0);assert.equal(f.counts().outputs,0);
});

test('concurrent audience withdrawal and requalification cannot revive the held candidate',async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.context.provider={async *generate(){entered();await held;yield {kind:'text',text:'Synthetic old audience candidate.'};yield {kind:'done'};}};
 const revision=f.audience.snapshot(f.identity).revision;f.advance();const pending=f.lifecycle.refresh();await started;
 f.audience.observe(f.identity,null);assert.equal(f.audience.snapshot(f.identity).privateAllowed,false);
 f.successorAudience();assert.equal(f.audience.snapshot(f.identity).privateAllowed,true);assert.ok(f.audience.snapshot(f.identity).revision>revision);
 release();await pending;assert.equal(f.counts().outputs,0);
 assert.notEqual(f.lifecycle.initiative.ledger.list(f.scope)[0]?.outcome.state,'emitted');
});

// Same-cycle review control: mutate only inside the original final admission
// callback, after generation, while original source/destination remain current.
for(const change of ['unchanged','withdraw','requalify'] as const)test(`prepared-current final emission audience ${change}`,async t=>{
 const f=fixture(t,false,false);await f.arrival();await f.ready();
 const revision=f.audience.snapshot(f.identity).revision;
 const prepare=f.context.prepare,transition=f.lifecycle.initiative.ledger.transition.bind(f.lifecycle.initiative.ledger);
 let insideBeginEmission=false,preparedReads=0,changed=false,sourceStayedCurrent=false,destinationStayedCurrent=false,outputInvocations=0,emittedTransitions=0;
 const emit=f.context.emit;f.context.emit=(...args:Parameters<typeof emit>)=>{outputInvocations++;return emit(...args);};
 f.lifecycle.initiative.ledger.transition=(...args:Parameters<typeof transition>)=>{
  const previous=insideBeginEmission;insideBeginEmission=args[3].type==='beginEmission';
  try{const result=transition(...args);if(args[3].type==='emitted')emittedTransitions++;return result;}finally{insideBeginEmission=previous;}
 };
 f.context.prepare=()=>{const prepared=prepare();return {...prepared,isCurrent:()=>{
  preparedReads++;const original=prepared.isCurrent();
  if(insideBeginEmission&&!changed){
   changed=true;
   if(change!=='unchanged')f.audience.observe(f.identity,null);
   if(change==='requalify')f.successorAudience();
   destinationStayedCurrent=f.context.authorized();const eventId=f.lifecycle.source.opportunityId();sourceStayedCurrent=!!eventId&&!!f.lifecycle.source.resolve(f.scope,f.identity.sessionId,eventId);
  }
  return original;
 } };};
 await f.tick();
 assert.equal(changed,true,'The prepared callback ran during final beginEmission');assert.ok(preparedReads>0);
 assert.equal(sourceStayedCurrent,true);assert.equal(destinationStayedCurrent,true);
 const outcome=f.lifecycle.initiative.ledger.list(f.scope)[0]!.outcome;
 console.log('PWCE_REVIEW_CAUSAL '+JSON.stringify({change,sourceStayedCurrent,destinationStayedCurrent,generationCalls:f.counts().generations,outputInvocations,emittedTransitions,finalState:outcome.state}));
 if(change==='unchanged'){assert.equal(f.audience.snapshot(f.identity).revision,revision);assert.equal(outputInvocations,1);assert.equal(emittedTransitions,1);assert.equal(f.counts().outputs,1);assert.equal(outcome.state,'emitted');}
 else{assert.ok(f.audience.snapshot(f.identity).revision>revision);assert.equal(outputInvocations,0,'No output call may be invoked; later bookkeeping cannot roll it back');assert.equal(emittedTransitions,0);assert.equal(f.counts().outputs,0);assert.notEqual(outcome.state,'emitted');}
 assert.equal(f.counts().acquisitions,0);
});
