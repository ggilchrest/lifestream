// Synthetic controller/request boundaries only; no native, model, server or grant.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {guardGameActivityAdapter} from '@lifestream/providers-bizhawk';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {createContractValidator} from '@lifestream/contracts';
const entry=process.env.CT_BINDING_ENTRY??'source';
if(!['source','compiled'].includes(entry))throw Error('Closed source/compiled selector required');
const prefix=entry==='compiled'?'../dist':'../src',ext=entry==='compiled'?'js':'ts';
const {captureSupervisedCtProposal,captureSupervisedCtControllerRequest,ctControllerAdapterForProfile,supervisedCtNoStartPolicy}=await import(`${prefix}/runtime/ct-controller-buttons.${ext}`);
const {createGameControllerAuthority}=await import(`${prefix}/runtime/game-controller-authority.${ext}`);
const {supervisedSessionBounds}=await import(`${prefix}/runtime/supervised-game-session.${ext}`);
const {captureCtVisibleGoalPolicy}=await import(`${prefix}/runtime/ct-visible-goal-policy.${ext}`);
const {captureGameSanityTiming}=await import('../../../packages/providers-bizhawk/'+(entry==='compiled'?'dist':'src')+'/game-sanity-timing.'+ext);
const names=['up','down','left','right','a','b','x','y','l','r','start','select'];
const allowed=names.filter(name=>name!=='start');
function scope(){return {principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID(),environmentId:randomUUID(),activityId:randomUUID(),runId:randomUUID(),activityEpoch:1,timelineId:randomUUID(),timelineRevision:1,campaignId:randomUUID(),observationDomain:'simulatedGame',contextBinding:{sessionId:randomUUID(),conversationId:randomUUID(),endpointId:randomUUID(),participationKind:'logicalActivity',humanSpeakerRef:null,audioOwnerEndpointId:null,ownerPermissionRef:'TEST-not-live-authority'}};}
function request(buttons=['a']){
 const s=scope(),at=new Date().toISOString(),observationId=randomUUID();
 const proposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope:s,proposalId:randomUUID(),observationId,observationRevision:1,preparedViewId:randomUUID(),preparedViewRevision:1,invalidationKey:randomUUID(),buttons,durationFrames:1,maxWallMs:100,expectedVisibleOutcome:'TEST only',uncertainty:'No native source',adviceRefs:[],reason:'TEST only',preconditions:[{predicateId:randomUUID(),fieldId:'TEST:button-domain',expectedValue:'visible',sourceObservationId:observationId}]};
 return {schemaVersion:'1.0.0',operation:'GameActivityAdapter.applyController',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+3000).toISOString(),cancellationId:randomUUID(),executionMode:'simulation',scope:s,idempotencyKey:randomUUID(),payload:{actionId:randomUUID(),proposal,admission:{admissionId:randomUUID(),capabilityInvocationId:randomUUID(),authorityContextRef:{providerRef:'TEST-not-live-authority',contextId:randomUUID(),revision:1},dispatchReceipt:{reference:'TEST-not-live-receipt',sha256:'a'.repeat(64),mediaType:'application/json',schemaRef:'TEST-only',byteLength:1},scopeDigest:'a'.repeat(64),inputDigest:'a'.repeat(64),policyRevision:1,issuedAt:at,expiresAt:new Date(Date.now()+3000).toISOString()},inputOwnerLeaseId:randomUUID(),buttonVector:Object.fromEntries(names.map(name=>[name,Array.isArray(buttons)&&buttons.includes(name)])),protectedMenuOperation:'none',expectedFrameNumber:10,expectedPinsDigest:'a'.repeat(64),dispatchValidation:{planningObservationId:observationId,dispatchObservationId:randomUUID(),dispatchObservationRevision:1,checkedFrameNumber:10,checkedAt:at,validatorRef:'TEST-only',predicateChecks:proposal.preconditions.map(p=>({predicateId:p.predicateId,fieldId:p.fieldId,observedValue:p.expectedValue,matched:true,sourceObservationId:observationId})),planningCapturedAt:at,planningFrameNumber:10,preparedContextFreshUntil:new Date(Date.now()+3000).toISOString()}}};
}
const call=()=>({signal:new AbortController().signal,isCurrent:()=>true});
function authorityFixture(profile='supervised8'){
 const s=scope();let inspections=0,dispatches=0,reviews=0,reviewed;
 const configuration={sessionProfile:profile,scope:s,pinsDigest:'a'.repeat(64),bounds:supervisedSessionBounds,grantId:'TEST-NOT-A-GRANT',policyRevision:1};
 const session={authorityOwner:()=>({database:null,context:{principalId:s.principalId,assertCurrent:()=>{}}}),current:()=>true};
 const repository={inspectGrant:()=>{inspections++;throw Error('TEST-existing-grant-gate-denied');},authorizeDispatch:()=>{dispatches++;throw Error('TEST-no-dispatch');},createRequest:value=>{reviews++;reviewed=value.request;return {request:{state:'pending',...value.request}};}};
 const authority=createGameControllerAuthority(configuration,session,{repository});
 const result={proposal:{scope:s,buttons:['a'],durationFrames:1,maxWallMs:100}};
 const observation={observationId:'TEST-observation',visibleState:[{fieldId:'ct.ui.controller-domain',value:'ordinaryGameplay',visibility:'visibleNow',lastObservedRef:'TEST-observation',freshUntil:new Date(Date.now()+30000).toISOString()}]};
 return {configuration,authority,result,session,observation,join:{runtime:{controllerCurrent:()=>true}},signal:new AbortController().signal,counts:()=>({inspections,dispatches,reviews}),reviewed:()=>reviewed};
}
test('supervised final adapter forwards every allowed button, combinations and neutral unchanged to the original adapter',async()=>{
 let calls=0;const context=call(),adapter={applyController:async(r,c)=>{calls++;assert.equal(c,context);assert.equal(r.payload.buttonVector.start,false);assert(Object.isFrozen(r.payload.proposal.buttons));return {TEST:'adapter boundary only'};},observe:async()=>{},releaseControls:async()=>{},controlSave:async()=>{}};
 const wrapped=ctControllerAdapterForProfile('supervised8',adapter);assert.equal(wrapped.observe,adapter.observe);assert.equal(wrapped.releaseControls,adapter.releaseControls);
 for(const list of [...allowed.map(name=>[name]),['up','a','select'],[]]){const r=request(list);assert.deepEqual(captureSupervisedCtControllerRequest(r),r);assert.equal((await wrapped.applyController(r,context)).TEST,'adapter boundary only');}
 assert.equal(calls,13);
});
test('Start alone or combined and malformed button data stop before original provider admission or native entry',async()=>{
 let native=0,claims=0,getters=0;const raw={applyController:async()=>{native++;throw Error('Unexpected native entry');}};
 const original=guardGameActivityAdapter(raw,{providerRef:'TEST-only',maxDurationMs:5000,sourceAvailable:()=>true,acceptAction:()=>true,claimEffect:async()=>{claims++;return false;}}),wrapped=ctControllerAdapterForProfile('supervised8',original);
 const getter=[];Object.defineProperty(getter,'0',{get(){getters++;return 'start';},enumerable:true});getter.length=1;
 for(const list of [['start'],['a','start'],['start','select'],['Start'],['a','a'],[false],null,'start',{},new Array(1),getter,new Proxy(['start'],{})]){
  const r=request();r.payload.proposal.buttons=list;r.allowSnesStart=true;r.sessionProfile='qualification';
  assert.equal(captureSupervisedCtProposal(r.payload.proposal),null);
  await assert.rejects(wrapped.applyController(r,call()),/ct_supervised_controller_buttons_denied/);
 }
 assert.equal(native,0);assert.equal(claims,0);assert.equal(getters,0);
});
test('last adapter rejects vector-only Start, mismatches and malformed vectors',async()=>{
 let calls=0;const wrapped=ctControllerAdapterForProfile('supervised8',{applyController:async()=>{calls++;}});
 for(const change of [r=>r.payload.buttonVector.start=true,r=>delete r.payload.buttonVector.start,r=>r.payload.buttonVector.a='true',r=>r.payload.buttonVector.extra=false,r=>r.payload.buttonVector=null,r=>r.payload.proposal.buttons=['start']]){
  const r=request();change(r);await assert.rejects(wrapped.applyController(r,call()),/ct_supervised_controller_buttons_denied/);
 }
 assert.equal(calls,0);
});
test('captured last-boundary request cannot adopt later caller mutation',async()=>{
 let seen;const original=request(['a']);const wrapped=ctControllerAdapterForProfile('supervised8',{applyController:async r=>{seen=r;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(r.payload.proposal.buttons,['a']);assert.equal(r.payload.buttonVector.start,false);return 'TEST';}});
 const pending=wrapped.applyController(original,call());original.payload.proposal.buttons.push('start');original.payload.buttonVector.start=true;assert.equal(await pending,'TEST');assert.notEqual(seen,original);assert(Object.isFrozen(seen.payload.buttonVector));
});
test('allowed buttons still require the existing native adapter admission and freshness checks',async()=>{
 let native=0,claims=0;const original=guardGameActivityAdapter({applyController:async()=>{native++;throw Error('Unexpected native entry');}},{providerRef:'TEST-only',maxDurationMs:5000,sourceAvailable:()=>true,acceptAction:()=>true,claimEffect:async()=>{claims++;return false;}});
 const r=request(['a']),validation=createContractValidator().validate('https://lifestream.dev/contracts/local-game-activity/1.0.0#/$defs/GameActionRequest',r);assert.equal(validation.valid,true,JSON.stringify(validation));
 await assert.rejects(ctControllerAdapterForProfile('supervised8',original).applyController(r,call()),/admissionRequired/);assert.equal(claims,1);assert.equal(native,0);
});
test('other trusted profiles retain their original adapter and Start-button behavior',async()=>{
 let calls=0;const original={applyController:async()=>{calls++;return 'TEST only';}};
 for(const profile of [undefined,'qualification']){assert.equal(ctControllerAdapterForProfile(profile,original),original);await ctControllerAdapterForProfile(profile,original).applyController(request(['start']),call());}
 assert.equal(calls,2);
});
test('supervised authority refuses forbidden/malformed proposals before grant inspection, while allowed actions still meet the grant gate',async()=>{
 const f=authorityFixture();f.configuration.sessionProfile='qualification';f.configuration.allowSnesStart=true;
 for(const buttons of [['start'],['a','start'],['Start'],['a','a'],null,'start',new Array(1)]){f.result.proposal.buttons=buttons;assert.equal(await f.authority.requestFor(f.join,f.result,{},f.observation,f.signal),null);}
 assert.deepEqual(f.counts(),{inspections:0,dispatches:0,reviews:0});
 f.result.proposal.buttons=['a'];await assert.rejects(f.authority.requestFor(f.join,f.result,{},f.observation,f.signal),/TEST-existing-grant-gate-denied/);assert.equal(f.counts().inspections,1);assert.equal(f.counts().dispatches,0);
});
test('supervised button restriction is part of grant target and pending review; generic grant target and all run bounds stay unchanged',()=>{
 const f=authorityFixture(),generic=authorityFixture('qualification');
 const digest=v=>createHash('sha256').update(canonicalJson(v)).digest('hex');
 assert.equal(f.authority.operation.targetRefs[0],'urn:lifestream:ct-run:'+digest({scope:f.configuration.scope,pinsDigest:f.configuration.pinsDigest,bounds:supervisedSessionBounds,controllerPolicy:supervisedCtNoStartPolicy}));
 assert.equal(generic.authority.operation.targetRefs[0],'urn:lifestream:ct-run:'+digest({scope:generic.configuration.scope,pinsDigest:generic.configuration.pinsDigest,bounds:supervisedSessionBounds}));
 const pending=f.authority.review();assert.equal(pending.state,'pending');assert.equal(pending.requestedClass,'allowSession');assert.match(pending.effectSummary,/SNES Start button is forbidden/);assert.match(pending.effectSummary,/8 actions/);assert.match(pending.effectSummary,/90000 ms/);
 assert.equal(f.authority.canStart(),false,'No grant exists in this synthetic fixture');
 assert.deepEqual([supervisedSessionBounds.wallBudgetMs,supervisedSessionBounds.actionBudget,supervisedSessionBounds.modelCallBudget,supervisedSessionBounds.maxActionFrames,supervisedSessionBounds.maxActionWallMs,supervisedSessionBounds.startBudget,supervisedSessionBounds.retryBudget,supervisedSessionBounds.memoryEpisodeBudget],[90000,8,8,12,500,1,0,0]);
});

test('actual composition openNative wiring wraps only the pinned supervised adapter',async()=>{
 const source=readFileSync(new URL('../src/runtime/ubuntu-game-composition.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export function createUbuntuGameComposition','function createUbuntuGameComposition');
 for(const profile of ['supervised8','qualification']){
  let options,calls=0;const adapter={applyController:async()=>{calls++;return 'TEST raw adapter';}},physical={evidence:{},openNative:async()=>({adapter,close:()=>{}}),close:async()=>{}};
  const factory=runInNewContext(source+'\ncreateUbuntuGameComposition;',{ctControllerAdapterForProfile,captureCtVisibleGoalPolicy,captureGameSanityTiming,gameInferenceSelectionDigest:()=> 'TEST-selection',supervisedGameProviderAvailable:()=>true,createGameCampaignOwner:()=>({campaign:{},createRepository:()=>{}}),createUbuntuGameHostJoin:value=>{options=value;return {serverOptions:{}};},Date,Promise});
  const configuration={sessionProfile:profile,initialDialogue:'TEST-only-reviewed-initial-dialogue',inferenceMode:'supervisedForeground',inferenceSelection:()=>({TEST:'no provider'}),attach:{scope:scope(),pinsDigest:'a'.repeat(64),providerRef:'TEST-only'},nativeInstallation:{kind:'TEST-inert'},nativeLaunch:{TEST:'never real'},campaign:{bounds:supervisedSessionBounds,policy:{revision:1},journal:{retentionPolicyRef:'TEST-only'}},maximumRunMs:90000};
  factory(configuration,{session:{current:()=>true,resolveApproval:()=>({sharedInference:true})},authority:{requestFor:()=>{throw Error('No request factory called');}},nativeFactory:()=>physical});
  configuration.sessionProfile=profile==='supervised8'?'qualification':'supervised8';
  const opened=await options.client.openNative({},{});
  if(profile==='supervised8'){await assert.rejects(opened.adapter.applyController(request(['start']),call()),/ct_supervised_controller_buttons_denied/);assert.equal(calls,0);await opened.adapter.applyController(request(['a']),call());assert.equal(calls,1);}
  else{assert.equal(opened.adapter,adapter);await opened.adapter.applyController(request(['start']),call());assert.equal(calls,1);}
 }
});

test('actual selected composition factory and real client enforce the last adapter with inert transport only',async t=>{
 const {createUbuntuGameComposition}=await import(`${prefix}/runtime/ubuntu-game-composition.mjs`);
 const {GAME_HOST_PROTOCOL:protocol,gameHostDigest}=await import('@lifestream/contracts/game-host');
 for(const kind of ['allowed','allowedCombo','allowedMovementOnly','start','startCombo','startMovementOnly','malformed','mismatch','widening','invalidVector'])await t.test(kind,async()=>{
  const r=request(kind==='allowedCombo'?['up','a','select']:kind==='start'||kind==='startMovementOnly'?['start']:kind==='startCombo'?['a','start']:['a']);r.executionMode='normal';
  if(kind==='malformed')r.payload.proposal.buttons=null;
  if(kind==='mismatch')r.payload.buttonVector.start=true;
  if(kind==='widening'){r.payload.proposal.buttons=['start'];r.payload.buttonVector.a=false;r.payload.buttonVector.start=true;r.allowSnesStart=true;}
  if(kind==='invalidVector')r.payload.buttonVector.start='false';
  const providerRef='TEST-inert-composition',attachmentId=randomUUID(),command={protocol,kind:'command',attachmentId,commandId:randomUUID(),requestDigest:gameHostDigest(r),expiresAt:r.deadlineAt,request:r};
  let sent=false,stop=false,pendingNext,rawCalls=0,admissions=0,results=0,opened=0,closed=0;
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const denied=()=>response({error:'TEST-finished'},401);
  const fetchAuthenticated=async(url,init)=>{
   assert(url.startsWith('http://127.0.0.1:43928/'));const route=url.split('/').at(-1),body=JSON.parse(init.body);
   if(route==='attach')return response({protocol,attachmentId,expiresAt:new Date(Date.now()+5000).toISOString(),pollMs:1000,maxMessageBytes:131072});
   if(route==='next'){
    if(!sent){sent=true;return response(command);}if(stop)return denied();
    return new Promise((resolve,reject)=>{const abort=()=>{pendingNext=null;reject(Error('TEST-aborted'));};pendingNext=value=>{init.signal.removeEventListener('abort',abort);pendingNext=null;resolve(value);};init.signal.addEventListener('abort',abort,{once:true});if(init.signal.aborted)abort();});
   }
   if(route==='admit'){admissions++;return response({...body,admitted:true,expiresAt:command.expiresAt});}
   if(route==='result'){results++;stop=true;pendingNext?.(denied());return response({protocol,attachmentId,commandId:body.commandId,resultDigest:body.resultDigest,accepted:true});}
   if(route==='detach')return response({...body,fenced:true});
   throw Error('Unexpected TEST transport route');
  };
  const raw={applyController:async request=>{rawCalls++;const at=new Date().toISOString();return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef,completedAt:at,outcome:{status:'succeeded',error:null,payload:{schemaVersion:'1.0.0',recordType:'gameActionReceipt',scope:request.scope,actionId:request.payload.actionId,proposalId:request.payload.proposal.proposalId,idempotencyKey:request.idempotencyKey,inputDigest:request.payload.admission.inputDigest,admissionId:request.payload.admission.admissionId,disposition:'completed',beforeFrame:10,afterFrame:11,framesApplied:1,buttonsNeutralized:true,startedAt:at,completedAt:at,resultingObservationIds:[],recordedAt:at,reason:null}}};}};
  const evidence={installationAvailable:()=>true,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>true,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>null};
  const physical={evidence,shutdownExactOldLease:async()=>true,openNative:async boundary=>{opened++;return {adapter:guardGameActivityAdapter(raw,boundary),close:()=>{closed++;}};},close:async()=>{}};
  const config={sessionProfile:'supervised8',inferenceMode:'supervisedForeground',inferenceSelection:()=>({TEST:'no real provider'}),inferenceQualificationFor:()=>null,backendUrl:'http://127.0.0.1:43928',attach:{protocol,hostId:randomUUID(),scope:r.scope,pinsDigest:'a'.repeat(64),sourceRevision:'b'.repeat(64),providerRef},nativeInstallation:{kind:'TEST-inert'},nativeLaunch:{TEST:'not a native launch'},campaign:{bounds:supervisedSessionBounds,policy:{revision:1},journal:{retentionPolicyRef:'TEST-only'}},maximumRunMs:90000,maximumPlanningSteps:8,maximumCommandMs:3000,metadataRetentionMs:60000,maximumObservationAgeMs:10000,maximumContextBytes:65536,planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024}};
  if(kind.endsWith('MovementOnly')){config.goalMode='movementOnly';config.initialDialogue='';}else config.initialDialogue='TEST-only-reviewed-initial-dialogue';
  const owner=createUbuntuGameComposition(config,{session:{current:()=>true,resolveApproval:()=>({sharedInference:true}),fetchAuthenticated},authority:{requestFor:()=>{throw Error('No actual authority invocation');}},nativeFactory:()=>physical});
  config.sessionProfile='qualification';config.allowSnesStart=true;
  try{await assert.rejects(owner.startClient());}finally{await owner.close();}
  const expected=kind==='allowed'||kind==='allowedCombo'||kind==='allowedMovementOnly'?1:0;
  assert.equal(opened,1);assert.equal(rawCalls,expected);assert.equal(results,expected);assert.equal(admissions,expected);assert.equal(closed,1);
  console.info(JSON.stringify({compositionEntry:entry,case:kind,syntheticRawDispatches:rawCalls,syntheticAdmissionCalls:admissions,realNativeCalls:0,grantsCreated:0}));
 });
});

test('planning constraints reflect frozen controller terms without reading or minting grant authority',()=>{
 const s=scope(),bounds={...supervisedSessionBounds,maxActionWallMs:500,maxInputLeaseMs:375};let current=true,ownerReads=0;
 const session={current:()=>current,authorityOwner:()=>{ownerReads++;throw Error('No authority evaluation for planning metadata');}};
 const configuration={scope:s,bounds,sessionProfile:'supervised8',pinsDigest:'a'.repeat(64),policyRevision:1},authority=createGameControllerAuthority(configuration,session);
 const limits=authority.planningConstraintsFor(s);
 assert.deepEqual(limits,{allowedButtons:allowed,maxDurationFrames:12,maxWallMs:375,grantsAuthority:false});assert(Object.isFrozen(limits)&&Object.isFrozen(limits.allowedButtons));
 bounds.maxActionFrames=120;bounds.maxInputLeaseMs=2000;configuration.sessionProfile='qualification';
 assert.equal(authority.planningConstraintsFor(s),limits);assert.equal(authority.planningConstraintsFor({...s,runId:randomUUID()}),null);
 current=false;assert.equal(authority.planningConstraintsFor(s),null);assert.equal(ownerReads,0);
 const generic=createGameControllerAuthority({...configuration,bounds:supervisedSessionBounds},session);current=true;
 assert.deepEqual(generic.planningConstraintsFor(s).allowedButtons,names);assert.equal(ownerReads,0);
});

test('original execution-owner preparation exposes inert limits before execution approval without beginning execution',async()=>{
 const {createUbuntuGameSession}=await import(prefix+'/runtime/ubuntu-game-session.'+ext);
 const s=scope();let actorCurrent=true,lifecycleCurrent=true,phase='preparing',begins=0;
 const lifecycle={signal:new AbortController().signal,check:()=>lifecycleCurrent,ready(){phase='ready';},beginGameplay(){begins++;phase='playing';},snapshot:()=>({state:phase})};
 const session=createUbuntuGameSession(s,{maximumRunMs:90000,maximumPlanningSteps:8,inferenceMode:'supervisedForeground'},{lifecycle,maximumGameplayMs:64000,canBegin:()=>true});
 const authority=createGameControllerAuthority({scope:s,pinsDigest:'a'.repeat(64),bounds:supervisedSessionBounds,sessionProfile:'supervised8',policyRevision:1},session);
 session.configure({broker:{},origin:'http://127.0.0.1:1',database:{}});
 session.bindHandle({startClient(){},ready:()=>new Promise(()=>{}),completion:()=>new Promise(()=>{}),stop:async()=>{},snapshot:()=>({pauseConfirmation:'confirmed'})});
 const actor={principalId:s.principalId,sessionId:s.contextBinding.sessionId,isCurrent:()=>actorCurrent};
 assert.equal(authority.planningConstraintsFor(s),null);
 await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:true});
 assert.equal(session.current(s),false);assert.equal(session.preparationCurrent(s),true);assert.equal(session.resolveApproval(s),null);
 assert.deepEqual(authority.planningConstraintsFor(s),{allowedButtons:allowed,maxDurationFrames:12,maxWallMs:500,grantsAuthority:false});
 assert.equal(session.resolveApproval(s),null);assert.equal(begins,0,'metadata cannot begin or authorize execution');
 lifecycleCurrent=false;assert.equal(authority.planningConstraintsFor(s),null);lifecycleCurrent=true;actorCurrent=false;assert.equal(authority.planningConstraintsFor(s),null);actorCurrent=true;
 session.beginExecution(s);assert.equal(begins,1);assert.equal(authority.planningConstraintsFor(s).grantsAuthority,false);
 await session.stop(actor);assert.equal(authority.planningConstraintsFor(s),null);
});
