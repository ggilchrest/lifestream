import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContractValidator } from '@lifestream/contracts';
import type * as M from '@lifestream/contracts/provider-messages';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import { boundedJson, canonicalJson } from '@lifestream/runtime/capabilities/schema-validation';
import { PwceCapabilityCatalog, PWCE_LIGHT_CAPABILITY_ID } from './capability-catalog.ts';
import { EXPECTED_PWCE_CAPABILITY_BUNDLE } from './capability-bundle.ts';
import { PwceGatewayClient } from './client.ts';
import { PwceCallScope, PwceTransportError } from './transport.ts';

type Decision = M.providerMessages_DefsExternalAuthorityDecision & { kind: 'preview' };
export type PwcePreparedAction = {
  input: { siteRef: string; targetEntityId: string; parameters: { level: number } };
  approval: { required: boolean; reference: string | null };
};
export type PwceAuthorityPreviewOptions = {
  providerRef: string; client: PwceGatewayClient; catalog: PwceCapabilityCatalog; capacity?: number;
  /** Resolve original host-retained input and approval policy, never model fields. */
  resolve(request: M.AuthorityRequest, signal: AbortSignal): Promise<PwcePreparedAction>;
  isCurrent(request: M.AuthorityRequest, prepared: PwcePreparedAction): boolean;
};
type RetainedDecision = { request: M.AuthorityRequest; prepared: PwcePreparedAction; decision: Decision; bytes: Uint8Array };
export function pwceGovernedDisposition(decision: Decision): M.providerMessages_DefsGovernedDisposition {
  const {decisionId,providerRef,invocationId,inputDigest,scopeDigest,authorityContextRef,disposition,reason,evaluatedAt,expiresAt,evidenceRef}=decision;
  return structuredClone({decisionId,providerRef,invocationId,inputDigest,scopeDigest,authorityContextRef,disposition,reason,evaluatedAt,expiresAt,evidenceRef});
}
const validator = createContractValidator(), descriptor = EXPECTED_PWCE_CAPABILITY_BUNDLE.capabilities[0];
const base = 'https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/';
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code: string): never => { throw new PwceTransportError(code, `PWCE authority preview ${code}`); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Bounded, explicit mapping of the published producer input and operation. */
export function pwceLightOperation(input: PwcePreparedAction['input'], worldRef: string) {
  if (!boundedJson(input, 4096) || !object(input) || Object.keys(input).sort().join(',') !== 'parameters,siteRef,targetEntityId' ||
    typeof input.siteRef !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.siteRef) || typeof input.targetEntityId !== 'string' || !input.targetEntityId.length || input.targetEntityId.length > 128 ||
    !object(input.parameters) || Object.keys(input.parameters).join(',') !== 'level' || typeof input.parameters.level !== 'number' || !Number.isFinite(input.parameters.level) || input.parameters.level < 0 || input.parameters.level > 1 ||
    typeof worldRef !== 'string' || !worldRef.length || worldRef.length > 128) return fail('invalid_input');
  // Domain-separated opaque references qualify the actual foreign tuple. Its
  // components remain in retained input/evidence, not newly owned world records.
  return { capabilityId: PWCE_LIGHT_CAPABILITY_ID, capabilityVersion: descriptor.schemaVersion, operation: 'light.setLevel',
    targetRefs: [`pwce:entity:sha256:${digest([worldRef, input.siteRef, input.targetEntityId])}`], dataScopeRefs: [`pwce:site:sha256:${digest([worldRef, input.siteRef])}`] };
}
function preparedCopy(value: PwcePreparedAction): PwcePreparedAction {
  if (!boundedJson(value, 8192) || !object(value) || Object.keys(value).sort().join(',') !== 'approval,input' || !object(value.approval) || Object.keys(value.approval).sort().join(',') !== 'reference,required' || typeof value.approval.required !== 'boolean' ||
    !(value.approval.reference === null || typeof value.approval.reference === 'string' && value.approval.reference.length > 0 && value.approval.reference.length <= 128)) return fail('invalid_preparation');
  return structuredClone(value);
}

/** Non-consuming AuthorityProvider.evaluate and scoped evidence custody only.
 * A preview has no dispatch receipt, no action claim and no grant issuance. */
export class PwceAuthorityPreview {
  private readonly options: PwceAuthorityPreviewOptions;
  private readonly decisions = new Map<string, RetainedDecision>();
  constructor(options: PwceAuthorityPreviewOptions) {
    const capacity = options.capacity ?? 256;
    if (!options.providerRef || options.providerRef.length > 500 || !Number.isInteger(capacity) || capacity < 1 || capacity > 4096) fail('invalid_configuration');
    this.options = { ...options, capacity };
  }
  private prune(): void { for (const [id, value] of this.decisions) if (Date.parse(value.decision.expiresAt) <= Date.now()) this.decisions.delete(id); }
  private current(request: M.AuthorityRequest, prepared: PwcePreparedAction, context: ProviderCallContext, call: PwceCallScope): void {
    call.check();
    if (!context.isCurrent(structuredClone(request.scope)) || !this.options.isCurrent(structuredClone(request), structuredClone(prepared))) fail('scope_changed');
    const record = this.options.catalog.retained(request.payload.snapshotId, request.scope);
    if (!record || record.snapshot.revision !== request.payload.snapshotRevision || record.executionMode !== request.executionMode) fail('snapshot_unavailable');
  }
  private call(request: M.AuthorityRequest, context: ProviderCallContext): PwceCallScope {
    const duration = Date.parse(request.deadlineAt) - Date.now();
    if (!Number.isFinite(duration) || duration <= 0) return fail('deadline_exceeded');
    if (duration > 30_000) return fail('invalid_request');
    return new PwceCallScope(duration, context.signal);
  }
  async evaluate(input: M.AuthorityRequest, context: ProviderCallContext): Promise<M.AuthorityResult> {
    if (!boundedJson(input) || !validator.validate(base + 'AuthorityRequest', input).valid) return fail('invalid_request');
    const request = structuredClone(input), call = this.call(request, context);
    try {
      call.check();
      if (!context.isCurrent(request.scope) || request.scope.authorityContextRef?.providerRef !== this.options.providerRef || request.payload.grantId !== null) return fail('scope_changed');
      this.prune(); if (this.decisions.size >= this.options.capacity!) return fail('decision_capacity');
      const prepared = preparedCopy(await call.wait(this.options.resolve(structuredClone(request), call.signal)));
      this.current(request, prepared, context, call);
      const record = await call.wait(this.options.catalog.revalidate(request, { ...context, signal: call.signal }));
      this.current(request, prepared, context, call);
      const operation = pwceLightOperation(prepared.input, record.binding.worldRef);
      if (!record.snapshot.capabilities.some(value => value.capabilityId === PWCE_LIGHT_CAPABILITY_ID) || !record.binding.siteRefs.includes(prepared.input.siteRef) ||
        digest(prepared.input) !== request.payload.inputDigest || !isDeepStrictEqual(operation, request.payload.scope) ||
        record.binding.executionEnvironmentRef === 'live' && !prepared.approval.required) return fail('preparation_mismatch');
      const binding = record.binding;
      const wire = { ...binding.identity, operation: 'authority.evaluate', authorityContextRef: binding.authorityContextRef, worldRef: binding.worldRef, executionEnvironmentRef: binding.executionEnvironmentRef,
        requestId: request.requestId, correlationId: request.correlationId, deadline: request.deadlineAt, snapshotRef: record.producerSnapshotRef,
        capabilityRef: descriptor.capabilityRef, capabilityVersion: descriptor.schemaVersion, capabilityOperation: descriptor.operation,
        ...prepared.input, approvalRequired: prepared.approval.required, approvalRef: prepared.approval.reference };
      const raw = await call.wait(this.options.client.request(wire, call.signal));
      this.current(request, prepared, context, call);
      if (!boundedJson(raw, 16_384) || raw.profileId !== 'pwce-agent-gateway.v1' || raw.profileVersion !== '1.0.0' || raw.requestId !== request.requestId || raw.correlationId !== request.correlationId || raw.worldRef !== binding.worldRef || raw.executionEnvironmentRef !== binding.executionEnvironmentRef) return fail('response_scope_mismatch');
      const keys = Object.keys(raw).filter(key => !['profileId','profileVersion','requestId','correlationId','worldRef','executionEnvironmentRef'].includes(key)).sort().join(',');
      if (!['limitations,outcome,rationaleCodes,requirements','capabilityRef,effectClass,limitations,outcome,rationaleCodes,requirements'].includes(keys) ||
        !['allowed','denied','approval_required'].includes(raw.outcome as string) || !Array.isArray(raw.rationaleCodes) || !raw.rationaleCodes.length || raw.rationaleCodes.length > 16 || raw.rationaleCodes.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) ||
        !Array.isArray(raw.limitations) || raw.limitations.length > 8 || raw.limitations.some(value => typeof value !== 'string' || value.length > 500) ||
        !isDeepStrictEqual(raw.requirements, raw.outcome === 'approval_required' ? ['runtime_human_approval'] : []) ||
        raw.outcome === 'allowed' && prepared.approval.required && prepared.approval.reference === null ||
        raw.outcome === 'allowed' && (raw.capabilityRef !== descriptor.capabilityRef || raw.effectClass !== descriptor.effectClass) ||
        raw.capabilityRef !== undefined && raw.capabilityRef !== descriptor.capabilityRef || raw.effectClass !== undefined && raw.effectClass !== descriptor.effectClass) return fail('invalid_decision');
      // Recheck the original producer source after evaluation; a fresh snapshot
      // or an older preview cannot replace this operation's custody.
      await call.wait(this.options.catalog.revalidate(request, { ...context, signal: call.signal })); this.current(request, prepared, context, call);
      const bytes = new TextEncoder().encode(canonicalJson(raw)), sha256 = createHash('sha256').update(bytes).digest('hex');
      const decisionId = randomUUID(), disposition = raw.outcome === 'allowed' ? 'authorized' : raw.outcome === 'approval_required' ? 'approvalRequired' : 'denied';
      const decision: Decision = { schemaVersion: '1.0.0', authorityKind: 'external', decisionId, kind: 'preview', providerRef: this.options.providerRef, invocationId: request.payload.invocationId, inputDigest: request.payload.inputDigest, scopeDigest: digest(request.payload.scope),
        authorityContextRef: request.scope.authorityContextRef!, executionMode: request.executionMode, disposition, reason: { code: `pwce_${disposition}`, summary: `PWCE authority preview returned ${raw.outcome}; original rationale is retained in provider evidence.` },
        evaluatedAt: new Date().toISOString(), admittedAt: null, expiresAt: new Date(Math.min(Date.parse(request.deadlineAt), Date.parse(record.snapshot.expiresAt))).toISOString(),
        evidenceRef: { reference: `pwce:authority-preview:${decisionId}`, sha256, byteLength: bytes.length, mediaType: 'application/json', schemaRef: 'https://pwce.local/contracts/pwce-agent-gateway-response-1.0.0.schema.json' }, scope: request.scope, correlationId: request.correlationId, snapshotId: request.payload.snapshotId, snapshotRevision: request.payload.snapshotRevision };
      const result: M.AuthorityResult = { schemaVersion: '1.0.0', operation: request.operation, requestId: request.requestId, correlationId: request.correlationId, providerRef: this.options.providerRef, completedAt: new Date().toISOString(), outcome: { status: 'succeeded', payload: decision, error: null } };
      if (!validator.validate(base + 'AuthorityResult', result).valid) return fail('invalid_projection');
      this.current(request, prepared, context, call); this.prune(); if (this.decisions.size >= this.options.capacity!) return fail('decision_capacity');
      this.decisions.set(decision.evidenceRef.reference, { request, prepared, decision: structuredClone(decision), bytes });
      return structuredClone(result);
    } finally { call.close(); }
  }
  async readEvidence(reference: M.ArtifactRef, input: M.AuthorityRequest, context: ProviderCallContext): Promise<Uint8Array> {
    if (!boundedJson(input) || !validator.validate(base + 'AuthorityRequest', input).valid || !boundedJson(reference, 4096)) return fail('invalid_request');
    const request = structuredClone(input), owned = structuredClone(reference), call = this.call(request, context);
    try {
      call.check(); this.prune(); const record = this.decisions.get(owned.reference);
      if (!record || !isDeepStrictEqual(record.decision.evidenceRef, owned) || !isDeepStrictEqual(record.request.scope, request.scope) || !isDeepStrictEqual(record.request.payload, request.payload) || record.request.executionMode !== request.executionMode || record.request.correlationId !== request.correlationId) return fail('evidence_unavailable');
      this.current(request, record.prepared, context, call);
      await call.wait(this.options.catalog.revalidate(request, { ...context, signal: call.signal })); this.current(request, record.prepared, context, call);
      if (Date.parse(record.decision.expiresAt) <= Date.now()) return fail('evidence_unavailable');
      return new Uint8Array(record.bytes);
    } finally { call.close(); }
  }
  /** Last synchronous fence for a previously resolved preview; no new authority. */
  assertDispatchCurrent(input: M.AuthorityDispatchRequest, prepared: PwcePreparedAction, context: ProviderCallContext): void {
    if (!boundedJson(input) || !validator.validate(base+'AuthorityDispatchRequest',input).valid) return fail('invalid_request');
    const request=structuredClone(input), required=request.payload.requiredProviderDisposition;
    this.prune();const record=this.decisions.get(required.evidenceRef.reference);
    const {expectedGrantRevision:_revision,requiredProviderDisposition:_disposition,...payload}=request.payload;
    if(!record || !isDeepStrictEqual(pwceGovernedDisposition(record.decision),required) || required.disposition!=='authorized' || !isDeepStrictEqual(record.prepared,prepared) || !isDeepStrictEqual(record.request.scope,request.scope) || !isDeepStrictEqual(record.request.payload,payload) || record.request.executionMode!==request.executionMode || record.request.correlationId!==request.correlationId) return fail('preview_unavailable');
    const evaluation: M.AuthorityRequest={...request,operation:'AuthorityProvider.evaluate',payload}, call=this.call(evaluation,context);
    try { this.current(evaluation,record.prepared,context,call); } finally { call.close(); }
  }
  /** Resolve only this adapter's original, currently authorized preview. */
  async resolveDispatch(input: M.AuthorityDispatchRequest, context: ProviderCallContext): Promise<PwcePreparedAction> {
    if (!boundedJson(input) || !validator.validate(base+'AuthorityDispatchRequest',input).valid) return fail('invalid_request');
    const request=structuredClone(input), required=request.payload.requiredProviderDisposition;
    this.prune();const record=this.decisions.get(required.evidenceRef.reference);
    const {expectedGrantRevision:_revision,requiredProviderDisposition:_disposition,...payload}=request.payload;
    if(!record || !isDeepStrictEqual(pwceGovernedDisposition(record.decision),required) || required.disposition!=='authorized' || !isDeepStrictEqual(record.request.scope,request.scope) || !isDeepStrictEqual(record.request.payload,payload) || record.request.executionMode!==request.executionMode || record.request.correlationId!==request.correlationId) return fail('preview_unavailable');
    const evaluation: M.AuthorityRequest={...request,operation:'AuthorityProvider.evaluate',payload};
    await this.readEvidence(required.evidenceRef,evaluation,context);
    return structuredClone(record.prepared);
  }
}
