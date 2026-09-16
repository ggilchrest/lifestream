import type {PwceActionJournal} from './pwce-action-journal.ts';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Database} from '@lifestream/storage-sqlite';
import type {AuthorityRequest,AuthorityDispatchRequest,CapabilityInvocationRequest,ArtifactRef,providerMessages_DefsExternalAuthorityDecision} from '@lifestream/contracts/provider-messages';
import {PwceAuthorityAdmission,PwceInvocation,pwceGovernedDisposition,type PwceTrustedDispatchClient,PwceAuthorityPreview,pwceLightOperation,PWCE_LIGHT_CAPABILITY_ID,EXPECTED_PWCE_CAPABILITY_BUNDLE,type PwcePreparedAction,type PwceCatalogRecord} from '@lifestream/providers-pwce';
import {boundedJson,canonicalJson,validateCapabilitySchema} from '@lifestream/runtime/capabilities/schema-validation';
import {resolveCapabilitySchema} from '@lifestream/runtime/capabilities/schema-artifacts';
import {CapabilityCall} from '@lifestream/runtime/capabilities/call';
import type {CapabilityCallContext} from '@lifestream/runtime/capabilities/ports';
import {AuthenticationError,type LocalAuthentication,type LocalContext} from '../auth/local-auth.ts';
import type {PwceCapabilityDiscovery,PwceCapabilityOwner,PwceCapabilityLease} from '../composition/pwce-capabilities.ts';
const descriptor=EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=(code='pwce_preparation_unavailable',status=503):never=>{throw new AuthenticationError(status,code);};
type Owner=Omit<PwceCapabilityOwner,'isCurrent'>;
type Preview={decision:providerMessages_DefsExternalAuthorityDecision;evidenceJson:string};
export type PwceActionPreparationRecord={schemaVersion:'1.0.0';invocationId:string;idempotencyKey:string;intentDigest:string;owner:Owner;catalog:PwceCatalogRecord;prepared:PwcePreparedAction;inputSchema:ArtifactRef;outputSchema:ArtifactRef;correlationId:string;createdAt:string;expiresAt:string;confirmationDigest:string;originalPreview:Preview};
type Binding=(assistantId:string,local:LocalContext,call:CapabilityCallContext)=>{provider:PwceCapabilityDiscovery;owner:PwceCapabilityOwner};
type Row={principal_id:string;idempotency_key:string;invocation_id:string;payload_json:string;sha256:string};
const review=(r:Omit<PwceActionPreparationRecord,'confirmationDigest'|'originalPreview'>)=>({invocationId:r.invocationId,owner:r.owner,input:r.prepared.input,approval:r.prepared.approval,operation:pwceLightOperation(r.prepared.input,r.catalog.binding.worldRef),catalog:r.catalog,inputSchema:r.inputSchema,outputSchema:r.outputSchema,expiresAt:r.expiresAt});

/** Retained review and non-consuming PWCE preview only. No grants, dispatcher
 * credential, admission claim, invocation call or automatic Human confirmation. */
export class PwceActionPreparation {
 private readonly database:Database;private readonly auth:LocalAuthentication;private readonly binding:Binding;
 constructor(database:Database,auth:LocalAuthentication,binding:Binding){this.database=database;this.auth=auth;this.binding=binding;}
 private guard(assistantId:string,local:LocalContext):void{this.auth.assertCurrent(local);if(!this.auth.canAdminister(local,assistantId))fail('assistant_scope_denied',403);}
 private decode(row:Row|undefined):PwceActionPreparationRecord|undefined{
  if(!row)return undefined;
  try{
   if(Buffer.byteLength(row.payload_json)>262144||createHash('sha256').update(row.payload_json).digest('hex')!==row.sha256)fail();
   const r=JSON.parse(row.payload_json) as PwceActionPreparationRecord;
   if(!boundedJson(r,262144)||r.schemaVersion!=='1.0.0'||r.invocationId!==row.invocation_id||r.idempotencyKey!==row.idempotency_key||r.owner.principalId!==row.principal_id||r.confirmationDigest!==hash(review(r)))fail();
   return r;
  }catch{return fail();}
 }
 private byKey(principalId:string,key:string){return this.decode(this.database.connection.prepare('SELECT * FROM pwce_action_preparations WHERE principal_id=? AND idempotency_key=?').get(principalId,key) as Row|undefined);}
 private save(record:PwceActionPreparationRecord):PwceActionPreparationRecord{
  if(!boundedJson(record,262144))return fail();
  const json=canonicalJson(record),sha=createHash('sha256').update(json).digest('hex');
  return this.database.transaction(tx=>{
   const old=this.decode(tx.get<Row>('SELECT * FROM pwce_action_preparations WHERE principal_id=? AND idempotency_key=?',record.owner.principalId,record.idempotencyKey));
   if(old){if(old.intentDigest!==record.intentDigest)fail('pwce_preparation_idempotency_conflict',409);return old;}
   if((tx.get<{n:number}>('SELECT COUNT(*) AS n FROM pwce_action_preparations')?.n??0)>=4096)fail('pwce_preparation_capacity',409);
   tx.run('INSERT INTO pwce_action_preparations VALUES (?,?,?,?,?)',record.owner.principalId,record.idempotencyKey,record.invocationId,json,sha);return structuredClone(record);
  });
 }
 private async previewOperation(record:Omit<PwceActionPreparationRecord,'confirmationDigest'|'originalPreview'>,lease:PwceCapabilityLease){
  const request:AuthorityRequest={schemaVersion:'1.0.0',operation:'AuthorityProvider.evaluate',requestId:randomUUID(),correlationId:record.correlationId,deadlineAt:lease.deadlineAt,cancellationId:randomUUID(),executionMode:record.catalog.executionMode,scope:{...structuredClone(record.catalog.scope),authorityContextRef:record.catalog.scope.authorityContextRef!,endpointId:record.catalog.scope.endpointId!,sessionId:record.catalog.scope.sessionId!},idempotencyKey:null,payload:{grantId:null,invocationId:record.invocationId,inputDigest:hash(record.prepared.input),snapshotId:record.catalog.snapshot.snapshotId,snapshotRevision:record.catalog.snapshot.revision,scope:pwceLightOperation(record.prepared.input,record.catalog.binding.worldRef)}};
  const preview=new PwceAuthorityPreview({providerRef:'pwce',client:lease.client,catalog:lease.catalog,resolve:async()=>structuredClone(record.prepared),isCurrent:(candidate,prepared)=>Date.now()<Date.parse(record.expiresAt)&&lease.context.isCurrent(candidate.scope)&&isDeepStrictEqual(prepared,record.prepared)&&isDeepStrictEqual(candidate.payload,request.payload)});
  const result=await preview.evaluate(request,lease.context);if(result.outcome.status!=='succeeded')return fail();
  if(result.outcome.payload.schemaVersion!=='1.0.0'||result.outcome.payload.authorityKind!=='external')return fail();
  const decision=result.outcome.payload as providerMessages_DefsExternalAuthorityDecision;
  const bytes=await preview.readEvidence(decision.evidenceRef,request,lease.context);
  return {preview:{decision,evidenceJson:new TextDecoder().decode(bytes)},request,provider:preview};
 }
 private async evaluate(record:Omit<PwceActionPreparationRecord,'confirmationDigest'|'originalPreview'>,lease:PwceCapabilityLease):Promise<Preview>{return (await this.previewOperation(record,lease)).preview;}
 /** Host-only gate. It grants no producer authority and cannot escape the
  * original finite lease. The callback must durably claim before dispatch. */
 async withConfirmedReview<T>(assistantId:string,invocationId:string,local:LocalContext,csrfToken:string,raw:unknown,inputCall:CapabilityCallContext,operation:(confirmation:{record:PwceActionPreparationRecord;lease:PwceCapabilityLease;request:AuthorityRequest;preview:PwceAuthorityPreview;evidence:Preview;assertCurrent():void})=>Promise<T>):Promise<T>{
  this.guard(assistantId,local);this.auth.csrf(local,csrfToken);
  if(!uuid.test(invocationId)||!boundedJson(raw,1024)||!raw||typeof raw!=='object'||Array.isArray(raw))return fail('invalid_pwce_confirmation',422);
  const body=structuredClone(raw) as {idempotencyKey:string;confirmationDigest:string};
  if(Object.keys(body).sort().join(',')!=='confirmationDigest,idempotencyKey'||!uuid.test(body.idempotencyKey)||typeof body.confirmationDigest!=='string'||!/^[a-f0-9]{64}$/.test(body.confirmationDigest))return fail('invalid_pwce_confirmation',422);
  const record=this.byKey(local.principalId,body.idempotencyKey);
  if(!record||record.invocationId!==invocationId||record.owner.assistantId!==assistantId||record.owner.sessionId!==local.sessionId)return fail('pwce_preparation_not_found',404);
  if(record.confirmationDigest!==body.confirmationDigest)return fail('pwce_confirmation_changed',409);
  const {provider,owner}=this.binding(assistantId,local,inputCall),{isCurrent:_current,...metadata}=owner;
  if(!isDeepStrictEqual(metadata,record.owner)||Date.parse(record.expiresAt)<=Date.now())return fail('pwce_preparation_review_expired_or_changed',409);
  return this.scoped(provider,owner,inputCall,async lease=>{
   let active=true;
   const assertCurrent=()=>{
    this.guard(assistantId,local);this.auth.csrf(local,csrfToken);
    if(!active||!owner.isCurrent()||inputCall.signal.aborted||!inputCall.isCurrent()||lease.context.signal.aborted||!lease.context.isCurrent(record.catalog.scope)||Date.now()>=Math.min(Date.parse(record.expiresAt),Date.parse(lease.deadlineAt))||!isDeepStrictEqual(this.byKey(local.principalId,record.idempotencyKey),record))return fail('pwce_confirmation_expired_or_changed',409);
   };
   try{
    assertCurrent();await this.validateInput(record,lease,inputCall);
    const preview=await this.previewOperation(record,lease);assertCurrent();
    if(preview.preview.decision.disposition!=='authorized')return fail('pwce_confirmation_requires_provider_authority',409);
    const result=await operation({record:structuredClone(record),lease,request:preview.request,preview:preview.provider,evidence:preview.preview,assertCurrent});
    assertCurrent();return result;
   }finally{active=false;}
  },record.catalog);
 }
 private async validateInput(record:Pick<PwceActionPreparationRecord,'prepared'|'inputSchema'|'outputSchema'>,lease:PwceCapabilityLease,inputCall:CapabilityCallContext){
  const scope=lease.record.scope,call=new CapabilityCall({...inputCall,deadlineAt:lease.deadlineAt,signal:lease.context.signal,isCurrent:()=>lease.context.isCurrent(scope)});
  try{
   const schemaScope={assistantId:scope.assistantId,endpointId:scope.endpointId!,sessionId:scope.sessionId!,environment:scope.environmentId,authorityContextRef:scope.authorityContextRef!};
   const inputSchema=await resolveCapabilitySchema(record.inputSchema,schemaScope,call,lease.catalog.schemas);await resolveCapabilitySchema(record.outputSchema,schemaScope,call,lease.catalog.schemas);
   if(!await call.wait(()=>validateCapabilitySchema(inputSchema,record.prepared.input,call.context.signal)))fail('pwce_capability_input_invalid',422);call.check();return inputSchema;
  }finally{call.close();}
 }
 private view(record:PwceActionPreparationRecord,currentPreview:Preview,inputSchema:unknown,replayed:boolean){return {providerRef:'pwce',replayed,preparation:{...review(record),confirmationDigest:record.confirmationDigest,createdAt:record.createdAt,originalPreview:record.originalPreview.decision,currentPreview:currentPreview.decision,originalPreviewEvidence:record.originalPreview.evidenceJson,currentPreviewEvidence:currentPreview.evidenceJson},input:structuredClone(record.prepared.input),inputSchema,idempotencyKey:record.idempotencyKey,grantsAuthority:false,dispatchStarted:false,confirmationAvailable:false,limitation:'Preparation is retained. Host confirmation and dispatch are not yet connected; PWCE remains the authority for this action.'};}
 private async scoped<T>(provider:PwceCapabilityDiscovery,owner:PwceCapabilityOwner,inputCall:CapabilityCallContext,operation:(lease:PwceCapabilityLease)=>Promise<T>,original?:PwceCatalogRecord):Promise<T>{
  // Preserve known host validation failures only after the outer scope checks.
  // Foreign/provider failures still use the bounded call's sanitized error.
  const result=await provider.withCatalog(owner,inputCall,async lease=>{try{return {ok:true as const,value:await operation(lease)};}catch(error){if(error instanceof AuthenticationError)return {ok:false as const,error};throw error;}},original);
  if(!result.ok)throw result.error;return result.value;
 }
 private async inspectRecord(record:PwceActionPreparationRecord,assistantId:string,local:LocalContext,inputCall:CapabilityCallContext,replayed:boolean){
  this.guard(assistantId,local);const {provider,owner}=this.binding(assistantId,local,inputCall),{isCurrent:_current,...metadata}=owner;
  if(record.owner.assistantId!==assistantId||record.owner.principalId!==local.principalId||record.owner.sessionId!==local.sessionId)fail('pwce_preparation_not_found',404);
  if(!isDeepStrictEqual(metadata,record.owner)||Date.parse(record.expiresAt)<=Date.now())fail('pwce_preparation_review_expired_or_changed',409);
  return this.scoped(provider,owner,inputCall,async lease=>{
   const inputSchema=await this.validateInput(record,lease,inputCall),preview=await this.evaluate(record,lease);
   this.guard(assistantId,local);if(!isDeepStrictEqual(this.byKey(local.principalId,record.idempotencyKey),record))fail();
   return this.view(record,preview,inputSchema,replayed);
  },record.catalog);
 }
 async dispatchConfirmed(assistantId:string,invocationId:string,local:LocalContext,csrfToken:string,raw:unknown,inputCall:CapabilityCallContext,journal:PwceActionJournal,dispatcher:PwceTrustedDispatchClient){
  return this.withConfirmedReview(assistantId,invocationId,local,csrfToken,raw,inputCall,async confirmation=>{
   const {record,lease,request,preview,evidence}=confirmation;
   const interactionTraceId=record.catalog.scope.interactionTraceId;if(typeof interactionTraceId!=='string')return fail('pwce_dispatch_interaction_required',409);
   const current=()=>{confirmation.assertCurrent();journal.assertCurrent();if(journal.deploymentId!==record.catalog.scope.environmentId)return fail('pwce_journal_deployment_mismatch',409);};current();
   if(evidence.decision.kind!=='preview')return fail();
   const prior=journal.admissions.read(record.idempotencyKey);
   let dispatch:AuthorityDispatchRequest;
   if(prior){
    const original=prior.intent.request,{expectedGrantRevision,requiredProviderDisposition:_preview,...payload}=original.payload;
    if(original.idempotencyKey!==record.idempotencyKey||original.correlationId!==record.correlationId||original.executionMode!==record.catalog.executionMode||expectedGrantRevision!==record.catalog.producerRevision||!isDeepStrictEqual(original.scope,record.catalog.scope)||!isDeepStrictEqual(payload,request.payload)||!isDeepStrictEqual(prior.intent.prepared,record.prepared)||!isDeepStrictEqual(prior.intent.catalog,record.catalog))return fail('pwce_dispatch_original_conflict',409);
    dispatch={...original,requestId:request.requestId,cancellationId:request.cancellationId,deadlineAt:request.deadlineAt};
   }else dispatch={...request,operation:'AuthorityProvider.authorizeDispatch',idempotencyKey:record.idempotencyKey,payload:{...request.payload,expectedGrantRevision:record.catalog.producerRevision,requiredProviderDisposition:pwceGovernedDisposition({...evidence.decision,kind:'preview'})}};
   const admission=new PwceAuthorityAdmission({providerRef:'pwce',client:lease.client,dispatcher,catalog:lease.catalog,preview,custody:journal.admissions,authorize:async(candidate,prepared)=>{
    current();return isDeepStrictEqual(candidate.payload,dispatch.payload)&&isDeepStrictEqual(candidate.scope,dispatch.scope)&&candidate.idempotencyKey===dispatch.idempotencyKey&&candidate.correlationId===dispatch.correlationId&&isDeepStrictEqual(prepared,record.prepared);
   }});
   const invocation=new PwceInvocation({providerRef:'pwce',client:lease.client,dispatcher,admission,custody:journal.invocations});
   const previousInvocation=journal.invocations.read(invocationId);
   if(previousInvocation){
    if(!prior||previousInvocation.request.idempotencyKey!==record.idempotencyKey||!isDeepStrictEqual(previousInvocation.request.scope,record.catalog.scope))return fail('pwce_dispatch_original_conflict',409);
    const query={...previousInvocation.request,operation:'CapabilityProvider.getInvocation' as const,requestId:request.requestId,cancellationId:request.cancellationId,deadlineAt:request.deadlineAt,payload:{invocationId}};
    const result=await invocation.getInvocation(query,lease.context);current();
    if(result.outcome.status!=='succeeded')return fail('pwce_invocation_unavailable');
    return {providerRef:'pwce',replayed:true,invocation:result.outcome.payload,admission:prior.outcome?.decision??null,grantsAuthority:false};
   }
   const admitted=await admission.authorizeDispatch(dispatch,lease.context);current();
   if(admitted.outcome.status!=='succeeded'||admitted.outcome.payload.authorityKind!=='external'||admitted.outcome.payload.disposition!=='authorized')return fail('pwce_dispatch_not_admitted',409);
   const decision=admitted.outcome.payload as providerMessages_DefsExternalAuthorityDecision;
   if(decision.kind!=='dispatch')return fail();
   const invoke:CapabilityInvocationRequest={...dispatch,scope:{...dispatch.scope,interactionTraceId},operation:'CapabilityProvider.invoke',requestId:randomUUID(),payload:{invocationId,capabilityId:PWCE_LIGHT_CAPABILITY_ID,capabilityVersion:descriptor.schemaVersion,snapshotId:record.catalog.snapshot.snapshotId,snapshotRevision:record.catalog.snapshot.revision,operationScope:dispatch.payload.scope,input:record.prepared.input,inputSchema:record.inputSchema,inputDigest:dispatch.payload.inputDigest,dispatchReceipt:decision.evidenceRef}};
   const result=await invocation.invoke(invoke,lease.context);current();
   if(result.outcome.status!=='succeeded')return fail('pwce_invocation_unavailable');
   return {providerRef:'pwce',replayed:!!prior,admission:admitted.outcome.payload,invocation:result.outcome.payload,grantsAuthority:false};
  });
 }
 async inspect(assistantId:string,invocationId:string,local:LocalContext,inputCall:CapabilityCallContext){
  this.guard(assistantId,local);if(!uuid.test(invocationId))fail('invalid_preparation_reference',422);
  const record=this.decode(this.database.connection.prepare('SELECT * FROM pwce_action_preparations WHERE principal_id=? AND invocation_id=?').get(local.principalId,invocationId) as Row|undefined);if(!record)return fail('pwce_preparation_not_found',404);
  return this.inspectRecord(record,assistantId,local,inputCall,true);
 }
 async prepare(assistantId:string,capabilityId:string,local:LocalContext,raw:unknown,inputCall:CapabilityCallContext){
  this.guard(assistantId,local);
  if(!boundedJson(raw,16384)||!raw||typeof raw!=='object'||Array.isArray(raw))return fail('invalid_pwce_preparation',422);
  const body=structuredClone(raw) as {idempotencyKey:string;capabilityVersion:string;input:PwcePreparedAction['input']};
  if(Object.keys(body).sort().join(',')!=='capabilityVersion,idempotencyKey,input'||!uuid.test(body.idempotencyKey)||body.capabilityVersion!==descriptor.schemaVersion||capabilityId!==PWCE_LIGHT_CAPABILITY_ID)fail('invalid_pwce_preparation',422);
  const {provider,owner}=this.binding(assistantId,local,inputCall),{isCurrent:_current,...metadata}=owner,intentDigest=hash({capabilityId,body,owner:metadata});
  const previous=this.byKey(local.principalId,body.idempotencyKey);
  if(previous){if(previous.intentDigest!==intentDigest)fail('pwce_preparation_idempotency_conflict',409);return this.inspectRecord(previous,assistantId,local,inputCall,true);}
  const saved=await this.scoped(provider,owner,inputCall,async lease=>{
   if(!lease.record.snapshot.capabilities.some(c=>c.capabilityId===capabilityId&&c.version===body.capabilityVersion))return fail();
   const record={schemaVersion:'1.0.0' as const,invocationId:randomUUID(),idempotencyKey:body.idempotencyKey,intentDigest,owner:metadata,catalog:lease.record,prepared:{input:body.input,approval:{required:lease.record.binding.executionEnvironmentRef==='live'||['always'].includes(descriptor.approval),reference:null}},inputSchema:descriptor.inputSchemaArtifact,outputSchema:descriptor.resultSchemaArtifact,correlationId:inputCall.correlationId,createdAt:new Date().toISOString(),expiresAt:new Date(Math.min(Date.now()+90000,Date.parse(lease.record.snapshot.expiresAt))).toISOString()};
   const inputSchema=await this.validateInput(record,lease,inputCall),preview=await this.evaluate(record,lease);
   this.guard(assistantId,local);if(!owner.isCurrent()||lease.context.signal.aborted)fail();
   const completed={...record,confirmationDigest:hash(review(record)),originalPreview:preview},stored=this.save(completed);
   return {stored,completed,inputSchema};
  });
  if(saved.stored.invocationId!==saved.completed.invocationId)return this.inspectRecord(saved.stored,assistantId,local,inputCall,true);
  return this.view(saved.stored,saved.stored.originalPreview,saved.inputSchema,false);
 }
}
