import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {Readable} from 'node:stream';
import type * as G from '@lifestream/contracts/game-activity';
import type {InferenceRequest,InferenceProvider} from '@lifestream/runtime/inference';
import {WindowsGameHostClient} from '@lifestream/providers-bizhawk';
import {GAME_HOST_PROTOCOL as protocol,GAME_HOST_NATIVE_EVIDENCE_VERSION} from '@lifestream/contracts/game-host';
import {MemoryRepository,type Database} from '@lifestream/storage-sqlite';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile,redactedDigest} from '../src/config/loader.ts';
import type {GameplayRunOwners,GameplayRun} from '../src/runtime/gameplay-run-owner.ts';
import {campaignFixtureData} from './fixtures/gameplay.ts';
import {nativeGameplayFixture} from './fixtures/native-gameplay.ts';
import {conversationFixtureProvider} from './fixtures/conversation-provider.ts';
import {loadCandidateGameplayOwners} from '../../../scripts/candidate-gameplay-owners.mjs';

/** One real LifestreamServer owner composition, real local auth/session/endpoint,
 * owned HTTP/native evidence, planning/coordinator/SQL/journal/memory/reply join.
 * All native child, perception, admission, save, provider proof and generated
 * output are explicitly synthetic. No production qualification or live input. */
async function fixture(t:import('node:test').TestContext,projection=true){
 const root=await mkdtemp(join(tmpdir(),'ls-gameplay-full-server-')),f=campaignFixtureData(),scope=f.scope;
 // Windows cannot fsync a directory in the existing recovery journal. Exercise
 // the actual SQLite/server join in memory there; Linux uses a real file DB.
 const config=loadProfile('test');config.profile='ai5090';config.authority.authentication='local-password';config.storage={databasePath:process.platform==='win32'?':memory:':join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 config.inferenceProfile={...config.inferenceProfile,servedModelName:'synthetic:joined-model',modelArtifactDigest:'b'.repeat(64)} as typeof config.inferenceProfile;
 const selected={configurationDigest:redactedDigest(config),providerRef:'@lifestream/providers-fixture',providerRevision:'workspace',model:'synthetic:joined-model',modelArtifactDigest:'b'.repeat(64),healthy:true,fixture:false};
 const receipt={schemaVersion:'1.0.0' as const,recordType:'gameInferenceQualification' as const,qualificationRef:'synthetic:full-server-proof',selection:selected,process:{pid:123,processStartTicks:'456',binarySha256:'c'.repeat(64),modelSha256:'b'.repeat(64),projectorSha256:null,envelopeDigest:'d'.repeat(64)},preemptionBoundMs:10,slotReleaseBoundMs:250,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()},bytes=Buffer.from(JSON.stringify(receipt));
 const statuses:Readonly<Record<string,unknown>>[]=[],requests:InferenceRequest[]=[];
 let native:ReturnType<typeof nativeGameplayFixture>|undefined,run:GameplayRun|null=null,metadata:any,client:WindowsGameHostClient|undefined,clientDone:Promise<void>|undefined,historical=true;
 const initial=f.source.startFor(f.join)!;
 const owners:GameplayRunOwners={
  native:{resolveAttachment:(_actor,raw)=>isDeepStrictEqual(raw,metadata)?run!.attachment:null,bindingCurrent:()=>!!native,controllerCurrent:()=>!!native,sourceCurrent:s=>native?.evidence.sourceAvailable(s,metadata.pinsDigest)===true,sourceAvailable:(s,p)=>native?.evidence.sourceAvailable(s,p)===true,acceptObservation:(r,o)=>native?.evidence.acceptObservation(r,o)===true,acceptAction:(r,result)=>native?.evidence.acceptAction(r,result)===true,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>{throw Error('Joined native usage required');},shutdownExactOldLease:async()=>{throw Error('Joined original-lease shutdown required');}},
  nativeEvidence:{qualifyUsage:(_binding,r,result,e)=>isDeepStrictEqual(native?.evidence.controllerUsageEvidenceFor(r,result),e),qualifyShutdown:(_binding,r,e)=>isDeepStrictEqual(native?.evidence.shutdownEvidenceFor(r),e)},
  qualification:{receipt,receiptSha256:createHash('sha256').update(bytes).digest('hex'),readReceipt:()=>bytes,processCurrent:()=>true},
  decoder:{purpose:'simulatedGame/gameFramebuffer',configurationRef:'synthetic:owned-png-fields',decoderRevision:'1.0.0',manifestDigest:'a'.repeat(64),allowedVisibleFieldIds:['fixture:visible-menu'],capability:{kind:'nativeVisibleUi'},current:()=>!!native,decode:async({observation:o,screenshot:shot})=>{
   const time=new Date().toISOString();return {facts:[{factId:randomUUID(),description:'The synthetic gate remains closed.',epistemicKind:'visibleFeature',sourceScreenshotIds:[shot.screenshotId],extractionKind:'screenPixels',extractorRef:null,uncertainty:'Scripted pixels; hidden cause unknown.',limitations:['Synthetic decoder; no real CT perception.'],sourceKind:'playerVisibleGameObservation',untrusted:true}],visibleState:[{fieldId:'fixture:visible-menu',value:'open',visibility:'visibleNow',firstObservedRef:o.observationId,lastObservedRef:o.observationId,timelineId:scope.timelineId,observedAt:o.receivedAt,freshUntil:shot.expiresAt,decoderRevision:'1.0.0',manifestDigest:'a'.repeat(64),limitations:['Synthetic native-visible field.']}]};}},
  runFor:()=>run,startCurrent:()=>!!native,
  reconcile:(_run,journal,o)=>({...f.f.input.binding,scope:structuredClone(scope),journal,ordinarySaveArtifact:null,ordinarySaveLineageRef:null,entryBindings:journal.entries.map(entry=>({entryId:entry.entryId,runId:scope.runId,timelineId:scope.timelineId,sourceObservationIds:entry.sourceRefs.some(ref=>ref.startsWith('game-observation:'))?entry.sourceRefs.filter(ref=>ref.startsWith('game-observation:')).map(ref=>ref.slice(17)):[o.observationId],sourceActionIds:entry.sourceRefs.filter(ref=>ref.startsWith('game-action:')).map(ref=>ref.slice(12)),sourceAdviceRefs:[],ordinarySaveDigest:null,currentDisposition:'historical'})),reconciliationState:'current',reconciledObservationId:o.observationId,reconciledAt:new Date().toISOString()}),
  reconciliationCurrent:(binding,o)=>binding.reconciledObservationId===o.observationId&&binding.ordinarySaveArtifact===null,
  admitController:async(...args)=>{const r=await f.source.requestFor(...args);if(r)r.executionMode='normal';return r;},admissionCurrent:r=>r.scope.runId===scope.runId&&r.payload.admission.authorityContextRef.providerRef==='fixture:authority',
  historicalSourceCurrent:()=>historical,
  retentionFor:()=>({policyRevision:1,retention:{retentionMs:3600000,maximumEpisodes:4,maximumBytes:8192,retentionPolicyRef:'synthetic:explicit-owner-retention'}}),
  estimate:()=>projection?{value:.6,basis:'Synthetic transformation fidelity; no perception calibration.',policyRef:'synthetic:estimate'}:null,
  maximumSteps:1,maximumRunMs:30000,maximumCommandMs:5000,maximumOwnedFrames:8,planningBounds:f.planningBounds,maximumObservationAgeMs:10000,maximumContextBytes:16384,onStatus:s=>statuses.push(s)
 };
 const installerToken=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 // Use the same pinned trusted-module loader as start-candidate. The fixture's
 // bridge supplies synthetic independent owners, never an alternate runtime.
 const registryKey='syntheticGameplayOwners:'+randomUUID(),modulePath=join(root,'synthetic-owners.mjs'),moduleCode='export const gameplayOwners=globalThis['+JSON.stringify(registryKey)+'];\n';
 (globalThis as any)[registryKey]=owners;let loaded:GameplayRunOwners;try{await writeFile(modulePath,moduleCode);loaded=await loadCandidateGameplayOwners(modulePath,createHash('sha256').update(moduleCode).digest('hex'));}finally{delete (globalThis as any)[registryKey];}
 const app=createLifestreamServer({config,gameplayOwners:loaded,sessionEnvironmentId:scope.environmentId,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]},profileLoader:profile=>{const next=loadProfile('test');next.profile=profile;next.authority.authentication='local-password';next.storage={databasePath:process.platform==='win32'?':memory:':join(root,'next.sqlite'),artifactDirectory:join(root,'next-artifacts')};return next;}});
 t.after(async()=>{await app.shutdown();client?.close();await clientDone;native?.close();f.db.close();await rm(root,{recursive:true,force:true});});await app.start();
 const internals=app as unknown as {database:Database;memories:MemoryRepository;providers:{inference:InferenceProvider;providers:Record<string,any>};gameplay:{completion:()=>Promise<void>;stop:()=>Promise<void>};gameCompositionRetired:boolean};
 const base='http://127.0.0.1:'+app.address().port,headers:Record<string,string>={origin:base,'content-type':'application/json'};
 const request=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
 const api=async(path:string,body:unknown)=>{const response=await request(path,body),value=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,value}));return value;};
 const enrollment=await request('/api/auth/v1/setup',{username:'synthetic-joined-owner',password,installerToken});assert.equal(enrollment.status,201,await enrollment.clone().text());headers.cookie=enrollment.headers.get('set-cookie')!.split(';')[0]!;const identity=(await enrollment.json()).session;headers['x-lifestream-csrf']=identity.csrfToken;
 const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic joined gameplay Assistant'}),assistantId=assistant.assistantId;
 await api(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});const relationship=(await api(`/api/admin/v1/assistants/${assistantId}/relationships`,{})).relationship;
 await api('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession',bindingKey:randomUUID()});await api('/api/runtime/v1/audience',{mode:'solo',seconds:300});
 const stored=internals.database.connection.prepare('SELECT conversation_id,endpoint_id FROM sessions WHERE id=?').get(identity.sessionId)!;
 scope.principalId=identity.principalId;scope.assistantId=assistantId;scope.relationshipId=relationship.relationshipId;scope.contextBinding={...scope.contextBinding,conversationId:String(stored.conversation_id),endpointId:String(stored.endpoint_id),sessionId:identity.sessionId};
 const owner={assistantId,relationshipId:scope.relationshipId};await api('/api/runtime/v1/memory',{...owner,enabled:true,expectedRevision:0});
 native=nativeGameplayFixture(scope,f.f.input.pinsDigest,'synthetic:joined-native');
 metadata={protocol,hostId:randomUUID(),scope,pinsDigest:f.f.input.pinsDigest,providerRef:'synthetic:joined-native',sourceRevision:'b'.repeat(64),nativeEvidenceVersion:GAME_HOST_NATIVE_EVIDENCE_VERSION};
 const {protocol:ignored,...attachment}=metadata;
 run={attachment,approvedUntil:new Date(Date.now()+25000).toISOString(),policy:initial.policy,bounds:initial.bounds,startLimits:{enabled:true,revision:1,rollingPeriodMs:3600000,rollingStartLimit:2,startsPerWindow:1},checkpoint:{...initial.checkpoint,scope},journal:initial.journal};
 internals.providers.providers.inference={...internals.providers.providers.inference,fixture:false};
 internals.providers.inference=conversationFixtureProvider({tokenize:async(input)=>{if(typeof input!=='string'){const content=input.sections.find(s=>s.kind==='conversation')?.content??'';if(content.includes('Planning view references'))statuses.push({state:'syntheticPlanningTokenization',view:content.split('Planning view references (identity only; no effect authority): ')[1]?.split('\n')[0]});}return {count:100,identity:'selected-model-tokenizer:synthetic:joined-model'};},async *generate(input){
  requests.push(input);const content=input.sections.find(s=>s.kind==='conversation')!.content;
  if(content.includes('Untrusted logical activity context (not a Human statement or authority): ')){
   const context=JSON.parse(content.split('Untrusted logical activity context (not a Human statement or authority): ')[1]!),view=JSON.parse(content.split('Planning view references (identity only; no effect authority): ')[1]!.split('\n')[0]!);
   const proposal:G.GameActionProposal={schemaVersion:'1.0.0',recordType:'gameActionProposal',scope,proposalId:randomUUID(),observationId:context.observation.observationId,observationRevision:context.observation.revision,preparedViewId:view.viewId,preparedViewRevision:view.revision,invalidationKey:view.invalidationKey,buttons:['a'],durationFrames:2,maxWallMs:100,expectedVisibleOutcome:'The synthetic gate might open.',uncertainty:'Scripted hypothesis only.',adviceRefs:[],reason:'Synthetic test of one visible menu.',preconditions:[{predicateId:randomUUID(),fieldId:'fixture:visible-menu',expectedValue:'open',sourceObservationId:context.observation.observationId}]};yield {kind:'text',text:JSON.stringify(proposal)};
  }else yield {kind:'text',text:'Synthetic ordinary reply about our historical game attempt.'};yield {kind:'done'};
 }});
 const start=async()=>{client=new WindowsGameHostClient({...native!.ports,attach:metadata,httpTimeoutMs:5000,sessionDurationMs:30000,shutdownTimeoutMs:2000,fetchAuthenticated:async(url,init)=>{const response=await fetch(base+new URL(url).pathname,{...init,headers:{...headers,...Object.fromEntries(new Headers(init.headers))}});return new Response(response.body,{status:response.status,headers:response.headers});}});clientDone=client.run().catch(error=>{statuses.push({state:'syntheticClientFailure',message:String(error)});});await client.ready;await internals.gameplay.completion();await clientDone;};
 // Local-auth deployments deliberately select their profile at launch; the
 // public switch route stays denied. Exercise the actual replacement handler
 // with the real session privately, without exposing another HTTP entrypoint.
 const replaceProfile=()=>new Promise<{status:number;body:string}>((resolve,reject)=>{
  const input=Readable.from([JSON.stringify({profile:'mac-local'})]) as any;input.headers={...headers,host:new URL(base).host};input.method='POST';input.url='/api/runtime/v1/profile';let status=0;
  (app as any).handleProfile(input,{writeHead:(value:number)=>{status=value;},end:(body:string)=>resolve({status,body})}).catch(reject);
 });
 return {app,internals,scope,owner,statuses,requests,request,api,start,native,metadata,replaceProfile,withdraw:()=>historical=false,reply:()=>request('/api/runtime/v1/messages',{...owner,userInput:'Recall our historical synthetic gate attempt.'})};
}

test('full server owner startup joins native HTTP to settled journal, active memory and ordinary nine-section reply after game lease retirement',{timeout:30000},async t=>{
 const f=await fixture(t);await f.start();assert.equal(f.native.controls(),1,JSON.stringify({statuses:f.statuses,requests:f.requests.length,observations:f.native.observations(),starts:f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_start_claims').get(),journals:f.internals.database.connection.prepare('SELECT count(*) AS n FROM campaign_journals').get(),checkpoints:f.internals.database.connection.prepare('SELECT count(*) AS n FROM activity_checkpoints').get()}));assert.equal(f.native.observations(),3);assert.equal(f.native.releases(),1);
 const status=f.statuses.find(s=>s.state==='episodePublication')!;assert.equal(status.episodeRetained,true,JSON.stringify(f.statuses));assert.equal(status.memoryActive,true);assert.equal(typeof status.memoryId,'string');
 assert.equal(f.statuses.find(s=>s.state==='stopped')?.nativeShutdownConfirmed,true);f.native.withdraw();
 assert.equal(f.internals.database.connection.prepare('SELECT state FROM activity_controller_reservations').get()!.state,'settled');
 const checkpoint=f.internals.database.connection.prepare('SELECT used_json,payload_json FROM activity_checkpoints').get()!,used=JSON.parse(String(checkpoint.used_json)),payload=JSON.parse(String(checkpoint.payload_json));
 assert.equal(used.actions,1);assert.equal(used.frames,2);assert.equal(used.wallMs,13);assert.equal(used.modelCalls,1);assert.equal(payload.saveArtifact,null);
 const journal=f.internals.database.connection.prepare('SELECT revision FROM campaign_journals').get()!;assert.equal(journal.revision,3);
 assert.ok(f.internals.database.connection.prepare("SELECT payload_json FROM campaign_journal_entries WHERE state='retained'").all().some(row=>JSON.parse(String(row.payload_json)).content==='The synthetic gate remains closed.'));
 const memory=f.internals.memories.get(f.owner.assistantId,String(status.memoryId))!;assert.equal(memory.lifecycle.status,'active');assert.equal(memory.lifecycle.factuality,'unverified');
 const response=await f.reply();assert.match(await response.text(),/interaction.completed/);const ordinary=f.requests.at(-1)!;assert.equal(ordinary.sections.length,9);const prepared=ordinary.sections.find(s=>s.kind==='preparedMemory')!.content;
 assert.match(prepared,/Past simulated game experience/,JSON.stringify({prepared,eligible:f.internals.memories.contextRecords(f.owner.assistantId,f.scope.principalId),statuses:f.statuses}));assert.match(prepared,/synthetic gate remains closed/);assert.match(prepared,/not current progress/);assert.ok(prepared.includes(f.scope.timelineId));assert.equal(f.requests.filter(r=>r.sections.find(s=>s.kind==='conversation')!.content.includes('Untrusted logical activity context')).length,1);
 await f.api('/api/runtime/v1/audience',{mode:'shared',seconds:300});await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/synthetic gate remains closed/);
 await f.api('/api/runtime/v1/audience',{mode:'solo',seconds:300});f.withdraw();await(await f.reply()).text();assert.doesNotMatch(f.requests.at(-1)!.sections.find(s=>s.kind==='preparedMemory')!.content,/synthetic gate remains closed/);
});

test('full server episode retention without projection is not reported as active memory',{timeout:30000},async t=>{
 const f=await fixture(t,false);await f.start();const status=f.statuses.find(s=>s.state==='episodePublication')!;assert.equal(status.episodeRetained,true,JSON.stringify(f.statuses));assert.equal(status.memoryActive,false);assert.equal(status.memoryId,null);assert.equal(f.internals.database.connection.prepare('SELECT count(*) AS n FROM game_experience_episodes').get()!.n,1);assert.equal(f.internals.memories.contextRecords(f.owner.assistantId,f.scope.principalId).length,0);
});

test('profile replacement awaits owned gameplay retirement with original database open and leaves old composition unavailable',{timeout:30000},async t=>{
 const f=await fixture(t),original=f.internals.database,stop=f.internals.gameplay.stop;
 let release!:()=>void,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 f.internals.gameplay={...f.internals.gameplay,stop:async()=>{assert.equal(f.internals.database,original);assert.ok(original.connection.prepare('SELECT 1').get());entered();await gate;await stop();assert.ok(original.connection.prepare('SELECT 1').get());}};
 let timer:ReturnType<typeof setTimeout>|undefined;try{const publicResponse=await f.request('/api/runtime/v1/profile',{profile:'mac-local'});assert.equal(publicResponse.status,409,await publicResponse.clone().text());const switched=f.replaceProfile();await Promise.race([enteredPromise,switched.then(response=>{throw Error('Replacement did not enter gameplay retirement: '+JSON.stringify(response));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Retirement entry deadline')),3000);})]);assert.equal(f.internals.database,original);release();const response=await switched;assert.equal(response.status,200,response.body);}finally{release();clearTimeout(timer);f.internals.gameplay={...f.internals.gameplay,stop};}assert.notEqual(f.internals.database,original);assert.equal(f.internals.gameCompositionRetired,true);assert.throws(()=>(f.app as any).gameHost.attach({principalId:f.scope.principalId,sessionId:f.scope.contextBinding.sessionId,isCurrent:()=>true},f.metadata),/game_host_unavailable/);
});
