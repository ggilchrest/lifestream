import {VisualAdmission, VisualAdmissionError, type CaptureAuthority} from '@lifestream/runtime/perception/admission';
import {validateVisualInput,type VisualCapabilitiesRequest,type VisualCameraRequest,type VisualBatchRequest} from '@lifestream/contracts/visual-input';
import {MAX_VISUAL_METADATA_BYTES,VISUAL_FRAMING_BYTES} from './visual-multipart.ts';
import type {VisualBounds, VisualFrame, VisualMediaType, VisualPerceptionProvider, VisualScope} from '@lifestream/runtime/perception/port';

export type VisualActor = Readonly<{principalId: string; sessionId: string; assistantId: string}>;
export type VisualSource = Readonly<{bindingRef: string; connected: boolean; configurationRevision: number}>;
export type VisualInputOptions = Readonly<{
  provider?: VisualPerceptionProvider;
  scopeFor: (actor: VisualActor) => Omit<VisualScope, 'sourceBindingRef' | 'captureConfigurationRevision'> | null;
  sourceFor: (actor: VisualActor, endpointId: string) => VisualSource | null;
  captureAuthority: (actor: VisualActor, scope: VisualScope) => CaptureAuthority;
  releaseCapture?: (actor: VisualActor, scope: VisualScope, leaseId: string, reason: 'stop' | 'expired' | 'invalidated') => void;
  optionalWorkReady?: () => boolean;
  bounds?: Partial<VisualBounds>;
  monotonicMs?: () => number;
  utcMs?: () => number;
  newId?: () => string;
}>;

export type CameraInput = Readonly<{
  action: 'enable' | 'renew' | 'stop';
  expectedRevision: number;
  idempotencyKey: string;
  leaseId?: string;
  challengeId?: string;
  endpointClockId?: string;
  endpointReceivedMonotonicMs?: number;
}>;

export type BatchMeta = Readonly<{
  leaseId: string;
  endpointClockId: string;
  correlationId: string;
  frames: readonly Readonly<{frameId: string; sequence: number; capturedMonotonicMs: number; clockMappingId: string; mediaType: VisualMediaType; sha256: string}>[];
}>;

export class VisualUploadError extends Error {
  readonly status: 429 | 503;
  readonly code: 'visual_upload_busy' | 'visual_upload_capacity';
  constructor(status:429 | 503, code:VisualUploadError['code']) { super(code); this.status=status; this.code=code; }
}

export class VisualInputRequestError extends Error {
  readonly code = 'visual_request_invalid';
  readonly status = 422;
  constructor() { super('Invalid visual request.'); }
}

/** Public HTTP adapter validation; canonical provider envelopes remain a separate boundary. */
export function parseVisualCapabilities(value: unknown): VisualCapabilitiesRequest {
  if (!validateVisualInput('capabilitiesRequest',value).valid) throw new VisualInputRequestError();
  return value as VisualCapabilitiesRequest;
}

export function parseVisualCamera(value: unknown): VisualCameraRequest {
  if (!validateVisualInput('cameraRequest',value).valid) throw new VisualInputRequestError();
  return value as VisualCameraRequest;
}

export function parseVisualBatch(value: unknown): VisualBatchRequest {
  if (!validateVisualInput('batchRequest',value).valid) throw new VisualInputRequestError();
  const batch=value as VisualBatchRequest;
  // JSON Schema uniqueItems cannot express unique frame IDs with different metadata.
  if (new Set(batch.frames.map(frame=>frame.frameId)).size!==batch.frames.length) throw new VisualInputRequestError();
  return batch;
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Binds an authenticated session to a host-owned physical source and policy. */
export class VisualInputHost {
  private readonly runtime: VisualAdmission;
  private readonly options: VisualInputOptions;
  private readonly commands = new Map<string, CameraInput>();
  private readonly uploads = new Map<string,AbortController>();

  constructor(options: VisualInputOptions) {
    this.options = options;
    this.runtime = new VisualAdmission({
      ...(options.provider ? {provider: options.provider} : {}),
      ...(options.optionalWorkReady ? {optionalWorkReady: options.optionalWorkReady} : {}),
      ...(options.bounds ? {bounds:options.bounds} : {}),
      ...(options.monotonicMs ? {monotonicMs:options.monotonicMs} : {}),
      ...(options.utcMs ? {utcMs:options.utcMs} : {}),
      ...(options.newId ? {newId:options.newId} : {}),
      onLeaseEnded: (scope,leaseId,reason) => { this.cancelUpload(scope.sessionId); options.releaseCapture?.({principalId:scope.principalId,sessionId:scope.sessionId,assistantId:scope.assistantId},scope,leaseId,reason); },
      currentScope: scope => {
        const actor = {principalId:scope.principalId,sessionId:scope.sessionId,assistantId:scope.assistantId};
        const current = this.scope(actor);
        if (current === null || !same(current,scope)) return false;
        const authority=options.captureAuthority(actor,current);
        return authority.sourceConnected && authority.devicePermission && authority.hostCaptureLease && authority.interpretationAllowed && authority.foregroundVisible && (options.provider?.dataEgressClass!=='configuredRemote'||authority.remoteEgressAllowed);
      }
    });
  }

  openUpload(sessionId: string) {
    if (this.uploads.has(sessionId)) throw new VisualUploadError(429,'visual_upload_busy');
    if (this.uploads.size >= this.runtime.bounds.maxHostSessions) throw new VisualUploadError(503,'visual_upload_capacity');
    const limits = {maxFrameBytes:this.runtime.bounds.maxFrameBytes,maxFrames:this.runtime.bounds.maxFramesPerBatch,
      maxRequestBytes:MAX_VISUAL_METADATA_BYTES + this.runtime.bounds.maxFramesPerBatch*this.runtime.bounds.maxFrameBytes + VISUAL_FRAMING_BYTES,deadlineMs:5_000};
    const releaseBytes=this.runtime.reserveIngress(sessionId,limits.maxRequestBytes), controller=new AbortController();
    this.uploads.set(sessionId,controller);
    let released=false;
    return {limits,signal:controller.signal,cancel:()=>controller.abort(),release:()=>{
      if (released) return;
      released=true; releaseBytes();
      if (this.uploads.get(sessionId)===controller) this.uploads.delete(sessionId);
    }};
  }

  private cancelUpload(sessionId:string) { this.uploads.get(sessionId)?.abort(); }
  resourceUsage() { return this.runtime.resourceUsage(); }

  private scope(actor: VisualActor): VisualScope | null {
    const base = this.options.scopeFor(actor);
    if (!base || base.principalId !== actor.principalId || base.sessionId !== actor.sessionId || base.assistantId !== actor.assistantId || !base.endpointId) return null;
    const source = this.options.sourceFor(actor,base.endpointId);
    if (!source?.bindingRef || !source.connected) return null;
    return {...base,sourceBindingRef:source.bindingRef,captureConfigurationRevision:source.configurationRevision};
  }

  capabilities(actor: VisualActor, supportedVersions: readonly string[]) {
    const scope = this.scope(actor);
    if (!scope) return {available:false,reason:'source_unavailable' as const,negotiation:null,camera:this.runtime.cameraStateFor(actor.sessionId,actor.principalId,actor.assistantId)};
    const negotiation = this.runtime.negotiate(scope,supportedVersions,true);
    const reason = !negotiation.configured ? 'unconfigured' : !negotiation.selectedVersion ? 'unsupported' : !negotiation.providerConnected ? 'provider_unavailable' : !negotiation.mediaTypes.length ? 'unsupported' : null;
    return {available:reason === null,reason,negotiation,transport:{maxConcurrentUploadsPerSession:1,maxConcurrentUploadsPerHost:this.runtime.bounds.maxHostSessions,uploadDeadlineMs:5_000},camera:this.runtime.cameraStateFor(actor.sessionId,actor.principalId,actor.assistantId)};
  }

  camera(actor: VisualActor, input: CameraInput) {
    const key = JSON.stringify([actor.principalId,actor.sessionId,input.idempotencyKey]);
    const prior = this.commands.get(key);
    if (prior) {
      if (!same(prior,input)) throw new VisualAdmissionError('stale_revision');
      return this.runtime.cameraStateFor(actor.sessionId,actor.principalId,actor.assistantId);
    }
    let result: ReturnType<VisualAdmission['cameraState']>;
    if (input.action === 'stop') {
      if (!input.leaseId) throw new VisualAdmissionError('stale_lease');
      this.runtime.stop(actor.sessionId,input.leaseId,actor.principalId,actor.assistantId);
      result = this.runtime.cameraStateFor(actor.sessionId,actor.principalId,actor.assistantId);
    } else {
      const scope = this.scope(actor);
      if (!scope) throw new VisualAdmissionError('source_unavailable');
      const source = this.options.sourceFor(actor,scope.endpointId);
      const authority = this.options.captureAuthority(actor,scope);
      if (!source?.connected || !authority.sourceConnected) throw new VisualAdmissionError('source_unavailable');
      if (!input.challengeId || !input.endpointClockId || input.endpointReceivedMonotonicMs === undefined) throw new VisualAdmissionError('clock_challenge_invalid');
      const clock = {expectedRevision:input.expectedRevision,challengeId:input.challengeId,endpointClockId:input.endpointClockId,endpointReceivedMonotonicMs:input.endpointReceivedMonotonicMs};
      result = input.action === 'enable' ? this.runtime.enable(scope,clock,authority) : this.runtime.renew(scope,input.leaseId ?? '',clock,authority);
    }
    this.commands.set(key,structuredClone(input));
    if (this.commands.size > 256) this.commands.delete(this.commands.keys().next().value!);
    return result;
  }

  async batch(actor: VisualActor, meta: BatchMeta, parts: ReadonlyMap<string,Uint8Array>, copied?:()=>void) {
    const scope = this.scope(actor);
    if (!scope) { this.runtime.stop(actor.sessionId,meta.leaseId,actor.principalId,actor.assistantId); throw new VisualAdmissionError('scope_changed'); }
    let authority:CaptureAuthority;
    try { authority=this.options.captureAuthority(actor,scope); } catch { this.runtime.stop(actor.sessionId,meta.leaseId,actor.principalId,actor.assistantId); throw new VisualAdmissionError('permission_denied'); }
    if (!authority.sourceConnected || !authority.devicePermission || !authority.hostCaptureLease || !authority.interpretationAllowed || !authority.foregroundVisible || (this.options.provider?.dataEgressClass==='configuredRemote'&&!authority.remoteEgressAllowed)) {
      this.runtime.stop(actor.sessionId,meta.leaseId,actor.principalId,actor.assistantId); throw new VisualAdmissionError('permission_denied');
    }
    if (!Array.isArray(meta.frames) || meta.frames.length !== parts.size || meta.frames.length > this.runtime.bounds.maxFramesPerBatch || meta.frames.some(frame => !parts.has(frame.frameId))) throw new VisualAdmissionError('frame_invalid');
    const frames: VisualFrame[] = meta.frames.map(frame => ({...frame,bytes:parts.get(frame.frameId)!}));
    const admitted = this.runtime.submit(scope,meta.leaseId,meta.endpointClockId,frames,meta.correlationId);
    copied?.();
    const result = await admitted.completion;
    return {requestId:admitted.requestId,queued:admitted.queued,result};
  }

  state(actor: VisualActor) { return this.runtime.cameraStateFor(actor.sessionId,actor.principalId,actor.assistantId); }
  invalidate(sessionId: string) { this.cancelUpload(sessionId); this.runtime.invalidate(sessionId); }
  close() { for (const upload of this.uploads.values()) upload.abort(); this.runtime.close(); }
}
