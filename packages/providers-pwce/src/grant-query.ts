import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createContractValidator} from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type {ProviderCallContext} from '@lifestream/runtime/ports/provider-messages';
import {boundedJson,canonicalJson} from '@lifestream/runtime/capabilities/schema-validation';
import {PwceCapabilityCatalog,type PwceCatalogRecord} from './capability-catalog.ts';
import {PwceGatewayClient} from './client.ts';
import {PwceCallScope,PwceTransportError} from './transport.ts';

export type PwceGrantQueryOptions={providerRef:string;client:PwceGatewayClient;catalog:PwceCapabilityCatalog;capacity?:number;
 /** Trusted host catalog lease. Request JSON cannot supply foreign authority. */
 resolve(request:M.GrantQueryRequest,signal:AbortSignal):Promise<PwceCatalogRecord>};
type Evidence={request:M.GrantQueryRequest;record:PwceCatalogRecord;reference:M.ArtifactRef;bytes:Uint8Array;expiresAt:string};
const validator=createContractValidator(),base='https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/';
const fail=(code:string):never=>{throw new PwceTransportError(code,`PWCE grant query ${code}`);};
const list=(value:unknown,limit:number,size:number):value is string[]=>Array.isArray(value)&&value.length<=limit&&new Set(value).size===value.length&&value.every(v=>typeof v==='string'&&v.length>0&&v.length<=size);
/** Current producer summary only. Never creates or infers a HumanAuthorityGrant. */
export class PwceGrantQuery{
 private readonly options:PwceGrantQueryOptions;
 private readonly evidence=new Map<string,Evidence>();
 constructor(options:PwceGrantQueryOptions){const capacity=options.capacity??256;if(!options.providerRef||options.providerRef.length>500||!Number.isInteger(capacity)||capacity<1||capacity>4096)fail('invalid_configuration');this.options={...options,capacity};}
 private call(request:M.GrantQueryRequest,context:ProviderCallContext){const remaining=Date.parse(request.deadlineAt)-Date.now();if(!Number.isFinite(remaining)||remaining<=0)fail('deadline_exceeded');if(remaining>30000)fail('invalid_request');return new PwceCallScope(remaining,context.signal);}
 private check(request:M.GrantQueryRequest,record:PwceCatalogRecord,context:ProviderCallContext,call:PwceCallScope){
  call.check();if(!context.isCurrent(structuredClone(request.scope))||request.scope.authorityContextRef?.providerRef!==this.options.providerRef||record.executionMode!==request.executionMode||!isDeepStrictEqual(record,this.options.catalog.retained(record.snapshot.snapshotId,request.scope)))fail('scope_changed');
 }
 private revalidate(request:M.GrantQueryRequest,record:PwceCatalogRecord,context:ProviderCallContext){return this.options.catalog.revalidate({...request,payload:{snapshotId:record.snapshot.snapshotId,snapshotRevision:record.snapshot.revision}},context);}
 private prune(){for(const [key,value] of this.evidence)if(Date.parse(value.expiresAt)<=Date.now())this.evidence.delete(key);}
 async getGrants(input:M.GrantQueryRequest,context:ProviderCallContext):Promise<M.GrantQueryResult>{
  if(!boundedJson(input)||!validator.validate(base+'GrantQueryRequest',input).valid||input.idempotencyKey!==null)fail('invalid_request');
  const request=structuredClone(input),call=this.call(request,context),scoped={...context,signal:call.signal};
  try{
   call.check();if(!context.isCurrent(structuredClone(request.scope))||request.scope.authorityContextRef?.providerRef!==this.options.providerRef)fail('scope_changed');
   // The producer publishes one current aggregate, not lifecycle rows or pages.
   if(request.payload.states.length||request.payload.page.cursor!==null)fail('unsupported_query');
   this.prune();if(this.evidence.size>=this.options.capacity!)fail('evidence_capacity');
   const record=structuredClone(await call.wait(this.options.resolve(structuredClone(request),call.signal)));this.check(request,record,scoped,call);
   await call.wait(this.revalidate(request,record,scoped));this.check(request,record,scoped,call);
   const binding=record.binding;
   const raw=await call.wait(this.options.client.request({...binding.identity,operation:'authority.getGrants',authorityContextRef:binding.authorityContextRef,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,requestId:request.requestId,correlationId:request.correlationId,deadline:request.deadlineAt},call.signal));this.check(request,record,scoped,call);
   if(!boundedJson(raw,65536)||Object.keys(raw).sort().join(',')!=='capabilityRefs,correlationId,executionEnvironmentRef,limitations,principalRef,profileId,profileVersion,requestId,siteRefs,sourceRevision,worldRef'||raw.profileId!=='pwce-agent-gateway.v1'||raw.profileVersion!=='1.0.0'||raw.requestId!==request.requestId||raw.correlationId!==request.correlationId||raw.worldRef!==binding.worldRef||raw.executionEnvironmentRef!==binding.executionEnvironmentRef||raw.principalRef!==binding.principalRef||!list(raw.siteRefs,128,64)||raw.siteRefs.some(site=>!binding.siteRefs.includes(site))||!list(raw.capabilityRefs,100,128)||typeof raw.sourceRevision!=='string'||!/^[a-f0-9]{64}$/.test(raw.sourceRevision)||!list(raw.limitations,16,500))fail('invalid_response');
   // Freeze decoded producer data before the following await; custom transports
   // cannot mutate it into a different projection after validation.
   const original=structuredClone(raw);
   await call.wait(this.revalidate(request,record,scoped));this.check(request,record,scoped,call);
   const bytes=new TextEncoder().encode(canonicalJson(original)),reference:M.ArtifactRef={reference:`pwce:grant-summary:${randomUUID()}`,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'application/json',schemaRef:'https://pwce.local/contracts/pwce-agent-gateway-response-1.0.0.schema.json'};
   const expiresAt=record.snapshot.expiresAt;
   const result:M.GrantQueryResult={schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:this.options.providerRef,completedAt:new Date().toISOString(),outcome:{status:'succeeded',error:null,payload:{grants:[],nextCursor:null,sourceRevision:{providerRef:this.options.providerRef,revision:original.sourceRevision as string,highWaterMark:null},externalSummary:{authorityKind:'externalSummary',providerRef:this.options.providerRef,scope:request.scope,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,principalRef:binding.principalRef,siteRefs:original.siteRefs as string[],capabilityRefs:original.capabilityRefs as string[],limitations:original.limitations as string[],expiresAt,evidenceRef:reference}}}};
   if(!validator.validate(base+'GrantQueryResult',result).valid)fail('invalid_projection');this.prune();if(this.evidence.size>=this.options.capacity!)fail('evidence_capacity');this.check(request,record,scoped,call);
   this.evidence.set(reference.reference,{request,record,reference,bytes,expiresAt});return structuredClone(result);
  }finally{call.close();}
 }
 async readEvidence(reference:M.ArtifactRef,input:M.GrantQueryRequest,context:ProviderCallContext):Promise<Uint8Array>{
  if(!boundedJson(reference)||!boundedJson(input)||!validator.validate(base+'GrantQueryRequest',input).valid)fail('invalid_request');
  const request=structuredClone(input),owned=structuredClone(reference),call=this.call(request,context),scoped={...context,signal:call.signal};
  try{this.prune();const saved=this.evidence.get(owned.reference);if(!saved||!isDeepStrictEqual(saved.reference,owned)||!isDeepStrictEqual(saved.request,{...request,deadlineAt:saved.request.deadlineAt}))return fail('evidence_unavailable');this.check(request,saved.record,scoped,call);await call.wait(this.revalidate(request,saved.record,scoped));this.check(request,saved.record,scoped,call);return new Uint8Array(saved.bytes);}finally{call.close();}
 }
}
