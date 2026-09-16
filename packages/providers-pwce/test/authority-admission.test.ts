import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {PwceAuthorityAdmission} from '../src/authority-admission.ts';
import {PwceAuthorityPreview,pwceLightOperation,pwceGovernedDisposition} from '../src/authority-preview.ts';
import {EXPECTED_PWCE_CAPABILITY_BUNDLE} from '../src/capability-bundle.ts';
import {PwceTransportError} from '../src/transport.ts';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(previewLifetime=30000){
 const scope={assistantId:randomUUID(),endpointId:randomUUID(),sessionId:randomUUID(),environmentId:randomUUID(),conversationId:randomUUID(),interactionTraceId:null,authorityContextRef:{providerRef:'pwce.synthetic',contextId:randomUUID(),revision:1}};
 const binding={authorityContextRef:randomUUID(),principalRef:'agent.synthetic',siteRefs:['home.one'],worldRef:'world.personal.v1',executionEnvironmentRef:'test',identity:{assistantRef:'assistant.synthetic',endpointRef:'endpoint.synthetic',participantRefs:['participant.synthetic'],audienceRef:'audience.synthetic'}};
 const prepared={input:{siteRef:'home.one',targetEntityId:'light.synthetic',parameters:{level:0.5}},approval:{required:false,reference:null}};
 const body={snapshotRef:randomUUID(),principalRef:binding.principalRef,siteRefs:binding.siteRefs,sourceRevision:1,invalidationSequence:1,issuedAt:new Date(Date.now()-100).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),capabilities:[{...EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0],available:true,authorization:'grant_required'}],availability:'configured',limitations:[]};
 const record={scope,binding,snapshot:{snapshotId:randomUUID(),revision:1,issuedAt:body.issuedAt,expiresAt:body.expiresAt,capabilities:[{capabilityId:'pwce.home.light.set-level'}]},executionMode:'normal',producerSnapshotRef:body.snapshotRef,producerRevision:1,producerDigest:hash(body)};
 const state={recoveryKnown:false,recoveryProof:null,recoveryCalls:[],recoveryMutate:()=>{},current:true,bound:true,approved:true,reserveFail:false,completeFail:false,sent:[],records:new Map(),hook:async()=>{},mutate:()=>{}};
 const catalog={assertReadScope:()=>{if(!state.current||!state.bound)throw new PwceTransportError('scope_changed','synthetic');},retained:()=>state.bound?structuredClone(record):undefined,revalidate:async()=>{await state.hook('catalog');if(!state.bound)throw new PwceTransportError('snapshot_unavailable','synthetic');return structuredClone(record);}};
 const client={recoverAdmission:async(_ref,wire)=>{state.recoveryCalls.push(structuredClone(wire));await state.hook('recovery');const raw={profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',recoveryProfileId:'pwce-admission-recovery.v1',recoveryProfileVersion:'1.0.0',requestId:wire.requestId,correlationId:wire.correlationId,worldRef:wire.worldRef,executionEnvironmentRef:wire.executionEnvironmentRef,...(state.recoveryKnown?{status:'known',reason:null,actionRef:state.recoveryProof.actionRef,admissionEvidence:structuredClone(state.recoveryProof)}:{status:'unknown',reason:'admission_not_found',actionRef:null,admissionEvidence:null})};state.recoveryMutate(raw);return raw;},request:async request=>({profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,outcome:'allowed',capabilityRef:'home.light.set_level',effectClass:'reversible',rationaleCodes:['explicit_grant_active'],requirements:[],limitations:[]}),admissionContracts:async()=>{await state.hook('contracts');}};
 const preview=new PwceAuthorityPreview({providerRef:'pwce.synthetic',client,catalog,resolve:async()=>prepared,isCurrent:(_request,value)=>state.current&&canonicalJson(value)===canonicalJson(prepared)});
 const previewRequest={schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:randomUUID(),correlationId:randomUUID(),cancellationId:randomUUID(),deadlineAt:new Date(Date.now()+previewLifetime).toISOString(),executionMode:'normal',scope,idempotencyKey:null,payload:{grantId:null,invocationId:randomUUID(),inputDigest:hash(prepared.input),snapshotId:record.snapshot.snapshotId,snapshotRevision:1,scope:pwceLightOperation(prepared.input,binding.worldRef)}};
 const context={signal:new AbortController().signal,isCurrent:()=>state.current},decision=(await preview.evaluate(previewRequest,context)).outcome.payload;
 const request={...previewRequest,operation:'AuthorityProvider.authorizeDispatch',requestId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString(),idempotencyKey:randomUUID(),payload:{...previewRequest.payload,expectedGrantRevision:1,requiredProviderDisposition:pwceGovernedDisposition(decision)}};
 const custody={read:key=>structuredClone(state.records.get(key)),reserve:intent=>{if(state.reserveFail)throw new Error('synthetic write failure');if(state.records.has(intent.request.idempotencyKey))return false;state.records.set(intent.request.idempotencyKey,{intent:structuredClone(intent),outcome:null});return true;},complete:(key,outcome)=>{if(state.completeFail)throw new Error('synthetic write failure');const saved=state.records.get(key);saved.outcome=structuredClone(outcome);return structuredClone(saved);}};
 const dispatcher={authorizeDispatch:async(_context,wire,_signal,isCurrent)=>{
  await state.hook('transport');isCurrent?.();
  assert.ok(state.records.get(request.idempotencyKey),'original intent must be committed before admission I/O');state.sent.push(structuredClone(wire));await state.hook('dispatch');
  const fingerprint={principalRef:binding.principalRef,capabilityRef:'home.light.set_level',capabilityVersion:'1.0.0',operation:'light.set_level',...prepared.input,executionEnvironmentRef:binding.executionEnvironmentRef,gatewayScope:{worldRef:binding.worldRef,...binding.identity}};
  const snapshotJson=JSON.stringify({scope:[binding.authorityContextRef,binding.principalRef,1,1,binding.siteRefs,binding.identity.assistantRef,binding.identity.endpointRef,binding.identity.participantRefs,binding.identity.audienceRef,binding.worldRef,binding.executionEnvironmentRef],sourceDigest:'a'.repeat(64),snapshot:{profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',...body}});
  const proof={schemaVersion:'1.0.0',kind:'pwce.action.admission',actionRef:randomUUID(),idempotencyKey:wire.idempotencyKey,requestFingerprint:canonicalJson(fingerprint),...fingerprint,grantRevision:1,targetIdentity:'synthetic:light.one',deadlineAt:wire.deadline,approvalRequired:prepared.approval.required,approvalRef:prepared.approval.reference,capabilitySnapshot:{snapshotRef:body.snapshotRef,sha256:bytesHash(snapshotJson),expiresAt:body.expiresAt,snapshotJson},precondition:null,admittedAt:new Date().toISOString(),decision:{outcome:'allowed',rationaleCodes:['explicit_grant_active']}};
  state.recoveryProof=structuredClone(proof);
  const raw={dispatchProfileId:'pwce-trusted-dispatch.v1',dispatchProfileVersion:'1.0.0',profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:wire.requestId,correlationId:wire.correlationId,worldRef:wire.worldRef,executionEnvironmentRef:wire.executionEnvironmentRef,status:'admitted',actionRef:proof.actionRef,admissionEvidence:proof};state.mutate(raw);return raw;
 }};
 const create=(dispatchEnabled=true)=>new PwceAuthorityAdmission({providerRef:'pwce.synthetic',client,...(dispatchEnabled?{dispatcher}:{}),catalog,preview,custody,authorize:async()=>{await state.hook('host');return state.approved;}});
 return {request,context,state,record,prepared,custody,create,catalog};
}

test('final admission retains original proof, returns canonical evidence and reuses the immutable result without I/O',async()=>{
 const f=await fixture(),result=await f.create().authorizeDispatch(f.request,f.context),decision=result.outcome.payload;
 assert.equal(decision.kind,'dispatch');assert.equal(decision.disposition,'authorized');assert.ok(decision.admittedAt);assert.equal(f.state.sent.length,1);
 const bytes=await f.create().readEvidence(decision.evidenceRef,f.request,f.context);assert.equal(bytesHash(bytes),decision.evidenceRef.sha256);assert.equal(bytes.length,decision.evidenceRef.byteLength);
 const proof=JSON.parse(new TextDecoder().decode(bytes));assert.equal(proof.admittedAt,decision.admittedAt);assert.notEqual(proof.idempotencyKey,f.request.idempotencyKey);
 const retry={...f.request,requestId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString()};const repeated=await f.create().authorizeDispatch(retry,f.context);assert.deepEqual(repeated.outcome.payload,decision);assert.equal(f.state.sent.length,1);assert.equal(repeated.requestId,retry.requestId);
});

test('altered original payload, grant revision, preview or mode cannot become admission',async()=>{
 for(const change of [r=>r.payload.inputDigest='0'.repeat(64),r=>r.payload.expectedGrantRevision=2,r=>r.payload.requiredProviderDisposition.decisionId=randomUUID(),r=>r.executionMode='replay',r=>r.payload.scope.targetRefs=['other.target']]){
  const f=await fixture();change(f.request);await assert.rejects(f.create().authorizeDispatch(f.request,f.context));assert.equal(f.state.sent.length,0);assert.equal(f.state.records.size,0);
 }
});

test('producer proof must bind exact input, approval, grant, foreign scope, snapshot and original deadline',async()=>{
 for(const mutate of [p=>p.parameters.level=0.6,p=>p.gatewayScope.audienceRef='another.audience',p=>p.grantRevision=2,p=>p.approvalRequired=true,p=>p.requestFingerprint='{}',p=>p.idempotencyKey='another',p=>p.capabilitySnapshot.snapshotRef=randomUUID(),p=>p.capabilitySnapshot.snapshotJson+=' ',p=>p.deadlineAt=new Date(Date.now()+60000).toISOString(),p=>p.admittedAt=new Date(Date.now()+10000).toISOString()]){
  const f=await fixture();f.state.mutate=raw=>mutate(raw.admissionEvidence);await assert.rejects(f.create().authorizeDispatch(f.request,f.context));assert.equal(f.state.sent.length,1);assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);
 }
});

test('rehashed malformed snapshot and precondition documents still fail their published schemas and bindings',async()=>{
 for(const mutate of [p=>{const s=JSON.parse(p.capabilitySnapshot.snapshotJson);s.scope[3]=2;p.capabilitySnapshot.snapshotJson=JSON.stringify(s);p.capabilitySnapshot.sha256=bytesHash(p.capabilitySnapshot.snapshotJson);},p=>{const text=JSON.stringify({schemaVersion:'1.0.0',phase:'admission',targetIdentity:p.targetIdentity,requestFingerprint:p.requestFingerprint,checkedAt:p.admittedAt,result:{allowed:false,reasonCode:'synthetic',observed:null}});p.precondition={checkJson:text,sha256:bytesHash(text)};}]){
  const f=await fixture();f.state.mutate=raw=>mutate(raw.admissionEvidence);await assert.rejects(f.create().authorizeDispatch(f.request,f.context));assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);
 }
});

test('lost admission reply and failed completion remain uncertain on a new adapter without resend',async()=>{
 for(const phase of ['dispatch','complete']){
  const f=await fixture();if(phase==='dispatch')f.state.hook=async current=>{if(current==='dispatch')throw new Error('lost reply');};else f.state.completeFail=true;
  await assert.rejects(f.create().authorizeDispatch(f.request,f.context));assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);
  await assert.rejects(f.create().authorizeDispatch({...f.request,requestId:randomUUID()},f.context),{code:'admission_outcome_unknown'});assert.equal(f.state.sent.length,1);
 }
});

test('failed reservation and host refusal cause zero producer admissions',async()=>{
 for(const kind of ['reserve','host']){const f=await fixture();if(kind==='reserve')f.state.reserveFail=true;else f.state.approved=false;await assert.rejects(f.create().authorizeDispatch(f.request,f.context));assert.equal(f.state.sent.length,0);assert.equal(f.state.records.size,0);}
});

test('scope withdrawal at every await cannot release authorized evidence',async()=>{
 for(const phase of ['catalog','host','contracts','dispatch']){const f=await fixture();f.state.hook=async current=>{if(current===phase)f.state.current=false;};await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'scope_changed'});assert.equal(f.custody.read(f.request.idempotencyKey)?.outcome??null,null);}
});

test('completed duplicate rechecks host authority, original current snapshot and retained bytes',async()=>{
 const f=await fixture();await f.create().authorizeDispatch(f.request,f.context);
 f.state.approved=false;await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'host_admission_required'});f.state.approved=true;
 f.state.bound=false;await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'snapshot_unavailable'});f.state.bound=true;
 f.state.records.get(f.request.idempotencyKey).outcome.evidenceJson='{}';await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'admission_custody_failed'});assert.equal(f.state.sent.length,1);
});

test('concurrent requests reserve once before contacting PWCE',async()=>{
 const f=await fixture();let release;const wait=new Promise(resolve=>{release=resolve;});f.state.hook=async phase=>{if(phase==='dispatch')await wait;};
 const first=f.create().authorizeDispatch(f.request,f.context);await new Promise(resolve=>setTimeout(resolve,20));const second=f.create().authorizeDispatch(f.request,f.context);release();
 const results=await Promise.allSettled([first,second]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.state.sent.length,1);
});

test('cancelled or deadline-ignoring host work never reaches admission I/O',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.create().authorizeDispatch(f.request,{...f.context,signal:controller.signal}),{code:'cancelled'});
 f.state.hook=async()=>new Promise(()=>{});await assert.rejects(f.create().authorizeDispatch({...f.request,deadlineAt:new Date(Date.now()+40).toISOString()},f.context),{code:'deadline_exceeded'});assert.equal(f.state.sent.length,0);
});

test('final denial and approval-required replies remain distinct durable observations without an admitted time',async()=>{
 for(const status of ['denied','approval_required']){
  const f=await fixture();f.state.mutate=raw=>{delete raw.admissionEvidence;delete raw.actionRef;raw.status=status;raw.outcome=status;raw.rationaleCodes=['synthetic_policy'];};
  const result=await f.create().authorizeDispatch(f.request,f.context),decision=result.outcome.payload;assert.equal(decision.disposition,status==='denied'?'denied':'approvalRequired');assert.equal(decision.admittedAt,null);
  const proof=JSON.parse(new TextDecoder().decode(await f.create().readEvidence(decision.evidenceRef,f.request,f.context)));assert.equal(proof.status,status);assert.deepEqual((await f.create().authorizeDispatch(f.request,f.context)).outcome.payload,decision);assert.equal(f.state.sent.length,1);
 }
 const f=await fixture();f.state.mutate=raw=>{delete raw.admissionEvidence;delete raw.actionRef;raw.status='denied';raw.outcome='approval_required';raw.rationaleCodes=['synthetic'];};await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'invalid_admission_evidence'});
});

test('valid precondition custody preserves original JSON bytes and validates its actual target and fingerprint',async()=>{
 const f=await fixture();f.state.mutate=raw=>{const p=raw.admissionEvidence,checkJson=JSON.stringify({schemaVersion:'1.0.0',phase:'admission',targetIdentity:p.targetIdentity,requestFingerprint:p.requestFingerprint,checkedAt:p.admittedAt,result:{allowed:true,reasonCode:'synthetic_ok',observed:{level:0.5}}},null,2);p.precondition={checkJson,sha256:bytesHash(checkJson)};};
 const result=await f.create().authorizeDispatch(f.request,f.context),bytes=await f.create().readEvidence(result.outcome.payload.evidenceRef,f.request,f.context),proof=JSON.parse(new TextDecoder().decode(bytes));assert.ok(proof.precondition.checkJson.includes('\n'));assert.equal(bytesHash(proof.precondition.checkJson),proof.precondition.sha256);
});

test('a completed key cannot change invocation, scope, input or evidence metadata',async()=>{
 const f=await fixture(),result=await f.create().authorizeDispatch(f.request,f.context),reference=result.outcome.payload.evidenceRef;
 for(const change of [r=>r.payload.invocationId=randomUUID(),r=>r.scope.sessionId=randomUUID(),r=>r.payload.inputDigest='0'.repeat(64),r=>r.correlationId=randomUUID()]){const other=structuredClone(f.request);change(other);await assert.rejects(f.create().authorizeDispatch(other,f.context),{code:'admission_conflict'});await assert.rejects(f.create().readEvidence(reference,other,f.context),{code:'admission_conflict'});}
 await assert.rejects(f.create().readEvidence({...reference,sha256:'0'.repeat(64)},f.request,f.context),{code:'admission_evidence_unavailable'});assert.equal(f.state.sent.length,1);
});

async function pendingRecovery(){
 const f=await fixture();f.state.mutate=()=>{throw new Error('synthetic discarded reply');};await assert.rejects(f.create().authorizeDispatch(f.request,f.context));f.state.recoveryKnown=true;return f;
}
const recoveryRequest=f=>({...structuredClone(f.request),requestId:randomUUID(),deadlineAt:new Date(Date.now()+30000).toISOString()});

test('pending admission recovers its original proof through status only and keeps host dispatch guards',async()=>{
 const f=await pendingRecovery();f.state.approved=false;
 const original=await f.create().recoverAdmission(recoveryRequest(f),f.context);assert.equal(original.outcome.evidenceJson,canonicalJson(f.state.recoveryProof));assert.equal(original.outcome.decision.admittedAt,f.state.recoveryProof.admittedAt);assert.equal(original.outcome.decision.evaluatedAt,f.state.recoveryProof.admittedAt);
 await assert.rejects(f.create().authorizeDispatch(recoveryRequest(f),f.context),{code:'host_admission_required'});f.state.approved=true;
 const result=await f.create().authorizeDispatch(recoveryRequest(f),f.context);assert.deepEqual(result.outcome.payload,original.outcome.decision);assert.equal(f.state.sent.length,1);assert.equal(f.state.recoveryCalls.length,1);
});

test('ordinary retry of incomplete admission uses the new lookup and never repeats admission',async()=>{
 const f=await pendingRecovery(),result=await f.create().authorizeDispatch(recoveryRequest(f),f.context);assert.equal(result.outcome.payload.disposition,'authorized');assert.equal(f.state.sent.length,1);assert.equal(f.state.recoveryCalls.length,1);assert.equal(f.state.recoveryCalls[0].idempotencyKey,f.custody.read(f.request.idempotencyKey).intent.producerKey);
});

test('unknown recovery remains pending and a later read can discover the original admission',async()=>{
 const f=await pendingRecovery();f.state.recoveryKnown=false;
 for(let i=0;i<2;i++){await assert.rejects(f.create().authorizeDispatch(recoveryRequest(f),f.context),{code:'admission_outcome_unknown'});assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);}
 f.state.recoveryKnown=true;assert.ok((await f.create().recoverAdmission(recoveryRequest(f),f.context)).outcome);assert.equal(f.state.sent.length,1);
});

test('expired admission is retained historically but never becomes a fresh dispatch decision',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await pendingRecovery(),originalDeadline=f.state.recoveryProof.deadlineAt;t.mock.timers.tick(31000);
 f.catalog.revalidate=async()=>{throw new Error('expired process-local catalog must not be needed for historical lookup');};
 const result=await f.create().recoverAdmission(recoveryRequest(f),f.context);assert.ok(Date.parse(result.outcome.decision.expiresAt)<Date.now());assert.ok(Date.parse(result.outcome.decision.expiresAt)<=Date.parse(originalDeadline));assert.equal(JSON.parse(result.outcome.evidenceJson).deadlineAt,originalDeadline);
 await assert.rejects(f.create().authorizeDispatch(recoveryRequest(f),f.context),{code:'admission_expired'});assert.equal(f.state.sent.length,1);
});

test('recovery rejects substituted proof and mismatched response envelopes without completing custody',async()=>{
 for(const mutate of [r=>r.actionRef=randomUUID(),r=>r.requestId=randomUUID(),r=>r.admissionEvidence.idempotencyKey='changed',r=>r.admissionEvidence.capabilitySnapshot.sha256='0'.repeat(64),r=>r.admissionEvidence.approvalRequired=true,r=>r.extra='forged']){const f=await pendingRecovery();f.state.recoveryMutate=mutate;await assert.rejects(f.create().recoverAdmission(recoveryRequest(f),f.context));assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);assert.equal(f.state.sent.length,1);}
});

test('local foreign scope and withdrawn current scope release no recovered evidence',async()=>{
 const f=await pendingRecovery(),foreign=recoveryRequest(f);foreign.scope.sessionId=randomUUID();await assert.rejects(f.create().recoverAdmission(foreign,f.context),{code:'admission_conflict'});assert.equal(f.state.recoveryCalls.length,0);
 f.state.hook=async phase=>{if(phase==='recovery')f.state.current=false;};await assert.rejects(f.create().recoverAdmission(recoveryRequest(f),f.context),{code:'scope_changed'});assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);
});

test('failed recovery persistence stays incomplete and can be read again without resend',async()=>{
 const f=await pendingRecovery();f.state.completeFail=true;await assert.rejects(f.create().recoverAdmission(recoveryRequest(f),f.context));assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);
 f.state.completeFail=false;assert.ok((await f.create().recoverAdmission(recoveryRequest(f),f.context)).outcome);assert.equal(f.state.sent.length,1);
});

test('concurrent recovery preserves one deterministic original decision',async()=>{
 const f=await pendingRecovery(),results=await Promise.all([f.create().recoverAdmission(recoveryRequest(f),f.context),f.create().recoverAdmission(recoveryRequest(f),f.context)]);assert.deepEqual(results[0],results[1]);assert.equal(f.state.sent.length,1);assert.deepEqual(f.custody.read(f.request.idempotencyKey),results[0]);
});

test('later missing producer proof cannot fall back to locally retained successful recovery',async()=>{
 const f=await pendingRecovery(),known=await f.create().recoverAdmission(recoveryRequest(f),f.context);f.state.recoveryKnown=false;await assert.rejects(f.create().recoverAdmission(recoveryRequest(f),f.context),{code:'admission_outcome_unknown'});assert.deepEqual(f.custody.read(f.request.idempotencyKey),known);assert.equal(f.state.sent.length,1);
});


test('catalog withdrawal during host approval or negotiation prevents any admission reservation or send',async()=>{
 for(const phase of ['host','contracts']){
  const f=await fixture();f.state.hook=async current=>{if(current===phase)f.state.bound=false;};
  await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'snapshot_unavailable'});
  assert.equal(f.state.sent.length,0);assert.equal(f.state.records.size,0);
 }
});

test('changed retained preparation after approval is caught before reservation',async()=>{
 const f=await fixture();f.state.hook=async phase=>{if(phase==='contracts')f.prepared.approval.required=true;};
 // The host retained input changes independently of the already copied preview.
 await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'scope_changed'});
 assert.equal(f.state.sent.length,0);assert.equal(f.state.records.size,0);
});

test('preview expiry during negotiation prevents admission even with a longer request deadline',async t=>{
 const f=await fixture(5000),now=Date.now();let elapsed=0;t.mock.method(Date,'now',()=>now+elapsed);
 f.state.hook=async phase=>{if(phase==='contracts')elapsed=6000;};
 await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'preview_expired'});
 assert.equal(f.state.sent.length,0);assert.equal(f.state.records.size,0);
});

test('a completed admission that expires during duplicate validation is not returned as current permission',async t=>{
 const f=await fixture(5000);await f.create().authorizeDispatch(f.request,f.context);
 const now=Date.now();let elapsed=0;t.mock.method(Date,'now',()=>now+elapsed);
 f.state.hook=async phase=>{if(phase==='catalog')elapsed=6000;};
 await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'admission_expired'});
 assert.equal(f.state.sent.length,1);assert.ok(f.custody.read(f.request.idempotencyKey).outcome);
});


test('admission transport fence catches invalidation after reservation and preserves the original intent',async()=>{
 const f=await fixture();f.state.hook=async phase=>{if(phase==='transport')f.state.bound=false;};
 await assert.rejects(f.create().authorizeDispatch(f.request,f.context),{code:'snapshot_unavailable'});
 assert.equal(f.state.sent.length,0);assert.equal(f.state.records.size,1);assert.equal(f.custody.read(f.request.idempotencyKey).outcome,null);
});


test('read-only admission composition can recover custody but cannot authorize a send',async()=>{
 const f=await pendingRecovery(),reader=f.create(false),before=f.state.sent.length;
 const recovered=await reader.recoverAdmission(recoveryRequest(f),f.context);assert.ok(recovered.outcome);assert.equal(f.state.sent.length,before);
 await assert.rejects(reader.authorizeDispatch(f.request,f.context),{code:'dispatch_unavailable'});assert.equal(f.state.sent.length,before);
});
