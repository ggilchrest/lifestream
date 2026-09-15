import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type {ProviderCallContext} from '@lifestream/runtime/ports/provider-messages';
import {boundedJson,canonicalJson,validateCapabilitySchema} from '@lifestream/runtime/capabilities/schema-validation';
import {PwceGatewayClient} from './client.ts';
import {PwceTrustedDispatchClient} from './dispatch.ts';
import {PwceCapabilityCatalog,type PwceCatalogRecord} from './capability-catalog.ts';
import {PwceAuthorityPreview,pwceLightOperation,type PwcePreparedAction} from './authority-preview.ts';
import {EXPECTED_PWCE_ADMISSION_BUNDLE as bundle,PWCE_ADMISSION_SCHEMA as proofSchema} from './admission-bundle.ts';
import {PWCE_DISPATCH_RESPONSE_SCHEMA} from './dispatch-bundle.ts';
import {EXPECTED_PWCE_CAPABILITY_BUNDLE} from './capability-bundle.ts';
import {PwceCallScope,PwceTransportError} from './transport.ts';

type Decision=M.providerMessages_DefsExternalAuthorityDecision & {kind:'dispatch'};
export type PwceAdmissionIntent={request:M.AuthorityDispatchRequest;prepared:PwcePreparedAction;catalog:PwceCatalogRecord;producerKey:string;intentDigest:string};
export type PwceAdmissionOutcome={decision:Decision;evidenceJson:string};
export type PwceAdmissionRecord={intent:PwceAdmissionIntent;outcome:PwceAdmissionOutcome|null};
/** Synchronous durable transactions; reserve must commit before network I/O. */
export interface PwceAdmissionCustody {
  read(key:string):PwceAdmissionRecord|undefined;
  reserve(intent:PwceAdmissionIntent):boolean;
  complete(key:string,outcome:PwceAdmissionOutcome):PwceAdmissionRecord;
}
export type PwceAuthorityAdmissionOptions={
  providerRef:string;client:PwceGatewayClient;dispatcher:PwceTrustedDispatchClient;catalog:PwceCapabilityCatalog;preview:PwceAuthorityPreview;custody:PwceAdmissionCustody;
  /** Trusted host admission gate; never obtained from browser/model JSON. */
  authorize(request:M.AuthorityDispatchRequest,prepared:PwcePreparedAction,context:ProviderCallContext):Promise<boolean>;
};
type Proof={actionRef:string;idempotencyKey:string;requestFingerprint:string;principalRef:string;capabilityRef:string;capabilityVersion:string;operation:string;siteRef:string;targetEntityId:string;parameters:{level:number};executionEnvironmentRef:string;gatewayScope:Record<string,unknown>;grantRevision:number;targetIdentity:string;deadlineAt:string;approvalRequired:boolean;approvalRef:string|null;capabilitySnapshot:{snapshotRef:string;sha256:string;expiresAt:string;snapshotJson:string};precondition:{sha256:string;checkJson:string}|null;admittedAt:string;decision:{outcome:'allowed';rationaleCodes:string[]}};
const validator=createContractValidator(),base='https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/',descriptor=EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0];
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const byteHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const uuid=(value:unknown)=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const fail=(code:string):never=>{throw new PwceTransportError(code,`PWCE final admission ${code}`);};
const requestDigest=(request:M.AuthorityDispatchRequest)=>hash({providerRef:request.scope.authorityContextRef?.providerRef,scope:request.scope,executionMode:request.executionMode,correlationId:request.correlationId,idempotencyKey:request.idempotencyKey,payload:request.payload});
const definitionSchema=(name:string)=>({$schema:proofSchema.$schema,$id:proofSchema.$id,$defs:proofSchema.$defs,$ref:`#/$defs/${name}`});
async function schema(value:unknown,definition:unknown,call:PwceCallScope):Promise<void>{if(!await call.wait(validateCapabilitySchema(definition,value,call.signal)))fail('invalid_admission_evidence');}
function decode(text:string,sha256:string,maxBytes:number):Record<string,unknown>{
  if(Buffer.byteLength(text)>maxBytes||byteHash(text)!==sha256)return fail('invalid_admission_evidence');
  try{return JSON.parse(text) as Record<string,unknown>;}catch{return fail('invalid_admission_evidence');}
}
async function verifyProof(value:unknown,intent:PwceAdmissionIntent,call:PwceCallScope):Promise<Proof>{
  await schema(value,proofSchema,call);const proof=value as Proof,binding=intent.catalog.binding;
  const fingerprint={principalRef:binding.principalRef,capabilityRef:descriptor.capabilityRef,capabilityVersion:descriptor.schemaVersion,operation:descriptor.operation,...intent.prepared.input,executionEnvironmentRef:binding.executionEnvironmentRef,gatewayScope:{worldRef:binding.worldRef,...binding.identity}};
  for(const [field,expected]of Object.entries(fingerprint))if(!isDeepStrictEqual(proof[field as keyof Proof],expected))return fail('admission_binding_mismatch');
  if(proof.idempotencyKey!==intent.producerKey||proof.requestFingerprint!==canonicalJson(fingerprint)||proof.grantRevision!==intent.catalog.producerRevision||proof.grantRevision!==intent.request.payload.expectedGrantRevision||proof.approvalRequired!==intent.prepared.approval.required||proof.approvalRef!==intent.prepared.approval.reference)return fail('admission_binding_mismatch');
  const snapshot=decode(proof.capabilitySnapshot.snapshotJson,proof.capabilitySnapshot.sha256,32768);
  await schema(snapshot,definitionSchema('RetainedSnapshotDocument'),call);
  const source=snapshot.snapshot as Record<string,unknown>,scope=snapshot.scope as unknown[],{profileId:_p,profileVersion:_v,...body}=source;
  if(proof.capabilitySnapshot.snapshotRef!==intent.catalog.producerSnapshotRef||proof.capabilitySnapshot.expiresAt!==intent.catalog.snapshot.expiresAt||hash(body)!==intent.catalog.producerDigest||scope[0]!==binding.authorityContextRef||scope[1]!==binding.principalRef||scope[3]!==intent.catalog.producerRevision||!isDeepStrictEqual(scope[4],binding.siteRefs)||!isDeepStrictEqual(scope.slice(5),[binding.identity.assistantRef,binding.identity.endpointRef,binding.identity.participantRefs,binding.identity.audienceRef,binding.worldRef,binding.executionEnvironmentRef]))return fail('admission_binding_mismatch');
  if(Date.parse(proof.admittedAt)>Date.now()||Date.parse(proof.admittedAt)<Date.parse(intent.catalog.snapshot.issuedAt)||Date.parse(proof.deadlineAt)<=Date.parse(proof.admittedAt)||Date.parse(proof.deadlineAt)-Date.parse(proof.admittedAt)>30000||Date.parse(proof.deadlineAt)>Date.parse(intent.request.deadlineAt)||Date.parse(proof.deadlineAt)>Date.parse(intent.catalog.snapshot.expiresAt)||binding.executionEnvironmentRef==='live'&&(!proof.approvalRequired||proof.precondition===null))return fail('invalid_admission_evidence');
  if(proof.precondition){const check=decode(proof.precondition.checkJson,proof.precondition.sha256,16384);await schema(check,definitionSchema('AdmissionPrecondition'),call);if(check.requestFingerprint!==proof.requestFingerprint||check.targetIdentity!==proof.targetIdentity||Date.parse(check.checkedAt as string)>Date.parse(proof.admittedAt))return fail('admission_binding_mismatch');}
  return structuredClone(proof);
}

/** Final admission only. No invocation method or dispatcher retry is exposed. */
export class PwceAuthorityAdmission {
  private readonly options:PwceAuthorityAdmissionOptions;
  constructor(options:PwceAuthorityAdmissionOptions){if(!options.providerRef||options.providerRef.length>500||typeof options.authorize!=='function')fail('invalid_configuration');this.options={...options};}
  private call(request:M.AuthorityDispatchRequest,context:ProviderCallContext):PwceCallScope{const duration=Date.parse(request.deadlineAt)-Date.now();if(!Number.isFinite(duration)||duration<=0)return fail('deadline_exceeded');if(duration>30000)return fail('invalid_request');return new PwceCallScope(duration,context.signal);}
  private current(request:M.AuthorityDispatchRequest,context:ProviderCallContext,call:PwceCallScope):void{call.check();if(!context.isCurrent(structuredClone(request.scope))||request.scope.authorityContextRef?.providerRef!==this.options.providerRef||request.payload.grantId!==null)fail('scope_changed');}
  private stored(request:M.AuthorityDispatchRequest):PwceAdmissionRecord|undefined {
    const record=this.options.custody.read(request.idempotencyKey);if(!record)return undefined;
    if(!boundedJson(record,262144)||!validator.validate(base+'AuthorityDispatchRequest',record.intent.request).valid||record.intent.intentDigest!==requestDigest(record.intent.request)||record.intent.intentDigest!==requestDigest(request))return fail('admission_conflict');
    const intent=record.intent,original=intent.request;
    if(hash(intent.prepared.input)!==original.payload.inputDigest||!isDeepStrictEqual(intent.catalog.scope,original.scope)||intent.catalog.snapshot.snapshotId!==original.payload.snapshotId||intent.catalog.snapshot.revision!==original.payload.snapshotRevision||intent.producerKey!==`lifestream:${hash({providerRef:this.options.providerRef,scope:original.scope,invocationId:original.payload.invocationId,idempotencyKey:original.idempotencyKey})}`||!isDeepStrictEqual(pwceLightOperation(intent.prepared.input,intent.catalog.binding.worldRef),original.payload.scope))return fail('admission_custody_failed');
    return structuredClone(record);
  }
  private result(request:M.AuthorityDispatchRequest,outcome:PwceAdmissionOutcome):M.AuthorityDispatchResult{
    return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:this.options.providerRef,completedAt:new Date().toISOString(),outcome:{status:'succeeded',payload:structuredClone(outcome.decision),error:null}};
  }
  async authorizeDispatch(input:M.AuthorityDispatchRequest,context:ProviderCallContext):Promise<M.AuthorityDispatchResult>{
    if(!boundedJson(input)||!validator.validate(base+'AuthorityDispatchRequest',input).valid)return fail('invalid_request');
    const request=structuredClone(input),call=this.call(request,context);
    try{
      this.current(request,context,call);
      const existing=this.stored(request);
      if(existing){if(!existing.outcome)return fail('admission_outcome_unknown');if(!await call.wait(this.options.authorize(structuredClone(request),structuredClone(existing.intent.prepared),{...context,signal:call.signal})))return fail('host_admission_required');this.current(request,context,call);await this.checkOutcome(existing,request,context,call,true);return this.result(request,existing.outcome);}
      const prepared=await call.wait(this.options.preview.resolveDispatch(request,{...context,signal:call.signal}));this.current(request,context,call);
      const catalog=await call.wait(this.options.catalog.revalidate(request,{...context,signal:call.signal}));this.current(request,context,call);
      if(catalog.producerRevision!==request.payload.expectedGrantRevision||catalog.executionMode!=='normal'||hash(prepared.input)!==request.payload.inputDigest||!isDeepStrictEqual(pwceLightOperation(prepared.input,catalog.binding.worldRef),request.payload.scope))return fail('admission_binding_mismatch');
      if(!await call.wait(this.options.authorize(structuredClone(request),structuredClone(prepared),{...context,signal:call.signal})))return fail('host_admission_required');this.current(request,context,call);
      await call.wait(this.options.client.admissionContracts(call.signal));this.current(request,context,call);
      const producerKey=`lifestream:${hash({providerRef:this.options.providerRef,scope:request.scope,invocationId:request.payload.invocationId,idempotencyKey:request.idempotencyKey})}`;
      const intent:PwceAdmissionIntent={request,prepared,catalog,producerKey,intentDigest:requestDigest(request)};
      if(!this.options.custody.reserve(structuredClone(intent)))return fail('admission_outcome_unknown');
      this.current(request,context,call);
      const binding=catalog.binding,wire={...binding.identity,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,requestId:request.requestId,correlationId:request.correlationId,deadline:request.deadlineAt,
        snapshotRef:catalog.producerSnapshotRef,capabilityRef:descriptor.capabilityRef,capabilityVersion:descriptor.schemaVersion,capabilityOperation:descriptor.operation,...prepared.input,idempotencyKey:producerKey,approvalRequired:prepared.approval.required,approvalRef:prepared.approval.reference};
      const raw=await call.wait(this.options.dispatcher.authorizeDispatch(binding.authorityContextRef,wire,call.signal));this.current(request,context,call);
      await schema(raw,PWCE_DISPATCH_RESPONSE_SCHEMA,call);
      for(const field of ['requestId','correlationId','worldRef','executionEnvironmentRef']as const)if(raw[field]!==wire[field])return fail('admission_binding_mismatch');
      let evidenceJson:string,schemaRef:string,admittedAt:string|null=null,expiresAt=catalog.snapshot.expiresAt,disposition:Decision['disposition'];
      if(raw.status==='admitted'){
        const proof=await verifyProof(raw.admissionEvidence,intent,call);
        if(raw.actionRef!==proof.actionRef)return fail('admission_binding_mismatch');
        evidenceJson=canonicalJson(raw.admissionEvidence);schemaRef=bundle.schemaRef;admittedAt=proof.admittedAt;expiresAt=proof.deadlineAt;disposition='authorized';
      }else{
        if(!['denied','approval_required'].includes(raw.status as string)||raw.outcome!==raw.status||raw.admissionEvidence!==undefined||raw.admission!==undefined||raw.actionRef!==undefined||!Array.isArray(raw.rationaleCodes)||!raw.rationaleCodes.length||raw.rationaleCodes.length>16||raw.rationaleCodes.some(value=>typeof value!=='string'||!/^[a-zA-Z0-9_.-]{1,128}$/.test(value)))return fail('invalid_admission_evidence');
        evidenceJson=canonicalJson(raw);schemaRef=PWCE_DISPATCH_RESPONSE_SCHEMA.$id;disposition=raw.outcome==='approval_required'?'approvalRequired':'denied';
      }
      await call.wait(this.options.catalog.revalidate(request,{...context,signal:call.signal}));this.current(request,context,call);
      const decisionId=uuid(['pwce-final-admission',request.scope,request.payload.invocationId,byteHash(evidenceJson)]);
      const decision:Decision={schemaVersion:'1.0.0',authorityKind:'external',decisionId,kind:'dispatch',providerRef:this.options.providerRef,invocationId:request.payload.invocationId,inputDigest:request.payload.inputDigest,scopeDigest:hash(request.payload.scope),authorityContextRef:request.scope.authorityContextRef!,executionMode:request.executionMode,disposition,
        reason:{code:`pwce_admission_${disposition}`,summary:`PWCE final admission returned ${disposition}; original producer evidence is retained.`},evaluatedAt:new Date().toISOString(),admittedAt,expiresAt:new Date(Math.min(Date.parse(expiresAt),Date.parse(request.payload.requiredProviderDisposition.expiresAt),Date.parse(request.deadlineAt))).toISOString(),
        evidenceRef:{reference:`pwce:admission:${decisionId}`,sha256:byteHash(evidenceJson),byteLength:Buffer.byteLength(evidenceJson),mediaType:'application/json',schemaRef},scope:request.scope,correlationId:request.correlationId,snapshotId:request.payload.snapshotId,snapshotRevision:request.payload.snapshotRevision};
      if(Date.parse(decision.expiresAt)<=Date.now())return fail('admission_expired');
      const outcome={decision,evidenceJson};if(!validator.validate(base+'AuthorityDispatchResult',this.result(request,outcome)).valid)return fail('invalid_projection');
      this.current(request,context,call);
      const saved=this.options.custody.complete(request.idempotencyKey,structuredClone(outcome));
      if(!isDeepStrictEqual(saved.intent,intent)||!isDeepStrictEqual(saved.outcome,outcome))return fail('admission_custody_failed');
      this.current(request,context,call);return this.result(request,outcome);
    }finally{call.close();}
  }
  private async checkOutcome(record:PwceAdmissionRecord,request:M.AuthorityDispatchRequest,context:ProviderCallContext,call:PwceCallScope,unexpired:boolean):Promise<void>{
    const outcome=record.outcome;if(!outcome||!validator.validate(base+'AuthorityDispatchResult',this.result(record.intent.request,outcome)).valid||byteHash(outcome.evidenceJson)!==outcome.decision.evidenceRef.sha256||Buffer.byteLength(outcome.evidenceJson)!==outcome.decision.evidenceRef.byteLength)return fail('admission_custody_failed');
    if(unexpired&&Date.parse(outcome.decision.expiresAt)<=Date.now())return fail('admission_expired');
    const decision=outcome.decision,original=record.intent.request;
    if(decision.providerRef!==this.options.providerRef||!isDeepStrictEqual(decision.scope,original.scope)||decision.inputDigest!==original.payload.inputDigest||decision.scopeDigest!==hash(original.payload.scope)||decision.invocationId!==original.payload.invocationId||decision.snapshotId!==original.payload.snapshotId||decision.snapshotRevision!==original.payload.snapshotRevision||decision.correlationId!==original.correlationId||decision.executionMode!==original.executionMode||!isDeepStrictEqual(decision.authorityContextRef,original.scope.authorityContextRef))return fail('admission_custody_failed');
    if(outcome.decision.disposition==='authorized'){
      const proof=await verifyProof(JSON.parse(outcome.evidenceJson),record.intent,call);
      if(decision.admittedAt!==proof.admittedAt||decision.evidenceRef.schemaRef!==bundle.schemaRef||Date.parse(decision.expiresAt)>Math.min(Date.parse(proof.deadlineAt),Date.parse(original.payload.requiredProviderDisposition.expiresAt),Date.parse(original.deadlineAt)))return fail('admission_custody_failed');
    }else{const raw=JSON.parse(outcome.evidenceJson);await schema(raw,PWCE_DISPATCH_RESPONSE_SCHEMA,call);if(raw.requestId!==original.requestId||raw.correlationId!==original.correlationId||raw.worldRef!==record.intent.catalog.binding.worldRef||raw.executionEnvironmentRef!==record.intent.catalog.binding.executionEnvironmentRef||raw.outcome!==(decision.disposition==='denied'?'denied':'approval_required')||raw.status!==raw.outcome||raw.admissionEvidence!==undefined||raw.admission!==undefined||raw.actionRef!==undefined||decision.admittedAt!==null||decision.evidenceRef.schemaRef!==PWCE_DISPATCH_RESPONSE_SCHEMA.$id)return fail('admission_custody_failed');}
    const currentCatalog=await call.wait(this.options.catalog.revalidate(request,{...context,signal:call.signal}));this.current(request,context,call);
    if(!isDeepStrictEqual(currentCatalog,record.intent.catalog))return fail('admission_custody_failed');
  }
  async readEvidence(reference:M.ArtifactRef,input:M.AuthorityDispatchRequest,context:ProviderCallContext):Promise<Uint8Array>{
    if(!boundedJson(input)||!validator.validate(base+'AuthorityDispatchRequest',input).valid)return fail('invalid_request');
    const request=structuredClone(input),owned=structuredClone(reference),call=this.call(request,context);
    try{this.current(request,context,call);const record=this.stored(request);if(!record?.outcome||!isDeepStrictEqual(record.outcome.decision.evidenceRef,owned))return fail('admission_evidence_unavailable');await this.checkOutcome(record,request,context,call,false);return new TextEncoder().encode(record.outcome.evidenceJson);}finally{call.close();}
  }
}
