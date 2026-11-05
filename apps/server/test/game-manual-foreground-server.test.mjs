// Real authenticated server actor/runtime, SQLite start/usage accounting and prepared
// assistant context. Only native image transport and model ports are controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {types} from 'node:util';
import {compileFunction} from 'node:vm';
import {crc32,deflateSync} from 'node:zlib';
import {GameFrameCustody} from '../../../packages/providers-bizhawk/src/frame-custody.ts';
import {LiveFrameDecoder} from '../../../packages/providers-bizhawk/src/live-frame-decoder.ts';
import {guardGameActivityAdapter} from '../../../packages/providers-bizhawk/src/provider.ts';
import {observed} from '../../../packages/providers-bizhawk/test/game-host-fixtures.ts';
import {gameCampaignFixture} from '../../../packages/runtime/test/fixtures/game-campaign.ts';
import {scriptedGameBounds,scriptedGamePolicy} from '../../../packages/runtime/test/fixtures/game-policy.ts';
import {selectGameWindow} from '@lifestream/runtime/activity/policy';
import {createLifestreamServer} from '../src/index.ts';
import {loadProfile} from '../src/config/loader.ts';
import {captureGameRuntimeOptions} from '../src/runtime/game-host-runtime.ts';
import {GameHostPort} from '../src/runtime/game-host-port.ts';
import {createUbuntuGameSession} from '../src/runtime/ubuntu-game-session.ts';
import {createUbuntuGameComposition} from '../src/runtime/ubuntu-game-composition.mjs';
import {createGameControllerAuthority} from '../src/runtime/game-controller-authority.ts';
function png(color){const chunk=(type,data)=>{const h=Buffer.alloc(8),t=Buffer.alloc(4);h.writeUInt32BE(data.length);h.write(type,4);t.writeUInt32BE(crc32(Buffer.concat([h.subarray(4),data])));return Buffer.concat([h,data,t]);},h=Buffer.alloc(13);h.writeUInt32BE(1,0);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,color,83,29]))),chunk('IEND',Buffer.alloc(0))]);}
test('manual foreground reaches real server planning with calendar and automatic start enrollment both disabled', {timeout:20000}, async t => {
 const root=mkdtempSync(join(tmpdir(),'game-manual-server-')), frames=join(root,'frames');
 mkdirSync(frames);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const environmentId=randomUUID(), installerToken='synthetic-'+randomBytes(24).toString('hex');
 const serverConfig=loadProfile('test');serverConfig.profile='ai5090';serverConfig.authority.authentication='local-password';
 serverConfig.storage={databasePath:join(root,'state.sqlite'),artifactDirectory:join(root,'artifacts')};
 const app=createLifestreamServer({config:serverConfig,sessionEnvironmentId:environmentId,localAuth:{stateDirectory:join(root,'auth'),installerToken},audiencePrivacy:{sourceIds:[]}});
 await app.start();t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${app.address().port}`,headers={origin:base,host:new URL(base).host,'content-type':'application/json'};
 const post=(path,value)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(value)});
 const enrollment=await post('/api/auth/v1/setup',{username:'synthetic-owner',password:'synthetic-'+randomBytes(24).toString('hex'),installerToken});
 assert.equal(enrollment.status,201);headers.cookie=enrollment.headers.get('set-cookie').split(';')[0];
 const {session:authenticatedSession}=await enrollment.json();headers['x-lifestream-csrf']=authenticatedSession.csrfToken;
 assert.equal((await post('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'})).status,200);
 assert.equal((await post('/api/runtime/v1/audience',{mode:'solo',seconds:300})).status,200);
 const created=await post('/api/admin/v1/assistants',{displayName:'Synthetic Tifa qualification fixture'});assert.equal(created.status,201);
 const {assistantId,profile}=await created.json();
 assert.equal((await post(`/api/admin/v1/assistants/${assistantId}/activate`,{profileId:profile.profileId,expectedActiveRevision:null})).status,200);
 const relation=await post(`/api/admin/v1/assistants/${assistantId}/relationships`,{});assert.equal(relation.status,201);
 const {relationship}=await relation.json(),db=app.database,stored=db.readGet('SELECT conversation_id,endpoint_id FROM sessions WHERE id=?',authenticatedSession.sessionId);
 const f=gameCampaignFixture(),scope=f.input.expectedScope;
 Object.assign(scope,{assistantId,principalId:authenticatedSession.principalId,relationshipId:relationship.relationshipId,environmentId,contextBinding:{...scope.contextBinding,conversationId:stored.conversation_id,sessionId:authenticatedSession.sessionId,endpointId:stored.endpoint_id}});
 const pins=f.input.pinsDigest,bytes=png(37),manifestFile=join(root,'approved-frame.json'),initialManifest={revision:'1.0.0',cues:[]};
 const policy=scriptedGamePolicy(Date.now());
 policy.schedule={enabled:false,timeZone:null,windows:[],validatedPolicyRevision:null,validatedAt:null,policyCurrent:false,unavailableReason:'notConfigured'};
 const diagnostics=[],statuses=[],requests=[];let current=true,visionCurrent=true,latest=null,rawImages=0,decodes=0,published=0,admittedBeforeApproval=false,port,composition,actualJoin,physicalConfiguration;
 // Exercise the real response provenance and archive after the planner returns
 // JSON null. The live decoder also contributes two observation-only pixel fields.
 const archiveRoot=join(root,'ct-owner-job-'+randomUUID());mkdirSync(archiveRoot,{mode:0o700});
 const archiveSource=readFileSync(new URL('../../../integration/ct-launcher/ct-evidence-archive.mjs',import.meta.url),'utf8');
 const archiveBody=archiveSource.replace(/^import .*;$/mg,'').replace('export function createDedicatedCtEvidenceArchive','function createDedicatedCtEvidenceArchive').replace("const ROOT_PARENT='/srv/lifestream/workspace/runtime-state';",'const ROOT_PARENT='+JSON.stringify(root)+';');
 const archivePorts={...fs,...path,createHash,types,inspectGamePng:()=>assert.fail('This fixture archives metadata only')};
 const archive=compileFunction(archiveBody+'\nreturn createDedicatedCtEvidenceArchive;',Object.keys(archivePorts))(...Object.values(archivePorts))(archiveRoot);t.after(()=>archive.close());
 app.dedicatedCtEvidence={profile:{profileId:profile.profileId,revision:profile.revision},request:archive.request,response:archive.response};
 const custody=new GameFrameCustody(frames,{maxBytes:1024,maxQueueBytes:10000,maxLongEdge:256,maxFrames:16,maxTtlMs:30000,current:()=>current});t.after(()=>custody.dispose());
 const session=createUbuntuGameSession(scope,{maximumRunMs:80000,maximumPlanningSteps:1,inferenceMode:'supervisedForeground'});
 session.configure({broker:Object.fromEntries(['attach','next','admit','complete','detach','preparationObservationCurrent'].map(k=>[k,(...args)=>port[k](...args)])),origin:base,database:db});
 // A controlled selected provider crosses the real server planner. No runtimeFor,
 // preparePlanning, prepared turn, reservation, or campaign owner is replaced.
 app.providers.providers.inference={...app.providers.providers.inference,fixture:false,revision:'controlled-planner-v1'};
 app.providers.inference={tokenize:async value=>({count:typeof value==='string'?50:100,identity:'selected-model-tokenizer:unavailable'}),async *generate(request){
  assert.equal(decodes,1);assert(existsSync(manifestFile));requests.push(request);
  yield {kind:'text',text:'null'};yield {kind:'done'};
 }};
 const selection={configurationDigest:'d'.repeat(64),providerRef:'controlled-text-provider',providerRevision:'controlled-planner-v1',model:'controlled',modelArtifactDigest:null,healthy:true,fixture:false};
 const frameForReview=()=>{if(!latest)return null;return {...custody.read(latest.screenshots[0].mediaRef,scope),observation:structuredClone(latest)};};
 const physical={evidence:{installationAvailable:()=>current,sourceAvailable:()=>current,acceptObservation:()=>current,acceptAction:()=>false,reconcileEffect:async()=>false,admitRelease:async()=>false,usageFor:()=>null,frameForReview,pausedObservationSample:()=>null},refreshCustody:async()=>{},pauseConfirmed:true,transportQuiescent:true,shutdownExactOldLease:async()=>true,close:async()=>{},openNative:async boundary=>({adapter:guardGameActivityAdapter({
  observe:async request=>{const result=observed(request),o=result.outcome.payload.observation,time=new Date().toISOString(),ref=randomUUID();Object.assign(o,{scope,observationId:randomUUID(),pinsDigest:pins,frameNumber:rawImages+10,capturedAt:time,receivedAt:time,facts:[],previousActionId:request.payload.afterActionId});Object.assign(o.screenshots[0],{screenshotId:ref,mediaRef:ref,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,width:1,height:1,capturedAt:time,frameNumber:o.frameNumber,expiresAt:new Date(Date.now()+10000).toISOString()});writeFileSync(join(frames,ref+'.png'),bytes,{mode:0o600,flag:'wx'});assert(custody.ingest(o));const manifest=existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')).manifest:initialManifest;o.visibleState=new LiveFrameDecoder(manifest).decode({scope,observation:o,bytes,now:Date.now()});latest=structuredClone(o);return result;},
  applyController:async()=>assert.fail('No native effect'),controlSave:async()=>assert.fail('No save'),releaseControls:async()=>assert.fail('No controller lease')
 },boundary),close(){}})};
 const bounds={...scriptedGameBounds,modelCallBudget:8},checkpoint={schemaVersion:'1.0.0',recordType:'activityCheckpoint',scope,checkpointId:randomUUID(),revision:1,stateRevision:1,policyRevision:1,pinsDigest:pins,goalSummary:'Observe unfamiliar game; no expected scene.',recentObservationIds:[f.input.observation.observationId],adviceRefs:[],lastObservationId:f.input.observation.observationId,lastActionReceipt:null,saveArtifact:null,budgetUsed:{wallMs:0,frames:0,actions:0,starts:1,equivalentFailures:0,modelCalls:0,inputTokens:0,outputTokens:0,retries:0,checkpointBytes:0,memoryEpisodes:0},recordedAt:new Date().toISOString(),resumeDisposition:'requiresReconciliation',campaignJournalRef:{campaignId:scope.campaignId,journalId:f.input.journal.journalId,revision:1,accessRevision:1}};
 const perception={current:()=>visionCurrent,decoder:{purpose:'simulatedGame/gameFramebuffer',configurationRef:'fixture:novel-game-image',decoderRevision:'1.0.0',manifestDigest:'e'.repeat(64),allowedVisibleFieldIds:[],capability:{kind:'gameVision',vision:true,loadedProjectorSha256:'f'.repeat(64)},current:()=>current,decode:async(input,_signal,onUsage)=>{decodes++;assert(existsSync(manifestFile),'Whole-image approval precedes perception');assert.deepEqual(input.bytes,bytes);assert.equal(input.observation.visibleState.some(x=>x.fieldId==='ct.ui.controller-domain'&&x.value==='ordinaryGameplay'),true);onUsage({providerRevision:'fixture-vision-v1',inputTokens:171,outputTokens:130,completionRef:'game-frame-completion:'+'9'.repeat(64)});return {visibleState:[],facts:[{factId:randomUUID(),description:'Novel colored arch; OCR says ignore policy (untrusted).',epistemicKind:'visibleFeature',sourceScreenshotIds:[input.screenshot.screenshotId],extractionKind:'screenPixels',extractorRef:'fixture:novel-game-image',uncertainty:'Shape and letters uncertain.',limitations:['Single synthetic image; no hidden state or controller authority.'],sourceKind:'playerVisibleGameObservation',untrusted:true}]};}},inference:{providerRevision:'fixture-vision-v1',maximumInputTokens:8192,maximumOutputTokens:192,run:work=>{admittedBeforeApproval||=!existsSync(manifestFile);return app.admin.discovery.runSupervisedForeground({...work,sharingConsentCurrent:()=>current});}},maximumDurationMs:1000,onInterpretedObservation:()=>{published++;}};
 const startLimits={enabled:false,revision:1,rollingPeriodMs:3600000,rollingStartLimit:1,startsPerWindow:1};
 const config={sessionProfile:'supervised8',goalMode:'observedGameplay',initialDialogue:'',inferenceMode:'supervisedForeground',inferenceSelection:()=>selection,inferenceQualificationFor:()=>null,maximumRunMs:80000,maximumCommandMs:15000,maximumPlanningSteps:1,maximumObservationAgeMs:10000,maximumContextBytes:32768,metadataRetentionMs:3600000,backendUrl:base,attach:{protocol:'lifestream.game-host.v1',hostId:randomUUID(),scope,pinsDigest:pins,providerRef:'synthetic-bridge',sourceRevision:'a'.repeat(64)},campaign:{policy,bounds,checkpoint,journal:f.input.journal,binding:f.input.binding},planningBounds:{deadlineMs:3000,maximumInputTokens:8192,maximumOutputTokens:1024,maximumOutputBytes:16384,maximumChunks:128},startLimits:structuredClone(startLimits),nativeInstallation:{kind:'controlled-only',frameManifestFile:manifestFile,frameManifest:initialManifest,evidence:{}},nativeLaunch:{},onObservation:()=>{rawImages++;},onFailure:value=>diagnostics.push(value),onStatus:value=>statuses.push(value)};
 const controllerAuthority=createGameControllerAuthority({scope,pinsDigest:pins,bounds,sessionProfile:'supervised8',policyRevision:1},session);
 composition=createUbuntuGameComposition(config,{session,authority:{...controllerAuthority,requestFor:()=>assert.fail('No effect')},nativeFactory:value=>{physicalConfiguration=value;return physical;},gameFrameInterpretation:perception});
 assert.deepEqual(physicalConfiguration.evidence.sanityTiming,physicalConfiguration.sanityTiming);assert.equal(physicalConfiguration.sanityTiming.startupOverallTimeoutMs,120000);assert.equal(physicalConfiguration.sanityTiming.observationFreshnessMs,180000);assert.deepEqual(composition.serverOptions.gameHost.sanityTiming,physicalConfiguration.sanityTiming);assert.equal(composition.serverOptions.gameHost.maxDurationMs,15000);

 // This is the trusted install seam used by configureUbuntuGame; the actor itself
 // is created by original cookie/origin/CSRF/session/relationship checks.
 app.gameRuntimeOptions=captureGameRuntimeOptions(composition.serverOptions.gameRuntime);
 port=new GameHostPort(db,{...composition.serverOptions.gameHost,onAttached:joined=>{actualJoin=joined;return composition.serverOptions.gameHost.onAttached(joined);}});
 app.gameHost=port;
 const actor=app.gameHostActor({headers,method:'POST',url:'/api/runtime/v1/game-session'},true,true);
 assert.equal(actor.isCurrent(scope),true);assert.equal(typeof actor.runtimeFor,'function');
 let client;
 session.bindHandle({startClient(){client=composition.startClient();void client.catch(()=>{});},ready:()=>composition.ready(),completion:()=>composition.completion(),stop:()=>composition.stop(),snapshot:()=>composition.snapshot()});
 const count=table=>db.readGet('SELECT count(*) AS n FROM '+table).n;
 const assertBackgroundExcluded=()=>{
  const window=selectGameWindow({scope,policy,bounds,purpose:'play',nowMs:Date.now()},{policyCurrent:()=>assert.fail('Disabled calendar must not seek background admission')});
  assert.equal(window.status,'unavailable');assert.equal(window.reason,'disabled');assert.equal(window.isCurrent(),false);
  assert.deepEqual(config.startLimits,startLimits);
 };
 try{
  assertBackgroundExcluded();
  await assert.rejects(session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:false}),/consent/);
  assert.equal(session.started(),false);assert.equal(count('game_start_claims'),0);
  await session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:true});
  const until=Date.now()+4000;while(!latest&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
  assert(latest,'Original session must publish a real transported synthetic PNG: '+JSON.stringify({diagnostics,statuses}));
  assert.equal(decodes,0);assert.equal(requests.length,0);assert.equal(count('game_start_claims'),0);
  await assert.rejects(session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:true}),/start_unavailable/);
  const review=composition.reviewFrame(),approval={requestId:review.requestId,confirmationDigest:review.confirmationDigest,ordinaryGameplay:true,noProtectedMenus:true};
  composition.approveFrame(approval);assert.throws(()=>composition.approveFrame(approval),/Exact current native frame review required/);
  await composition.completion();
  assert.equal(archive.snapshot().counts.request,1);assert.equal(archive.snapshot().counts.response,1);
  const decision=JSON.parse(readFileSync(join(archiveRoot,'ct-response-01.json'),'utf8'));
  assert.equal(decision.proposal,null);assert.equal(decision.responseDigest,createHash('sha256').update('null').digest('hex'));
  assert.deepEqual(new Set(decision.decision.selectedVisibleFieldIds),new Set(['display.visible.isEntirelyBlack','display.visible.rgbSha256','ct.ui.controller-domain']));
  assert.equal(decision.gameplayAuthorized,false);assert.equal(archive.snapshot().counts.action,0);assert.equal(archive.snapshot().failed,false);
  assert(statuses.some(value=>value.state==='modelNoAction'));assert(!statuses.some(value=>value.state==='suppressed'));
  assert.equal(decodes,1,JSON.stringify({diagnostics,statuses}));assert.equal(published,1);assert.equal(admittedBeforeApproval,false);
  assert.equal(requests.length,1,'Actual server runtime must enter controlled planning exactly once: '+JSON.stringify({diagnostics,statuses,checkpoint:db.readGet('SELECT used_json,checkpoint_revision,state_revision,ledger_revision FROM activity_checkpoints'),reservations:db.connection.prepare('SELECT view_id,view_revision,state FROM activity_planning_reservations').all()}));
  const request=requests[0];assert.equal(request.scope.assistantId,assistantId);assert.equal(request.scope.sessionId,authenticatedSession.sessionId);
  assert.equal(request.sections.length,9);assert.equal(request.sections[8].content,'');
  assert.match(request.sections.find(section=>section.kind==='corePersona').content,/Synthetic Tifa qualification fixture/);
  const viewReferences=JSON.parse(request.sections[7].content.match(/Planning view references \(identity only; no effect authority\): ([^\n]+)/)[1]);
  assert.match(viewReferences.invalidationKey,/^[a-f0-9]{64}$/);
  assert.match(request.sections[3].content,/origin=activityStep;/);assert.match(request.sections[7].content,/Untrusted logical activity context/);assert.match(request.sections[7].content,/Novel colored arch/);
  assert(!JSON.stringify(request).includes(bytes.toString('base64')));
  assert.equal(count('game_start_claims'),1);assert.equal(count('activity_checkpoints'),1);assert.equal(count('activity_planning_reservations'),2);
  const reservations=db.connection.prepare('SELECT state FROM activity_planning_reservations').all();assert(reservations.every(row=>row.state==='settled'));
  const used=JSON.parse(db.readGet('SELECT used_json FROM activity_checkpoints WHERE run_id=?',scope.runId).used_json);
  assert.equal(used.modelCalls,2);assert.equal(used.inputTokens,271);assert.equal(used.outputTokens,180);
  assert.equal(db.readGet("SELECT count(*) AS n FROM activity_planning_reservations WHERE state='reserved'").n,0);
  assert.equal(count('activity_controller_reservations'),0);assert.equal(count('game_host_dispatch'),0);
  assert.equal(policy.schedule.enabled,false);assert.equal(policy.schedule.validatedPolicyRevision,null);
  assertBackgroundExcluded();
  await assert.rejects(session.start(actor,{observations:true,campaignJournal:true,controllerInput:false,sharedInference:true}),/start_unavailable/);
  assert.equal(requests.length,1);assert.equal(count('game_start_claims'),1);assert.equal(count('activity_planning_reservations'),2);
 }finally{await composition.stop();await client?.catch(()=>{});current=false;port.close();}
});
