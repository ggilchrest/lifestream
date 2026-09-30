import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Database,MemoryRepository} from '@lifestream/storage-sqlite';
import {fixtureVisualProvider} from '@lifestream/runtime/perception/fixture';
import {createPreparedTurnBinding,finalizePreparedTurn,requestForFinalizedTurn} from '@lifestream/runtime/inference/prompt';
import type {VisualMemoryProjection} from '@lifestream/contracts/visual-memory';
import {VisualInputHost} from '../src/runtime/visual-input.ts';
import {AutomaticMemory} from '../src/runtime/automatic-memory.ts';
import {startVisualTurnEvidence} from '../src/runtime/visual-turn-evidence.ts';
import {correlateVisualLineage,replayVisualLineage,type VisualLineageInput} from '../src/runtime/visual-lineage.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+5gz/qwAAAABJRU5ErkJggg==','base64');
async function fixture(t:import('node:test').TestContext,modality:'text'|'audio'='text'){
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const owner={principalId:randomUUID(),assistantId:randomUUID(),relationshipId:randomUUID()},actor={principalId:owner.principalId,assistantId:owner.assistantId,sessionId:randomUUID()},scope={...actor,relationshipId:owner.relationshipId,environmentId:randomUUID(),conversationId:randomUUID(),endpointId:randomUUID(),sessionRevision:1,audienceRevision:1,scopeGeneration:1};
 const db=new Database({path:':memory:'});db.migrate();const memories=new MemoryRepository(db);
 let mono=10000,utc=Date.now(),providerCalls=0;
 const worker=new AutomaticMemory({database:db,memories,provider:()=>({revision:'unused',provider:{async *generate(){providerCalls++;yield {kind:'done' as const};}}}),idle:()=>true,scopeAllowed:()=>true,changed:()=>{}});
 const visual=new VisualInputHost({scopeFor:()=>scope,sourceFor:()=>({bindingRef:'PRIVATE_SYNTHETIC_CAMERA_PATH',connected:true,configurationRevision:1}),
  captureAuthority:()=>({sourceConnected:true,devicePermission:true,hostCaptureLease:true,interpretationAllowed:true,remoteEgressAllowed:false,foregroundVisible:true}),monotonicMs:()=>mono,utcMs:()=>utc,
  provider:fixtureVisualProvider(request=>({requestId:request.requestId,status:'complete',observations:[{observationId:randomUUID(),frameIds:[request.frames[0]!.frameId],appearance:'PRIVATE_SYNTHETIC_SCENE_PROSE',inference:null,confidence:null,limitations:['Scripted perception, no real camera.']}],reason:null})),
  memorySelection:publication=>({reason:'appearanceContinuity',independenceKey:randomUUID(),transformationConfidence:{value:0.8,basis:'Synthetic source-to-summary fidelity only.',policyRef:'PRIVATE_TRANSFORMATION_POLICY'},observations:[{observationId:publication.batch.observations[0]!.observationId,subject:{subjectRef:'explicit-synthetic-subject',binding:'userConfirmed',basisRefs:['synthetic-association'],limitations:['Login does not identify a depicted subject.']},visibility:'inView'}]})
 },()=>{},()=>undefined,(publication,selection)=>assert.equal(worker.queueVisualPublication(publication,selection).state,'queued'));
 t.after(async()=>{visual.close();await worker.close();db.close();});worker.configure(owner,true,0);worker.configureVisual(owner,true,0,86400000);
 const offer=visual.capabilities(actor,['1.0.0']);mono+=10;t.mock.timers.tick(10);utc=Date.now();
 const lease=visual.camera(actor,{action:'enable',expectedRevision:0,idempotencyKey:randomUUID(),challengeId:offer.negotiation!.challenge!.id,endpointClockId:'synthetic-clock',endpointReceivedMonotonicMs:5000});
 mono+=1100;t.mock.timers.tick(1100);utc=Date.now();const frameId=randomUUID();
 await visual.batch(actor,{leaseId:lease.leaseId!,endpointClockId:'synthetic-clock',correlationId:randomUUID(),frames:[{frameId,sequence:0,capturedMonotonicMs:mono-5010,clockMappingId:lease.clockMappingId!,mediaType:'image/png',sha256:createHash('sha256').update(png).digest('hex')}]},new Map([[frameId,png]]));
 await worker.tick();assert.deepEqual(worker.inspect(owner).visual.intakeReceipts.map(r=>r.state),['retained']);
 const viewId=randomUUID(),invalidationKey=randomUUID(),selection=visual.selectContext(actor,{viewId,revision:1,invalidationKey,conversation:'[]',explicitQuestion:true,allowAside:true,expectedConversationId:scope.conversationId,expectedRelationshipId:owner.relationshipId});assert.ok(selection.view);
 const binding=createPreparedTurnBinding({viewId,revision:1,invalidationKey,scope:{...actor,relationshipId:owner.relationshipId,conversationId:scope.conversationId,endpointId:scope.endpointId},conversation:'[]',sourceRevisions:{visual:String(selection.view.sourceRevision)}}),interactionId=randomUUID();
 const recorder=startVisualTurnEvidence(visual.turnEvidence(actor,selection,binding),interactionId,modality);
 const turn=finalizePreparedTurn({assistantId:actor.assistantId,sessionId:actor.sessionId,interactionId,endpointId:scope.endpointId,conversation:'[]',userInput:'PRIVATE_SYNTHETIC_INPUT',preparedTurnBinding:binding,preparedVisualContext:selection.view},()=>visual.contextCurrent(selection.view!));
 recorder.finalized(turn,requestForFinalizedTurn(turn,binding,()=>visual.contextCurrent(selection.view!)));recorder.providerInvoked();recorder.emitted(modality);recorder.generationEnded('completed');
 if(modality==='audio'){recorder.synthesisCompleted();recorder.endpointSettled('completed',4800);}recorder.ended('completed');await Promise.resolve();
 const input=():VisualLineageInput=>{
  const episodes=worker.inspect(owner).visual.episodes.filter(row=>row.episode!==null).map(row=>row.episode!),projections=episodes.filter(e=>e.memoryRecordId).map(episode=>({schemaVersion:'1.0.0',recordType:'visualMemoryProjection',episode,memoryRecord:memories.get(owner.assistantId,episode.memoryRecordId!)!.provenance.canonical}) as VisualMemoryProjection);
  return {publications:visual.publicationReceipts(actor),turns:visual.turnReceipts(actor),episodes,projections,terminalSources:[]};
 };
 return {input,worker,owner,memories,providerCalls:()=>providerCalls,advance:(ms:number)=>{mono+=ms;t.mock.timers.tick(ms);utc=Date.now();}};
}

test('actual isolated publication, prepared request and SQLite projection correlate without scene prose or delivery inference',async t=>{
 const f=await fixture(t),input=f.input(),result=correlateVisualLineage(input);
 assert.equal(input.publications.length,1);assert.equal(input.episodes.length,1);assert.equal(input.projections.length,1);assert.ok(!Number.isInteger(input.publications[0]!.admission.capturedAtLatestMs),'real admission preserves fractional uncertainty');
 assert.deepEqual(result.contradictions,[]);assert.deepEqual(result.missingEvidence,[]);assert.equal(result.status,'partialDiagnosticCorrelation');assert.equal(result.turns[0]!.contextIncluded,true);assert.equal(result.turns[0]!.generationCompleted,true);assert.equal(result.turns[0]!.outputEmissionRecorded,true);assert.equal(result.turns[0]!.deliveryProved,false);assert.equal(result.turns[0]!.endpointAcknowledgmentRecorded,false);assert.equal(f.providerCalls(),0);
 assert.equal(result.events.filter(e=>e.kind==='memoryProjection').length,1);assert.equal(result.claimsRuntimeAcceptance,false);assert.equal(result.sourceCurrencyProved,false);
 const serialized=JSON.stringify(result);for(const privateValue of ['PRIVATE_',png.toString('base64'),input.episodes[0]!.scope.principalId,input.episodes[0]!.observations[0]!.observationId])assert.ok(!serialized.includes(privateValue));
});

test('actual audio observer acknowledgment remains distinct from proven delivery or perception',async t=>{
 const f=await fixture(t,'audio'),result=correlateVisualLineage(f.input());assert.deepEqual(result.contradictions,[]);assert.equal(result.turns[0]!.endpointAcknowledgmentRecorded,true);assert.equal(result.turns[0]!.deliveryProved,false);assert.equal(result.perceptionQualityProved,false);
});

test('isolated metadata replay preserves source-family/time and pins artifacts with new IDs, no writes or provider calls',async t=>{
 const f=await fixture(t),input=f.input(),before=JSON.stringify(input),result=await replayVisualLineage(input),again=await replayVisualLineage(input);
 assert.equal(result.comparison.equal,true);assert.equal(result.manifest.liveRoute,false);assert.notEqual(result.manifest.replayId,again.manifest.replayId);assert.ok(result.events.every((event,index)=>event.id!==result.comparison.sourceEventIds[index]&&event.sourceEventIds?.[0]===result.comparison.sourceEventIds[index]&&event.traceId===result.manifest.replayId));
 assert.deepEqual(result.events.map(event=>event.payload),result.correlation.events);assert.ok(result.events.some(event=>event.payload.kind==='retainedSource'&&event.payload.occurredAt===input.episodes[0]!.occurredAt));assert.equal(result.perceptionReplayed,false);assert.equal(result.durableReinforcement,false);assert.equal(f.providerCalls(),0);assert.equal(JSON.stringify(f.input()),before);
});

test('actual source correction keeps original model attribution and records contradicted projection without correction prose',async t=>{
 const f=await fixture(t),original=f.input().episodes[0]!;f.worker.correctVisual(f.owner,original.episodeId,original.revision,'PRIVATE_EXACT_HUMAN_CORRECTION');
 const input=f.input(),result=correlateVisualLineage(input);assert.deepEqual(result.contradictions,[]);assert.equal(input.episodes[0]!.state,'superseded');assert.equal(result.events.find(e=>e.kind==='memoryProjection')!.status,'contradicted');assert.ok((result.events.find(e=>e.kind==='retainedSource')!.correctionRefs as string[]).length);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|humanEntry/);
});

test('newer forgotten terminal source suppresses stale retained snapshots and replay cannot reactivate memory',async t=>{
 const f=await fixture(t),input=f.input(),e=input.episodes[0]!;f.worker.forgetVisual(f.owner,e.episodeId,e.revision);
 const forgotten=f.worker.inspect(f.owner).visual.episodes[0]!;assert.equal(forgotten.episode,null);
 const result=await replayVisualLineage({...input,terminalSources:[{episodeId:e.episodeId,revision:forgotten.revision,state:'forgotten'}]});assert.deepEqual(result.correlation.contradictions,[]);assert.ok(result.events.every(event=>!['retainedSource','memoryProjection'].includes(event.payload.kind as string)));assert.equal(result.events.filter(event=>event.payload.kind==='terminalSource').length,1);assert.equal(f.worker.inspect(f.owner).visual.episodes[0]!.episode,null);
});

test('expired diagnostics preserve partial coverage rather than imply failed perception or complete trace',async t=>{
 const f=await fixture(t),input=f.input();f.advance(60000);const partial={...input,publications:f.input().publications,turns:input.turns.slice(-1)},result=correlateVisualLineage(partial);
 assert.deepEqual(result.contradictions,[]);assert.ok(result.missingEvidence.includes('selectedPublicationMissing'));assert.ok(result.missingEvidence.includes('turnSequenceGap'));assert.ok(result.missingEvidence.includes('retainedPublicationMissing'));assert.equal(result.turns[0]!.deliveryProved,false);
});

const mutations:readonly [string,(input:any)=>void,string][]=[
 ['lease',input=>input.turns[0].lineage.selected.leaseId=randomUUID(),'selectedPublicationMismatch'],
 ['audience',input=>{for(const r of input.turns)r.lineage.selected.audienceRevision++;},'selectedPublicationMismatch'],
 ['clock mapping',input=>{for(const r of input.turns)r.lineage.publication.clockMappingId=randomUUID();},'publicationLinkMismatch'],
 ['host sequence',input=>{for(const r of input.turns)r.lineage.publication.hostSequence++;},'publicationLinkMismatch'],
 ['source revision',input=>{for(const r of input.turns)r.lineage.selected.sourceRevision++;},'selectedPublicationMismatch'],
 ['changed lineage',input=>input.turns[1].lineage.selected.sourceRevision++,'turnLineageChanged'],
 ['duplicate sequence',input=>input.turns[1].sequence=input.turns[0].sequence,'duplicateTurnSequence'],
 ['backward receipt time',input=>input.turns[1].occurredAtMs--,'turnLineageChanged'],
 ['changed manifest',input=>input.turns[1].finalized.manifestDigest='a'.repeat(64),'preparedManifestChanged'],
 ['expired initial selection',input=>{for(const r of input.turns)r.occurredAtMs=r.lineage.selected.expiresAtMs;},'selectedPublicationMismatch'],
 ['older terminal receipt',input=>input.terminalSources=[{episodeId:input.episodes[0].episodeId,revision:input.episodes[0].revision,state:'forgotten'}],'terminalRevisionMismatch']
];
for(const [name,mutate,code] of mutations)test(`contradictory ${name} is reported without acceptance`,async t=>{
 const f=await fixture(t),input=structuredClone(f.input());const detached=JSON.parse(JSON.stringify(input));mutate(detached);const result=correlateVisualLineage(detached);assert.equal(result.status,'contradictoryMetadata');assert.ok(result.contradictions.includes(code));assert.equal(result.claimsRuntimeAcceptance,false);
});

test('bounded closed data rejects hostile objects, oversize, duplicate sources and forged canonical projection',async t=>{
 const f=await fixture(t),input=f.input();let calls=0;const hostile={...input};Object.defineProperty(hostile,'publications',{get(){calls++;return input.publications;}});assert.throws(()=>correlateVisualLineage(hostile));assert.equal(calls,0);
 const cycle:any={...input};cycle.self=cycle;
 for(const value of [new Proxy(input,{}),cycle,{...input,secret:'do not serialize'},{...input,publications:Array(129).fill(input.publications[0])},{...input,publications:[...input.publications,...input.publications]},{...input,turns:[{...input.turns[0],stage:'PRIVATE_UNKNOWN_STAGE'}]}, {...input,terminalSources:[{episodeId:'x'.repeat(4*1024*1024),revision:1,state:'forgotten'}]}])assert.throws(()=>correlateVisualLineage(value));
 const forged=structuredClone(input);forged.projections[0]!.memoryRecord.confidence=1;assert.throws(()=>correlateVisualLineage(forged));
 const sections=structuredClone(input);sections.turns[0]!.finalized!.sections[0]!.contentDigest='not a digest';assert.throws(()=>correlateVisualLineage(sections));
 const empty=correlateVisualLineage({publications:[],turns:[],episodes:[],projections:[],terminalSources:[]});assert.equal(empty.status,'partialDiagnosticCorrelation');assert.equal(empty.claimsRuntimeAcceptance,false);assert.ok(empty.missingEvidence.includes('turnCoverageMissing'));
});


test('supplied long source-binding digests correlate without implying current host eligibility',async t=>{
 const f=await fixture(t),input=JSON.parse(JSON.stringify(f.input())),e=input.episodes[0],p=input.publications[0],projection=input.projections[0],long='PRIVATE_SYNTHETIC_CAMERA_PATH'.repeat(12),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 e.scope.sourceBindingRef=long;p.admission.scope.sourceBindingRef='sha256:'+sha(long);
 const config=JSON.parse(e.observations[0].providerConfigurationRef);config[2]=long;e.observations[0].providerConfigurationRef=JSON.stringify(config);e.sourceDigest=sha(JSON.stringify({scope:e.scope,observations:e.observations}));
 projection.episode=structuredClone(e);projection.memoryRecord.provenance.sourceRefs=[`visual-episode:${e.episodeId}:${e.revision}:${e.sourceDigest}`];projection.memoryRecord.extensions['lifestream.conversationalVision'].sourceDigest=e.sourceDigest;
 const result=correlateVisualLineage(input);assert.deepEqual(result.contradictions,[]);assert.equal(result.sourceCurrencyProved,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SYNTHETIC_CAMERA_PATH/);
 assert.equal(result.events.find(e=>e.kind==='publication')!.scope,result.events.find(e=>e.kind==='retainedSource')!.scope);
});

test('canonical source and projection joins reject wrong publication epoch or retained revision',async t=>{
 const f=await fixture(t),input=JSON.parse(JSON.stringify(f.input()));input.publications[0].admission.scope.scopeGeneration++;
 assert.ok(correlateVisualLineage(input).contradictions.includes('retainedPublicationMismatch'));
 const changed=JSON.parse(JSON.stringify(f.input()));changed.episodes[0].revision++;
 assert.ok(correlateVisualLineage(changed).contradictions.includes('projectionSourceMismatch'));
});


test('supplied audience-rebound publication joins its published scope while retaining original admission epochs',async t=>{
 const f=await fixture(t),input=JSON.parse(JSON.stringify(f.input())),e=input.episodes[0],p=input.publications[0],projection=input.projections[0],sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 p.publication.audienceRevision++;p.publication.leaseRevision++;e.scope.audienceRevision++;
 for(const row of input.turns){row.lineage.selected.audienceRevision++;row.lineage.publication.audienceRevision++;row.lineage.publication.leaseRevision++;}
 e.sourceDigest=sha(JSON.stringify({scope:e.scope,observations:e.observations}));projection.episode=structuredClone(e);projection.memoryRecord.provenance.sourceRefs=[`visual-episode:${e.episodeId}:${e.revision}:${e.sourceDigest}`];projection.memoryRecord.extensions['lifestream.conversationalVision'].sourceDigest=e.sourceDigest;
 const result=correlateVisualLineage(input);assert.deepEqual(result.contradictions,[]);assert.equal(result.sourceCurrencyProved,false);const metadata=result.events.find(e=>e.kind==='publication')!;assert.equal(metadata.publicationAudienceRevision,2);assert.equal((metadata.sourceEpochs as {audience:number}).audience,1);
});
