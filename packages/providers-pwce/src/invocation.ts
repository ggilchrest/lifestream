import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type {ProviderCallContext} from '@lifestream/runtime/ports/provider-messages';
import {boundedJson,canonicalJson,validateCapabilitySchema} from '@lifestream/runtime/capabilities/schema-validation';
import {PwceGatewayClient} from './client.ts';
import {PwceTrustedDispatchClient} from './dispatch.ts';
import {PwceAuthorityAdmission} from './authority-admission.ts';
import {EXPECTED_PWCE_CAPABILITY_BUNDLE} from './capability-bundle.ts';
import {EXPECTED_PWCE_INVOCATION_BUNDLE as bundle,PWCE_INVOCATION_SCHEMA} from './invocation-bundle.ts';
import {PwceCallScope,PwceTransportError} from './transport.ts';

type Status=M.providerMessages_DefsCapabilityStatus;
type ProducerResult={status:string;externalEffectOccurred:boolean|'unknown';completedAt:string;reconciledAt?:string;[key:string]:unknown};
type Proof={actionRef:string;admissionEvidence:unknown;status:string;attemptRef:string|null;startedAt:string|null;dispatchResult:ProducerResult|null;result:ProducerResult|null;reconciliationRef:string|null};
export type PwceInvocationObservation={status:Status;terminal:boolean;proofJson:string;evidenceRef:M.ArtifactRef};
export type PwceInvocationRecord={request:M.CapabilityInvocationRequest;requestDigest:string;latest:PwceInvocationObservation|null;observationCount:number};
export interface PwceInvocationCustody {
  read(invocationId:string):PwceInvocationRecord|undefined;
  /** Commit once before initial I/O; false never grants another initial call. */
  claim(request:M.CapabilityInvocationRequest):boolean;
  observe(invocationId:string,observation:PwceInvocationObservation):PwceInvocationRecord;
  readObservation(invocationId:string,reference:M.ArtifactRef):PwceInvocationObservation|undefined;
}
export type PwceInvocationOptions={providerRef:string;client:PwceGatewayClient;dispatcher?:PwceTrustedDispatchClient;admission:PwceAuthorityAdmission;custody:PwceInvocationCustody};
const validator=createContractValidator(),base='https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/',descriptor=EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0];
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const fail=(code:string):never=>{throw new PwceTransportError(code,`PWCE invocation ${code}`);};
export const pwceInvocationDigest=(request:M.CapabilityInvocationRequest):string=>hash(canonicalJson({scope:request.scope,correlationId:request.correlationId,executionMode:request.executionMode,idempotencyKey:request.idempotencyKey,payload:request.payload}));
const terminal=(status:Status)=>['succeeded','failed','denied'].includes(status.type);
const withoutEvidence=(status:Status)=>{const {evidenceRef:_e,...rest}=status as Status&{evidenceRef?:M.ArtifactRef};return rest;};

/** Canonical invoke/status component. A duplicate invokes only the status path. */
export class PwceInvocation {
  private readonly options:PwceInvocationOptions;
  constructor(options:PwceInvocationOptions){if(!options.providerRef||options.providerRef.length>500)fail('invalid_configuration');this.options={...options};}
  private call(request:M.CapabilityInvocationRequest|M.CapabilityStatusRequest,context:ProviderCallContext):PwceCallScope {
    const left=Date.parse(request.deadlineAt)-Date.now();if(!Number.isFinite(left)||left<=0)return fail('deadline_exceeded');if(left>30000)return fail('invalid_request');return new PwceCallScope(left,context.signal);
  }
  private current(request:M.CapabilityInvocationRequest|M.CapabilityStatusRequest,context:ProviderCallContext,call:PwceCallScope):void {
    call.check();if(!context.isCurrent(structuredClone(request.scope))||request.scope.authorityContextRef?.providerRef!==this.options.providerRef||request.executionMode!=='normal')fail('scope_changed');
  }
  private stored(id:string):PwceInvocationRecord|undefined {
    const record=this.options.custody.read(id);if(!record)return undefined;
    if(!boundedJson(record,262144)||!validator.validate(base+'CapabilityInvocationRequest',record.request).valid||record.request.payload.invocationId!==id||record.requestDigest!==pwceInvocationDigest(record.request)||!Number.isSafeInteger(record.observationCount)||record.observationCount<0||record.observationCount>17)return fail('invocation_custody_failed');return structuredClone(record);
  }
  private envelope(request:M.CapabilityInvocationRequest|M.CapabilityStatusRequest,status:Status):M.CapabilityInvocationResult|M.CapabilityStatusResult {
    const result={schemaVersion:'1.0.0' as const,operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:this.options.providerRef,completedAt:new Date().toISOString(),outcome:{status:'succeeded' as const,payload:structuredClone(status),error:null}};
    if(!validator.validate(base+(request.operation==='CapabilityProvider.invoke'?'CapabilityInvocationResult':'CapabilityStatusResult'),result).valid)return fail('invalid_projection');return result;
  }
  private statusRequest(request:M.CapabilityInvocationRequest):M.CapabilityStatusRequest {return {...request,operation:'CapabilityProvider.getInvocation',payload:{invocationId:request.payload.invocationId}};}
  private original(record:PwceInvocationRecord,request:M.CapabilityStatusRequest):M.CapabilityInvocationRequest {
    if(!isDeepStrictEqual(record.request.scope,request.scope)||record.request.correlationId!==request.correlationId||record.request.executionMode!==request.executionMode||record.request.idempotencyKey!==request.idempotencyKey)return fail('invocation_unavailable');
    return {...record.request,requestId:request.requestId,deadlineAt:request.deadlineAt,cancellationId:request.cancellationId};
  }
  private async proof(value:unknown,original:Awaited<ReturnType<PwceAuthorityAdmission['resolveInvocation']>>,call:PwceCallScope):Promise<Proof> {
    if(!await call.wait(validateCapabilitySchema(PWCE_INVOCATION_SCHEMA,value,call.signal,false,131072)))return fail('invalid_invocation_evidence');
    const proof=value as Proof;
    if(proof.actionRef!==original.proof.actionRef||canonicalJson(proof.admissionEvidence)!==original.record.outcome!.evidenceJson)return fail('invocation_binding_mismatch');
    const earliest=Date.parse(proof.startedAt??original.proof.admittedAt),now=Date.now();
    if(earliest<Date.parse(original.proof.admittedAt)||earliest>now)return fail('invalid_invocation_evidence');
    for(const result of [proof.result,proof.dispatchResult])if(result&&(Buffer.byteLength(canonicalJson(result))>17000||Date.parse(result.completedAt)<earliest||Date.parse(result.completedAt)>now||result.reconciledAt!==undefined&&result.reconciledAt!==result.completedAt))return fail('invalid_invocation_evidence');
    if(proof.result&&proof.result.status!==proof.status||proof.dispatchResult?.reconciledAt!==undefined||proof.reconciliationRef===null&&proof.dispatchResult!==null&&!isDeepStrictEqual(proof.result,proof.dispatchResult))return fail('invocation_binding_mismatch');
    return structuredClone(proof);
  }
  private project(proof:Proof,request:M.CapabilityInvocationRequest,evidenceRef:M.ArtifactRef):Status {
    const invocationId=request.payload.invocationId,receiptRef=request.payload.dispatchReceipt!,reason={code:`pwce_${proof.status}`,summary:`PWCE reports ${proof.status}; original producer evidence is retained.`};
    if(proof.status==='admitted')return {type:'authorized',invocationId,decisionRef:receiptRef};
    if(proof.status==='started')return {type:'started',invocationId,receiptRef,startedAt:proof.startedAt!};
    if(proof.status==='succeeded')return {type:'succeeded',invocationId,output:proof.result as M.protocolCommon_DefsJsonValue,outputSchema:structuredClone(descriptor.resultSchemaArtifact),confirmedAt:proof.result!.completedAt,evidenceRef};
    if(proof.status==='denied')return {type:'denied',invocationId,reason};
    if(proof.status==='failed'&&proof.result!.externalEffectOccurred!=='unknown'||proof.result!.externalEffectOccurred===false)return {type:'failed',invocationId,error:{code:reason.code,message:reason.summary,retryable:false,correlationId:request.correlationId,details:[]},effectState:proof.result!.externalEffectOccurred===false?'notStarted':'confirmedFailed',evidenceRef};
    return {type:'outcomeUnknown',invocationId,reason,receiptRef,reconciliationRef:`pwce:action:${proof.actionRef}`};
  }
  private observation(proof:Proof,request:M.CapabilityInvocationRequest):PwceInvocationObservation {
    const proofJson=canonicalJson(proof),sha256=hash(proofJson),evidenceRef={reference:`pwce:invocation:${request.payload.invocationId}:${sha256}`,sha256,byteLength:Buffer.byteLength(proofJson),mediaType:'application/json',schemaRef:bundle.schemaRef};
    const status=this.project(proof,request,evidenceRef);return {status,terminal:terminal(status),proofJson,evidenceRef};
  }
  private persist(request:M.CapabilityInvocationRequest,proof:Proof):PwceInvocationObservation {
    const existing=this.stored(request.payload.invocationId);if(!existing||existing.requestDigest!==pwceInvocationDigest(request))return fail('invocation_custody_failed');
    const observation=this.observation(proof,request),prior=existing.latest;
    if(prior){
      if(hash(prior.proofJson)!==prior.evidenceRef.sha256||Buffer.byteLength(prior.proofJson)!==prior.evidenceRef.byteLength)return fail('invocation_custody_failed');
      const before=JSON.parse(prior.proofJson) as Proof;
      if(!isDeepStrictEqual(prior,this.observation(before,request)))return fail('invocation_custody_failed');
      if(before.actionRef!==proof.actionRef||before.attemptRef!==null&&before.attemptRef!==proof.attemptRef||before.startedAt!==null&&before.startedAt!==proof.startedAt||before.dispatchResult!==null&&!isDeepStrictEqual(before.dispatchResult,proof.dispatchResult)||prior.terminal&&(!observation.terminal||!isDeepStrictEqual(withoutEvidence(prior.status),withoutEvidence(observation.status))))return fail('invocation_observation_conflict');
    }
    const saved=this.options.custody.observe(request.payload.invocationId,observation);
    if(saved.requestDigest!==existing.requestDigest||!isDeepStrictEqual(saved.latest,observation))return fail('invocation_custody_failed');return observation;
  }
  async invoke(input:M.CapabilityInvocationRequest,context:ProviderCallContext):Promise<M.CapabilityInvocationResult> {
    const dispatcher=this.options.dispatcher;if(!dispatcher)return fail('dispatch_unavailable');
    if(!boundedJson(input)||!validator.validate(base+'CapabilityInvocationRequest',input).valid)return fail('invalid_request');
    const request=structuredClone(input),call=this.call(request,context);
    try{
      this.current(request,context,call);const prior=this.stored(request.payload.invocationId);
      if(prior){if(prior.requestDigest!==pwceInvocationDigest(request))return fail('invocation_conflict');const status=await call.wait(this.getInvocation(this.statusRequest(request),{...context,signal:call.signal}));this.current(request,context,call);if(status.outcome.status!=='succeeded')return fail('invocation_unavailable');return this.envelope(request,status.outcome.payload) as M.CapabilityInvocationResult;}
      const original=await call.wait(this.options.admission.resolveInvocation(request,{...context,signal:call.signal},'dispatch'));this.current(request,context,call);
      await call.wait(this.options.client.invocationContracts(call.signal));this.current(request,context,call);original.assertCurrent();
      if(!this.options.custody.claim(structuredClone(request)))return fail('invocation_outcome_unknown');
      this.current(request,context,call);original.assertCurrent();const {binding}=original.record.intent.catalog,prepared=original.record.intent.prepared;
      const wire={...binding.identity,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,requestId:request.requestId,correlationId:request.correlationId,deadline:original.proof.deadlineAt,snapshotRef:original.record.intent.catalog.producerSnapshotRef,capabilityRef:descriptor.capabilityRef,capabilityVersion:descriptor.schemaVersion,capabilityOperation:descriptor.operation,...prepared.input,idempotencyKey:original.proof.idempotencyKey,approvalRequired:prepared.approval.required,approvalRef:prepared.approval.reference,actionRef:original.proof.actionRef};
      const raw=await call.wait(dispatcher.invoke(binding.authorityContextRef,wire,call.signal,()=>{this.current(request,context,call);original.assertCurrent();return true;}));this.current(request,context,call);
      const proof=await this.proof(raw.invocationEvidence,original,call);
      if(raw.actionRef!==proof.actionRef||raw.status!==(proof.status==='succeeded'?'completed':proof.status)||proof.result!==null&&!isDeepStrictEqual(raw.result,proof.result))return fail('invocation_binding_mismatch');
      await call.wait(this.options.admission.resolveInvocation(request,{...context,signal:call.signal},'read'));this.current(request,context,call);
      const observation=this.persist(request,proof);this.current(request,context,call);return this.envelope(request,observation.status) as M.CapabilityInvocationResult;
    }finally{call.close();}
  }
  async getInvocation(input:M.CapabilityStatusRequest,context:ProviderCallContext):Promise<M.CapabilityStatusResult> {
    if(!boundedJson(input)||!validator.validate(base+'CapabilityStatusRequest',input).valid)return fail('invalid_request');
    const request=structuredClone(input),call=this.call(request,context);
    try{
      this.current(request,context,call);const stored=this.stored(request.payload.invocationId);if(!stored)return fail('invocation_unavailable');
      const originalRequest=this.original(stored,request),original=await call.wait(this.options.admission.resolveInvocation(originalRequest,{...context,signal:call.signal},'read'));this.current(request,context,call);
      await call.wait(this.options.client.invocationContracts(call.signal));this.current(request,context,call);original.assertCurrent();
      const {binding}=original.record.intent.catalog,raw=await call.wait(this.options.client.request({...binding.identity,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,authorityContextRef:binding.authorityContextRef,requestId:request.requestId,correlationId:request.correlationId,deadline:request.deadlineAt,operation:'capabilities.getInvocation',actionRef:original.proof.actionRef},call.signal));this.current(request,context,call);
      for(const [key,value] of Object.entries({profileId:'pwce-agent-gateway.v1',profileVersion:'1.0.0',requestId:request.requestId,correlationId:request.correlationId,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef}))if(raw[key]!==value)return fail('invocation_binding_mismatch');
      if(raw.status!=='known'||raw.invocationEvidenceUnavailable!==undefined)return fail('invocation_evidence_unavailable');
      const proof=await this.proof(raw.invocationEvidence,original,call),action=raw.action as Record<string,unknown>|undefined;
      if(!action||action.actionRef!==proof.actionRef||action.status!==proof.status||!isDeepStrictEqual(action.result,proof.result)||!isDeepStrictEqual(action.dispatchResult??null,proof.dispatchResult)||(action.attemptRef??null)!==proof.attemptRef||(action.startedAt??null)!==proof.startedAt)return fail('invocation_binding_mismatch');
      await call.wait(this.options.admission.resolveInvocation(originalRequest,{...context,signal:call.signal},'read'));this.current(request,context,call);
      const observation=this.persist(originalRequest,proof);this.current(request,context,call);return this.envelope(request,observation.status) as M.CapabilityStatusResult;
    }finally{call.close();}
  }
  async readEvidence(reference:M.ArtifactRef,input:M.CapabilityStatusRequest,context:ProviderCallContext):Promise<Uint8Array> {
    if(!boundedJson(input)||!validator.validate(base+'CapabilityStatusRequest',input).valid||!boundedJson(reference))return fail('invalid_request');
    const request=structuredClone(input),owned=structuredClone(reference),call=this.call(request,context);
    try{
      await call.wait(this.getInvocation(request,{...context,signal:call.signal}));this.current(request,context,call);
      const record=this.stored(request.payload.invocationId);if(!record)return fail('invocation_unavailable');
      const originalRequest=this.original(record,request),original=await call.wait(this.options.admission.resolveInvocation(originalRequest,{...context,signal:call.signal},'read'));this.current(request,context,call);
      const observation=this.options.custody.readObservation(request.payload.invocationId,owned);
      if(!observation||!boundedJson(observation,262144)||!isDeepStrictEqual(observation.evidenceRef,owned)||typeof observation.proofJson!=='string'||hash(observation.proofJson)!==owned.sha256||Buffer.byteLength(observation.proofJson)!==owned.byteLength)return fail('invocation_evidence_unavailable');
      let parsed:unknown;try{parsed=JSON.parse(observation.proofJson);}catch{return fail('invocation_evidence_unavailable');}
      const proof=await this.proof(parsed,original,call);
      if(!isDeepStrictEqual(observation,this.observation(proof,originalRequest)))return fail('invocation_evidence_unavailable');
      this.current(request,context,call);return new TextEncoder().encode(observation.proofJson);
    }finally{call.close();}
  }
}
