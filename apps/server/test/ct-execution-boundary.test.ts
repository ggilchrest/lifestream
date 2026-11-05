// Synthetic original-owner/lifecycle join. No native facts, actor, model or
// controller authority is manufactured by the timing helper.
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {compileFunction} from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import assert from 'node:assert/strict';
import {createUbuntuGameSession} from '../src/runtime/ubuntu-game-session.ts';
import {createAuthenticatedGameRuntime,captureGameRuntimeOptions} from '../src/runtime/game-host-runtime.ts';
import {createSelectedCtJobLifecycle} from '../../../integration/ct-launcher/ct-job-lifecycle-owner.mjs';
import {fixtureEpisode} from '../../../packages/runtime/test/fixtures/game-memory.ts';
import {GAME_HOST_PROTOCOL} from '@lifestream/contracts/game-host';
import type {ActivityCheckpointRepository} from '@lifestream/storage-sqlite';
import {Database,GameStartRepository} from '@lifestream/storage-sqlite';
import {selectGameWindow,selectManualGameStart,manualGameStartCurrent} from '@lifestream/runtime/activity/policy';
import {claimManualGameStart} from '../src/runtime/game-activity.ts';
import {scriptedGameBounds,scriptedGamePolicy} from '../../../packages/runtime/test/fixtures/game-policy.ts';
import {isDeepStrictEqual} from 'node:util';

const execution={maximumGameplayMs:64000,operationLimits:{owner_prepare:120000,native_prepare:120000,native_start:120000,model:3000,controller:500,settle:5000},cleanupTimeoutMs:5000};
function originalBackendBroker(host:any){
 const source=readFileSync(new URL('../src/runtime/ubuntu-game-backend.ts',import.meta.url),'utf8'),start=source.indexOf(' const broker=Object.fromEntries('),end=source.indexOf('\n const ready=',start);
 assert.ok(start>=0&&end>start);
 return compileFunction(stripTypeScriptTypes(source.slice(start,end),{mode:'strip'})+'\nreturn broker;',['ports','unavailable'])({broker:()=>host},(code:string)=>{throw Error(code);});
}
function fixture(scopeInput?:any,originalBroker?:any){
 const scope=scopeInput??fixtureEpisode().scope;let current=true,qualified=false,quiet=true,grant=true,mono=0,sequence=0,starts=0,brokerCalls=0;
 const lifecycle=createSelectedCtJobLifecycle(execution,{isCurrent:()=>current,canExecute:()=>qualified&&grant,isQuiescent:()=>quiet,onStop:async()=>true,clock:{now:()=>mono,setTimeout:()=>++sequence,clearTimeout:()=>{}}});
 const session=createUbuntuGameSession(scope,{maximumRunMs:90000,maximumPlanningSteps:8,inferenceMode:'supervisedForeground'},{lifecycle,maximumGameplayMs:64000,canBegin:()=>qualified&&quiet});
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>current};
 const broker=originalBroker??Object.fromEntries(['attach','next','admit','complete','detach'].map(name=>[name,async()=>{brokerCalls++;return {};} ]));
 session.configure({broker,origin:'http://127.0.0.1:32123',database:{}});session.setControllerStartCheck(()=>grant);
 session.bindHandle({startClient:()=>{starts++;},ready:async()=>{},completion:()=>new Promise(()=>{}),stop:async()=>{},snapshot:()=>({pauseConfirmation:quiet?'confirmed':'unconfirmed'})});
 const consent={observations:true,campaignJournal:true,controllerInput:true,sharedInference:true};
 return {scope,session,actor,lifecycle,consent,starts:()=>starts,brokerCalls:()=>brokerCalls,qualify:()=>{qualified=true;},grant:(v:boolean)=>{grant=v;},quiet:(v:boolean)=>{quiet=v;},withdraw:()=>{current=false;},advance:(ms:number)=>{mono+=ms;}};
}

// Execute the exact installed-composition selector closure with controlled native
// expiry/review truth. Real session/lifecycle/runtime and SQLite are used below;
// this bounded fixture does not fabricate native permission or image review.
function originalCompositionStart(f:ReturnType<typeof fixture>,nativeExpires:number,reviewed=()=>true){
 const text=readFileSync(new URL('../src/runtime/ubuntu-game-composition.mjs',import.meta.url),'utf8'),start=text.indexOf(' let manualStart;'),end=text.indexOf('  observe:async(',start);
 assert.ok(start>=0&&end>start);const policy=scriptedGamePolicy(Date.now());policy.schedule={enabled:false,timeZone:null,windows:[],validatedPolicyRevision:null,validatedAt:null,policyCurrent:false,unavailableReason:'notConfigured'};
 const campaign={policy,bounds:structuredClone(scriptedGameBounds),checkpoint:{scope:f.scope},journal:{campaignId:f.scope.campaignId}},current=()=>f.session.preparationCurrent(f.scope),configuration={maximumRunMs:90000};
 const args={selectGameWindow,selectManualGameStart,isDeepStrictEqual,session:f.session,scope:f.scope,c:campaign,configuration,current,sourceCurrent:current,foreground:true,frameOwner:{current:reviewed},lastObservation:{scope:f.scope},nativeExpires,executionOwner:true,lifecycle:f.lifecycle,terminalCurrent:()=>false,goal:null};
 const source=compileFunction(text.slice(start,end)+'};return source;',Object.keys(args))(...Object.values(args));
 return {source,input:{scope:f.scope,policy,bounds:campaign.bounds}};
}
test('original manual composition uses consumed deferred consent after review and claims once without issuing an execution approval',async t=>{
 const previousDiagnostics=process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS='1';t.after(()=>{if(previousDiagnostics===undefined)delete process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS;else process.env.LIFESTREAM_TEXT_TIMING_DIAGNOSTICS=previousDiagnostics;});
 const diagnosticRows:Record<string,unknown>[]=[];t.mock.method(console,'info',(value:string)=>{diagnosticRows.push(JSON.parse(value));throw Error('PRIVATE_REPORTER');});
 const {gameCampaignFixture}=await import('../../../packages/runtime/test/fixtures/game-campaign.ts');
 const {selectGameCampaignContext}=await import('@lifestream/runtime/activity/game-journal');
 const {createPreparedTurnBinding}=await import('@lifestream/runtime/inference/prompt');const {randomUUID}=await import('node:crypto');
 const game=gameCampaignFixture(),f=fixture(game.input.expectedScope),scope=f.scope,db=new Database({path:':memory:'});db.migrate();t.after(async()=>{db.close();await f.lifecycle.stop();});
 const originalExpiry=Date.now()+15000,selected=originalCompositionStart(f,originalExpiry);
 assert.equal(selected.source.startFor(),null);await f.session.start(f.actor,f.consent);f.qualify();assert.equal(f.session.resolveApproval(scope),null);
 const first=selected.source.startFor();assert.equal(first.manualStart.status,'selected');assert.equal(first.manualStart.expiresAtMs,originalExpiry);assert.equal(f.session.resolveApproval(scope),null);assert.equal(f.lifecycle.snapshot().gameplayStarted,false);
 const starts=new GameStartRepository(db,{maxClaims:4,maxAssistantSlots:1,limitsFor:()=>({enabled:true,revision:1,rollingPeriodMs:86400000,rollingStartLimit:2,startsPerWindow:1}),quarantined:()=>false,admissionCurrent:()=>f.session.preparationCurrent(scope),inspectionCurrent:()=>true,dispositionCurrent:()=>false});
 assert.equal(claimManualGameStart(starts,selected.input,first.manualStart),true);assert.equal(f.session.resolveApproval(scope),null);assert.equal(claimManualGameStart(starts,selected.input,selected.source.startFor().manualStart),false);assert.equal(f.starts(),1);
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId,conversationId:scope.contextBinding.conversationId,sessionId:scope.contextBinding.sessionId,endpointId:scope.contextBinding.endpointId},conversation:'[]',sourceRevisions:{journal:'1'}});
 let began=0;const runtime=createAuthenticatedGameRuntime(scope,captureGameRuntimeOptions({inferenceMode:'supervisedForeground',resolveApproval:f.session.resolveApproval,sourceCurrent:f.session.preparationCurrent,preparation:{current:f.session.preparationCurrent,begin:candidate=>{began++;f.session.beginExecution(candidate);return true;}}}),{} as ActivityCheckpointRepository,{current:()=>true,prepare:()=>({preparedTurnBinding:binding,isCurrent:()=>true} as any),run:async()=>{throw Error('No model in timing control');},cancel(){},publishEpisode:()=>({state:'unavailable',memoryId:null})})!;t.after(()=>runtime.close());
 const context=selectGameCampaignContext(game.input,game.boundary),bounds={deadlineMs:3000,maximumChunks:128,maximumInputTokens:8192,maximumOutputBytes:8192,maximumOutputTokens:1024};
 runtime.preparePlanning(context,bounds);const approval=f.session.resolveApproval(scope);assert.ok(approval);assert.equal(began,1);runtime.preparePlanning(context,bounds);assert.equal(began,1);assert.equal(f.session.resolveApproval(scope),approval);assert.equal(selected.source.startFor().manualStart,first.manualStart);
 const deadlineRows=diagnosticRows.filter(row=>row.event==='game-planning-deadline');assert.equal(deadlineRows.length,2);assert.equal(deadlineRows[0]!.runtimeExpiresAtMs,deadlineRows[1]!.runtimeExpiresAtMs,'second preparation cannot renew the existing runtime expiry');for(const row of deadlineRows){assert.equal(row.runId,scope.runId);assert.equal(row.viewId,binding.viewId);assert.equal(row.planningDeadlineMs,3000);assert.ok(Number.isSafeInteger(row.planningStartedAtMs));assert.ok(Number(row.effectiveExpiresAtMs)<=Number(row.requestExpiresAtMs));}assert.doesNotMatch(JSON.stringify(diagnosticRows),/PRIVATE|principalId|assistantId/);
});
test('original manual composition clips and caches native expiry and cannot renew or admit an unreviewed frame',async t=>{
 for(const mode of ['native','run','unreviewed','expired'])await t.test(mode,async()=>{
  const f=fixture(),originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  try{await f.session.start(f.actor,f.consent);const nativeExpires=now+(mode==='native'?15000:mode==='expired'?-1:120000),selected=originalCompositionStart(f,nativeExpires,()=>mode!=='unreviewed'),first=selected.source.startFor().manualStart;
   assert.equal(f.session.resolveApproval(f.scope),null);assert.equal(first.status,mode==='unreviewed'||mode==='expired'?'unavailable':'selected');
   if(first.status==='selected'){assert.equal(first.expiresAtMs,Math.min(nativeExpires,now+90000));now=first.expiresAtMs;assert.equal(manualGameStartCurrent(first,f.scope,{policy:selected.input.policy,bounds:selected.input.bounds}),false);assert.equal(selected.source.startFor().manualStart,first);assert.equal(f.session.resolveApproval(f.scope),null);}
  }finally{Date.now=originalNow;await f.lifecycle.stop();}
 });
});
test('Start consumes once into preparation without minting execution approval or starting gameplay; unclassified effect transport remains denied',async()=>{
 const f=fixture();await f.session.start(f.actor,f.consent);assert.equal(f.starts(),1);assert.equal(f.session.status(f.actor).state,'preparing');
 assert.equal(f.session.resolveApproval(f.scope),null);assert.equal(f.session.current(f.scope),false);assert.equal(f.session.preparationCurrent(f.scope),true);assert.equal(f.lifecycle.snapshot().activeGameplayMs,0);
 for(const route of ['attach','next'])assert.equal((await f.session.fetchAuthenticated('http://127.0.0.1:32123/api/runtime/v1/game-host/'+route,{method:'POST',redirect:'error',body:'{}'})).status,200);
 for(const route of ['admit','result'])await assert.rejects(f.session.fetchAuthenticated('http://127.0.0.1:32123/api/runtime/v1/game-host/'+route,{method:'POST',redirect:'error',body:'{}'}),/game_execution_not_ready/);
 assert.equal(f.brokerCalls(),2);await assert.rejects(f.session.start(f.actor,f.consent));await f.lifecycle.stop();
});
test('CT67 nonauthorizing context bind never invokes permission review and cannot reopen after original Start consumption',async()=>{
 const f=fixture();let reviews=0;f.session.setPermissionReview(()=>{reviews++;throw Error('Unexpected permission issuance');});
 const context={assertCurrent:()=>{}};
 f.session.reviewPreparation(f.actor,context);assert.equal(reviews,0);assert.equal(f.session.authorityOwner()!.context,context);assert.equal(f.session.resolveApproval(f.scope),null);
 await f.session.start(f.actor,f.consent);assert.equal(f.starts(),1);assert.throws(()=>f.session.reviewPreparation(f.actor,context),/game_preparation_unavailable/);
 f.qualify();f.session.beginExecution(f.scope);assert.throws(()=>f.session.reviewPreparation(f.actor,context),/game_preparation_unavailable/);assert.equal(reviews,0);assert.equal(f.starts(),1);await f.lifecycle.stop();
});
test('the first qualified original planning boundary issues one fresh finite approval after a long preparatory wait; permission and paused state remain required',async()=>{
 const f=fixture(),originalNow=Date.now;let wall=originalNow();Date.now=()=>wall;
 try{
  await f.session.start(f.actor,f.consent);wall+=3*60*60*1000;f.advance(3*60*60*1000);
  assert.equal(f.session.preparationCurrent(f.scope),true);assert.equal(f.session.resolveApproval(f.scope),null);assert.equal(f.lifecycle.snapshot().activeGameplayMs,0);
  assert.throws(()=>f.session.beginExecution(f.scope));f.qualify();f.quiet(false);assert.throws(()=>f.session.beginExecution(f.scope));f.quiet(true);f.grant(false);assert.throws(()=>f.session.beginExecution(f.scope));f.grant(true);
  const approval=f.session.beginExecution(f.scope);assert.equal(Date.parse(approval.approvedUntil),wall+64000);assert.equal(approval.maximumRunMs,64000);assert.equal(f.session.current(f.scope),true);assert.equal(f.lifecycle.snapshot().state,'playing');
  assert.throws(()=>f.session.beginExecution(f.scope));assert.equal(f.session.resolveApproval(f.scope),approval);
  f.advance(1000);wall+=1000;f.lifecycle.waitForReview();const spent=f.lifecycle.snapshot().activeGameplayMs;wall+=64000;f.advance(64000);
  assert.equal(f.lifecycle.snapshot().activeGameplayMs,spent);assert.equal(f.session.current(f.scope),false);assert.equal(f.session.preparationCurrent(f.scope),false);assert.equal(f.session.resolveApproval(f.scope),null);assert.throws(()=>f.session.beginExecution(f.scope));
 }finally{Date.now=originalNow;await f.lifecycle.stop();}
});
test('original owner withdrawal during preparation prevents any execution approval',async()=>{
 const f=fixture();await f.session.start(f.actor,f.consent);f.qualify();f.withdraw();assert.equal(f.session.preparationCurrent(f.scope),false);assert.throws(()=>f.session.beginExecution(f.scope));assert.equal(f.session.resolveApproval(f.scope),null);await f.lifecycle.stop();
});
test('legacy session still issues its finite wall approval at Start',async()=>{
 const scope=fixtureEpisode().scope,session=createUbuntuGameSession(scope,{maximumRunMs:1000,maximumPlanningSteps:1});const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>true};
 session.configure({broker:{},origin:'http://127.0.0.1:32123',database:{}});session.bindHandle({startClient(){},ready:async()=>{},completion:()=>new Promise(()=>{}),snapshot:()=>({})});
 const before=Date.now();await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false});assert.ok(Date.parse(session.resolveApproval(scope).approvedUntil)>=before+1000);assert.equal(session.current(scope),true);
});
test('the original server runtime can retain preparation without an approval, but cannot prepare an unqualified selection, run a model, or admit controller input',async()=>{
 const f=fixture();await f.session.start(f.actor,f.consent);let beginnings=0,modelCalls=0;
 const options=captureGameRuntimeOptions({inferenceMode:'supervisedForeground',resolveApproval:f.session.resolveApproval,sourceCurrent:f.session.preparationCurrent,preparation:{current:f.session.preparationCurrent,begin:scope=>{beginnings++;f.session.beginExecution(scope);return true;}}});
 const runtime=createAuthenticatedGameRuntime(f.scope,options,{} as ActivityCheckpointRepository,{current:()=>true,prepare:()=>{throw Error('No selected original prepared turn in this negative fixture');},run:async()=>{modelCalls++;throw Error('No model allowed');},cancel(){},publishEpisode:()=>({state:'unavailable',memoryId:null})})!;
 assert.ok(runtime);assert.equal(runtime.isCurrent(),true);assert.equal(runtime.controllerCurrent(),false);assert.equal(runtime.isQuiescent(),true);
 assert.throws(()=>runtime.preparePlanning({status:'unavailable'} as never,{} as never));assert.equal(beginnings,0);assert.equal(modelCalls,0);assert.equal(f.session.resolveApproval(f.scope),null);
 assert.equal((await runtime.runPlanning({} as never,{} as never)).state,'suppressed');assert.equal(modelCalls,0);f.withdraw();assert.equal(runtime.isCurrent(),false);await f.lifecycle.stop();
});

test('terminal Stop, retirement and failed lifecycle entry cannot regain preparation or mint a later approval',async()=>{
 for(const terminal of ['stop','retire','failedBegin']){
  const f=fixture();await f.session.start(f.actor,f.consent);f.qualify();
  if(terminal==='stop')await f.session.stop(f.actor);
  else if(terminal==='retire')f.session.retire();
  else {f.lifecycle.ready();f.lifecycle.beginGameplay();assert.throws(()=>f.session.beginExecution(f.scope));}
  assert.equal(f.session.preparationCurrent(f.scope),false);assert.equal(f.session.current(f.scope),false);assert.throws(()=>f.session.beginExecution(f.scope));assert.equal(f.session.resolveApproval(f.scope),null);await f.lifecycle.stop();
 }
});

test('the actual original runtime joins a selected campaign and session at first model entry; approval is not refilled and in-flight planning is not quiescent',async()=>{
 const {gameCampaignFixture}=await import('../../../packages/runtime/test/fixtures/game-campaign.ts');
 const {selectGameCampaignContext}=await import('@lifestream/runtime/activity/game-journal');
 const {createPreparedTurnBinding}=await import('@lifestream/runtime/inference/prompt');
 const {randomUUID}=await import('node:crypto');
 const game=gameCampaignFixture(),f=fixture(game.input.expectedScope),scope=f.scope;await f.session.start(f.actor,f.consent);
 const binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{principalId:scope.principalId,assistantId:scope.assistantId,relationshipId:scope.relationshipId,conversationId:scope.contextBinding.conversationId,sessionId:scope.contextBinding.sessionId,endpointId:scope.contextBinding.endpointId},conversation:'[]',sourceRevisions:{journal:'1'}});
 let beginnings=0,runs=0,finish:any;const pending=new Promise<any>(resolve=>{finish=resolve;});
 const options=captureGameRuntimeOptions({inferenceMode:'supervisedForeground',resolveApproval:f.session.resolveApproval,sourceCurrent:f.session.preparationCurrent,preparation:{current:f.session.preparationCurrent,begin:candidate=>{beginnings++;f.session.beginExecution(candidate);return true;}}});
 const runtime=createAuthenticatedGameRuntime(scope,options,{} as ActivityCheckpointRepository,{current:()=>true,prepare:()=>({preparedTurnBinding:binding,isCurrent:()=>true} as any),run:async()=>{runs++;return pending;},cancel(){},publishEpisode:()=>({state:'unavailable',memoryId:null})})!;
 const selected=selectGameCampaignContext(game.input,game.boundary),bounds={deadlineMs:3000,maximumChunks:128,maximumInputTokens:8192,maximumOutputBytes:8192,maximumOutputTokens:1024};assert.equal(selected.status,'selected');
 assert.throws(()=>runtime.preparePlanning(selected,bounds));assert.equal(f.session.resolveApproval(scope),null);assert.equal(beginnings,1);f.qualify();
 const step=runtime.preparePlanning(selected,bounds),approval=f.session.resolveApproval(scope);assert.ok(approval);assert.equal(beginnings,2);assert.equal(runtime.controllerCurrent(),true);
 const operation=runtime.runPlanning(step,{current:()=>true,terminalRef:()=>null,publishDecision:()=>false});assert.equal(runs,1);assert.equal(runtime.isQuiescent(),false);finish({state:'suppressed',reason:'synthetic-no-provider',completedSteps:0});await operation;assert.equal(runtime.isQuiescent(),true);
 runtime.preparePlanning(selected,bounds);assert.equal(beginnings,2);assert.equal(f.session.resolveApproval(scope),approval);runtime.close();await f.lifecycle.stop();
});

test('the original broker/client admits only its retained preparation observation; execution waits for the result ACK and controller effects stay denied',async t=>{
 const {fixture:hostFixture}=await import('./fixtures/game-host.ts');
 const {GameHostPort}=await import('../src/runtime/game-host-port.ts');
 const {WindowsGameHostClient}=await import('../../../packages/providers-bizhawk/src/game-host-client.ts');
 const {guardGameActivityAdapter}=await import('../../../packages/providers-bizhawk/src/provider.ts');
 const {createNativeExecutionLifetime}=await import('../../../packages/providers-bizhawk/src/native-execution-lifetime.ts');
 const {waitForGameClientQuiescence}=await import('../src/runtime/ubuntu-game-join.mjs');
 const {observe,observed}=await import('../../../packages/providers-bizhawk/test/game-host-fixtures.ts');
 const {randomUUID}=await import('node:crypto');
 const h=hostFixture();t.after(()=>h.db.close());let joined:any,originalAdmit:any,originalCompletion:any,nativeCalls=0,actions=0,resultAck!:()=>void,ackEntered!:()=>void;
 const ackGate=new Promise<void>(resolve=>{resultAck=resolve;}),ackSeen=new Promise<void>(resolve=>{ackEntered=resolve;});
 const host=new GameHostPort(h.db,{maxAttachments:1,maxDurationMs:5000,createRepository:()=>h.repository,resolveAttachment:(_actor,metadata)=>{const {protocol,...value}=metadata;return value;},bindingCurrent:()=>true,controllerCurrent:()=>false,boundary:{sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false},onAttached:join=>{joined=join;}});t.after(()=>host.close());
 const f=fixture(h.input.request.scope,originalBackendBroker(host));await f.session.start(f.actor,f.consent);f.qualify();f.quiet(false);
 const runtime=createAuthenticatedGameRuntime(f.scope,captureGameRuntimeOptions({inferenceMode:'supervisedForeground',resolveApproval:f.session.resolveApproval,sourceCurrent:f.session.preparationCurrent,preparation:{current:f.session.preparationCurrent,begin:()=>false}}),h.repository,{current:()=>true,prepare:()=>{throw Error('No model input');},run:async()=>{throw Error('No model');},cancel(){},publishEpisode:()=>({state:'unavailable',memoryId:null})})!;(f.actor as any).runtimeFor=()=>runtime;
 const client=new WindowsGameHostClient({backendUrl:'http://127.0.0.1:32123',attach:{protocol:GAME_HOST_PROTOCOL,hostId:randomUUID(),scope:f.scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-bridge',sourceRevision:'b'.repeat(64)},fetchAuthenticated:async(url,init)=>{if(url.endsWith('/admit'))originalAdmit=JSON.parse(String(init.body));if(url.endsWith('/result'))originalCompletion=JSON.parse(String(init.body));const response=await f.session.fetchAuthenticated(url,init);if(url.endsWith('/result')&&response.status===200){ackEntered();await ackGate;}return response;},isScopeCurrent:f.session.preparationCurrent,sourceIsQualified:()=>true,nativeBoundary:{providerRef:'synthetic-bridge',maxDurationMs:5000,sourceAvailable:()=>true,acceptObservation:()=>true,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false},openNative:async boundary=>({adapter:guardGameActivityAdapter({observe:async request=>{nativeCalls++;return observed(request);},applyController:async()=>{actions++;throw Error('No controller');},releaseControls:async()=>{throw Error('No release');},controlSave:async()=>{throw Error('No save');}},boundary),close(){}}),shutdownExactOldLease:async()=>{},httpTimeoutMs:5000,nativeStartupTimeoutMs:1000,sessionDurationMs:90000,executionLifetime:createNativeExecutionLifetime(f.lifecycle,new Date(Date.now()+120000).toISOString()),shutdownTimeoutMs:1000});
 const running=client.run();void running.catch(()=>{});t.after(async()=>{resultAck();client.close();await running.catch(()=>{});await f.lifecycle.stop();});await client.ready;
 const request={...observe(),scope:f.scope};request.deadlineAt=new Date(Date.now()+5000).toISOString();
 const observedResult=joined.adapter.observe(request,{signal:new AbortController().signal,isCurrent:()=>true});await ackSeen;const result=await observedResult;assert.equal(result.outcome.status,'succeeded');assert.equal(nativeCalls,1);assert.equal(f.session.resolveApproval(f.scope),null);assert.notEqual(client.snapshot.activeCommandId,null);
 let quietResolved=false;const quiet=waitForGameClientQuiescence(client,new AbortController().signal,()=>f.session.preparationCurrent(f.scope)).then(value=>{quietResolved=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(quietResolved,false);assert.throws(()=>f.session.beginExecution(f.scope));
 assert.equal(host.preparationObservationCurrent(f.actor,'admit',originalAdmit),false);assert.equal(host.preparationObservationCurrent(f.actor,'complete',originalCompletion),false);
 for(const [route,payload] of [['admit',originalAdmit],['result',originalCompletion]])await assert.rejects(f.session.fetchAuthenticated('http://127.0.0.1:32123/api/runtime/v1/game-host/'+route,{method:'POST',redirect:'error',body:JSON.stringify(payload)}));
 const fabricated={protocol:GAME_HOST_PROTOCOL,attachmentId:joined.attachmentId,commandId:randomUUID(),requestDigest:'a'.repeat(64)};await assert.rejects(f.session.fetchAuthenticated('http://127.0.0.1:32123/api/runtime/v1/game-host/admit',{method:'POST',redirect:'error',body:JSON.stringify(fabricated)}));
 const control={...h.input.request,deadlineAt:new Date(Date.now()+1000).toISOString(),payload:{...h.input.request.payload,admission:{...h.input.request.payload.admission,expiresAt:new Date(Date.now()+1000).toISOString()}}};await assert.rejects(joined.adapter.applyController(control,{signal:new AbortController().signal,isCurrent:()=>true}),error=>{assert.equal((error as any).effectMayHaveStarted,false);assert.notEqual((error as any).code,'invalidRequest');return true;});assert.equal(actions,0);
 resultAck();assert.equal(await quiet,true);assert.equal(client.snapshot.activeCommandId,null);f.quiet(true);const approval=f.session.beginExecution(f.scope);assert.equal(approval.maximumRunMs,64000);assert.equal(actions,0);client.close();await running.catch(()=>{});await f.lifecycle.stop();
});

test('a genuinely retained preparation observation loses admission on owner withdrawal, lifecycle cancellation, request cancellation or attachment retirement',async t=>{
 const {fixture:hostFixture}=await import('./fixtures/game-host.ts');const {GameHostPort}=await import('../src/runtime/game-host-port.ts');const {observe}=await import('../../../packages/providers-bizhawk/test/game-host-fixtures.ts');const {randomUUID}=await import('node:crypto');
 for(const cause of ['owner','lifecycle','request','retired']){
  const h=hostFixture();let joined:any,f:any;const host=new GameHostPort(h.db,{maxAttachments:1,maxDurationMs:5000,createRepository:()=>h.repository,resolveAttachment:(_actor,metadata)=>{const {protocol,...value}=metadata;return value;},bindingCurrent:()=>f.session.preparationCurrent(f.scope),controllerCurrent:()=>false,boundary:{sourceAvailable:()=>true,acceptObservation:()=>true},onAttached:join=>{joined=join;}});
  f=fixture(h.input.request.scope,originalBackendBroker(host));await f.session.start(f.actor,f.consent);
  try{
   const metadata={protocol:GAME_HOST_PROTOCOL,hostId:randomUUID(),scope:f.scope,pinsDigest:'a'.repeat(64),providerRef:'synthetic-bridge',sourceRevision:'b'.repeat(64)};
   const attached=host.attach(f.actor,metadata),controller=new AbortController(),request={...observe(),scope:f.scope,deadlineAt:new Date(Date.now()+5000).toISOString()};const pending=joined.adapter.observe(request,{signal:controller.signal,isCurrent:()=>true});void pending.catch(()=>{});
   const event:any=await host.next(f.actor,{protocol:GAME_HOST_PROTOCOL,attachmentId:attached.attachmentId},new AbortController().signal);const admission={protocol:GAME_HOST_PROTOCOL,attachmentId:attached.attachmentId,commandId:event.commandId,requestDigest:event.requestDigest};assert.equal(host.preparationObservationCurrent(f.actor,'admit',admission),true);
   if(cause==='owner')f.withdraw();else if(cause==='lifecycle')await f.lifecycle.stop();else if(cause==='request')controller.abort();else host.detach(f.actor,{protocol:GAME_HOST_PROTOCOL,attachmentId:attached.attachmentId});
   assert.equal(host.preparationObservationCurrent(f.actor,'admit',admission),false);await assert.rejects(f.session.fetchAuthenticated('http://127.0.0.1:32123/api/runtime/v1/game-host/admit',{method:'POST',redirect:'error',body:JSON.stringify(admission)}));assert.equal(f.session.resolveApproval(f.scope),null);host.close();await pending.catch(()=>{});
  }finally{host.close();await f.lifecycle.stop();h.db.close();}
 }
});
