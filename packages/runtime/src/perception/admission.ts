import {createHash, randomUUID} from 'node:crypto';
import type {VisualBounds, VisualFrame, VisualMediaType, VisualPerceptionProvider, VisualPerceptionRequest, VisualPerceptionResult, VisualScope} from './port.ts';
import {referenceVisualBounds} from './port.ts';

export type VisualDropReason = 'disabled' | 'unsupported' | 'unconfigured' | 'source_unavailable' | 'permission_denied' | 'lease_conflict' | 'stale_revision' | 'stale_lease' | 'scope_changed' | 'clock_challenge_invalid' | 'clock_uncertain' | 'frame_invalid' | 'frame_oversize' | 'frame_stale' | 'frame_future' | 'rate_limited' | 'foreground_priority' | 'provider_unavailable' | 'provider_invalid' | 'deadline' | 'replaced' | 'cancelled';
export class VisualAdmissionError extends Error {
  readonly reason: VisualDropReason;
  constructor(reason: VisualDropReason) { super(reason); this.reason = reason; }
}

export type CaptureAuthority = Readonly<{
  sourceConnected: boolean;
  devicePermission: boolean;
  hostCaptureLease: boolean;
  interpretationAllowed: boolean;
  remoteEgressAllowed: boolean;
  foregroundVisible: boolean;
}>;

type ClockChallenge = {id: string; sentMono: number; sentUtc: number; expiresMono: number};
type ClockMapping = {id: string; endpointClockId: string; endpointReceivedMono: number; hostSentMono: number; hostReceivedMono: number; anchorUtc: number; expiresMono: number};
type Lease = {id: string; scope: VisualScope; revision: number; expiresMono: number; mapping: ClockMapping; lastAdmissionMono: number; lastSequence: number; lastCaptureMono: number; lastUsableCaptureMono: number | null};
type Job = {request: VisualPerceptionRequest; buffers: Uint8Array[]; decodedBytes: number; capturedEarliestMono: number; deadlineMono: number; settle: (result: VisualPerceptionResult) => void; controller: AbortController; cancelReason: VisualDropReason | null};
type SessionState = {revision: number; challenge: ClockChallenge | undefined; lease: Lease | undefined; pending: Job | undefined; inFlight: Job | undefined};

export type VisualNegotiation = Readonly<{
  profile: 'lifestream.conversational-vision.v1' | null;
  selectedVersion: '1.0.0' | null;
  implemented: boolean;
  configured: boolean;
  providerConnected: boolean;
  sourceConnected: boolean;
  mediaTypes: readonly VisualMediaType[];
  bounds: VisualBounds;
  challenge: Readonly<{id: string; hostSentMonotonicMs: number; hostSentAt: string; expiresAt: string}> | null;
}>;

export type CameraState = Readonly<{
  revision: number;
  captureActive: boolean;
  activeForSession: boolean;
  reason: VisualDropReason | null;
  leaseId: string | null;
  expiresAtMonotonicMs: number | null;
  clockMappingId: string | null;
  currentObservationUsable: boolean;
}>;

const scopeEqual = (a: VisualScope, b: VisualScope) => JSON.stringify(a) === JSON.stringify(b);
const failure = (requestId: string, reason: VisualDropReason): VisualPerceptionResult => ({requestId, status: reason === 'deadline' ? 'timedOut' : reason === 'cancelled' || reason === 'replaced' ? 'cancelled' : 'rejected', observations: [], reason});
const header = (bytes: Uint8Array, mediaType: VisualMediaType): {width: number; height: number} | null => {
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {width: view.getUint32(16), height: view.getUint32(20)};
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0xff) { offset++; continue; }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 7) return null;
      return {height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!, width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!};
    }
    offset += 2 + length;
  }
  return null;
};

export type VisualAdmissionOptions = Readonly<{
  provider?: VisualPerceptionProvider;
  bounds?: Partial<VisualBounds>;
  monotonicMs?: () => number;
  utcMs?: () => number;
  newId?: () => string;
  optionalWorkReady?: () => boolean;
  currentScope?: (scope: VisualScope) => boolean;
  onLeaseEnded?: (scope: VisualScope, leaseId: string, reason: 'stop' | 'expired' | 'invalidated') => void;
}>;

/** In-memory, session-bound admission. No frames or leases are restored after a restart. */
export class VisualAdmission {
  readonly bounds: VisualBounds;
  private readonly sessions = new Map<string, SessionState>();
  private readonly mono: () => number;
  private readonly utc: () => number;
  private readonly id: () => string;
  private readonly provider: VisualPerceptionProvider | undefined;
  private readonly optionalWorkReady: () => boolean;
  private readonly currentScope: (scope: VisualScope) => boolean;
  private readonly onLeaseEnded: VisualAdmissionOptions['onLeaseEnded'];
  private providerPoisoned = false;
  private modelBusy = false;

  constructor(options: VisualAdmissionOptions = {}) {
    this.bounds = Object.freeze(Object.fromEntries(Object.entries(referenceVisualBounds).map(([key, max]) => {
      const requested = options.bounds?.[key as keyof VisualBounds];
      if (requested === undefined) return [key, max];
      if (!Number.isSafeInteger(requested) || requested <= 0 || requested > max) throw new Error(`invalid visual bound ${key}`);
      return [key, requested];
    })) as VisualBounds);
    if (options.provider && !options.provider.supportsCancellation) throw new Error('visual provider requires cancellation or an isolating worker');
    this.provider = options.provider;
    this.mono = options.monotonicMs ?? (() => performance.now());
    this.utc = options.utcMs ?? (() => Date.now());
    this.id = options.newId ?? randomUUID;
    this.optionalWorkReady = options.optionalWorkReady ?? (() => true);
    this.currentScope = options.currentScope ?? (() => true);
    this.onLeaseEnded = options.onLeaseEnded;
  }

  private scopeCurrent(scope: VisualScope): boolean { try { return this.currentScope(scope) === true; } catch { return false; } }
  private providerReady(): boolean { try { return !!this.provider && !this.providerPoisoned && this.provider.healthy(); } catch { return false; } }
  private optionalReady(): boolean { try { return this.optionalWorkReady() === true; } catch { return false; } }

  private stateFor(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      if (this.sessions.size >= 64) {
        const retired = [...this.sessions].find(([,candidate]) => !candidate.lease && !candidate.pending && !candidate.inFlight);
        if (!retired) throw new VisualAdmissionError('lease_conflict');
        this.sessions.delete(retired[0]);
      }
      state = {revision: 0, challenge: undefined, lease: undefined, pending: undefined, inFlight: undefined}; this.sessions.set(sessionId, state);
    }
    if (state.challenge && state.challenge.expiresMono < this.mono()) state.challenge = undefined;
    if (state.lease && state.lease.expiresMono <= this.mono()) {
      const expired = state.lease;
      state.lease = undefined; state.challenge = undefined; state.revision++;
      if (state.pending) { state.pending.settle(failure(state.pending.request.requestId, 'stale_lease')); this.dispose(state.pending); state.pending = undefined; }
      if (state.inFlight) { state.inFlight.cancelReason = 'cancelled'; state.inFlight.controller.abort(); }
      this.leaseEnded(expired,'expired');
    }
    return state;
  }

  negotiate(scope: VisualScope, supportedVersions: readonly string[], sourceConnected: boolean): VisualNegotiation {
    const state = this.stateFor(scope.sessionId), now = this.mono(), utc = this.utc();
    const selected = supportedVersions.includes('1.0.0') && !!this.provider && !this.providerPoisoned;
    const provider = this.provider, healthy = this.providerReady();
    const challenge = selected ? {id: this.id(), sentMono: now, sentUtc: utc, expiresMono: now + 5_000} : undefined;
    state.challenge = challenge;
    return {
      profile: selected ? 'lifestream.conversational-vision.v1' : null,
      selectedVersion: selected ? '1.0.0' : null,
      implemented: true, configured: !!provider, providerConnected: healthy, sourceConnected,
      mediaTypes: healthy ? provider!.mediaTypes.filter(type => type === 'image/jpeg' || type === 'image/png') : [],
      bounds: this.bounds,
      challenge: challenge ? {id: challenge.id, hostSentMonotonicMs: now, hostSentAt: new Date(utc).toISOString(), expiresAt: new Date(utc + 5_000).toISOString()} : null
    };
  }

  enable(scope: VisualScope, input: {expectedRevision: number; challengeId: string; endpointClockId: string; endpointReceivedMonotonicMs: number}, authority: CaptureAuthority): CameraState {
    const state = this.stateFor(scope.sessionId), now = this.mono();
    if (state.revision !== input.expectedRevision || state.lease) throw new VisualAdmissionError('stale_revision');
    if (!this.scopeCurrent(scope)) throw new VisualAdmissionError('scope_changed');
    if (!authority.sourceConnected || !scope.sourceBindingRef) throw new VisualAdmissionError('source_unavailable');
    if (!authority.devicePermission || !authority.interpretationAllowed || !authority.foregroundVisible) throw new VisualAdmissionError('permission_denied');
    if (!authority.hostCaptureLease) throw new VisualAdmissionError('lease_conflict');
    if (!this.provider) throw new VisualAdmissionError('unconfigured');
    if (!this.providerReady()) throw new VisualAdmissionError('provider_unavailable');
    if (this.provider?.dataEgressClass === 'configuredRemote' && !authority.remoteEgressAllowed) throw new VisualAdmissionError('permission_denied');
    if ([...this.sessions.values()].filter(s => s.lease && s.lease.expiresMono > now).length >= this.bounds.maxHostSessions) throw new VisualAdmissionError('lease_conflict');
    const mapping = this.consumeChallenge(state, input, now);
    state.lease = {id: this.id(), scope: structuredClone(scope), revision: ++state.revision, expiresMono: now + this.bounds.leaseTtlMs, mapping, lastAdmissionMono: -Infinity, lastSequence: -1, lastCaptureMono: -Infinity, lastUsableCaptureMono: null};
    return this.cameraState(scope.sessionId);
  }

  renew(scope: VisualScope, leaseId: string, input: {expectedRevision: number; challengeId: string; endpointClockId: string; endpointReceivedMonotonicMs: number}, authority: CaptureAuthority): CameraState {
    const state = this.stateFor(scope.sessionId), lease = state.lease, now = this.mono();
    if (!lease || lease.id !== leaseId || lease.expiresMono <= now) throw new VisualAdmissionError('stale_lease');
    if (state.revision !== input.expectedRevision || !scopeEqual(lease.scope, scope) || !this.scopeCurrent(scope)) throw new VisualAdmissionError('scope_changed');
    if (!authority.sourceConnected || !authority.devicePermission || !authority.hostCaptureLease || !authority.interpretationAllowed || !authority.foregroundVisible || (this.provider?.dataEgressClass === 'configuredRemote' && !authority.remoteEgressAllowed)) { this.stop(scope.sessionId, leaseId, scope.principalId); throw new VisualAdmissionError('permission_denied'); }
    lease.mapping = this.consumeChallenge(state, input, now);
    lease.expiresMono = now + this.bounds.leaseTtlMs;
    lease.revision = ++state.revision;
    return this.cameraState(scope.sessionId);
  }

  private consumeChallenge(state: SessionState, input: {challengeId: string; endpointClockId: string; endpointReceivedMonotonicMs: number}, now: number): ClockMapping {
    const challenge = state.challenge;
    state.challenge = undefined;
    if (!challenge || challenge.id !== input.challengeId || now > challenge.expiresMono || !input.endpointClockId || !Number.isFinite(input.endpointReceivedMonotonicMs) || input.endpointReceivedMonotonicMs < 0 || now < challenge.sentMono) throw new VisualAdmissionError('clock_challenge_invalid');
    if (now - challenge.sentMono > this.bounds.maxClockUncertaintyMs) throw new VisualAdmissionError('clock_uncertain');
    return {id: this.id(), endpointClockId: input.endpointClockId, endpointReceivedMono: input.endpointReceivedMonotonicMs, hostSentMono: challenge.sentMono, hostReceivedMono: now, anchorUtc: challenge.sentUtc, expiresMono: now + this.bounds.leaseTtlMs};
  }

  cameraState(sessionId: string): CameraState {
    const state = this.stateFor(sessionId), lease = state.lease, now = this.mono();
    if (lease && !this.scopeCurrent(lease.scope)) { this.endLease(state,lease,'invalidated'); return this.cameraState(sessionId); }
    const captureActive = !!lease && lease.expiresMono > now && this.scopeCurrent(lease.scope);
    const providerHealthy = this.providerReady();
    const usable = captureActive && providerHealthy && lease!.lastUsableCaptureMono !== null && now - lease!.lastUsableCaptureMono <= this.bounds.freshnessMs;
    return {revision: state.revision, captureActive, activeForSession: usable, reason: !captureActive ? 'disabled' : !providerHealthy ? 'provider_unavailable' : !usable ? 'frame_stale' : null, leaseId: captureActive ? lease!.id : null, expiresAtMonotonicMs: captureActive ? lease!.expiresMono : null, clockMappingId: captureActive ? lease!.mapping.id : null, currentObservationUsable: usable};
  }

  cameraStateFor(sessionId:string,principalId:string,assistantId:string):CameraState {
    const current=this.cameraState(sessionId),lease=this.sessions.get(sessionId)?.lease;
    if(lease?.scope.principalId===principalId&&lease.scope.assistantId===assistantId)return current;
    return {...current,captureActive:false,activeForSession:false,reason:'disabled',leaseId:null,expiresAtMonotonicMs:null,clockMappingId:null,currentObservationUsable:false};
  }

  stop(sessionId: string, leaseId: string, principalId: string, assistantId?:string): CameraState {
    const state = this.stateFor(sessionId), lease = state.lease;
    if (lease && lease.id === leaseId && lease.scope.principalId === principalId && (assistantId===undefined||lease.scope.assistantId===assistantId)) {
      this.endLease(state,lease,'stop');
    }
    return this.cameraState(sessionId);
  }

  invalidate(sessionId: string): void {
    const lease = this.sessions.get(sessionId)?.lease;
    if (lease) this.endLease(this.sessions.get(sessionId)!,lease,'invalidated');
  }

  close(): void {
    for (const [sessionId] of this.sessions) this.invalidate(sessionId);
    this.sessions.clear();
  }

  private endLease(state: SessionState, lease: Lease, reason: 'stop' | 'invalidated'): void {
    state.lease = undefined; state.challenge = undefined; state.revision++;
    if (state.pending) { this.dispose(state.pending); state.pending.settle(failure(state.pending.request.requestId, 'cancelled')); state.pending = undefined; }
    if (state.inFlight) { state.inFlight.cancelReason = 'cancelled'; state.inFlight.controller.abort(); }
    this.leaseEnded(lease,reason);
  }

  private leaseEnded(lease: Lease, reason: 'stop' | 'expired' | 'invalidated'): void {
    try { this.onLeaseEnded?.(structuredClone(lease.scope),lease.id,reason); } catch { /* Failure to release a broker lease cannot restore capture authorization. */ }
  }

  submit(scope: VisualScope, leaseId: string, endpointClockId: string, frames: readonly VisualFrame[], correlationId: string): {requestId: string; queued: boolean; completion: Promise<VisualPerceptionResult>} {
    const state = this.stateFor(scope.sessionId), lease = state.lease, now = this.mono(), requestId = this.id();
    if (!lease || lease.id !== leaseId || lease.expiresMono <= now || lease.mapping.expiresMono <= now) throw new VisualAdmissionError('stale_lease');
    if (!scopeEqual(scope, lease.scope) || !this.scopeCurrent(scope)) throw new VisualAdmissionError('scope_changed');
    if (endpointClockId !== lease.mapping.endpointClockId) throw new VisualAdmissionError('clock_challenge_invalid');
    const provider = this.provider;
    if (!provider || !this.providerReady()) throw new VisualAdmissionError('provider_unavailable');
    if (!this.optionalReady()) throw new VisualAdmissionError('foreground_priority');
    if (!frames.length || frames.length > this.bounds.maxFramesPerBatch || (frames.length > 1 && (!provider.supportsMultipleFrames || !provider.supportsTemporalInput))) throw new VisualAdmissionError('frame_invalid');
    if (now - lease.lastAdmissionMono < this.bounds.minAdmissionIntervalMs) throw new VisualAdmissionError('rate_limited');
    let bytes = 0, decoded = 0, first = Infinity, last = -Infinity, earliest = Infinity, latest = -Infinity;
    let priorSequence = lease.lastSequence, priorCapture = lease.lastCaptureMono;
    const seen = new Set<string>();
    for (const frame of frames) {
      if (frame.clockMappingId !== lease.mapping.id || !frame.frameId || seen.has(frame.frameId) || !Number.isSafeInteger(frame.sequence) || frame.sequence <= priorSequence || !Number.isFinite(frame.capturedMonotonicMs) || frame.capturedMonotonicMs <= priorCapture || frame.capturedMonotonicMs - priorCapture < 1000 / this.bounds.maxCaptureFramesPerSecond) throw new VisualAdmissionError('frame_invalid');
      if (!provider.mediaTypes.includes(frame.mediaType) || frame.bytes.length > this.bounds.maxFrameBytes) throw new VisualAdmissionError('frame_oversize');
      const dimensions = header(frame.bytes, frame.mediaType);
      if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || Math.max(dimensions.width, dimensions.height) > this.bounds.maxLongEdgePixels) throw new VisualAdmissionError('frame_invalid');
      if (createHash('sha256').update(frame.bytes).digest('hex') !== frame.sha256) throw new VisualAdmissionError('frame_invalid');
      bytes += frame.bytes.length;
      decoded += dimensions.width * dimensions.height * 4;
      const elapsed = Math.abs(frame.capturedMonotonicMs - lease.mapping.endpointReceivedMono);
      const low = frame.capturedMonotonicMs + lease.mapping.hostSentMono - lease.mapping.endpointReceivedMono - elapsed * 0.0001;
      const high = frame.capturedMonotonicMs + lease.mapping.hostReceivedMono - lease.mapping.endpointReceivedMono + elapsed * 0.0001;
      if (high - low > this.bounds.maxClockUncertaintyMs) throw new VisualAdmissionError('clock_uncertain');
      if (low > now) throw new VisualAdmissionError('frame_future');
      if (now - low > this.bounds.freshnessMs) throw new VisualAdmissionError('frame_stale');
      first = Math.min(first, frame.capturedMonotonicMs); last = Math.max(last, frame.capturedMonotonicMs);
      earliest = Math.min(earliest, low); latest = Math.max(latest, high);
      priorSequence = frame.sequence; priorCapture = frame.capturedMonotonicMs; seen.add(frame.frameId);
    }
    const inFlightBytes = state.inFlight?.buffers.reduce((sum, buffer) => sum + buffer.length, 0) ?? 0;
    const inFlightDecoded = state.inFlight?.decodedBytes ?? 0;
    if (last - first > this.bounds.maxBatchSpanMs || bytes > this.bounds.maxFramesPerBatch * this.bounds.maxFrameBytes || bytes + inFlightBytes > this.bounds.maxRawBytesPerSession || decoded + inFlightDecoded > this.bounds.maxDecodedBytesPerSession) throw new VisualAdmissionError('frame_oversize');
    const held = frames.map(frame => Uint8Array.from(frame.bytes));
    const receivedUtc = this.utc();
    const request: VisualPerceptionRequest = {requestId, correlationId, environment: 'live', scope: structuredClone(scope), leaseId, capturedAtEarliestMs: lease.mapping.anchorUtc + earliest - lease.mapping.hostSentMono, capturedAtLatestMs: lease.mapping.anchorUtc + latest - lease.mapping.hostSentMono, receivedAtMs: receivedUtc, deadlineAtMs: receivedUtc + this.bounds.deadlineMs, frames: frames.map((frame, index) => ({...frame, bytes: held[index]!}))};
    let settle!: (result: VisualPerceptionResult) => void;
    const completion = new Promise<VisualPerceptionResult>(resolve => { settle = resolve; });
    const job: Job = {request, buffers: held, decodedBytes: decoded, capturedEarliestMono: earliest, deadlineMono: now + this.bounds.deadlineMs, settle, controller: new AbortController(), cancelReason: null};
    lease.lastAdmissionMono = now; lease.lastSequence = priorSequence; lease.lastCaptureMono = priorCapture;
    const queued = this.modelBusy || !!state.inFlight;
    if (queued) {
      if (state.pending) { state.pending.settle(failure(state.pending.request.requestId, 'replaced')); this.dispose(state.pending); }
      state.pending = job;
    } else this.run(state, job);
    return {requestId, queued, completion};
  }

  private run(state: SessionState, job: Job): void {
    this.modelBusy = true; state.inFlight = job;
    const provider = this.provider!;
    const deadline = setTimeout(() => { job.cancelReason = 'deadline'; job.controller.abort(); }, this.bounds.deadlineMs);
    const timedOut = new Promise<VisualPerceptionResult>(resolve => job.controller.signal.addEventListener('abort', () => resolve(failure(job.request.requestId, job.cancelReason ?? 'cancelled')), {once: true}));
    let providerSettled = false;
    const executed = Promise.resolve().then(() => provider.interpret(job.request, job.controller.signal)).finally(() => { providerSettled = true; });
    void Promise.race([executed, timedOut]).then(raw => {
      const lease = state.lease;
      let result = this.validResult(raw, job.request) ? raw : failure(job.request.requestId, 'provider_invalid');
      if (job.cancelReason) result = failure(job.request.requestId, job.cancelReason);
      else if (result.status !== 'cancelled' && this.mono() >= job.deadlineMono) result = failure(job.request.requestId, 'deadline');
      else if (result.status !== 'cancelled' && (!lease || lease.id !== job.request.leaseId || !scopeEqual(lease.scope, job.request.scope) || !this.scopeCurrent(job.request.scope))) result = failure(job.request.requestId, 'scope_changed');
      else if (lease && result.status === 'complete' && result.observations.length) lease.lastUsableCaptureMono = job.capturedEarliestMono;
      return result;
    }, () => failure(job.request.requestId, 'provider_unavailable')).then(result => {
      clearTimeout(deadline); this.dispose(job);
      job.settle(result);
      const retire = () => {
        if (state.inFlight === job) state.inFlight = undefined;
        this.modelBusy = false;
        for (const owner of this.sessions.values()) {
          const next = owner.pending;
          if (!next) continue;
          owner.pending = undefined;
          const validLease = !!owner.lease && owner.lease.id === next.request.leaseId && scopeEqual(owner.lease.scope,next.request.scope) && this.scopeCurrent(next.request.scope);
          const reason: VisualDropReason | null = this.mono() >= next.deadlineMono ? 'deadline' : !validLease ? 'scope_changed' : !this.providerReady() ? 'provider_unavailable' : !this.optionalReady() ? 'foreground_priority' : null;
          if (reason) { this.dispose(next); next.settle(failure(next.request.requestId, reason)); continue; }
          this.run(owner, next);
          return;
        }
      };
      if (providerSettled) { retire(); return; }
      // Aborted providers retain the one model slot until they exit. A provider
      // that ignores cancellation is quarantined after a finite grace period.
      let retirementTimer: ReturnType<typeof setTimeout>;
      void Promise.race([
        executed.then(() => true, () => true),
        new Promise<boolean>(resolve => { retirementTimer = setTimeout(() => resolve(false), Math.min(1_000, this.bounds.deadlineMs)); })
      ]).then(settled => {
        clearTimeout(retirementTimer);
        if (!settled && !providerSettled) this.providerPoisoned = true;
        retire();
      });
    });
  }

  private validResult(value: unknown, request: VisualPerceptionRequest): value is VisualPerceptionResult {
    if (!value || typeof value !== 'object') return false;
    const result = value as Partial<VisualPerceptionResult>;
    if (result.requestId !== request.requestId || typeof result.status !== 'string' || !['complete','empty','rejected','cancelled','timedOut','failed'].includes(result.status) || !Array.isArray(result.observations) || result.observations.length > 32 || (result.status !== 'complete' && result.observations.length !== 0) || (result.reason !== null && typeof result.reason !== 'string')) return false;
    const ids = new Set(request.frames.map(frame => frame.frameId));
    try {
      return result.observations.every(item => item && typeof item === 'object' && typeof item.observationId === 'string' && item.observationId.length > 0 && Array.isArray(item.frameIds) && item.frameIds.length > 0 && item.frameIds.every((id: string) => ids.has(id)) && typeof item.appearance === 'string' && item.appearance.length > 0 && (item.inference === null || typeof item.inference === 'string') && (item.confidence === null || typeof item.confidence === 'number' && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1) && Array.isArray(item.limitations) && item.limitations.every((limit: string) => typeof limit === 'string') && Buffer.byteLength(JSON.stringify(item)) <= 8_192);
    } catch { return false; }
  }

  private dispose(job: Job): void { for (const buffer of job.buffers) buffer.fill(0); }
}
