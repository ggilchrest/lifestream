// Synthetic local sources only. These tests establish source wiring, not CT,
// actual provider performance, native window, ordinary-save or Human acceptance.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join as pathJoin} from 'node:path';
import {Database,ActivityCheckpointRepository,GameExperienceRepository,CampaignJournalRepository,MemoryRepository} from '@lifestream/storage-sqlite';
import type * as G from '@lifestream/contracts/game-activity';
import {createPreparedTurnBinding,type PreparedTurnBinding,type RuntimeSelfContext} from '@lifestream/runtime/inference/prompt';
import {projectGameEpisode} from '@lifestream/runtime/activity/memory';
import {selectGameCampaignContext} from '@lifestream/runtime/activity/game-journal';
import type {InferenceProvider,InferenceRequest} from '@lifestream/runtime/inference';
import {campaignFixtureData} from './gameplay.ts';
import {DiscoveryAdministration} from '../../src/admin/understanding.ts';
import {createGameplayComposition,type GameplayCompositionOptions} from '../../src/runtime/gameplay-composition.ts';
import {createAuthenticatedGameRuntime,captureGameRuntimeOptions,productionGameMemory,qualifiedGameInferenceBounds} from '../../src/runtime/game-host-runtime.ts';
import {runCheckpointedGamePlanning,runCheckpointedGameController} from '../../src/runtime/game-activity.ts';
import {gameMemoryContextRecord} from '../../src/runtime/game-memory.ts';
import type {GameHostJoin} from '../../src/runtime/game-host-port.ts';


import {createServer} from 'node:http';
import {once} from 'node:events';
import {isDeepStrictEqual} from 'node:util';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_NATIVE_EVIDENCE_VERSION,gameHostDigest} from '@lifestream/contracts/game-host';
import {WindowsGameHostClient} from '@lifestream/providers-bizhawk';
import {GameHostPort} from '../../src/runtime/game-host-port.ts';
import {handleGameHostHttp} from '../../src/runtime/game-host-http.ts';
import {nativeGameplayFixture} from './native-gameplay.ts';
export function gameplayHttpFixture(mode:'normal'|'noUsage'|'noConsent'|'noShutdown'|'noFacts'|'wrongModel'|'badUsage'|'lostResultAck'='normal',path=':memory:'){
 const f=campaignFixtureData(path),scope=f.scope,statuses:Readonly<Record<string,unknown>>[]=[],requests:InferenceRequest[]=[],episodes:G.GameExperienceEpisode[]=[];
 let live=true,binding:PreparedTurnBinding,joined!:GameHostJoin,repository!:ActivityCheckpointRepository;
 const nativeFixture=nativeGameplayFixture(scope,f.f.input.pinsDigest,'test-only:native');
 const metadata={protocol,hostId:randomUUID(),scope,pinsDigest:f.f.input.pinsDigest,providerRef:'test-only:native',sourceRevision:'b'.repeat(64),nativeEvidenceVersion:GAME_HOST_NATIVE_EVIDENCE_VERSION};
 const {protocol:ignored,...metadataBinding}=metadata;
 let restored:ReturnType<typeof createGameplayComposition>|undefined;
 const retention={policyRevision:1,retention:{retentionMs:3600000,maximumEpisodes:4,maximumBytes:8192,retentionPolicyRef:'test-only:reviewed-game-retention'}};
 f.db.connection.prepare('INSERT INTO local_accounts(principal_id,username,owner,password_verifier,created_at) VALUES(?,?,1,?,?)').run(f.o.principalId,'fixture-only','not-a-credential',Date.now());
 f.db.connection.prepare('INSERT INTO automatic_memory_policies VALUES(?,?,?,?,1,1,?)').run('fixture-only',f.o.principalId,f.o.assistantId,f.o.relationshipId,new Date().toISOString());
 f.observation.facts=mode==='noFacts'?[]:[{factId:randomUUID(),description:'The visible gate remains closed.',epistemicKind:'visibleFeature',sourceScreenshotIds:[f.observation.screenshots[0]!.screenshotId],extractionKind:'screenPixels',extractorRef:null,uncertainty:'The hidden cause is unknown.',limitations:['Synthetic qualified screenshot; no real CT.'],sourceKind:'playerVisibleGameObservation',untrusted:true}];
 f.source.current=()=>live;
 f.source.bindingFor=(_scope,journal,observation)=>({...f.f.input.binding,journal,entryBindings:journal.entries.map(entry=>f.f.input.binding.entryBindings.find(b=>b.entryId===entry.entryId)??{entryId:entry.entryId,runId:scope.runId,timelineId:scope.timelineId,sourceObservationIds:entry.sourceRefs.filter(r=>r.startsWith('game-observation:')).map(r=>r.slice(17)),sourceActionIds:entry.sourceRefs.filter(r=>r.startsWith('game-action:')).map(r=>r.slice(12)),sourceAdviceRefs:[],ordinarySaveDigest:null,currentDisposition:'historical'}),reconciledObservationId:observation.observationId,reconciledAt:observation.receivedAt});
 f.source.observe=async(join,signal,afterActionId)=>{
  if(signal.aborted)return null;
  const request:G.GameObserveRequest={schemaVersion:'1.0.0',operation:'GameActivityAdapter.observe',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+3000).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope,idempotencyKey:randomUUID(),payload:{expectedPinsDigest:metadata.pinsDigest,afterActionId:afterActionId??null,maxScreenshots:1}};
  const result=await join.adapter.observe(request,{signal,isCurrent:()=>live});if(result.outcome.status!=='succeeded'||!result.outcome.payload)return null;
  const observation=structuredClone(result.outcome.payload.observation),shot=observation.screenshots[0]!,bytes=port.consumeOwnedFrame(scope,observation,shot);
  assert.ok(bytes,'Actual purpose-bound HTTP PNG custody is required');assert.equal(createHash('sha256').update(bytes).digest('hex'),shot.sha256);bytes.fill(0);
  // Synthetic pixel interpretation of the fixture-owned PNG, attributed to the
  // actual correlated screenshot. No model output or game progress assertion.
  observation.facts=mode==='noFacts'?[]:[{factId:randomUUID(),description:'The visible gate remains closed.',epistemicKind:'visibleFeature',sourceScreenshotIds:[shot.screenshotId],extractionKind:'screenPixels',extractorRef:null,uncertainty:'The hidden cause is unknown.',limitations:['Synthetic owned PNG; no live CT.'],sourceKind:'playerVisibleGameObservation',untrusted:true}];
  observation.visibleState=f.observation.visibleState.map(v=>({...v,lastObservedRef:observation.observationId,observedAt:observation.receivedAt,freshUntil:new Date(Date.now()+5000).toISOString()}));
  Object.assign(f.observation,observation);return structuredClone(observation);
 };
 const originalRequest=f.source.requestFor;f.source.requestFor=async(...args)=>{const request=await originalRequest(...args);if(request)request.executionMode='normal';return request;};
 const selected={configurationDigest:'a'.repeat(64),providerRef:'test-only:provider',providerRevision:'test-only:provider:1',model:'test-only:model',modelArtifactDigest:'b'.repeat(64),healthy:true,fixture:false};
 const receipt={schemaVersion:'1.0.0' as const,recordType:'gameInferenceQualification' as const,qualificationRef:'test-only:measured-envelope',selection:selected,process:{pid:123,processStartTicks:'456',binarySha256:'c'.repeat(64),modelSha256:'b'.repeat(64),projectorSha256:null,envelopeDigest:'d'.repeat(64)},preemptionBoundMs:10,slotReleaseBoundMs:250,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+30000).toISOString()},bytes=Buffer.from(JSON.stringify(receipt));
 const usage=new Map<string,{receipt:G.GameActionReceipt;wallMs:number;completionRef:string}>();
 const native:GameplayCompositionOptions['native']={resolveAttachment:(_actor,raw)=>isDeepStrictEqual(raw,metadata)?metadataBinding:null,bindingCurrent:()=>live,controllerCurrent:()=>live,sourceCurrent:()=>live,sourceAvailable:()=>live,acceptObservation:()=>live,acceptAction:()=>live,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>{throw Error('Opted-in gameplay must not use fallback native usage');},shutdownExactOldLease:async()=>{throw Error('Opted-in gameplay must not use fallback shutdown');}};
 const approval={scope,approvedUntil:new Date(Date.now()+10000).toISOString(),maximumRunMs:10000,maximumPlanningSteps:1,observations:true as const,campaignJournal:true as const,controllerInput:true,memoryEpisodes:true};
 const nativeEvidence:GameplayCompositionOptions['nativeEvidence']={qualifyUsage:(binding,request,result,proof)=>isDeepStrictEqual(binding,metadataBinding)&&nativeFixture.evidence.sourceAvailable(scope,metadata.pinsDigest)&&isDeepStrictEqual(nativeFixture.evidence.controllerUsageEvidenceFor(request,result),proof),qualifyShutdown:(binding,action,proof)=>isDeepStrictEqual(binding,metadataBinding)&&mode!=='noShutdown'&&isDeepStrictEqual(nativeFixture.evidence.shutdownEvidenceFor(action),proof)};
 const options:GameplayCompositionOptions={native,nativeEvidence,maximumOwnedFrames:8,campaign:f.ownerOptions,grounding:{scopeCurrent:()=>true,quarantined:()=>false,retentionFor:()=>mode==='noConsent'?null:retention,maximumFences:4,estimate:()=>({value:0.6,basis:'Synthetic source-to-summary transformation, no perception calibration.',policyRef:'test-only:transformation'})},qualification:{receipt,receiptSha256:createHash('sha256').update(bytes).digest('hex'),readReceipt:()=>bytes,processCurrent:()=>live},resolveApproval:()=>approval,maximumSteps:1,maximumRunMs:10000,maximumCommandMs:5000,onStatus:s=>statuses.push(s)};
 const composition=createGameplayComposition(options,()=>f.db),runtimeOptions=captureGameRuntimeOptions(composition.gameRuntime),memory=productionGameMemory(runtimeOptions)!;
 const port=new GameHostPort(f.db,{...composition.gameHost,
  createRepository:database=>{repository=composition.gameHost.createRepository(database);return repository;},onAttached:join=>{joined=join;composition.gameHost.onAttached!(join);}});

 let source=new GameExperienceRepository(f.db,memory.source),memories=new MemoryRepository(f.db,source.memorySources(4));
 const admin=new DiscoveryAdministration(f.db,{snapshot:()=>({boundary:'test-only:composition',configuration:undefined}),evidenceAllowed:()=>false,sourceAllowed:()=>false,forget:()=> 'missing',changed:()=>{}});
 const provider:InferenceProvider={tokenize:async()=>({count:100,identity:'test-only:tokenizer'}),async *generate(request){
  requests.push(request);
  const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope,proposalId:randomUUID(),observationId:f.observation.observationId,observationRevision:1,preparedViewId:binding.viewId,preparedViewRevision:binding.revision,invalidationKey:binding.invalidationKey,buttons:['a'],durationFrames:2,maxWallMs:100,expectedVisibleOutcome:'The gate might open.',uncertainty:'Synthetic hypothesis; no result yet.',adviceRefs:[],reason:'Test the visible menu once.',preconditions:[{predicateId:randomUUID(),fieldId:'fixture:visible-menu',expectedValue:'open',sourceObservationId:f.observation.observationId}]};
  yield {kind:'text',text:JSON.stringify(proposal)};yield {kind:'done'};
 }};
 const runtime=createAuthenticatedGameRuntime(scope,runtimeOptions,repository,{current:()=>live,prepare:()=>{
  const c=scope.contextBinding;binding=createPreparedTurnBinding({viewId:randomUUID(),revision:1,invalidationKey:randomUUID(),scope:{...f.o,conversationId:c.conversationId,sessionId:c.sessionId,endpointId:c.endpointId},conversation:'[]',sourceRevisions:{journal:'1'}});
  const runtimeSelfContext:RuntimeSelfContext={sourceRevision:'test-only:runtime',runtimeStatus:'ready',inputModalities:{text:'active',microphone:'inactive',visual:'notConfigured'},outputModalities:{text:'active',speechGeneration:'unavailable',speechDelivery:'unavailable',presentation:'notConfigured'},endpointScope:'sessionEndpoint',audienceScope:'unknown',permissionState:'authenticatedSession',limitations:['Synthetic qualified activity, no physical audience or live effects.']};
  return {assistantId:scope.assistantId,preparedTurnBinding:binding,runtimeSelfContext,isCurrent:()=>live};
 },run:(step,repo,publication,current)=>{
  const qualified=qualifiedGameInferenceBounds(runtimeOptions,mode==='wrongModel'?{...selected,model:'other'}:selected);
  return runCheckpointedGamePlanning({...step,provider},{repository:repo,background:admin,...publication,current:(s,c)=>live&&current()&&qualified?.current()===true&&publication.current(s,c),providerRevision:selected.providerRevision,tokenizerIdentity:'test-only:tokenizer',...(qualified?{providerPreemptionBoundMs:qualified.preemptionBoundMs,providerSlotReleaseBoundMs:qualified.slotReleaseBoundMs}:{})});
 },cancel:key=>admin.cancelBackground(key,'scopeInvalidated'),publishEpisode:episode=>{
  episodes.push(episode);if(!source.admit(episode))return {state:'unavailable',memoryId:null};
  const projection=projectGameEpisode({episode,memoryId:randomUUID(),estimate:memory.estimate(episode)!,nowMs:Date.now()},()=>true)!;
  const saved=memories.saveGameProjection(projection),active=memories.activateGameCandidate(scope.assistantId,saved.id,scope.principalId,1);return {state:active?'retained':'unavailable',memoryId:active?.id??null};
 }})!;
 const actor={principalId:scope.principalId,sessionId:scope.contextBinding.sessionId,isCurrent:()=>live,runtimeFor:()=>runtime};
 const server=createServer((request,response)=>{void handleGameHostHttp(port,request,response,request.url!,()=>actor);});
 const routes:string[]=[];let client:WindowsGameHostClient,clientDone:Promise<void>;
 const start=async()=>{
  server.listen({host:'127.0.0.1',port:0,exclusive:true});await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
  client=new WindowsGameHostClient({...nativeFixture.ports,nativeEvidence:{usageFor:(request,result)=>mode==='noUsage'?null:nativeFixture.evidence.controllerUsageEvidenceFor(request,result)},attach:metadata,httpTimeoutMs:3000,sessionDurationMs:10000,shutdownTimeoutMs:2000,
   fetchAuthenticated:async(url,init)=>{
    const path=new URL(url).pathname,route=path.split('/').at(-1)!;routes.push(route);
    if(mode==='badUsage'&&route==='result'){const body=JSON.parse(init.body as string);if(body.nativeUsage){body.nativeUsage.completedMonotonicMs+=1;init={...init,body:JSON.stringify(body)};}}
    const response=await fetch(base+path,init);
    if(mode==='lostResultAck'&&route==='result'){const body=JSON.parse(init.body as string);if(body.result.operation==='GameActivityAdapter.applyController'){await response.body?.cancel();throw Error('Synthetic lost result ack after actual server ingress');}}
    return new Response(response.body,{status:response.status,headers:response.headers});
   }});
  clientDone=client.run().catch(()=>{});await client.ready;
 };
 return {...f,get db(){return f.db;},options,retention,composition,repository,get episodeSource(){return source;},get memories(){return memories;},runtime,get join(){return joined;},port,routes,get client(){return client;},statuses,requests,episodes,sourceObserve:()=>f.source.observe(joined,new AbortController().signal),sourceBinding:(journal:G.CampaignJournal,observation:G.GameObservation)=>f.source.bindingFor(scope,journal,observation),controls:nativeFixture.controls,shutdowns:nativeFixture.releases,observations:nativeFixture.observations,start,completion:async()=>{await composition.completion();await clientDone;},withdraw:()=>{live=false;},reopen:()=>{admin.close();f.db.close();f.db=new Database({path});f.db.migrate();restored=createGameplayComposition(options,()=>f.db);restored.gameHost.createRepository(f.db);const historical=productionGameMemory(captureGameRuntimeOptions(restored.gameRuntime))!;source=new GameExperienceRepository(f.db,historical.source);memories=new MemoryRepository(f.db,source.memorySources(4));return new ActivityCheckpointRepository(f.db,f.ownerOptions.metadata);},close:async()=>{await composition.stop();client?.close();await clientDone;port.close();server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await restored?.stop();admin.close();f.db.close();nativeFixture.close();}};
}
