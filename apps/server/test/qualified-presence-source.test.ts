import {isCanonicalQualifiedPresenceGuard} from '../src/runtime/qualified-presence-source.ts';
import {presenceTerminalCustodyRoles,createPresenceTerminalCustodyOwner,type PresenceTerminalCustodyOwners} from '../src/runtime/presence-terminal-custody.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Database} from '@lifestream/storage-sqlite';
import {compileRelationshipContext} from '@lifestream/runtime/context';
import {QualifiedPresenceSource,type PresenceBinding,type PresenceCameraSample,type PresenceIdentitySample,type QualifiedPresenceAvailability,type PresenceAvailabilityWindow} from '../src/runtime/qualified-presence-source.ts';
import {AudienceCoordinator} from '../src/runtime/audience.ts';
import {InitiativeHost,type InitiativeOwner} from '../src/runtime/initiative-host.ts';
import {initiativePreset} from '../src/admin/initiative-policy.ts';
import {extensionSettings} from '../../../tests/fixtures/extension-settings.ts';

/** Identity/enrollment and physical camera are explicit trusted TEST DOUBLES. */
function fixture(available=false,participates=true){
 // Explicit nonphysical participating owners. Production owner integration is separate.
 const custodyIssuers=Object.fromEntries(presenceTerminalCustodyRoles.map(role=>[role,createPresenceTerminalCustodyOwner(role)])) as Record<typeof presenceTerminalCustodyRoles[number],ReturnType<typeof createPresenceTerminalCustodyOwner>>;
 const terminalCustody=Object.freeze(Object.fromEntries(presenceTerminalCustodyRoles.map(role=>[role,custodyIssuers[role].handle]))) as PresenceTerminalCustodyOwners;
 const revokeCustody=(role:typeof presenceTerminalCustodyRoles[number])=>custodyIssuers[role].invalidate();

 let utc=Date.now(),mono=0,allowed=true,seq=1;let clockHook:(()=>void)|undefined,monoHook:(()=>void)|undefined;
 const scope={assistantId:randomUUID(),userId:randomUUID(),relationshipId:randomUUID(),deploymentId:randomUUID()},sessionId=randomUUID(),endpointId=randomUUID(),configurationId=randomUUID();
 const tuning={...extensionSettings.initiative.tuning,arrivalDwellSeconds:10,meaningfulAbsenceSeconds:600,openingsPerHour:2,openingsPerDay:8,checkInIntervalSeconds:1800};
 const configuration={...structuredClone(extensionSettings.initiative),...scope,schemaVersion:'1.0.0',recordType:'configuration',configurationId,revision:1,parentConfigurationRevision:`${configurationId}:1`,lifecycle:'active',preset:'friendly',proactiveness:5,dimensions:initiativePreset(5),allowedContexts:['privateAvailable'],endpointIds:[endpointId],allowedModalities:['text'],allowedKinds:['arrivalReturn'],consentRefs:['fixture:persistent-explicit'],tuning};
 const profile={assistantId:scope.assistantId,profileId:randomUUID(),revision:1,status:'active',adaptivePersonaPolicy:{dimensions:[]}};
 let owner:InitiativeOwner={scope,configuration,profile,boundary:'owner:fixture',consentCurrent:true,evidenceRefs:[]};
 let binding:PresenceBinding={scope,sessionId,endpointId,siteRef:'site:fixture',zoneRef:'zone:fixture',resourceId:'exact:b600',cameraSourceId:'camera:fixture',identitySourceId:'enrolled:fixture',enrollmentRef:'association:fixture',enrollmentRevision:1,captureLeaseId:'lease:fixture',captureFence:'fence:1',configurationRevision:1};
 let camera:PresenceCameraSample={sourceId:binding.cameraSourceId,resourceId:binding.resourceId,captureLeaseId:binding.captureLeaseId,captureFence:binding.captureFence,sequence:seq,observedAt:utc,expiresAt:utc+5000,evidenceRef:'camera:1',coverageKnown:true,occupants:0};
 let identity:PresenceIdentitySample={sourceId:binding.identitySourceId,principalId:scope.userId,siteRef:binding.siteRef,zoneRef:binding.zoneRef,resourceId:binding.resourceId,enrollmentRef:binding.enrollmentRef,enrollmentRevision:1,sequence:seq,observedAt:utc,expiresAt:utc+5000,evidenceRef:'identity:1',status:'qualifiedAbsent'};
 let window:PresenceAvailabilityWindow|null=null,reads=0,currentReads=0,selectionReads=0,availabilityCurrent=true;const abort=new AbortController();let readHook:(()=>void)|undefined,currentHook:(()=>void)|undefined,selectionHook:(()=>void)|undefined;
 const availability:QualifiedPresenceAvailability={...(participates?{terminalCustody}:{}),revision:1,signal:abort.signal,selection:(b,c)=>{selectionReads++;selectionHook?.();return {binding:structuredClone(b),initiativeConfigurationId:c.configurationId,initiativeConfigurationRevision:c.revision,sessionRevision:1};},read:()=>{reads++;readHook?.();return window;},current:()=>{currentReads++;currentHook?.();return availabilityCurrent;}};
 const ports={binding:()=>binding,current:()=>allowed,owner:()=>owner,camera:()=>camera,identity:()=>identity,now:()=>{clockHook?.();return utc;},monotonicMs:()=>{monoHook?.();return mono;},...(available?{availability}:{})};
 const source=new QualifiedPresenceSource('presence:fixture',ports);
 const offer=(id='fixture:window')=>{revokeCustody('availability');window={windowId:id,revision:1,selection:{binding:structuredClone(binding),initiativeConfigurationId:configuration.configurationId,initiativeConfigurationRevision:configuration.revision,sessionRevision:1},evidenceRef:'fixture:affirmative-window',availableFrom:utc,expiresAt:utc+600000};};

 const step=(ms:number,status:PresenceIdentitySample['status']=identity.status,occupants=status==='supported'?1:0)=>{revokeCustody('producer');utc+=ms;mono+=ms;seq++;camera={...camera,sequence:seq,observedAt:utc,expiresAt:utc+5000,evidenceRef:`camera:${seq}`,occupants};identity={...identity,sequence:seq,observedAt:utc,expiresAt:utc+5000,evidenceRef:`identity:${seq}`,status};return source.poll();};
 const absent=(seconds=600)=>{if(identity.status!=='qualifiedAbsent'||camera.occupants!==0)step(1000,'qualifiedAbsent',0);else source.poll();for(let s=0;s<seconds;s+=1)step(1000,'qualifiedAbsent',0);};
 const arrive=(seconds=10)=>{step(1000,'supported',1);for(let s=0;s<seconds;s+=1)step(1000,'supported',1);return source.opportunityId()!;};
 return {revokeCustody,selectionHook:(h:()=>void)=>{selectionHook=h;},clockHook:(h:()=>void)=>{clockHook=h;},monoHook:(h:()=>void)=>{monoHook=h;},availability,ports,offer,get window(){return window;},set window(v:PresenceAvailabilityWindow|null){revokeCustody('availability');window=v;},abort:()=>{revokeCustody('availability');abort.abort();},readHook:(f:()=>void)=>{readHook=f;},currentHook:(f:()=>void)=>{currentHook=f;},availabilityCounts:()=>({reads,currentReads,selectionReads}),availabilityCurrent:(v:boolean)=>{revokeCustody('availability');availabilityCurrent=v;},scope,sessionId,endpointId,configuration,profile,source,step,absent,arrive,now:()=>utc,mono:()=>mono,age(ms:number,wall=true){mono+=ms;if(wall)utc+=ms;},setAllowed(v:boolean){revokeCustody('authentication');allowed=v;},get camera(){return camera;},set camera(v:PresenceCameraSample){revokeCustody('producer');camera=v;},get identity(){return identity;},set identity(v:PresenceIdentitySample){revokeCustody('enrollment');identity=v;},get binding(){return binding;},set binding(v:PresenceBinding){revokeCustody('session');binding=v;},get owner(){return owner;},set owner(v:InitiativeOwner){revokeCustody('configuration');owner=v;}};
}

test('one-person camera count without independent qualified enrolled identity never establishes owner or solo',t=>{
 const f=fixture(),audience=new AudienceCoordinator({sourceIds:[f.source.sourceId],now:f.now,monotonicMs:f.mono});t.after(()=>audience.close());
 const actor={principalId:f.scope.userId,sessionId:f.sessionId,endpointId:f.endpointId};
 f.identity={...f.identity,status:'uncertain'};f.camera={...f.camera,occupants:1};audience.observe(actor,f.source.poll());assert.equal(audience.snapshot(actor).privateAllowed,false);
 f.step(1000,'supported',1);audience.observe(actor,f.source.poll());assert.equal(audience.snapshot(actor).classification,'solo-supported');
 f.step(1000,'supported',2);audience.observe(actor,f.source.poll());assert.equal(audience.snapshot(actor).classification,'shared');assert.equal(audience.snapshot(actor).privateAllowed,false);
 f.identity={...f.identity,principalId:randomUUID()};assert.equal(f.source.poll(),null);
});

test('configured absence/dwell boundaries generate one immutable event; repeated evidence cannot renew or manufacture return',()=>{
 const f=fixture();f.configuration.tuning.arrivalDwellSeconds=12;f.configuration.tuning.meaningfulAbsenceSeconds=601;
 f.absent(600);f.arrive(12);assert.equal(f.source.opportunityId(),undefined);
 f.absent(601);f.arrive(11);assert.equal(f.source.opportunityId(),undefined);f.step(1000,'supported',1);
 const id=f.source.opportunityId()!,event=f.source.resolve(f.scope,f.sessionId,id)!;assert.equal(event.dwellSeconds,12);assert.equal(event.absenceSeconds,601);
 assert.equal(f.source.opportunityId(),id);f.source.poll();assert.deepEqual(f.source.resolve(f.scope,f.sessionId,id),event);
 f.step(1000,'supported',1);assert.deepEqual(f.source.resolve(f.scope,f.sessionId,id),event);event.identityQualified=false;assert.equal(f.source.resolve(f.scope,f.sessionId,id)!.identityQualified,true);
});

test('stale/lost/unknown/shared/restart/handoff observations cannot bridge a qualified absence or create arrival',()=>{
 for(const lose of [(f:ReturnType<typeof fixture>)=>{f.setAllowed(false);f.source.poll();f.setAllowed(true);},(f:ReturnType<typeof fixture>)=>{f.step(1000,'uncertain',1);},(f:ReturnType<typeof fixture>)=>{f.step(1000,'supported',2);},(f:ReturnType<typeof fixture>)=>{f.age(6000);f.source.poll();},(f:ReturnType<typeof fixture>)=>f.source.stop(),(f:ReturnType<typeof fixture>)=>{f.binding={...f.binding,captureFence:'fence:2'};}]){const f=fixture();f.absent();lose(f);f.arrive();assert.equal(f.source.opportunityId(),undefined);}
 const first=fixture();first.arrive(20);assert.equal(first.source.opportunityId(),undefined);
});

test('queued event resolution revalidates enrollment, permission, configuration, scope and original freshness',()=>{
 for(const revoke of [(f:ReturnType<typeof fixture>)=>f.setAllowed(false),(f:ReturnType<typeof fixture>)=>{f.identity={...f.identity,enrollmentRevision:2};},(f:ReturnType<typeof fixture>)=>{f.owner={...f.owner,consentCurrent:false};},(f:ReturnType<typeof fixture>)=>{f.camera={...f.camera,captureFence:'new'};},(f:ReturnType<typeof fixture>)=>{f.configuration.revision++;},(f:ReturnType<typeof fixture>)=>f.age(5000)]){const f=fixture();f.absent();const id=f.arrive();assert.ok(f.source.resolve(f.scope,f.sessionId,id));revoke(f);assert.equal(f.source.resolve(f.scope,f.sessionId,id),undefined);}
 const f=fixture();f.absent();const id=f.arrive();assert.equal(f.source.resolve({...f.scope,userId:randomUUID()},f.sessionId,id),undefined);
});

test('out-of-order, altered duplicate samples and frozen clocks cannot refresh freshness or accelerate dwell',()=>{
 const f=fixture();f.absent();f.step(1000,'supported',1);f.camera={...f.camera,sequence:1};assert.equal(f.source.poll(),null);f.arrive();assert.equal(f.source.opportunityId(),undefined);
 const stalled=fixture();stalled.source.poll();stalled.age(4000,false);assert.ok(stalled.source.poll());stalled.age(1001,false);assert.equal(stalled.source.poll(),null);
 const mutated=fixture();mutated.source.poll();mutated.identity={...mutated.identity,status:'supported'};assert.equal(mutated.source.poll(),null);
});

function integrated(t:TestContext,available=false){
 const f=fixture(available),db=new Database({path:':memory:'});db.migrate();db.exec('CREATE TABLE assistant_relationship_idempotency (idempotency_key TEXT PRIMARY KEY, relationship_id TEXT NOT NULL, operation TEXT NOT NULL, response_json TEXT NOT NULL)');
 const host=new InitiativeHost(db,undefined,f.now,f.source);t.after(()=>{host.close();db.close();});
 const view=()=>compileRelationshipContext({records:[],userInput:'',audienceScope:'authenticatedSession',profileRevision:'profile:fixture',relationshipRevision:`${f.scope.relationshipId}:1`,configurationRevision:`${f.configuration.configurationId}:1`,now:f.now()});
 let calls=0,outputs=0;
 const context:Parameters<InitiativeHost['receiveQualified']>[1]={owner:()=>f.owner,session:()=>({sessionId:f.sessionId,conversationId:f.sessionId,revision:1,endpoint:{schemaVersion:'1.0.0',endpointId:f.endpointId,endpointClass:'testHarness',locationRef:null,ownership:'fixture',inputModalities:['text'],outputModalities:['text'],privacyClass:'personal',presenceCapabilities:[],rendererCapabilities:null,handoffSupport:'none',speakerIdentity:'unavailable',health:'healthy',configurationRevision:1}}),authorized:()=>true,signal:new AbortController().signal,emit:(_p,suffix)=>{suffix();outputs++;},provider:{async *generate(){calls++;yield {kind:'text',text:'Fixture arrival.'};yield {kind:'done'};}},prepare:()=>({assistantId:f.scope.assistantId,endpointId:f.endpointId,isCurrent:()=>true,profileProjection:{sourceRef:'profile:fixture',sourceRevision:'profile:1',corePersona:'Synthetic.',adaptivePersona:'Fixed.'},preparedRelationshipContext:view(),runtimeSelfContext:{sourceRevision:'runtime:fixture',runtimeStatus:'ready',endpointId:f.endpointId,endpointScope:'sessionEndpoint',audienceScope:'authenticatedSession',permissionState:'authenticatedSession',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'notObserved',presentation:'notConfigured'},limitations:['Identity test double, no actual recognition/capture.']}})};
 return {f,host,context,counts:()=>({calls,outputs}),ready:()=>host.handle({schemaVersion:'1.0.0',operation:'outputReadiness',sessionId:f.sessionId,modality:'text',ready:true},context)};
}

test('real qualified ingress/SQLite policy emits once from trusted fixture transition and withdraws before late output',async t=>{
 const i=integrated(t);i.f.absent();const id=i.f.arrive();await i.ready();const received=await i.host.receiveQualified(id,i.context);assert.deepEqual(i.counts(),{calls:1,outputs:1},JSON.stringify({status:received?.status,outcome:i.host.ledger.list(i.f.scope)[0]?.outcome.reasonCodes}));await i.host.receiveQualified(id,i.context);assert.deepEqual(i.counts(),{calls:1,outputs:1});
 for(const revoke of [(f:ReturnType<typeof fixture>)=>f.setAllowed(false),(f:ReturnType<typeof fixture>)=>{f.identity={...f.identity,status:'uncertain'};},(f:ReturnType<typeof fixture>)=>{f.owner={...f.owner,scope:{...f.scope,userId:randomUUID()}};},(f:ReturnType<typeof fixture>)=>{f.binding={...f.binding,identitySourceId:'replacement'};},(f:ReturnType<typeof fixture>)=>{f.step(1000,'supported',2);}]){
  const j=integrated(t);j.f.absent();const event=j.f.arrive();await j.ready();j.context.provider={async *generate(){yield {kind:'text',text:'Held candidate.'};revoke(j.f);yield {kind:'done'};}};await j.host.receiveQualified(event,j.context);assert.equal(j.counts().outputs,0);assert.notEqual(j.host.ledger.list(j.f.scope)[0]?.outcome.state,'emitted');
 }
});

test('identity source separation, future observations and partial coverage fail closed; original monotonic elapsed bounds transition clocks',()=>{
 const same=fixture();same.binding={...same.binding,identitySourceId:same.binding.cameraSourceId};assert.equal(same.source.poll(),null);
 const future=fixture();future.identity={...future.identity,observedAt:future.now()+1};assert.equal(future.source.poll(),null);
 const partial=fixture();partial.absent();partial.camera={...partial.camera,coverageKnown:false};partial.step(1000,'qualifiedAbsent',0);partial.camera={...partial.camera,coverageKnown:true};partial.arrive();assert.equal(partial.source.opportunityId(),undefined);
 const clock=fixture();clock.source.poll();clock.age(600_000,false);clock.step(1000,'qualifiedAbsent',0);clock.arrive();assert.equal(clock.source.opportunityId(),undefined);
 const expired=fixture();expired.absent();const id=expired.arrive();for(let s=0;s<90;s++)expired.step(1000,'supported',1);assert.equal(expired.source.resolve(expired.scope,expired.sessionId,id),undefined);
});


test('late retained event lookup cannot discard a genuine newer transition',()=>{
 const f=fixture();f.absent();const old=f.arrive();f.absent();const successor=f.arrive();assert.notEqual(old,successor);
 assert.equal(f.source.resolve(f.scope,f.sessionId,old),undefined);assert.equal(f.source.resolve({...f.scope,userId:randomUUID()},f.sessionId,successor),undefined);assert.ok(f.source.resolve(f.scope,f.sessionId,successor));
});


const enableCheckIn=(f:ReturnType<typeof fixture>)=>{f.configuration.allowedKinds.push('availableCheckIn');f.configuration.tuning.checkInIntervalSeconds=300;f.configuration.tuning.checkInTtlSeconds=30;};
test('supported identity and interval are not affirmative availability; optional owner defaults off',()=>{
 const absent=fixture();enableCheckIn(absent);absent.offer();absent.step(1,'supported',1);assert.equal(absent.source.opportunityId(),undefined);assert.deepEqual(absent.availabilityCounts(),{reads:0,currentReads:0,selectionReads:0});
 const f=fixture(true);enableCheckIn(f);f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);f.offer();f.step(1,'supported',1);const id=f.source.opportunityId()!;assert.ok(id);const event=f.source.resolve(f.scope,f.sessionId,id)!;assert.equal(event.kind,'availableCheckIn');assert.equal(event.absenceSeconds,undefined);assert.equal(event.observedAt,f.now());f.step(1,'supported',1);assert.deepEqual(f.source.resolve(f.scope,f.sessionId,id),event);
});
test('availability cannot supply identity, coverage, allowed kind, nonzero policy or another selection',()=>{
 for(const status of ['uncertain','unavailable','qualifiedAbsent']as const){const f=fixture(true);enableCheckIn(f);f.offer();f.step(1,status,status==='qualifiedAbsent'?0:1);assert.equal(f.source.opportunityId(),undefined);assert.equal(f.availabilityCounts().reads,0);}
 for(const count of [0,2]){const f=fixture(true);enableCheckIn(f);f.offer();f.step(1,'supported',count);assert.equal(f.source.opportunityId(),undefined);}
 for(const deny of [(f:ReturnType<typeof fixture>)=>{f.configuration.allowedKinds=['arrivalReturn'];},(f:ReturnType<typeof fixture>)=>{f.configuration.tuning.checkInIntervalSeconds=0;},(f:ReturnType<typeof fixture>)=>{f.camera={...f.camera,coverageKnown:false};},(f:ReturnType<typeof fixture>)=>{f.window!.selection.sessionRevision=2;},(f:ReturnType<typeof fixture>)=>{f.window!.selection.binding.captureFence='wrong';}]){const f=fixture(true);enableCheckIn(f);f.offer();deny(f);f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);}
});
test('immutable availability custody and both clocks fence TTL, intervals, replay and content changes',()=>{
 const f=fixture(true);enableCheckIn(f);f.offer();f.step(1,'supported',1);const first=f.source.opportunityId()!,event=f.source.resolve(f.scope,f.sessionId,first)!;
 for(let i=0;i<31;i++)f.step(1000,'supported',1);assert.equal(f.source.opportunityId(),undefined);f.source.stop();f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined,'stop cannot regenerate expired original window');
 f.offer('fixture:next');f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);for(let i=0;i<270;i++)f.step(1000,'supported',1);const second=f.source.opportunityId()!;assert.ok(second);assert.notEqual(second,first);assert.equal(f.source.resolve(f.scope,f.sessionId,first),undefined);assert.ok(f.source.resolve(f.scope,f.sessionId,second));assert.equal(event.expiresAt,event.observedAt+30000);
 f.window!.evidenceRef='changed';f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);f.window!.evidenceRef='fixture:affirmative-window';f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined,'altered window is permanently denied in bounded custody');
 const frozen=fixture(true);enableCheckIn(frozen);frozen.offer();frozen.step(1,'supported',1);const stale=frozen.source.opportunityId()!;frozen.age(30001,false);assert.equal(frozen.source.resolve(frozen.scope,frozen.sessionId,stale),undefined);
});
test('owner faults, accessor values, signal loss and reentrant callbacks fail closed',()=>{
 for(const lose of [(f:ReturnType<typeof fixture>)=>f.abort(),(f:ReturnType<typeof fixture>)=>f.currentHook(()=>f.abort()),(f:ReturnType<typeof fixture>)=>f.readHook(()=>f.abort()),(f:ReturnType<typeof fixture>)=>f.readHook(()=>{f.setAllowed(false);}),(f:ReturnType<typeof fixture>)=>f.currentHook(()=>{f.configuration.revision++;}),(f:ReturnType<typeof fixture>)=>{const selection=f.availability.selection;f.availability.selection=(b,c)=>new Proxy(selection(b,c)!,{ownKeys(target){f.abort();return Reflect.ownKeys(target);}});},(f:ReturnType<typeof fixture>)=>f.currentHook(()=>{throw Error('Owner fault');}),(f:ReturnType<typeof fixture>)=>{f.ports.availability={...f.availability};},(f:ReturnType<typeof fixture>)=>{Object.defineProperty(f.window!,'evidenceRef',{get(){assert.fail('Window getter must not run');}});}]){const f=fixture(true);enableCheckIn(f);f.offer();lose(f);f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);}
 const proxy=fixture(true);enableCheckIn(proxy);proxy.offer();const selection=proxy.availability.selection;proxy.availability.selection=(b,c)=>new Proxy(selection(b,c)!,{ownKeys(target){proxy.abort();return Reflect.ownKeys(target);}});proxy.step(1,'supported',1);assert.equal(proxy.availabilityCounts().reads,0,'An effectful selection descriptor cannot invoke the owner read after abort');
});
test('bounded windows do not evict custody or replace a genuine arrivalReturn',()=>{
 const f=fixture(true);enableCheckIn(f);for(let i=0;i<8;i++){f.offer(`window:${i}`);f.step(i===0?1:300000,'supported',1);assert.ok(f.source.opportunityId());}f.offer('window:8');f.step(300000,'supported',1);assert.equal(f.source.opportunityId(),undefined);
 const arrival=fixture(true);enableCheckIn(arrival);arrival.absent();arrival.offer();const id=arrival.arrive();assert.equal(arrival.source.resolve(arrival.scope,arrival.sessionId,id)!.kind,'arrivalReturn');
});

function armWindowClock(f:ReturnType<typeof fixture>,effect:()=>void,at=7,monotonic=false){
 let reads=0,armed=false;f.currentHook(()=>{if(armed)return;armed=true;const hook=()=>{if(++reads===at)effect();};if(monotonic)f.monoHook(hook);else f.clockHook(hook);});return ()=>reads;
}
test('final configured clock withdrawal denies fresh and retained availability without rebasing custody',()=>{
 for(const monotonic of [false,true])for(const retained of [false,true]){
  const f=fixture(true);enableCheckIn(f);f.offer();let id:string|undefined;
  if(retained){f.step(1,'supported',1);id=f.source.opportunityId();assert.ok(id);}
  const reads=armWindowClock(f,()=>f.abort(),7,monotonic);
  const result=retained?f.source.resolve(f.scope,f.sessionId,id!):(f.step(1,'supported',1),f.source.opportunityId());
  assert.equal(f.availability.signal.aborted,true);assert.equal(reads(),7);assert.equal(result,undefined);
 }
});
test('clock-boundary authority, selection and owner replacements deny original availability',()=>{
 for(const lose of [(f:ReturnType<typeof fixture>)=>f.setAllowed(false),(f:ReturnType<typeof fixture>)=>{f.configuration.revision++;},(f:ReturnType<typeof fixture>)=>{f.ports.availability={...f.availability};}]){
  const f=fixture(true);enableCheckIn(f);f.offer();armWindowClock(f,()=>lose(f));f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);
 }
});
test('terminal owner fence also denies withdrawal in the added selection revalidation clock',()=>{
 for(const retained of [false,true]){
  const f=fixture(true);enableCheckIn(f);f.offer();let id:string|undefined;
  if(retained){f.step(1,'supported',1);id=f.source.opportunityId();assert.ok(id);}
  const reads=armWindowClock(f,()=>f.abort(),13);
  const result=retained?f.source.resolve(f.scope,f.sessionId,id!):(f.step(1,'supported',1),f.source.opportunityId());
  assert.equal(f.availability.signal.aborted,true);assert.equal(reads(),13);assert.equal(result,undefined);
 }
});
test('added final evidence reads cannot roll back original last-seen clock fences',()=>{
 const f=fixture(true);enableCheckIn(f);f.offer();armWindowClock(f,()=>f.age(1),13);f.step(1,'supported',1);assert.ok(f.source.opportunityId());
 f.clockHook(()=>{});f.currentHook(()=>{});f.age(-1);assert.equal(f.source.poll(),null);
});

test('affirmative current verdict follows original and added configured clock revocation',()=>{
 for(const at of [7,13])for(const retained of [false,true])for(const monotonic of [false,true]){
  const f=fixture(true);enableCheckIn(f);f.offer();let id:string|undefined;
  if(retained){f.step(1,'supported',1);id=f.source.opportunityId();assert.ok(id);}
  let revocations=0;const reads=armWindowClock(f,()=>{revocations++;f.availabilityCurrent(false);},at,monotonic);
  const result=retained?f.source.resolve(f.scope,f.sessionId,id!):(f.step(1,'supported',1),f.source.opportunityId());
  assert.equal(reads(),13);assert.equal(revocations,1);assert.equal(f.availability.signal.aborted,false);assert.equal(result,undefined);
 }
});
test('terminal affirmative callback is followed by captured original authority and selection guards',()=>{
 for(const lose of [(f:ReturnType<typeof fixture>)=>f.abort(),(f:ReturnType<typeof fixture>)=>f.setAllowed(false),(f:ReturnType<typeof fixture>)=>{f.configuration.revision++;},(f:ReturnType<typeof fixture>)=>{f.ports.availability={...f.availability};}]){
  const f=fixture(true);enableCheckIn(f);f.offer();let calls=0;f.currentHook(()=>{if(++calls===2)lose(f);});f.step(1,'supported',1);assert.equal(calls,2);assert.equal(f.source.opportunityId(),undefined);
 }
});
test('captured high-water snapshot cannot admit a window that expired in added clock reads',()=>{
 const f=fixture(true);enableCheckIn(f);f.offer();f.window!.expiresAt=f.now()+2;armWindowClock(f,()=>f.age(2),13);f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined);assert.equal(f.availabilityCounts().currentReads,1);
});
test('original host does not generate or emit after final-clock affirmative current withdrawal',async t=>{
 const i=integrated(t,true);enableCheckIn(i.f);i.f.offer();i.f.step(1,'supported',1);const id=i.f.source.opportunityId()!;assert.ok(id);await i.ready();
 armWindowClock(i.f,()=>i.f.availabilityCurrent(false),13);await i.host.receiveQualified(id,i.context);assert.equal(i.f.availability.signal.aborted,false);assert.deepEqual(i.counts(),{calls:0,outputs:0});
});

// Producing assertions from frozen focused negative7 are unchanged. Only the
// fixture declares participating owner registration and pre-mutation revocation.
for(const retained of [false,true])test(`terminal custody denies R3 selection withdrawal for ${retained?'retained':'fresh'} event`,()=>{
 const f=fixture(true);enableCheckIn(f);f.offer();if(retained){f.step(1,'supported',1);assert.ok(f.source.opportunityId());}
 let currentCalls=0,withdrawals=0;f.currentHook(()=>{if(++currentCalls===2)f.selectionHook(()=>{withdrawals++;f.availabilityCurrent(false);});});
 let result:unknown;if(retained)result=f.source.resolve(f.scope,f.sessionId,f.source.opportunityId()!);else{f.step(1,'supported',1);result=f.source.opportunityId();}
 assert.equal(currentCalls,2);assert.equal(withdrawals,1);assert.equal(f.availability.signal.aborted,false);assert.equal(result,undefined);
});
test('legacy nonparticipating owner denies fresh and retained availability but preserves truthful presence',()=>{
 const f=fixture(true,false);enableCheckIn(f);f.offer();assert.ok(f.step(1,'supported',1));assert.equal(f.source.opportunityId(),undefined);assert.deepEqual(f.availabilityCounts(),{reads:0,currentReads:0,selectionReads:0});assert.equal(f.source.resolve(f.scope,f.sessionId,'not-issued'),undefined);
});
test('terminal custody covers every owner callback revocation without signal abort or clock rebasing',()=>{
 for(const role of presenceTerminalCustodyRoles){const f=fixture(true);enableCheckIn(f);f.offer();let calls=0;f.currentHook(()=>{if(++calls===2)f.revokeCustody(role);});f.step(1,'supported',1);assert.equal(f.source.opportunityId(),undefined,role);assert.equal(f.availability.signal.aborted,false);}
});

test('ENTRY custody fences serialization callbacks before window/event publication and resolve ACK',()=>{
 const f=fixture(true);f.configuration.allowedKinds=['availableCheckIn'];f.step(1000,'supported',1);f.offer();
 // Own data survives the original closed copy; Object.prototype.toJSON can
 // still execute during original hash material and must precede final custody.
 const original=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');let armed=false;
 try{
  Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value:function(this:Record<string,unknown>){if(armed&&Object.hasOwn(this,'windowId')){armed=false;f.revokeCustody('availability');}return this;}});
  armed=true;f.source.poll();assert.equal(f.source.opportunityId(),undefined);
  f.offer('fixture:new');f.source.poll();const id=f.source.opportunityId()!;assert.ok(id);const old=f.source.opportunityGuard(id)!;assert.equal(old(),true);armed=true;assert.equal(f.source.resolve(f.scope,f.sessionId,id),undefined);assert.equal(old(),false);
 }finally{if(original)Object.defineProperty(Object.prototype,'toJSON',original);else Reflect.deleteProperty(Object.prototype,'toJSON');}
});


test('manual participating fixture guards never register canonical admission provenance',()=>{
 const f=fixture(true);enableCheckIn(f);f.offer();f.step(1,'supported',1);const id=f.source.opportunityId()!,guard=f.source.opportunityGuard(id)!;assert.ok(id);assert.equal(guard(),true);
 assert.equal(isCanonicalQualifiedPresenceGuard(guard,f.source,id),false);const previous=Reflect.get(f.source,'operationCurrent');let legacyCalls=0;Reflect.set(f.source,'operationCurrent',()=>{legacyCalls++;return false;});try{assert.equal(guard(),false);assert.equal(legacyCalls,1);}finally{Reflect.set(f.source,'operationCurrent',previous);}
 let calls=0;const fake=new Proxy(()=>{calls++;return true;},{get(){calls++;throw Error('getter must not run');}});
 assert.equal(isCanonicalQualifiedPresenceGuard(fake,f.source,id),false);assert.equal(calls,0);
 assert.equal(isCanonicalQualifiedPresenceGuard(()=>true,f.source,id),false);assert.equal(isCanonicalQualifiedPresenceGuard(null,f.source,id),false);
});
