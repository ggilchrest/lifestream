import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Database} from '../packages/storage-sqlite/src/database.ts';
import {SqlitePwceAdmissionCustody} from '../apps/server/src/authority/pwce-admission-custody.ts';
import {PwceInvocation} from '../packages/providers-pwce/src/invocation.ts';
import {SqlitePwceInvocationCustody} from '../apps/server/src/authority/pwce-invocation-custody.ts';
import {PwceAuthorityAdmission} from '../packages/providers-pwce/src/authority-admission.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PwceGatewayClient } from '../packages/providers-pwce/src/client.ts';
import { PwceAuthorityPreview, pwceLightOperation, pwceGovernedDisposition } from '../packages/providers-pwce/src/authority-preview.ts';
import { canonicalJson } from '../packages/runtime/src/capabilities/schema-validation.ts';
import { PwceCapabilityCatalog, PWCE_LIGHT_CAPABILITY_ID } from '../packages/providers-pwce/src/capability-catalog.ts';
import { EXPECTED_PWCE_CAPABILITY_BUNDLE } from '../packages/providers-pwce/src/capability-bundle.ts';
import { createContractValidator } from '../packages/contracts/src/validator.ts';
import { PwceTrustedDispatchClient } from '../packages/providers-pwce/src/dispatch.ts';
import { PWCE_DISPATCH_REQUEST_SCHEMA, PWCE_DISPATCH_RESPONSE_SCHEMA } from '../packages/providers-pwce/src/dispatch-bundle.ts';
const producer=resolve(process.env.PWCE_PRODUCER_ROOT ?? '../PWCE'), token=randomBytes(24).toString('hex'), dispatcherToken=randomBytes(24).toString('hex');
const host=spawn(process.execPath,['scripts/gateway-dispatch-fixture.mjs'],{cwd:producer,env:{PATH:process.env.PATH,PWCE_FIXTURE_TOKEN:token,PWCE_FIXTURE_DISPATCHER_TOKEN:dispatcherToken},stdio:['pipe','pipe','pipe']});
const exit=once(host,'exit'), lines=createInterface({input:host.stdout}), iterator=lines[Symbol.asyncIterator]();let stderr='';
host.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8192)host.kill('SIGTERM');});
async function readLine(){let timer;try { const item=await Promise.race([iterator.next(),exit.then(()=>{throw new Error('synthetic producer exited');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('synthetic producer response deadline exceeded')),10000);})]);assert.equal(item.done,false);assert.ok(item.value.length<4096);return JSON.parse(item.value); }finally{clearTimeout(timer);}}
async function stats(){host.stdin.write('stats\n');const result=await readLine();assert.equal(result.fixtureStats,true);return result.calls;}
const ajv=new Ajv2020({strict:false});addFormats(ajv);const validateRequest=ajv.compile(PWCE_DISPATCH_REQUEST_SCHEMA),validateResponse=ajv.compile(PWCE_DISPATCH_RESPONSE_SCHEMA);
let calls=0, wireCalls=0, catalogChecks=0, authorityChecks=0, admissionChecks=0, invocationChecks=0;
const custodyDir=mkdtempSync(join(tmpdir(),'pwce-joined-admission-')),custodyPath=join(custodyDir,'state.sqlite');
let database=new Database({path:custodyPath});database.migrate();
try {
 const ready=await readLine();assert.equal(ready.fixture,true);assert.equal(ready.liveEffects,false);assert.equal(ready.scenario,'trusted-dispatch');
 const url=new URL(ready.url);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');
 const core=new PwceGatewayClient({baseUrl:ready.url,token});
 let discardReply=false;
 const client=new PwceTrustedDispatchClient({baseUrl:ready.url,token,dispatcherToken,fetchImpl:async (url,init)=>{
  const action=String(url).endsWith('/gateway/v1/dispatch');if(action){wireCalls++;assert.ok(validateRequest(JSON.parse(init.body)),JSON.stringify(validateRequest.errors));}
  const response=await fetch(url,init);
  if(action&&discardReply){discardReply=false;await response.arrayBuffer();throw new Error('synthetic discarded completed HTTP reply');}
  return response;
 }});
 const identity={assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic'};
 const authority=await core.authority(['home.one'],undefined,identity);
 const scope={...identity,worldRef:'world.personal.v1',executionEnvironmentRef:'test'};
 const snapshot=await core.request({...scope,authorityContextRef:authority.authorityContextRef,operation:'capabilities.getSnapshot'});
 const localScope={assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),environmentId:randomUUID(),conversationId:randomUUID(),interactionTraceId:randomUUID(),authorityContextRef:{providerRef:'pwce.synthetic',contextId:randomUUID(),revision:1}};
 const binding={authorityContextRef:authority.authorityContextRef,principalRef:'agent.fixture',siteRefs:['home.one'],worldRef:scope.worldRef,executionEnvironmentRef:scope.executionEnvironmentRef,identity};
 const catalog=new PwceCapabilityCatalog({providerRef:'pwce.synthetic',client:core,resolve:async()=>binding,isCurrent:()=>true});
 const catalogRequest=()=>({schemaVersion:'1.0.0',operation:'CapabilityProvider.getSnapshot',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope:localScope,idempotencyKey:null,payload:{requestedCapabilityIds:[]}});
 const callContext={signal:new AbortController().signal,isCurrent:()=>true}, projected=await catalog.getSnapshot(catalogRequest(),callContext);
 const contracts=createContractValidator();assert.ok(contracts.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/CapabilitySnapshotResult',projected).valid);
 assert.equal(projected.outcome.payload.capabilities[0].capabilityId,PWCE_LIGHT_CAPABILITY_ID);assert.equal(catalog.retained(projected.outcome.payload.snapshotId,localScope).producerSnapshotRef,snapshot.snapshotRef);catalogChecks++;
 const schemaScope={assistantId:localScope.assistantId,endpointId:localScope.endpointId,sessionId:localScope.sessionId,environment:localScope.environmentId,authorityContextRef:localScope.authorityContextRef};
 const schemaContext=()=>({...callContext,requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString(),executionMode:'live'});
 for(const artifact of [EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0].inputSchemaArtifact,EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0].resultSchemaArtifact]) {
  const bytes=await catalog.schemas.read(artifact,schemaScope,schemaContext());assert.equal(bytes.byteLength,artifact.byteLength);assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
  const schema=JSON.parse(new TextDecoder().decode(bytes));assert.equal(schema.$id,artifact.reference);ajv.compile(schema);catalogChecks++;
 }
 assert.equal(await catalog.schemas.read(EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0].inputSchemaArtifact,{...schemaScope,sessionId:randomUUID()},schemaContext()),undefined);
 assert.equal(await stats(),0);catalogChecks++;
 const preparedActions=new Map(), hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
 const createPreview=selectedCatalog=>new PwceAuthorityPreview({providerRef:'pwce.synthetic',client:core,catalog:selectedCatalog,resolve:async request=>preparedActions.get(request.payload.invocationId),isCurrent:(request,prepared)=>hash(preparedActions.get(request.payload.invocationId))===hash(prepared)});
 const preview=createPreview(catalog);
 const previewRequest=(required=false,selected=projected,selectedScope=localScope)=>{
  const action={input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.5}},approval:{required,reference:null}},invocationId=randomUUID();preparedActions.set(invocationId,action);
  return {schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:randomUUID(),correlationId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString(),cancellationId:randomUUID(),executionMode:'normal',scope:selectedScope,idempotencyKey:null,payload:{grantId:null,invocationId,inputDigest:hash(action.input),snapshotId:selected.outcome.payload.snapshotId,snapshotRevision:1,scope:pwceLightOperation(action.input,binding.worldRef)}};
 };
 const allowedRequest=previewRequest(),allowed=await preview.evaluate(allowedRequest,callContext);
 assert.ok(contracts.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/AuthorityResult',allowed).valid);assert.equal(allowed.outcome.payload.disposition,'authorized');assert.equal(allowed.outcome.payload.kind,'preview');assert.equal(allowed.outcome.payload.admittedAt,null);authorityChecks++;
 const evidence=await preview.readEvidence(allowed.outcome.payload.evidenceRef,allowedRequest,callContext);
 assert.equal(createHash('sha256').update(evidence).digest('hex'),allowed.outcome.payload.evidenceRef.sha256);assert.equal(JSON.parse(new TextDecoder().decode(evidence)).outcome,'allowed');authorityChecks++;
 const approvalNeeded=await preview.evaluate(previewRequest(true),callContext);assert.equal(approvalNeeded.outcome.payload.disposition,'approvalRequired');assert.equal(approvalNeeded.outcome.payload.admittedAt,null);assert.equal(await stats(),0);authorityChecks++;


 const dispatchRequest=(request,decision)=>({...request,operation:'AuthorityProvider.authorizeDispatch',requestId:randomUUID(),idempotencyKey:randomUUID(),payload:{...request.payload,expectedGrantRevision:catalog.retained(request.payload.snapshotId,request.scope).producerRevision,requiredProviderDisposition:pwceGovernedDisposition(decision)}});
 let hostApproved=true;
 const admission=()=>new PwceAuthorityAdmission({providerRef:'pwce.synthetic',client:core,dispatcher:client,catalog,preview,custody:new SqlitePwceAdmissionCustody(database),authorize:async()=>hostApproved});
 const finalRequest=dispatchRequest(allowedRequest,allowed.outcome.payload),final=await admission().authorizeDispatch(finalRequest,callContext);
 assert.ok(contracts.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/AuthorityDispatchResult',final).valid);assert.equal(final.outcome.payload.disposition,'authorized');assert.equal(final.outcome.payload.kind,'dispatch');assert.ok(final.outcome.payload.admittedAt);assert.equal(await stats(),0);admissionChecks++;
 const finalEvidence=await admission().readEvidence(final.outcome.payload.evidenceRef,finalRequest,callContext),proof=JSON.parse(new TextDecoder().decode(finalEvidence));
 assert.equal(createHash('sha256').update(finalEvidence).digest('hex'),final.outcome.payload.evidenceRef.sha256);assert.equal(proof.admittedAt,final.outcome.payload.admittedAt);assert.equal(proof.kind,'pwce.action.admission');assert.equal(proof.capabilitySnapshot.snapshotRef,snapshot.snapshotRef);admissionChecks++;
 database.close();database=new Database({path:custodyPath});database.migrate();
 const beforeReplay=wireCalls,replayed=await admission().authorizeDispatch({...finalRequest,requestId:randomUUID()},callContext);assert.deepEqual(replayed.outcome.payload,final.outcome.payload);assert.equal(wireCalls,beforeReplay);admissionChecks++;
 hostApproved=false;await assert.rejects(admission().authorizeDispatch(finalRequest,callContext),{code:'host_admission_required'});hostApproved=true;assert.equal(wireCalls,beforeReplay);admissionChecks++;
 const lostPreviewRequest=previewRequest(),lostPreview=await preview.evaluate(lostPreviewRequest,callContext),lostRequest=dispatchRequest(lostPreviewRequest,lostPreview.outcome.payload);
 discardReply=true;await assert.rejects(admission().authorizeDispatch(lostRequest,callContext),{code:'unavailable'});const afterLost=wireCalls;
 database.close();database=new Database({path:custodyPath});database.migrate();
 await assert.rejects(admission().authorizeDispatch({...lostRequest,requestId:randomUUID()},callContext),{code:'admission_outcome_unknown'});assert.equal(wireCalls,afterLost);assert.equal(await stats(),0);admissionChecks++;

 const invocation=()=>new PwceInvocation({providerRef:'pwce.synthetic',client:core,dispatcher:client,admission:admission(),custody:new SqlitePwceInvocationCustody(database)});
 const invocationRequest=(request,decision)=>({...request,operation:'CapabilityProvider.invoke',requestId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString(),payload:{invocationId:request.payload.invocationId,capabilityId:PWCE_LIGHT_CAPABILITY_ID,capabilityVersion:'1.0.0',snapshotId:request.payload.snapshotId,snapshotRevision:request.payload.snapshotRevision,operationScope:request.payload.scope,input:preparedActions.get(request.payload.invocationId).input,inputSchema:EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0].inputSchemaArtifact,inputDigest:request.payload.inputDigest,dispatchReceipt:decision.evidenceRef}});
 const queryFor=request=>({...request,operation:'CapabilityProvider.getInvocation',requestId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString(),payload:{invocationId:request.payload.invocationId}});
 const invocationInput=invocationRequest(finalRequest,final.outcome.payload),effect=await invocation().invoke(invocationInput,callContext);assert.ok(contracts.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/CapabilityInvocationResult',effect).valid);assert.equal(effect.outcome.payload.type,'succeeded');assert.equal(await stats(),1);invocationChecks++;
 const invocationEvidence=await invocation().readEvidence(effect.outcome.payload.evidenceRef,queryFor(invocationInput),callContext);assert.equal(createHash('sha256').update(invocationEvidence).digest('hex'),effect.outcome.payload.evidenceRef.sha256);assert.equal(JSON.parse(new TextDecoder().decode(invocationEvidence)).actionRef,proof.actionRef);invocationChecks++;
 const originalInvokes=wireCalls;database.close();database=new Database({path:custodyPath});database.migrate();const repeatedEffect=await invocation().invoke({...invocationInput,requestId:randomUUID()},callContext);assert.deepEqual(repeatedEffect.outcome.payload,effect.outcome.payload);assert.equal(wireCalls,originalInvokes);assert.equal(await stats(),1);invocationChecks++;
 const secondPreviewRequest=previewRequest(),secondPreview=await preview.evaluate(secondPreviewRequest,callContext),secondFinalRequest=dispatchRequest(secondPreviewRequest,secondPreview.outcome.payload),secondFinal=await admission().authorizeDispatch(secondFinalRequest,callContext),secondInvocation=invocationRequest(secondFinalRequest,secondFinal.outcome.payload);
 discardReply=true;await assert.rejects(invocation().invoke(secondInvocation,callContext),{code:'unavailable'});assert.equal(await stats(),2);invocationChecks++;
 const afterMissingInvocation=wireCalls;database.close();database=new Database({path:custodyPath});database.migrate();const recoveredInvocation=await invocation().getInvocation(queryFor(secondInvocation),callContext);assert.equal(recoveredInvocation.outcome.payload.type,'succeeded');assert.equal(wireCalls,afterMissingInvocation);assert.equal(await stats(),2);invocationChecks++;
 const foreignQuery=queryFor(secondInvocation);foreignQuery.scope={...foreignQuery.scope,sessionId:randomUUID()};await assert.rejects(invocation().getInvocation(foreignQuery,callContext),{code:'invocation_unavailable'});assert.equal(wireCalls,afterMissingInvocation);invocationChecks++;
 const baselineCalls=await stats();

 const input={...scope,requestId:randomUUID(),correlationId:randomUUID(),deadline:new Date(Date.now()+30_000).toISOString(),snapshotRef:snapshot.snapshotRef,capabilityRef:'home.light.set_level',capabilityVersion:'1.0.0',capabilityOperation:'light.set_level',siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.5},idempotencyKey:randomUUID(),approvalRequired:false,approvalRef:null};
 const admitted=await client.authorizeDispatch(authority.authorityContextRef,input);assert.ok(validateResponse(admitted),JSON.stringify(validateResponse.errors));assert.equal(admitted.status,'admitted');assert.equal(await stats(),baselineCalls);calls++;
 const duplicate=await client.authorizeDispatch(authority.authorityContextRef,input);assert.equal(duplicate.actionRef,admitted.actionRef);assert.equal(duplicate.duplicate,true);assert.equal(await stats(),baselineCalls);calls++;
 const command={...input,actionRef:admitted.actionRef};discardReply=true;
 await assert.rejects(client.invoke(authority.authorityContextRef,command),{code:'unavailable'});assert.equal(await stats(),baselineCalls+1);calls++;
 const completed=await client.invoke(authority.authorityContextRef,command);assert.ok(validateResponse(completed),JSON.stringify(validateResponse.errors));assert.equal(completed.status,'completed');assert.equal(await stats(),baselineCalls+1);calls++;
 const recovered=await core.request({...scope,authorityContextRef:authority.authorityContextRef,operation:'capabilities.getInvocation',actionRef:admitted.actionRef});assert.equal(recovered.action.status,'succeeded');assert.equal(recovered.action.idempotencyKey,input.idempotencyKey);calls++;
 const unknownInput={...input,requestId:randomUUID(),idempotencyKey:randomUUID(),targetEntityId:'light.unknown'};
 const unknownAdmission=await client.authorizeDispatch(authority.authorityContextRef,unknownInput);
 const unknownCommand={...unknownInput,actionRef:unknownAdmission.actionRef};
 for(let i=0;i<2;i++){const reply=await client.invoke(authority.authorityContextRef,unknownCommand);assert.ok(validateResponse(reply),JSON.stringify(validateResponse.errors));assert.equal(reply.status,'outcome_unknown');}assert.equal(await stats(),baselineCalls+2);calls++;
 const pendingInput={...input,requestId:randomUUID(),idempotencyKey:randomUUID()};const pending=await client.authorizeDispatch(authority.authorityContextRef,pendingInput);
 host.stdin.write('revoke\n');assert.equal((await readLine()).revoked,true);
 await assert.rejects(catalog.schemas.read(EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0].inputSchemaArtifact,schemaScope,schemaContext()),{code:'authority_context_invalidated'});catalogChecks++;
 await assert.rejects(catalog.getSnapshot(catalogRequest(),callContext),{code:'authority_context_invalidated'});catalogChecks++;
 await assert.rejects(invocation().getInvocation(queryFor(invocationInput),callContext),{code:'authority_context_invalidated'});invocationChecks++;
 await assert.rejects(admission().readEvidence(final.outcome.payload.evidenceRef,finalRequest,callContext),{code:'authority_context_invalidated'});admissionChecks++;
 await assert.rejects(preview.readEvidence(allowed.outcome.payload.evidenceRef,allowedRequest,callContext),{code:'authority_context_invalidated'});authorityChecks++;
 const deniedAuthority=await core.authority(['home.one'],undefined,identity),deniedBinding={...binding,authorityContextRef:deniedAuthority.authorityContextRef},deniedScope={...localScope,authorityContextRef:{...localScope.authorityContextRef,contextId:randomUUID()}};
 const deniedCatalog=new PwceCapabilityCatalog({providerRef:'pwce.synthetic',client:core,resolve:async()=>deniedBinding,isCurrent:()=>true});
 const deniedSnapshot=await deniedCatalog.getSnapshot({...catalogRequest(),scope:deniedScope},callContext),denied=await createPreview(deniedCatalog).evaluate(previewRequest(false,deniedSnapshot,deniedScope),callContext);
 assert.equal(denied.outcome.payload.disposition,'denied');assert.equal(denied.outcome.payload.admittedAt,null);assert.equal(await stats(),baselineCalls+2);authorityChecks++;

 await assert.rejects(client.invoke(authority.authorityContextRef,{...pendingInput,actionRef:pending.actionRef}),{code:'authority_context_invalidated'});assert.equal(await stats(),baselineCalls+2);calls++;
 console.log(JSON.stringify({checks:calls,catalogChecks,authorityChecks,admissionChecks,invocationChecks,wireCalls,targetCalls:baselineCalls+2,fixtures:true,scope:'separate-process canonical catalog, preview and durable final admission plus pinned dispatch transport; canonical original invocation/status custody; no configured runtime activation, real effects or Human acceptance'}));
}finally{
 database.close();rmSync(custodyDir,{recursive:true,force:true});
 host.stdin.end('stop\n');let timer;
 try{await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(()=>{host.kill('SIGTERM');resolve();},3000);})]);}finally{clearTimeout(timer);lines.close();}
 assert.ok(!stderr.includes(token)&&!stderr.includes(dispatcherToken),'synthetic credentials must not appear in producer diagnostics');
 if(stderr)process.stderr.write(stderr);
}
