import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {PwceInvocation,pwceInvocationDigest} from '../src/invocation.ts';
import {PwceAuthorityAdmission} from '../src/authority-admission.ts';
import {PwceAuthorityPreview,pwceLightOperation,pwceGovernedDisposition} from '../src/authority-preview.ts';
import {EXPECTED_PWCE_CAPABILITY_BUNDLE} from '../src/capability-bundle.ts';
import {PwceTransportError} from '../src/transport.ts';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
async function admissionFixture(){
 const scope={assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),environmentId:randomUUID(),conversationId:randomUUID(),interactionTraceId:randomUUID(),authorityContextRef:{providerRef:'pwce.synthetic',contextId:randomUUID(),revision:1}};
 const binding={authorityContextRef:randomUUID(),principalRef:'agent.synthetic',siteRefs:['home.one'],worldRef:'world.personal.v1',executionEnvironmentRef:'test',identity:{assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic'}};
 const prepared={input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.5}},approval:{required:false,reference:null}};
 const body={snapshotRef:randomUUID(),principalRef:binding.principalRef,siteRefs:binding.siteRefs,sourceRevision:1,invalidationSequence:1,issuedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:[{...EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0],available:true,authorization:'grant_required'}],availability:'configured',limitations:[]};
 const record={scope,binding,snapshot:{snapshotId:randomUUID(),revision:1,issuedAt:body.issuedAt,expiresAt:body.expiresAt,capabilities:[{capabilityId:'pwce.home.light.set-level'}]},executionMode:'normal',producerSnapshotRef:body.snapshotRef,producerRevision:1,producerDigest:hash(body)};
 const state={current:true,bound:true,approved:true,reserveFail:false,completeFail:false,sent:[],records:new Map(),hook:async()=>{},mutate:()=>{}};
 const catalog={retained:()=>state.bound?structuredClone(record):undefined,revalidate:async()=>{await state.hook('catalog');if(!state.bound)throw new PwceTransportError('snapshot_unavailable','synthetic');return structuredClone(record);}};
 const client={request:async request=>({profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,outcome:'allowed',capabilityRef:'home.light.set_level',effectClass:'reversible',rationaleCodes:['explicit_grant_active'],requirements:[],limitations:[]}),admissionContracts:async()=>{await state.hook('contracts');}};
 const preview=new PwceAuthorityPreview({providerRef:'pwce.synthetic',client,catalog,resolve:async()=>prepared,isCurrent:()=>state.current});
 const previewRequest={schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:randomUUID(),correlationId:randomUUID(),cancellationId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString(),executionMode:'normal',scope,idempotencyKey:null,payload:{grantId:null,invocationId:randomUUID(),inputDigest:hash(prepared.input),snapshotId:record.snapshot.snapshotId,snapshotRevision:1,scope:pwceLightOperation(prepared.input,binding.worldRef)}};
 const context={signal:new AbortController().signal,isCurrent:()=>state.current},decision=(await preview.evaluate(previewRequest,context)).outcome.payload;
 const request={...previewRequest,operation:'AuthorityProvider.authorizeDispatch',requestId:randomUUID(),idempotencyKey:randomUUID(),payload:{...previewRequest.payload,expectedGrantRevision:1,requiredProviderDisposition:pwceGovernedDisposition(decision)}};
 const custody={read:key=>structuredClone(state.records.get(key)),reserve:intent=>{if(state.reserveFail)throw new Error('synthetic write failure');if(state.records.has(intent.request.idempotencyKey))return false;state.records.set(intent.request.idempotencyKey,{intent:structuredClone(intent),outcome:null});return true;},complete:(key,outcome)=>{if(state.completeFail)throw new Error('synthetic write failure');const saved=state.records.get(key);saved.outcome=structuredClone(outcome);return structuredClone(saved);}};
 const dispatcher={authorizeDispatch:async(_context,wire)=>{
  assert.ok(state.records.get(request.idempotencyKey),'original intent must be committed before admission I/O');state.sent.push(structuredClone(wire));await state.hook('dispatch');
  const fingerprint={principalRef:binding.principalRef,capabilityRef:'home.light.set_level',capabilityVersion:'1.0.0',operation:'light.set_level',...prepared.input,executionEnvironmentRef:binding.executionEnvironmentRef,gatewayScope:{worldRef:binding.worldRef,...binding.identity}};
  const snapshotJson=JSON.stringify({scope:[binding.authorityContextRef,binding.principalRef,1,1,binding.siteRefs,binding.identity.assistantRef,binding.identity.endpointRef,binding.identity.participantRefs,binding.identity.audienceRef,binding.worldRef,binding.executionEnvironmentRef],sourceDigest:'a'.repeat(64),snapshot:{profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',...body}});
  const proof={schemaVersion:'1.0.0',kind:'pwce.action.admission',actionRef:randomUUID(),idempotencyKey:wire.idempotencyKey,requestFingerprint:canonicalJson(fingerprint),...fingerprint,grantRevision:1,targetIdentity:'synthetic:light.one',deadlineAt:wire.deadline,approvalRequired:prepared.approval.required,approvalRef:prepared.approval.reference,capabilitySnapshot:{snapshotRef:body.snapshotRef,sha256:bytesHash(snapshotJson),expiresAt:body.expiresAt,snapshotJson},precondition:null,admittedAt:new Date().toISOString(),decision:{outcome:'allowed',rationaleCodes:['explicit_grant_active']}};
  const raw={dispatchProfileId:'pwce-trusted-dispatch.v1',dispatchProfileVersion:'1.0.0',profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:wire.requestId,correlationId:wire.correlationId,worldRef:wire.worldRef,executionEnvironmentRef:wire.executionEnvironmentRef,status:'admitted',actionRef:proof.actionRef,admissionEvidence:proof};state.mutate(raw);return raw;
 }};
 const create=()=>new PwceAuthorityAdmission({providerRef:'pwce.synthetic',client,dispatcher,catalog,preview,custody,authorize:async()=>{await state.hook('host');return state.approved;}});
 return {request,context,state,record,prepared,custody,create,client,dispatcher,catalog};
}

async function fixture(){
 const f=await admissionFixture();f.catalog.assertReadScope=()=>{if(!f.state.current||!f.state.bound)throw new PwceTransportError('scope_changed','synthetic');};
 const admission=f.create(),admitted=await admission.authorizeDispatch(f.request,f.context),originalProof=JSON.parse(f.custody.read(f.request.idempotencyKey).outcome.evidenceJson);
 const request={...f.request,operation:'CapabilityProvider.invoke',requestId:randomUUID(),payload:{invocationId:f.request.payload.invocationId,capabilityId:'pwce.home.light.set-level',capabilityVersion:'1.0.0',snapshotId:f.request.payload.snapshotId,snapshotRevision:1,operationScope:f.request.payload.scope,input:structuredClone(f.prepared.input),inputSchema:EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0].inputSchemaArtifact,inputDigest:f.request.payload.inputDigest,dispatchReceipt:admitted.outcome.payload.evidenceRef}};
 const records=new Map(),history=new Map(),state={sent:[],queries:[],proof:null,status:'succeeded',effect:true,lost:false,claimFailure:false,writeFailure:false,missing:false,hook:async()=>{},mutate:()=>{}};
 const custody={read:id=>structuredClone(records.get(id)),claim:request=>{if(state.claimFailure)throw new Error('synthetic claim failure');const id=request.payload.invocationId;if(records.has(id))return false;records.set(id,{request:structuredClone(request),requestDigest:pwceInvocationDigest(request),latest:null,observationCount:0});history.set(id,[]);return true;},observe:(id,observation)=>{if(state.writeFailure)throw new Error('synthetic observation failure');const record=records.get(id);record.latest=structuredClone(observation);record.observationCount++;history.get(id).push(structuredClone(observation));return structuredClone(record);},readObservation:(id,ref)=>structuredClone(history.get(id)?.find(item=>canonicalJson(item.evidenceRef)===canonicalJson(ref)))};
 f.client.invocationContracts=async()=>{await state.hook('contracts');};
 f.dispatcher.invoke=async(_binding,wire,_signal,isCurrent)=>{await state.hook('transport');isCurrent?.();assert.ok(records.has(request.payload.invocationId),'initial dispatch claim precedes I/O');state.sent.push(structuredClone(wire));const now=new Date().toISOString(),result={status:state.status,externalEffectOccurred:state.effect,observed:{synthetic:true},completedAt:now};state.proof={schemaVersion:'1.0.0',kind:'pwce.action.invocation',actionRef:originalProof.actionRef,admissionEvidence:structuredClone(originalProof),status:state.status,attemptRef:randomUUID(),startedAt:now,dispatchResult:structuredClone(result),result:structuredClone(result),reconciliationRef:null};state.mutate(state.proof);await state.hook('invoke');if(state.lost)throw new Error('synthetic missing reply');return {actionRef:state.proof.actionRef,status:state.proof.status==='succeeded'?'completed':state.proof.status,result:state.proof.result,invocationEvidence:structuredClone(state.proof)};};
 f.client.request=async request=>{state.queries.push(structuredClone(request));await state.hook('status');return {profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,worldRef:request.worldRef,executionEnvironmentRef:request.executionEnvironmentRef,...(state.missing?{status:'unknown'}:{status:'known',invocationEvidence:structuredClone(state.proof),action:{actionRef:state.proof.actionRef,status:state.proof.status,attemptRef:state.proof.attemptRef,startedAt:state.proof.startedAt,dispatchResult:structuredClone(state.proof.dispatchResult),result:structuredClone(state.proof.result)}})};};
 const create=(dispatchEnabled=true)=>new PwceInvocation({providerRef:'pwce.synthetic',client:f.client,...(dispatchEnabled?{dispatcher:f.dispatcher}:{}),admission,custody});
 const query=()=>({...structuredClone(request),operation:'CapabilityProvider.getInvocation',requestId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString(),payload:{invocationId:request.payload.invocationId}});
 return {f,request,state,custody,records,history,create,query,context:f.context};
}

test('canonical invocation exposes confirmed output and exact producer evidence',async()=>{
 const f=await fixture(),result=await f.create().invoke(f.request,f.context);assert.equal(result.outcome.payload.type,'succeeded');assert.deepEqual(result.outcome.payload.output,f.state.proof.result);assert.equal(f.state.sent.length,1);
 const bytes=await f.create().readEvidence(result.outcome.payload.evidenceRef,f.query(),f.context);assert.equal(bytesHash(bytes),result.outcome.payload.evidenceRef.sha256);assert.equal(bytes.length,result.outcome.payload.evidenceRef.byteLength);assert.equal(JSON.parse(new TextDecoder().decode(bytes)).actionRef,f.state.proof.actionRef);
 const replay=await f.create().invoke({...f.request,requestId:randomUUID()},f.context);assert.deepEqual(replay.outcome.payload,result.outcome.payload);assert.equal(f.state.sent.length,1);assert.ok(f.state.queries.every(q=>q.operation==='capabilities.getInvocation'));
});

test('missing invocation reply recovers original status on a new adapter without resending',async()=>{
 const f=await fixture();f.state.lost=true;await assert.rejects(f.create().invoke(f.request,f.context),{code:'unavailable'});assert.equal(f.custody.read(f.request.payload.invocationId).latest,null);
 const result=await f.create().invoke({...f.request,requestId:randomUUID()},f.context);assert.equal(result.outcome.payload.type,'succeeded');assert.equal(f.state.sent.length,1);assert.equal(f.state.queries.length,1);
});

test('forged input, receipt, operation, capability, scope or mode cannot obtain an initial call',async()=>{
 for(const change of [r=>r.payload.input.parameters.level=0.8,r=>r.payload.dispatchReceipt.sha256='0'.repeat(64),r=>r.payload.operationScope.targetRefs=['other'],r=>r.payload.capabilityId='other',r=>r.scope.sessionId=randomUUID(),r=>r.executionMode='replay']){const f=await fixture();change(f.request);await assert.rejects(f.create().invoke(f.request,f.context));assert.equal(f.state.sent.length,0);assert.equal(f.records.size,0);}
});

test('mismatched producer proof leaves the initial claim uncertain',async()=>{
 for(const mutate of [p=>p.admissionEvidence.idempotencyKey='other',p=>p.actionRef=randomUUID(),p=>p.attemptRef=null,p=>p.startedAt='invalid',p=>p.result.completedAt=new Date(0).toISOString(),p=>p.dispatchResult.observed={changed:true},p=>p.result.externalEffectOccurred=false]){const f=await fixture();f.state.mutate=mutate;await assert.rejects(f.create().invoke(f.request,f.context));assert.equal(f.state.sent.length,1);assert.equal(f.custody.read(f.request.payload.invocationId).latest,null);}
});

test('claim failure prevents I/O and observation failure retains a recoverable original attempt',async()=>{
 const unclaimed=await fixture();unclaimed.state.claimFailure=true;await assert.rejects(unclaimed.create().invoke(unclaimed.request,unclaimed.context));assert.equal(unclaimed.state.sent.length,0);
 const f=await fixture();f.state.writeFailure=true;await assert.rejects(f.create().invoke(f.request,f.context));assert.equal(f.custody.read(f.request.payload.invocationId).latest,null);f.state.writeFailure=false;assert.equal((await f.create().getInvocation(f.query(),f.context)).outcome.payload.type,'succeeded');assert.equal(f.state.sent.length,1);
});

test('scope withdrawal before and after dispatch withholds late output',async()=>{
 for(const phase of ['contracts','invoke']){const f=await fixture();f.state.hook=async current=>{if(current===phase)f.f.state.current=false;};await assert.rejects(f.create().invoke(f.request,f.context),{code:'scope_changed'});assert.equal(f.state.sent.length,phase==='contracts'?0:1);assert.equal(f.custody.read(f.request.payload.invocationId)?.latest??null,null);}
 const f=await fixture();await f.create().invoke(f.request,f.context);f.state.hook=async phase=>{if(phase==='status')f.f.state.current=false;};await assert.rejects(f.create().getInvocation(f.query(),f.context),{code:'scope_changed'});assert.equal(f.state.sent.length,1);
});

test('changed retry content conflicts instead of issuing a second command',async()=>{
 const f=await fixture();await f.create().invoke(f.request,f.context);for(const change of [r=>r.idempotencyKey=randomUUID(),r=>r.payload.input.parameters.level=0.9,r=>r.correlationId=randomUUID()]){const other=structuredClone(f.request);change(other);await assert.rejects(f.create().invoke(other,f.context),{code:'invocation_conflict'});}assert.equal(f.state.sent.length,1);
});

test('expired admission prevents a new call but does not prevent read-only recovery of an existing attempt',async()=>{
 const f=await fixture();await f.create().invoke(f.request,f.context);f.f.state.records.get(f.request.idempotencyKey).outcome.decision.expiresAt=new Date(0).toISOString();f.f.state.approved=false;
 assert.equal((await f.create().invoke({...f.request,requestId:randomUUID()},f.context)).outcome.payload.type,'succeeded');assert.equal(f.state.sent.length,1);
 const fresh=await fixture();fresh.f.state.records.get(fresh.request.idempotencyKey).outcome.decision.expiresAt=new Date(0).toISOString();await assert.rejects(fresh.create().invoke(fresh.request,fresh.context),{code:'admission_expired'});assert.equal(fresh.state.sent.length,0);
});

test('terminal result cannot regress and the original attempt cannot change',async()=>{
 const f=await fixture(),success=await f.create().invoke(f.request,f.context),original=structuredClone(f.state.proof);
 f.state.proof.attemptRef=randomUUID();await assert.rejects(f.create().getInvocation(f.query(),f.context),{code:'invocation_observation_conflict'});f.state.proof=structuredClone(original);f.state.proof.result={status:'outcome_unknown',externalEffectOccurred:'unknown',completedAt:new Date().toISOString()};f.state.proof.status='outcome_unknown';f.state.proof.reconciliationRef=randomUUID();f.state.proof.result.reconciledAt=f.state.proof.result.completedAt;
 await assert.rejects(f.create().getInvocation(f.query(),f.context),{code:'invocation_observation_conflict'});assert.deepEqual(f.custody.read(f.request.payload.invocationId).latest.status,success.outcome.payload);
});

test('partial, uncertain and known failure distinctions retain original producer results',async()=>{
 for(const [status,effect,type] of [['partially_succeeded',true,'outcomeUnknown'],['outcome_unknown','unknown','outcomeUnknown'],['failed','unknown','outcomeUnknown'],['failed',false,'failed'],['timed_out',false,'failed'],['cancelled','unknown','outcomeUnknown'],['denied',false,'denied']]){const f=await fixture();f.state.status=status;f.state.effect=effect;const result=await f.create().invoke(f.request,f.context);assert.equal(result.outcome.payload.type,type);assert.equal(JSON.parse(f.custody.read(f.request.payload.invocationId).latest.proofJson).result.status,status);}
});

test('foreign status and missing producer proof cannot expose older successful output',async()=>{
 const f=await fixture(),result=await f.create().invoke(f.request,f.context);const query=f.query();query.scope.sessionId=randomUUID();await assert.rejects(f.create().getInvocation(query,f.context),{code:'invocation_unavailable'});assert.equal(f.state.queries.length,0);
 f.state.missing=true;await assert.rejects(f.create().readEvidence(result.outcome.payload.evidenceRef,f.query(),f.context),{code:'invocation_evidence_unavailable'});assert.equal(f.state.sent.length,1);
});

test('read-only confirmation preserves earlier uncertain proof bytes',async()=>{
 const f=await fixture();f.state.status='outcome_unknown';f.state.effect='unknown';await f.create().invoke(f.request,f.context);const first=f.custody.read(f.request.payload.invocationId).latest;
 const now=new Date().toISOString();f.state.proof.status='succeeded';f.state.proof.result={status:'succeeded',externalEffectOccurred:true,completedAt:now,reconciledAt:now};f.state.proof.reconciliationRef=randomUUID();assert.equal((await f.create().getInvocation(f.query(),f.context)).outcome.payload.type,'succeeded');
 const bytes=await f.create().readEvidence(first.evidenceRef,f.query(),f.context);assert.equal(new TextDecoder().decode(bytes),first.proofJson);assert.equal(f.state.sent.length,1);
});

test('historical evidence metadata and original binding are revalidated before disclosure',async()=>{
 for(const change of ['mediaType','binding']){
  const f=await fixture();f.state.status='outcome_unknown';f.state.effect='unknown';await f.create().invoke(f.request,f.context);
  const first=structuredClone(f.custody.read(f.request.payload.invocationId).latest),now=new Date().toISOString();
  f.state.proof.status='succeeded';f.state.proof.result={status:'succeeded',externalEffectOccurred:true,completedAt:now,reconciledAt:now};f.state.proof.reconciliationRef=randomUUID();await f.create().getInvocation(f.query(),f.context);
  if(change==='mediaType')first.evidenceRef.mediaType='text/plain';
  else{const proof=JSON.parse(first.proofJson);proof.actionRef=randomUUID();first.proofJson=canonicalJson(proof);first.evidenceRef.sha256=bytesHash(first.proofJson);first.evidenceRef.byteLength=Buffer.byteLength(first.proofJson);}
  f.custody.readObservation=()=>structuredClone(first);
  await assert.rejects(f.create().readEvidence(first.evidenceRef,f.query(),f.context),{code:change==='binding'?'invocation_binding_mismatch':'invocation_evidence_unavailable'});
  assert.equal(f.state.sent.length,1);
 }
});


test('catalog invalidation during invocation negotiation prevents the initial claim and send',async()=>{
 const f=await fixture();f.state.hook=async phase=>{if(phase==='contracts')f.f.state.bound=false;};
 await assert.rejects(f.create().invoke(f.request,f.context),{code:'snapshot_unavailable'});
 assert.equal(f.records.size,0);assert.equal(f.state.sent.length,0);
});

test('admission custody changes during invocation negotiation cannot reuse the resolved proof',async()=>{
 const f=await fixture();f.state.hook=async phase=>{if(phase==='contracts')f.f.state.records.get(f.request.idempotencyKey).outcome.evidenceJson='{}';};
 await assert.rejects(f.create().invoke(f.request,f.context),{code:'admission_custody_failed'});
 assert.equal(f.records.size,0);assert.equal(f.state.sent.length,0);
});

test('withdrawal during synchronous claim leaves an uncertain claim and never sends',async()=>{
 const f=await fixture(),claim=f.custody.claim;f.custody.claim=request=>{const result=claim(request);f.f.state.bound=false;return result;};
 await assert.rejects(f.create().invoke(f.request,f.context),{code:'snapshot_unavailable'});
 assert.equal(f.records.size,1);assert.equal(f.state.sent.length,0);assert.equal(f.custody.read(f.request.payload.invocationId).latest,null);
});


test('invocation transport fence catches invalidation after claiming without sending or resetting custody',async()=>{
 const f=await fixture();f.state.hook=async phase=>{if(phase==='transport')f.f.state.bound=false;};
 await assert.rejects(f.create().invoke(f.request,f.context),{code:'snapshot_unavailable'});
 assert.equal(f.state.sent.length,0);assert.equal(f.records.size,1);assert.equal(f.custody.read(f.request.payload.invocationId).latest,null);
});


test('read-only invocation composition retrieves original status but cannot claim or invoke',async()=>{
 const f=await fixture(),reader=f.create(false);await assert.rejects(reader.invoke(f.request,f.context),{code:'dispatch_unavailable'});assert.equal(f.records.size,0);assert.equal(f.state.sent.length,0);
 await f.create().invoke(f.request,f.context);const sent=f.state.sent.length;assert.equal((await reader.getInvocation(f.query(),f.context)).outcome.status,'succeeded');assert.equal(f.state.sent.length,sent);
 await assert.rejects(reader.invoke(f.request,f.context),{code:'dispatch_unavailable'});assert.equal(f.state.sent.length,sent);
});
