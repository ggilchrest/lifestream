#!/usr/bin/env node
// Prospective S052 synthetic development qualification. No receipt is written.
// Set LIFESTREAM_REPOSITORY only when developing this harness outside the repo.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = resolve(process.env.LIFESTREAM_REPOSITORY ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const moduleAt = path => import(pathToFileURL(join(repository, path)));
const { createLifestreamServer } = await moduleAt('apps/server/src/index.ts');
const { loadProfile, redactedDigest } = await moduleAt('apps/server/src/config/loader.ts');
const { SglangInferenceProvider } = await moduleAt('packages/providers-sglang/src/provider.ts');
const { SglangInferenceProvider: ServerSglangInferenceProvider } = await moduleAt('packages/providers-sglang/dist/provider.js');
const { FixtureInferenceProvider } = await moduleAt('packages/runtime/src/inference/fixture.ts');
const { buildCanonicalPrompt } = await moduleAt('packages/runtime/src/inference/prompt.ts');
const { streamMessage } = await moduleAt('apps/server/src/runtime/inference.ts');
const { loadWindowsKey } = await import(pathToFileURL(join(repository, '../orchestration/scripts/start-conversation.mjs')));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const expected = Object.freeze({ model:'qwen3.8-27b-local', modelPath:'RadixArk/Qwen3.8-27B-NVFP4', modelRevision:'319f741cce68d7914884900c138a1fbb70a42f30', runtimeVersion:'0.0.0.dev1+g5f55db35e', image:'sha256:616a3e97f45191af975896cfa644279096cb31bd408a071c2e99ca7209c3cafe', context:65536, quantization:'NVFP4' });
const selected = loadProfile('local-dev');
const originalKey = process.env.LIFESTREAM_INFERENCE_API_KEY;
const originalGenerate = SglangInferenceProvider.prototype.generate;
const originalServerGenerate = ServerSglangInferenceProvider.prototype.generate;
const captured = [];
const ownedServers = [];
let tunnel, app, storage, key;
const report = {slice:'LS-S052', caseIds:['LS-TEST-069'], collectedAt:new Date().toISOString(), sourceRevision:undefined, claim:'prospective-development-runtime; Human, production, physical I/O and real authentication excluded', checks:[], exclusions:['production qualification','physical input or playback','Human quality acceptance','real local authentication (S069)','service lifecycle or model/configuration changes']};
const check = async (id, evidenceClass, work) => {
  const start = performance.now();
  try { const evidence=await work(); report.checks.push({id,evidenceClass,result:'pass',elapsedMs:Math.round(performance.now()-start),evidence}); }
  catch(error) { report.checks.push({id,evidenceClass,result:'fail',elapsedMs:Math.round(performance.now()-start),error:{name:error.name,message:error instanceof assert.AssertionError ? error.message : 'bounded check failed; no credential or provider response was logged'}}); }
};
const listen = port => new Promise(resolvePort => { const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolvePort(true)});socket.once('error',()=>{socket.destroy();resolvePort(false)});socket.once('timeout',()=>{socket.destroy();resolvePort(false)}); });
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
const serverAt=async listener=>{const server=createServer(listener);await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen)});ownedServers.push(server);return {server,endpoint:`http://127.0.0.1:${server.address().port}`};};
const parseSse=text=>text.trim().split(/\n\n/u).map(event=>{const name=event.match(/^event: (.+)$/mu)?.[1];const data=event.match(/^data: (.+)$/mu)?.[1];return {name,data:data?JSON.parse(data):null};});
const collect=async(provider,request,controller=new AbortController())=>{const chunks=[];const timer=setTimeout(()=>controller.abort(new Error('harness-bound')),12000);try{for await(const chunk of provider.generate(request,{signal:controller.signal}))chunks.push(chunk)}finally{clearTimeout(timer)}return chunks;};
const prompt = (userInput='Reply with exactly READY', executionMode='live') => buildCanonicalPrompt({assistantId:'s052-synthetic-assistant',sessionId:'s052-synthetic-session',interactionId:randomUUID(),endpointId:null,userInput,executionMode});
const terminal=chunks=>chunks.filter(chunk=>chunk.kind==='done'||chunk.kind==='error');

try {
  report.sourceRevision=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim();
  report.sourceWorktreeStatus=(await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:repository})).stdout.trim().split('\n').filter(Boolean);
  report.scriptSha256=sha256(await readFile(fileURLToPath(import.meta.url)));
  report.buildArtifactDigests=Object.fromEntries(await Promise.all(['packages/providers-sglang/dist/provider.js','packages/runtime/dist/inference/prompt.js','packages/runtime/dist/context/builder.js'].map(async path=>[path,sha256(await readFile(join(repository,path)))])));
  report.configFileSha256=sha256(await readFile(join(repository,'apps/server/src/config/profiles/local-dev.json')));
  report.compositionRevision=(await exec('git',['rev-parse','HEAD'],{cwd:resolve(repository,'..')})).stdout.trim();
  report.accessHelperSha256=sha256(await readFile(join(repository,'../orchestration/scripts/start-conversation.mjs')));
  await check('pinned-config','configuration',async()=>{
    assert.equal(selected.providers.inference,'ai5090-development');assert.equal(selected.inferenceProfile.servedModelName,expected.model);assert.equal(selected.inferenceProfile.model,expected.modelPath);assert.equal(selected.inferenceProfile.modelRevision,expected.modelRevision);assert.equal(selected.inferenceProfile.runtimeVersion,expected.runtimeVersion);assert.equal(selected.inferenceProfile.containerImageDigest,expected.image);assert.equal(selected.inferenceProfile.contextLength,expected.context);assert.equal(selected.inferenceProfile.quantization,expected.quantization);
    return expected;
  });
  assert.equal(report.checks.at(-1).result,'pass','selected development profile identity mismatch');
  key=await loadWindowsKey();
  process.env.LIFESTREAM_INFERENCE_API_KEY=key;
  if(!(await listen(43000))) {
    tunnel=spawn('ssh',['-N','-T','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-L','127.0.0.1:43000:127.0.0.1:30000','ai5090'],{stdio:['ignore','ignore','ignore']});
    let failed=false;tunnel.once('error',()=>{failed=true});tunnel.once('exit',()=>{failed=true});
    for(let attempt=0;attempt<20&&!failed&&!(await listen(43000));attempt++)await delay(250);
    assert.ok(!failed&&await listen(43000),'temporary approved SSH loopback unavailable');
  }
  const endpoint='http://127.0.0.1:43000';
  await check('observed-provider-identity','development-provider',async()=>{
    const health=await fetch(endpoint+'/health',{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(8000)});assert.equal(health.status,200);
    const response=await fetch(endpoint+'/v1/models',{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(8000)});assert.equal(response.status,200);const models=await response.json();const model=models.data.find(item=>item.id===expected.model);assert.ok(model);assert.equal(model.max_model_len,expected.context);
    const command=String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $image=wsl.exe -d Ubuntu-24.04-AI -u root -- docker inspect --format '{{.Image}}' qwen5090; $running=wsl.exe -d Ubuntu-24.04-AI -u root -- docker inspect --format '{{.State.Running}}' qwen5090; [Console]::Out.Write((@{imageId=($image -join '').Trim(); running=($running -join '').Trim()} | ConvertTo-Json -Compress))`;
    const {stdout}=await exec('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','ai5090','powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{timeout:20000,maxBuffer:16384});const container=JSON.parse(stdout.trim());assert.equal(container.imageId,expected.image);assert.equal(container.running,'true');
    const identityCommand=String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $raw=wsl.exe -d Ubuntu-24.04-AI -u root -- docker inspect --format '{{json .Args}}' qwen5090; $modelArguments=ConvertFrom-Json ($raw -join ''); $identity=@{}; foreach($field in @('--model-path','--revision','--context-length','--served-model-name')) { $index=[Array]::IndexOf($modelArguments,$field); if($index -ge 0 -and $index+1 -lt $modelArguments.Count) {$identity[$field]=$modelArguments[$index+1]} }; $runtime=wsl.exe -d Ubuntu-24.04-AI -u root -- docker exec qwen5090 python -m pip show sglang; $version=$runtime | Select-String '^Version:' | Select-Object -First 1; if($version){$identity['runtimeVersion']=$version.ToString().Replace('Version:','').Trim()}; [Console]::Out.Write(($identity | ConvertTo-Json -Compress))`;
    const observed=await exec('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=8','ai5090','powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(identityCommand,'utf16le').toString('base64')],{timeout:30000,maxBuffer:32768});const deployed=JSON.parse(observed.stdout.trim());assert.equal(deployed['--model-path'],expected.modelPath);assert.equal(deployed['--revision'],expected.modelRevision);assert.equal(deployed['--served-model-name'],expected.model);assert.equal(Number(deployed['--context-length']),expected.context);assert.equal(deployed.runtimeVersion,expected.runtimeVersion);
    return {endpoint,health:200,model:{id:model.id,max_model_len:model.max_model_len},container,deployed,modelRevisionEvidence:'read-only running container argument and runtime package inspection; model listing alone is insufficient'};
  });
  assert.equal(report.checks.at(-1).result,'pass','selected provider identity could not be established');
  storage=await mkdtemp(join(tmpdir(),'lifestream-s052-'));
  const config={...selected,inferenceProfile:{...selected.inferenceProfile,endpoint},storage:{databasePath:join(storage,'data.sqlite'),artifactDirectory:join(storage,'artifacts')}};
  report.effectiveConfigurationDigest=redactedDigest({...config,storage:{databasePath:'temporary/data.sqlite',artifactDirectory:'temporary/artifacts'}});
  SglangInferenceProvider.prototype.generate=async function*(request,context){captured.push(structuredClone(request));yield* originalGenerate.call(this,request,context);};
  ServerSglangInferenceProvider.prototype.generate=async function*(request,context){captured.push(structuredClone(request));yield* originalServerGenerate.call(this,request,context);};
  app=createLifestreamServer({config});await app.start();const base=`http://127.0.0.1:${app.address().port}`;
  await check('typed-real-stream-manifest-correlation-readonly','development-provider',async()=>{
    const sessionId='s052-synthetic-session';const assistantId='s052-synthetic-assistant';
    const response=await fetch(base+'/api/runtime/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-lifestream-fixture-session':sessionId,'x-lifestream-fixture-principal':'s052-synthetic-operator',origin:base},body:JSON.stringify({assistantId,userInput:'Reply with exactly READY',readOnlyCapability:{name:'capability.read-only.status',input:{scope:'s052-synthetic'}}}),signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);
    const events=parseSse(await response.text());const outcomes=events.filter(event=>event.name==='interaction.completed'||event.name==='interaction.error');assert.equal(outcomes.length,1,'typed interaction requires exactly one terminal');assert.equal(outcomes[0].name,'interaction.completed','selected provider must complete the actual typed route');
    const started=events.find(event=>event.name==='interaction.started').data;const request=captured.find(item=>item.scope.interactionId===started.interactionId);assert.ok(request);assert.equal(request.scope.sessionId,sessionId);assert.equal(request.scope.assistantId,assistantId);
    assert.deepEqual(request.sections.map(section=>section.kind),['policy','corePersona','adaptivePersona','interactionState','preparedMemory','worldContext','capabilityState','conversation','userInput']);
    assert.deepEqual(request.sections.map(section=>section.trusted),[true,true,true,true,false,false,false,false,false]);
    for(const section of request.sections){assert.equal(section.contentDigest,sha256(section.content));assert.ok(section.sourceRevision&&section.sourceRef);assert.ok(['none','redacted'].includes(section.redaction));}
    assert.deepEqual(events.find(event=>event.name==='input.manifest').data,request.manifest);
    const deltas=events.filter(event=>event.name==='message.delta');assert.ok(deltas.length);assert.ok(deltas.every(event=>event.data.interactionId===started.interactionId));const output=deltas.map(event=>event.data.text).join('');assert.match(output,/READY/u);
    const capability=events.find(event=>event.name==='capability.read-only').data;assert.equal(capability.effect,'read-only');assert.equal(capability.name,'capability.read-only.status');
    return {manifest:request.manifest,scope:request.scope,provider:started.provider,output,deltaCount:deltas.length,terminal:outcomes[0].name,capability,capabilityClaim:'selection only; no tool dispatch',authentication:'synthetic fixture session; S069 remains separate'};
  });
  const realProvider=()=>new SglangInferenceProvider({endpoint,model:expected.model,apiKey:key});
  await check('real-call-cancellation','development-provider',async()=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('synthetic-user-cancel')),100);let chunks;try{chunks=await collect(realProvider(),prompt('Reply with exactly CANCEL_TEST'),controller)}finally{clearTimeout(timer)}assert.deepEqual(terminal(chunks).map(chunk=>chunk.error?.code??chunk.kind),['cancelled']);return {terminal:'cancelled',textChunks:chunks.filter(chunk=>chunk.kind==='text').length};});
  await check('real-response-byte-limit','development-provider',async()=>{const chunks=await collect(new SglangInferenceProvider({endpoint,model:expected.model,apiKey:key,maxResponseBytes:2}),prompt('Reply with exactly LIMIT_TEST'));assert.deepEqual(terminal(chunks).map(chunk=>chunk.error?.code??chunk.kind),['response_limit']);return {limitBytes:2,terminal:'response_limit',emittedBytes:chunks.filter(chunk=>chunk.kind==='text').reduce((n,chunk)=>n+Buffer.byteLength(chunk.text),0)};});
  await check('fixture-parity','fixture',async()=>{const request=prompt('fixture parity');const chunks=await collect(new FixtureInferenceProvider(),request);assert.equal(terminal(chunks).length,1);assert.equal(terminal(chunks)[0].kind,'done');return {kinds:chunks.map(chunk=>chunk.kind),orderedManifest:request.manifest.sections.map(section=>section.kind)};});
  await check('runtime-deadline','fault-injection',async()=>{
    let aborted=false;const stalled={async *generate(_request,{signal}){await new Promise(resolveAbort=>{if(signal.aborted)resolveAbort();else signal.addEventListener('abort',resolveAbort,{once:true})});aborted=true;yield {kind:'error',error:{code:'cancelled',message:'synthetic deadline cancellation'}};}};
    const {endpoint:runtimeEndpoint}=await serverAt((_request,response)=>{void streamMessage(response,stalled,{userInput:'synthetic deadline'},'s052-deadline',new AbortController().signal)});const start=performance.now();const response=await fetch(runtimeEndpoint,{signal:AbortSignal.timeout(12500)});const events=parseSse(await response.text());const elapsedMs=Math.round(performance.now()-start);assert.ok(aborted);assert.ok(elapsedMs>=9500&&elapsedMs<12500);assert.deepEqual(events.filter(event=>['interaction.completed','interaction.error'].includes(event.name)).map(event=>event.name),['interaction.error']);return {elapsedMs,terminal:'interaction.error',providerAborted:true,claim:'runtime-owned deadline with injected stalled provider; no shared provider outage'};
  });
  await check('outage-fails-without-fabricated-answer','fault-injection',async()=>{const {server,endpoint:closedEndpoint}=await serverAt((_request,response)=>response.end());await new Promise(resolveClose=>server.close(resolveClose));const chunks=await collect(new SglangInferenceProvider({endpoint:closedEndpoint,model:expected.model}),prompt());assert.equal(chunks.filter(chunk=>chunk.kind==='text').length,0);assert.deepEqual(terminal(chunks).map(chunk=>chunk.error?.code),['inference_unavailable']);return {terminal:'inference_unavailable',textChunks:0,sharedProviderChanged:false};});
  await check('replay-zero-provider-calls','fault-injection',async()=>{let calls=0;const {endpoint:spy}=await serverAt((_request,response)=>{calls++;response.end('data: [DONE]\n\n')});const chunks=await collect(new SglangInferenceProvider({endpoint:spy,model:expected.model}),prompt('synthetic replay','replay'));assert.equal(calls,0);assert.deepEqual(terminal(chunks).map(chunk=>chunk.error?.code),['replay_live_provider_forbidden']);return {calls,terminal:'replay_live_provider_forbidden'};});
  await check('invalid-canonical-input-rejected-before-provider','fault-injection',async()=>{let calls=0;const {endpoint:spy}=await serverAt((_request,response)=>{calls++;response.end('data: [DONE]\n\n')});const provider=new SglangInferenceProvider({endpoint:spy,model:expected.model});const variants=[];for(const mutation of ['reorder','missingDigest','untrustedPolicy']){const request=prompt();if(mutation==='reorder')[request.sections[0],request.sections[1]]=[request.sections[1],request.sections[0]];if(mutation==='missingDigest')delete request.sections[0].contentDigest;if(mutation==='untrustedPolicy')request.sections[0].trusted=false;const before=calls;const chunks=await collect(provider,request);variants.push({mutation,providerCalls:calls-before,terminals:terminal(chunks).map(chunk=>chunk.error?.code??chunk.kind)});}assert.ok(variants.every(variant=>variant.providerCalls===0&&variant.terminals.length===1&&variant.terminals[0]!=='done'),JSON.stringify(variants));return variants;});
} catch(error) {report.blocker={name:error.name,message:error instanceof assert.AssertionError?error.message:'selected provider or harness prerequisite unavailable; no credential was logged'};}
finally {
  SglangInferenceProvider.prototype.generate=originalGenerate;
  ServerSglangInferenceProvider.prototype.generate=originalServerGenerate;
  await app?.shutdown();
  for(const server of ownedServers){server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));}
  tunnel?.kill('SIGTERM');
  if(storage)await rm(storage,{recursive:true,force:true});
  if(originalKey===undefined)delete process.env.LIFESTREAM_INFERENCE_API_KEY;else process.env.LIFESTREAM_INFERENCE_API_KEY=originalKey;
  key=undefined;
  report.result=report.blocker||report.checks.some(item=>item.result!=='pass')?'fail':'pass';
  report.acceptance=report.result==='pass'&&report.sourceWorktreeStatus?.length===0?'candidate-evidence-requires-committed-harness-and-qualified-requirement-inputs':'not-qualified';
  console.log(JSON.stringify(report,null,2));
  if(report.result!=='pass')process.exitCode=1;
}
