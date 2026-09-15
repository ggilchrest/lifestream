import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContractValidator } from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import type { CapabilitySchemaStore, SchemaArtifactRef } from '@lifestream/runtime/capabilities/schema-artifacts';
import type { CapabilityCallContext, CapabilityScope } from '@lifestream/runtime/capabilities/ports';
import { boundedJson, canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import { PwceGatewayClient } from './client.ts';
import { EXPECTED_PWCE_CAPABILITY_BUNDLE } from './capability-bundle.ts';
import { PwceCallScope, PwceTransportError } from './transport.ts';

export type PwceCapabilityBinding = {
  authorityContextRef: string; principalRef: string; siteRefs: string[]; worldRef: string;
  executionEnvironmentRef: 'normal' | 'live' | 'test' | 'replay' | 'simulation' | 'dry-run';
  identity: { assistantRef: string | null; endpointRef: string | null; participantRefs: string[]; audienceRef: string | null };
};
export type PwceCapabilityCatalogOptions = {
  providerRef: string; client: PwceGatewayClient; capacity?: number;
  /** Both callbacks belong to the trusted composition root, not request JSON. */
  resolve(scope: M.CallScope, executionMode: M.CapabilitySnapshotRequest['executionMode'], signal: AbortSignal): Promise<PwceCapabilityBinding>;
  isCurrent(binding: PwceCapabilityBinding, scope: M.CallScope): boolean;
};
export type PwceCatalogRecord = {
  snapshot: M.capabilitySnapshot_Root; scope: M.CallScope; binding: PwceCapabilityBinding;
  producerSnapshotRef: string; producerRevision: number; producerDigest: string; executionMode: M.CapabilitySnapshotRequest['executionMode'];
};
const validator = createContractValidator(), descriptor = EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0];
export const PWCE_LIGHT_CAPABILITY_ID = 'pwce.home.light.set-level';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const uuid = (value: unknown) => { const h=hash(value); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail = (code: string): never => { throw new PwceTransportError(code, `PWCE capability catalog ${code}`); };
const object = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const definition: M.capabilitySnapshot_Root['capabilities'][number] = {
  capabilityId: PWCE_LIGHT_CAPABILITY_ID, version: descriptor.schemaVersion, inputSchemaRef: descriptor.inputSchemaRef, outputSchemaRef: descriptor.resultSchemaRef,
  sideEffectClass: descriptor.effectClass, authorization: 'invokeDecision', idempotency: descriptor.idempotency, latencyClass: 'slow',
  offlineAvailable: false, simulationSupported: descriptor.simulationSupported, providerRouteRef: 'pwce:home.light.set_level'
};
function budget(deadlineAt: string, signal: AbortSignal): PwceCallScope {
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return fail('deadline_exceeded');
  if (remaining > 30_000) return fail('invalid_request');
  return new PwceCallScope(remaining, signal);
}
function modeMatches(mode: 'normal' | 'live' | 'replay' | 'simulation', environment: PwceCapabilityBinding['executionEnvironmentRef']): boolean {
  return mode === 'replay' || mode === 'simulation' ? mode === environment : ['normal','live','test'].includes(environment);
}
function boundIdentity(value: unknown): boolean { return value === null || typeof value === 'string' && value.length > 0 && value.length <= 128; }
function validateBinding(value: PwceCapabilityBinding): void {
  if (!boundedJson(value,16_384) || !object(value) || Object.keys(value).sort().join(',') !== 'authorityContextRef,executionEnvironmentRef,identity,principalRef,siteRefs,worldRef' ||
    !isUuid(value.authorityContextRef) || !boundIdentity(value.worldRef) || value.worldRef === null || !boundIdentity(value.principalRef) || value.principalRef === null ||
    !Array.isArray(value.siteRefs) || !value.siteRefs.length || value.siteRefs.length > 128 || value.siteRefs.some(site=>typeof site !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(site)) || new Set(value.siteRefs).size !== value.siteRefs.length ||
    !['normal','live','test','replay','simulation','dry-run'].includes(value.executionEnvironmentRef) || !object(value.identity) ||
    Object.keys(value.identity).sort().join(',') !== 'assistantRef,audienceRef,endpointRef,participantRefs' || !boundIdentity(value.identity.assistantRef) || !boundIdentity(value.identity.endpointRef) || !boundIdentity(value.identity.audienceRef) ||
    !Array.isArray(value.identity.participantRefs) || value.identity.participantRefs.length > 32 || value.identity.participantRefs.some(ref=>!boundIdentity(ref)||ref===null) || new Set(value.identity.participantRefs).size !== value.identity.participantRefs.length) fail('invalid_binding');
}
function bodyOf(value: Record<string,unknown>, binding: PwceCapabilityBinding, requestId: string, correlationId: string): Record<string,unknown> {
  if (value.profileId !== 'pwce-agent-gateway.v1' || value.profileVersion !== '1.0.0' || value.requestId !== requestId || value.correlationId !== correlationId || value.worldRef !== binding.worldRef || value.executionEnvironmentRef !== binding.executionEnvironmentRef) return fail('response_scope_mismatch');
  const { profileId: _p, profileVersion: _v, requestId: _r, correlationId: _c, worldRef: _w, executionEnvironmentRef: _e, ...body } = value;
  if (Object.keys(body).sort().join(',') !== 'availability,capabilities,expiresAt,invalidationSequence,issuedAt,limitations,principalRef,siteRefs,snapshotRef,sourceRevision' ||
    !isUuid(body.snapshotRef) || body.principalRef !== binding.principalRef || !isDeepStrictEqual(body.siteRefs,binding.siteRefs) || !Number.isSafeInteger(body.sourceRevision) || Number(body.sourceRevision)<0 || body.invalidationSequence !== body.sourceRevision ||
    typeof body.issuedAt !== 'string' || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.issuedAt)) || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.issuedAt)>Date.now() || Date.parse(body.expiresAt)<=Date.now() || Date.parse(body.expiresAt)<=Date.parse(body.issuedAt) || Date.parse(body.expiresAt)-Date.parse(body.issuedAt)>3_600_000 ||
    !Array.isArray(body.limitations) || body.limitations.length>8 || body.limitations.some(value=>typeof value!=='string'||value.length>500)) return fail('invalid_snapshot');
  const expected=body.availability==='none'?[]:body.availability==='configured'?[{...descriptor,available:true,authorization:'grant_required'}]:null;
  if (!expected || !isDeepStrictEqual(body.capabilities,expected)) return fail('unsupported_capability_definition');
  return body;
}

/** Canonical catalog projection only. Records preserve their producer bindings;
 * neither this port nor schema reads may authorize or dispatch an effect. */
export class PwceCapabilityCatalog {
  readonly schemas: CapabilitySchemaStore;
  private readonly records = new Map<string,PwceCatalogRecord>();
  private readonly sourceDigests = new Map<string,{digest:string;expiresAt:string;poisoned:boolean}>();
  private readonly options: PwceCapabilityCatalogOptions;
  constructor(options: PwceCapabilityCatalogOptions) {
    const capacity=options.capacity??256;
    if (!options.providerRef || options.providerRef.length>500 || !Number.isInteger(capacity)||capacity<1||capacity>1024) fail('invalid_configuration');
    this.options={...options,capacity};
    this.schemas={read:(reference,scope,context)=>this.readSchema(reference,scope,context)};
  }
  private check(scope:M.CallScope,binding:PwceCapabilityBinding,context:ProviderCallContext,call:PwceCallScope):void {
    call.check();
    if (!context.isCurrent(structuredClone(scope)) || !this.options.isCurrent(structuredClone(binding),structuredClone(scope))) fail('scope_changed');
  }
  private prune():void {
    for(const [id,record]of this.records)if(Date.parse(record.snapshot.expiresAt)<=Date.now())this.records.delete(id);
    for(const [id,record]of this.sourceDigests)if(Date.parse(record.expiresAt)<=Date.now())this.sourceDigests.delete(id);
  }
  private async producerSnapshot(binding:PwceCapabilityBinding,requestId:string,correlationId:string,deadline:string,signal:AbortSignal,snapshotRef?:string):Promise<Record<string,unknown>> {
    return this.options.client.request({...binding.identity,authorityContextRef:binding.authorityContextRef,worldRef:binding.worldRef,executionEnvironmentRef:binding.executionEnvironmentRef,requestId,correlationId,deadline,operation:'capabilities.getSnapshot',...(snapshotRef?{snapshotRef}:{})},signal);
  }
  async getSnapshot(input:M.CapabilitySnapshotRequest,context:ProviderCallContext):Promise<M.CapabilitySnapshotResult> {
    if(!boundedJson(input)||!validator.validate('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/CapabilitySnapshotRequest',input).valid) return fail('invalid_request');
    const request=structuredClone(input), scope=request.scope,call=budget(request.deadlineAt,context.signal);
    try {
      call.check();if(!context.isCurrent(scope)||!scope.endpointId||!scope.sessionId||scope.authorityContextRef?.providerRef!==this.options.providerRef)return fail('scope_changed');
      const binding=structuredClone(await call.wait(this.options.resolve(structuredClone(scope),request.executionMode,call.signal)));validateBinding(binding);this.check(scope,binding,context,call);
      if(!modeMatches(request.executionMode,binding.executionEnvironmentRef))return fail('execution_mode_mismatch');
      await call.wait(this.options.client.capabilityContracts(call.signal));this.check(scope,binding,context,call);
      const raw=await call.wait(this.producerSnapshot(binding,request.requestId,request.correlationId,request.deadlineAt,call.signal));this.check(scope,binding,context,call);
      const body=bodyOf(raw,binding,request.requestId,request.correlationId), producerDigest=hash(body), key=hash([binding,body.snapshotRef]);this.prune();
      const source=this.sourceDigests.get(key);if(source&&(source.poisoned||source.digest!==producerDigest)){source.poisoned=true;return fail('snapshot_identity_changed');}
      if(!source&&this.sourceDigests.size>=this.options.capacity!)return fail('catalog_capacity');
      const capabilities=(body.capabilities as unknown[]).length&&(!request.payload.requestedCapabilityIds.length||request.payload.requestedCapabilityIds.includes(PWCE_LIGHT_CAPABILITY_ID))?[structuredClone(definition)]:[];
      // Revision 1 describes this local projection, never a fabricated PWCE grant revision.
      const snapshot:M.capabilitySnapshot_Root={schemaVersion:'2.0.0',snapshotId:uuid(['pwce-capability-projection-v1',scope,binding,body.snapshotRef,capabilities.map(value=>value.capabilityId)]),revision:1,assistantId:scope.assistantId,endpointId:scope.endpointId,sessionId:scope.sessionId,environmentId:scope.environmentId,authorityContextRef:scope.authorityContextRef!,issuedAt:body.issuedAt as string,expiresAt:body.expiresAt as string,capabilities};
      if(!validator.validate('https://lifestream.dev/contracts/capability-snapshot/2.0.0',snapshot).valid)return fail('invalid_projection');
      if(!this.records.has(snapshot.snapshotId)&&this.records.size>=this.options.capacity!)return fail('catalog_capacity');
      this.check(scope,binding,context,call);
      this.sourceDigests.set(key,{digest:producerDigest,expiresAt:snapshot.expiresAt,poisoned:false});
      this.records.set(snapshot.snapshotId,structuredClone({snapshot,scope,binding,producerSnapshotRef:body.snapshotRef as string,producerRevision:body.sourceRevision as number,producerDigest,executionMode:request.executionMode}));
      return {schemaVersion:'1.0.0',operation:request.operation,requestId:request.requestId,correlationId:request.correlationId,providerRef:this.options.providerRef,completedAt:new Date().toISOString(),outcome:{status:'succeeded',payload:structuredClone(snapshot),error:null}};
    }finally{call.close();}
  }
  retained(snapshotId:string,scope:M.CallScope):PwceCatalogRecord|undefined {
    this.prune();const record=this.records.get(snapshotId);
    if(!record||this.sourceDigests.get(hash([record.binding,record.producerSnapshotRef]))?.poisoned||!isDeepStrictEqual(record.scope,scope)||!this.options.isCurrent(structuredClone(record.binding),structuredClone(scope)))return undefined;
    return structuredClone(record);
  }
  /** Current host ownership for read-only original-action access. This neither
   * renews an expired snapshot nor permits a new invocation after restart. */
  assertReadScope(record:PwceCatalogRecord,scope:M.CallScope,mode:M.CapabilityStatusRequest['executionMode'],context:ProviderCallContext):void {
    validateBinding(record.binding);
    if(!isDeepStrictEqual(record.scope,scope)||scope.authorityContextRef?.providerRef!==this.options.providerRef||record.executionMode!==mode||!modeMatches(mode,record.binding.executionEnvironmentRef)||context.signal.aborted||!context.isCurrent(structuredClone(scope))||!this.options.isCurrent(structuredClone(record.binding),structuredClone(scope)))fail('scope_changed');
  }
  /** Revalidate original custody without discovering or replacing its snapshot. */
  async revalidate(request: Pick<M.AuthorityRequest, 'scope' | 'requestId' | 'correlationId' | 'deadlineAt' | 'executionMode'> & { payload: { snapshotId: string; snapshotRevision: number } }, context: ProviderCallContext): Promise<PwceCatalogRecord> {
    if (!boundedJson(request) || !isUuid(request.requestId) || !isUuid(request.correlationId)) return fail('invalid_request');
    const owned = structuredClone(request), call = budget(owned.deadlineAt, context.signal);
    try {
      const record = this.retained(owned.payload.snapshotId, owned.scope);
      if (!record || record.snapshot.revision !== owned.payload.snapshotRevision || record.executionMode !== owned.executionMode) return fail('snapshot_unavailable');
      this.check(owned.scope, record.binding, context, call);
      const raw = await call.wait(this.producerSnapshot(record.binding, owned.requestId, owned.correlationId, owned.deadlineAt, call.signal, record.producerSnapshotRef));
      this.check(owned.scope, record.binding, context, call);
      if (hash(bodyOf(raw, record.binding, owned.requestId, owned.correlationId)) !== record.producerDigest) {
        const source = this.sourceDigests.get(hash([record.binding, record.producerSnapshotRef]));
        if (source) source.poisoned = true;
        return fail('snapshot_identity_changed');
      }
      if (!this.retained(record.snapshot.snapshotId, owned.scope)) return fail('snapshot_unavailable');
      return record;
    } finally { call.close(); }
  }
  private async readSchema(reference:SchemaArtifactRef,inputScope:CapabilityScope,context:CapabilityCallContext):Promise<Uint8Array|undefined>{
    const requested=structuredClone(reference),scope=structuredClone(inputScope),call=budget(context.deadlineAt,context.signal);this.prune();
    try{
      call.check();if(!context.isCurrent())return fail('scope_changed');
      const record=[...this.records.values()].find(value=>value.snapshot.capabilities.length&&value.scope.assistantId===scope.assistantId&&value.scope.endpointId===scope.endpointId&&value.scope.sessionId===scope.sessionId&&value.scope.environmentId===scope.environment&&isDeepStrictEqual(value.scope.authorityContextRef,scope.authorityContextRef));
      if(!record||!modeMatches(context.executionMode,record.binding.executionEnvironmentRef)||![descriptor.inputSchemaArtifact,descriptor.resultSchemaArtifact].some(value=>isDeepStrictEqual(value,requested)))return undefined;
      const check=()=>{call.check();if(this.sourceDigests.get(hash([record.binding,record.producerSnapshotRef]))?.poisoned)fail('snapshot_identity_changed');if(!context.isCurrent()||!this.options.isCurrent(structuredClone(record.binding),structuredClone(record.scope))||Date.parse(record.snapshot.expiresAt)<=Date.now())fail('scope_changed');};check();
      // Public schema bytes still require the current scoped snapshot before use.
      const raw=await call.wait(this.producerSnapshot(record.binding,context.requestId,context.correlationId,context.deadlineAt,call.signal,record.producerSnapshotRef));check();
      if(hash(bodyOf(raw,record.binding,context.requestId,context.correlationId))!==record.producerDigest){const source=this.sourceDigests.get(hash([record.binding,record.producerSnapshotRef]));if(source)source.poisoned=true;return fail('snapshot_identity_changed');}
      const bytes=await call.wait(this.options.client.capabilitySchema(requested,call.signal));check();return new Uint8Array(bytes);
    }finally{call.close();}
  }
}
