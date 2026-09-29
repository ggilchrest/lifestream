/** Public runtime interface. The private conversational-vision schema is not embedded here. */
export type VisualMediaType = 'image/jpeg' | 'image/png';

export type VisualScope = Readonly<{
  assistantId: string;
  principalId: string;
  relationshipId: string | null;
  environmentId: string;
  conversationId: string;
  sessionId: string;
  endpointId: string;
  sessionRevision: number;
  audienceRevision: number;
  scopeGeneration: number;
  sourceBindingRef: string;
  captureConfigurationRevision: number;
}>;

export type VisualBounds = Readonly<{
  maxFramesPerBatch: number;
  maxCaptureFramesPerSecond: number;
  maxBatchSpanMs: number;
  maxFrameBytes: number;
  maxLongEdgePixels: number;
  minAdmissionIntervalMs: number;
  maxRawBytesPerSession: number;
  maxDecodedBytesPerSession: number;
  maxHostSessions: number;
  leaseTtlMs: number;
  renewIntervalMs: number;
  deadlineMs: number;
  freshnessMs: number;
  maxClockUncertaintyMs: number;
}>;

export const referenceVisualBounds: VisualBounds = Object.freeze({
  maxFramesPerBatch: 3,
  maxCaptureFramesPerSecond: 3,
  maxBatchSpanMs: 2_000,
  maxFrameBytes: 2_097_152,
  maxLongEdgePixels: 1_280,
  minAdmissionIntervalMs: 1_000,
  maxRawBytesPerSession: 12_582_912,
  maxDecodedBytesPerSession: 20_971_520,
  maxHostSessions: 4,
  leaseTtlMs: 60_000,
  renewIntervalMs: 20_000,
  deadlineMs: 3_000,
  freshnessMs: 6_000,
  maxClockUncertaintyMs: 250
});

export type VisualFrame = Readonly<{
  frameId: string;
  sequence: number;
  capturedMonotonicMs: number;
  clockMappingId: string;
  mediaType: VisualMediaType;
  sha256: string;
  bytes: Uint8Array;
}>;

export type VisualPerceptionRequest = Readonly<{
  requestId: string;
  correlationId: string;
  environment: 'live' | 'replay';
  scope: VisualScope;
  leaseId: string;
  capturedAtEarliestMs: number;
  capturedAtLatestMs: number;
  receivedAtMs: number;
  deadlineAtMs: number;
  frames: readonly VisualFrame[];
}>;

export type VisualObservation = Readonly<{
  observationId: string;
  frameIds: readonly string[];
  appearance: string;
  inference: string | null;
  confidence: number | null;
  limitations: readonly string[];
}>;

export type VisualPerceptionResult = Readonly<{
  requestId: string;
  status: 'complete' | 'empty' | 'rejected' | 'cancelled' | 'timedOut' | 'failed';
  observations: readonly VisualObservation[];
  reason: string | null;
}>;

export type VisualPerceptionProvider = Readonly<{
  id: string;
  version: string;
  mediaTypes: readonly VisualMediaType[];
  supportsMultipleFrames: boolean;
  supportsTemporalInput: boolean;
  supportsCancellation: boolean;
  dataEgressClass: 'localOnly' | 'configuredRemote';
  healthy: () => boolean;
  interpret: (request: VisualPerceptionRequest, signal: AbortSignal) => Promise<VisualPerceptionResult>;
}>;
