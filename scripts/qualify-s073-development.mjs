// Bounded S073 synthetic ordinary-turn evidence against the selected development provider.
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLifestreamServer } from '../apps/server/src/index.ts';
import { loadProfile, redactedDigest } from '../apps/server/src/config/loader.ts';
import { SglangInferenceProvider } from '../packages/providers-sglang/dist/provider.js';
import { MemoryRepository } from '../packages/storage-sqlite/dist/index.js';
import { createQualificationReport, qualificationFailure, qualificationEvents, finishQualificationReport, holdQualificationText } from './qualification-report.mjs';
import { loadWindowsKey, sshArgs } from '../../orchestration/scripts/start-conversation.mjs';
const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const repository=fileURLToPath(new URL('../',import.meta.url)),report={slice:'LS-S073',caseIds:['LS-TEST-092','LS-TEST-093','LS-TEST-094','LS-TEST-096','LS-TEST-100'],collectedAt:new Date().toISOString(),result:'inProgress',checks:[],exclusions:['Human fit acceptance','physical capture/playback','real personal data','training/adapters','production or shared service changes']};
let activeCheck;
const recorder=await createQualificationReport(report,{outputPath:process.env.LIFESTREAM_S073_REPORT,forbiddenRoot:fileURLToPath(new URL('../../',import.meta.url)),prefix:'ls-s073-evidence-'});
report.reportPath=recorder.path;
const check=async(id,run)=>{activeCheck={id,result:'running',observations:[]};report.checks.push(activeCheck);await recorder.save();try{activeCheck.evidence=await run();activeCheck.result='pass';}catch(error){activeCheck.result='fail';activeCheck.failure=qualificationFailure(error);activeCheck.error=activeCheck.failure.message??'bounded provider/harness operation failed';}finally{await recorder.save();activeCheck=undefined;}};
const listening=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(500);for(const event of ['connect','error','timeout'])socket.once(event,()=>{socket.destroy();resolve(event==='connect')});});
const original=SglangInferenceProvider.prototype.generate,originalRecords=MemoryRepository.prototype.contextRecords,requests=[];
let tunnel,storage,app,key,hold,reads=0,requestStarted=0;const oldKey=process.env.LIFESTREAM_INFERENCE_API_KEY;
try{
 report.sourceRevision=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim();report.scriptSha256=sha(await readFile(fileURLToPath(import.meta.url)));report.sourceWorktreeStatus=(await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:repository})).stdout.trim().split('\n').filter(Boolean);
 key=await loadWindowsKey();process.env.LIFESTREAM_INFERENCE_API_KEY=key;const occupied=await Promise.all([43000,48080,48787].map(listening));assert.ok(occupied.every(Boolean)||occupied.every(value=>!value),'mixed existing tunnel ownership');
 if(!occupied.every(Boolean)){tunnel=spawn('ssh',sshArgs(),{stdio:['ignore','ignore','ignore']});let failed=false;tunnel.once('error',()=>{failed=true});tunnel.once('exit',()=>{failed=true});for(let i=0;i<30&&!failed&&!(await listening(43000));i++)await delay(250);assert.ok(!failed&&await listening(43000),'selected provider tunnel unavailable');}
 storage=await mkdtemp(join(tmpdir(),'ls-s073-'));const selected=loadProfile('ai5090'),config={...selected,authority:{...selected.authority,authentication:'local-password'},storage:{databasePath:join(storage,'db.sqlite'),artifactDirectory:join(storage,'artifacts')}};report.selectedProfileSha256=sha(await readFile(new URL('../apps/server/src/config/profiles/ai5090.json',import.meta.url)));report.effectiveConfigurationDigest=redactedDigest({...config,storage:{databasePath:'temporary/db.sqlite',artifactDirectory:'temporary/artifacts'}});
 MemoryRepository.prototype.contextRecords=function(...args){reads++;return originalRecords.apply(this,args);};SglangInferenceProvider.prototype.generate=async function*(request,context){
  requests.push({request:structuredClone(request),loopbackAuthenticationAndPreparationMs:performance.now()-requestStarted});
  const trace={sections:structuredClone(request.sections),manifest:request.manifest,output:'',terminal:null};
  if(activeCheck)(activeCheck.providerCalls??=[]).push(trace);
  await recorder.save();
  try{for await(const chunk of original.call(this,request,context)){
   const first=trace.output.length===0&&chunk.kind==='text'&&!!chunk.text;
   if(chunk.kind==='text')trace.output+=chunk.text??'';
   if(['error','done'].includes(chunk.kind))trace.terminal=chunk.kind;
   if(first||trace.terminal)await recorder.save();
   await holdQualificationText(hold,chunk);yield chunk;
  }}finally{await recorder.save();}
 };
 const installerToken=randomBytes(32).toString('hex');app=createLifestreamServer({config,localAuth:{stateDirectory:join(storage,'safety'),installerToken}});await app.start();const base=`http://127.0.0.1:${app.address().port}`,headers={'content-type':'application/json',origin:base};
 const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(path==='/api/runtime/v1/messages'?45000:20000)}),api=async(path,body)=>{const response=await post(path,body);assert.ok(response.ok,`${path.split('/').at(-1)} status ${response.status}`);return response.json();};
 const setup=await post('/api/auth/v1/setup',{username:'synthetic-owner',password:randomBytes(32).toString('hex'),installerToken});assert.equal(setup.status,201);headers.cookie=setup.headers.get('set-cookie').split(';')[0];const identity=await setup.json();headers['x-lifestream-csrf']=identity.session.csrfToken;
 report.providers=(await (await fetch(base+'/health')).json()).providers;assert.equal(report.providers.inference.fixture,false);assert.equal(report.providers.inference.status,'healthy');
 await api('/api/runtime/v1/session-context',{expectedRevision:0,mode:'text',audienceScope:'authenticatedSession'});
 const create=async convention=>{const assistant=await api('/api/admin/v1/assistants',{displayName:'Synthetic Context Assistant'});await api(`/api/admin/v1/assistants/${assistant.assistantId}/activate`,{profileId:assistant.profile.profileId,expectedActiveRevision:null});const relationship=(await api(`/api/admin/v1/assistants/${assistant.assistantId}/relationships`,{})).relationship;const result={assistantId:assistant.assistantId,relationshipId:relationship.relationshipId,revision:1,path:`/api/admin/v1/assistants/${assistant.assistantId}/relationships/${relationship.relationshipId}`};await add(result,convention,'baseline');return result;};
 const add=async(scope,content,contextUse='relevant')=>{const candidate=await api(scope.path+'/candidates',{content,contextUse,source:'synthetic-reviewed-record',sourceFamily:randomUUID(),uncertainty:'low',expectedRevision:scope.revision,idempotencyKey:randomUUID()});scope.revision=candidate.relationshipRevision;const approved=await api(scope.path+`/candidates/${candidate.candidate.candidateId}/decision`,{decision:'approved',expectedRevision:scope.revision,idempotencyKey:randomUUID()});scope.revision=approved.relationshipRevision;return approved.candidate;};
 const a=await create('When no format is requested, answer in one concise sentence.'),b=await create('When no format is requested, answer in exactly three numbered items.');
 const turn=async(scope,userInput)=>{
  const before=requests.length,beforeReads=reads,observation={userInput,stage:'request',result:'running'};
  activeCheck.observations.push(observation);await recorder.save();requestStarted=performance.now();
  try{
   const response=await post('/api/runtime/v1/messages',{assistantId:scope.assistantId,userInput});observation.httpStatus=response.status;observation.stage='response-stream';await recorder.save();
   assert.equal(response.status,200);const text=await response.text();observation.events=qualificationEvents(text);observation.stage='assertions';
   const observed=requests[before];observation.sections=observed?.request.sections;observation.manifest=observed?.request.manifest;await recorder.save();
   assert.match(text,/event: interaction.completed/u);assert.equal(requests.length,before+1,'one selected-provider request');
   const output=[...text.matchAll(/^data: (.+)$/gmu)].map(match=>JSON.parse(match[1])).filter(item=>typeof item.text==='string').map(item=>item.text).join('').trim(),memory=observed.request.sections.find(section=>section.kind==='preparedMemory');
   assert.ok(Buffer.byteLength(memory.content)<=8192);observation.result='pass';
   return {output,manifest:observed.request.manifest,memory,sourcePayloadReads:reads-beforeReads,loopbackAuthenticationAndPreparationMs:observed.loopbackAuthenticationAndPreparationMs};
  }catch(error){observation.result='fail';observation.failure=qualificationFailure(error);observation.sections=requests[before]?.request.sections;throw error;}
  finally{observation.elapsedMs=performance.now()-requestStarted;await recorder.save();}
 };
 await check('LS-TEST-092-baseline-cold-warm-no-recall',async()=>{const results=[];for(const scope of [a,b]){const cold=await turn(scope,'Explain how a cache works.'),warm=await turn(scope,'Explain how a cache works.');assert.equal(cold.sourcePayloadReads,1);assert.equal(warm.sourcePayloadReads,0);assert.equal(cold.memory.contentDigest,warm.memory.contentDigest);assert.match(cold.memory.content,/optional rich-archive recall is unavailable/iu);if(scope===a){assert.ok(cold.output.length<450,cold.output);assert.ok(!/\b3[.)]\s/u.test(cold.output),cold.output);}else assert.match(cold.output,/\b3[.)]\s/u);results.push({cold,warm});}assert.notEqual(results[0].cold.memory.contentDigest,results[1].cold.memory.contentDigest);return {results,recallCalls:0,interpretation:'payload reads count existing local composition, not an optional recall tool; timing includes loopback and authentication'};});
 await check('LS-TEST-093-current-request-precedence',async()=>{const observations=[];for(let repeat=0;repeat<3;repeat++){const observed=await turn(a,'Explain a cache in exactly four short numbered sentences. Use formal language.');for(const number of [1,2,3,4])assert.match(observed.output,new RegExp(`\\b${number}[.)]\\s`,'u'));assert.ok(observed.output.length>120,observed.output);observations.push(observed);}return {observations,claimBoundary:"Three consecutive current-request format precedence observations in a bounded four-sentence task. The prior missing-numbering observation and earlier four-example deadline failures remain preserved; no deterministic model compliance or general latency acceptance is claimed."};});
 await add(a,'For Python explanations, use beginner Python terminology.');await add(a,'The unrelated synthetic hobby is clockwork gardening.');await add(a,'For cache examples, use the synthetic project label Moon Orchard.');
 await check('LS-TEST-094-relevance-and-disabled-callbacks',async()=>{const relevant=await turn(a,'Explain Python generators.');assert.match(relevant.memory.content,/beginner Python/);assert.doesNotMatch(relevant.memory.content,/clockwork gardening|Moon Orchard/);assert.doesNotMatch(relevant.output,/clockwork gardening|Moon Orchard/iu);const current=[];for(let i=0;i<2;i++)current.push(await turn(a,'Give a concrete cache example.'));const config=(await api(a.path+'/configurations',{preset:'balanced',controls:{callbackFrequency:0},idempotencyKey:randomUUID()})).configuration;await api(a.path+`/configurations/${config.configurationId}/activate`,{expectedRevision:config.revision,idempotencyKey:randomUUID()});const disabled=[];for(let i=0;i<2;i++)disabled.push(await turn(a,'Give a concrete cache example.'));assert.ok(current.every(item=>item.output.includes('Moon Orchard')),JSON.stringify(current.map(item=>item.output)));assert.ok(disabled.every(item=>!item.output.includes('Moon Orchard')));assert.ok(disabled.every(item=>!item.memory.content.includes('Moon Orchard')));return {relevant,current,disabled,callbackDefinition:'exact mention of synthetic project label Moon Orchard',observedCallbackCounts:{current:current.filter(item=>item.output.includes('Moon Orchard')).length,disabled:disabled.filter(item=>item.output.includes('Moon Orchard')).length},distinctOutputCounts:{current:new Set(current.map(item=>item.output)).size,disabled:new Set(disabled.map(item=>item.output)).size}};});
 // Re-enable relevant records for the before/after correction observation.
 const enabled=(await api(a.path+'/configurations',{preset:'balanced',controls:{callbackFrequency:1},idempotencyKey:randomUUID()})).configuration;await api(a.path+`/configurations/${enabled.configurationId}/activate`,{expectedRevision:enabled.revision,idempotencyKey:randomUUID()});
 const memoryPath=`/api/admin/v1/assistants/${a.assistantId}/memories`,memory=(await api(memoryPath,{content:'The synthetic project codename is Cedar Harbor.'})).memory;await api(memoryPath+`/${memory.id}/lifecycle`,{status:'active',expectedRevision:1});
 const fencedTurn=async(scope,userInput,mutate)=>{
  const diagnostic=activeCheck.fence={stage:'request'},fence={started:performance.now(),diagnostic,enter:()=>{},wait:null,release:()=>{}};
  fence.wait=new Promise(resolve=>{fence.release=resolve;});hold=fence;
  let output,settled=false;requestStarted=performance.now();
  try{
   const response=await post('/api/runtime/v1/messages',{assistantId:scope.assistantId,userInput});
   diagnostic.httpStatus=response.status;assert.equal(response.status,200);
   output=response.text();void output.then(()=>{settled=true;},()=>{settled=true;});
   diagnostic.stage='waiting-for-provider-text';const deadline=Date.now()+45000;
   while(!fence.entered){
    assert.equal(fence.failure,undefined,'real provider text required before fence');
    assert.ok(!settled,'stream ended before real provider text');
    assert.ok(Date.now()<deadline,'provider chunk observation deadline');await delay(10);
   }
   diagnostic.stage='mutating-scope';await mutate();
  }catch(error){diagnostic.operationFailure=qualificationFailure(error);throw error;}
  finally{
   fence.release();if(hold===fence)hold=null;
   if(output)await output.then(text=>{diagnostic.events=qualificationEvents(text);},error=>{diagnostic.streamFailure=qualificationFailure(error);});
   diagnostic.elapsedMs=performance.now()-fence.started;await recorder.save();
  }
  return output;
 };
 await check('LS-TEST-096-correction-real-reply-and-pending-fence',async()=>{
  const before=await turn(a,'What is the synthetic project codename?');assert.match(before.output,/Cedar Harbor/u);
  const fenced=await fencedTurn(a,'What is the synthetic project codename?',async()=>{
   const proposal=(await api(memoryPath+`/${memory.id}/correction`,{content:'The synthetic project codename is Aurora Lantern.'})).event;
   await api(memoryPath+`/${memory.id}/correction`,{applyRevision:proposal.revision,expectedRevision:2});
   assert.equal((await post(memoryPath+`/${memory.id}/correction`,{applyRevision:proposal.revision,expectedRevision:2})).status,409);
  });
  assert.match(fenced,/runtime_input_stale/u);assert.doesNotMatch(fenced,/Cedar Harbor/u);
  const after=await turn(a,'What is the synthetic project codename?');assert.match(after.output,/Aurora Lantern/u);assert.doesNotMatch(after.memory.content,/Cedar Harbor/u);assert.match(after.memory.content,/Critical corrections:.*Aurora Lantern/u);
  return {before,after,pendingOutput:'fenced before held real provider chunk',staleApplyStatus:409};
 });
 await check('LS-TEST-100-audience-transition-and-safe-ordinary-fallback',async()=>{
  const fenced=await fencedTurn(a,'What is the synthetic project codename?',()=>api('/api/runtime/v1/session-context',{expectedRevision:1,mode:'text',audienceScope:'unknown'}));
  assert.match(fenced,/runtime_input_stale/u);assert.doesNotMatch(fenced,/Aurora Lantern/u);
  const fallback=await turn(a,'What is the synthetic project codename?');assert.doesNotMatch(fallback.memory.content,/Aurora Lantern|Moon Orchard|Cedar Harbor/u);assert.doesNotMatch(fallback.output,/Aurora Lantern|Cedar Harbor/u);assert.match(fallback.output,/don.t|not|unknown|unavailable|could you|provide|need|cannot|can.t|haven.t/iu);
  return {pendingOutput:'fenced',fallback,adapter:'none loaded; no learned private payload'};
 });
}catch(error){report.setupFailure=qualificationFailure(error);report.blocker=report.setupFailure.message??'bounded setup/provider unavailable; no credentials logged';}
finally{
 report.result=report.blocker||report.checks.some(item=>item.result!=='pass')?'fail':'pass';
 await finishQualificationReport(report,()=>recorder.save(),[
  ()=>{hold?.release?.();hold=null;SglangInferenceProvider.prototype.generate=original;MemoryRepository.prototype.contextRecords=originalRecords;},
  ()=>app?.shutdown(),
  ()=>storage?rm(storage,{recursive:true,force:true}):undefined,
  ()=>tunnel?.kill('SIGTERM'),
  ()=>{if(oldKey===undefined)delete process.env.LIFESTREAM_INFERENCE_API_KEY;else process.env.LIFESTREAM_INFERENCE_API_KEY=oldKey;key=undefined;}
 ]);
 console.log(JSON.stringify(report,null,2));if(report.result!=='pass')process.exitCode=1;
}
