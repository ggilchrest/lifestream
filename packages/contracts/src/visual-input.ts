import {createContractValidator,type ValidationResult} from './validator.ts';

/** Compact HTTP adapter identity; it does not identify the canonical perception envelopes. */
export const visualInputWireProfile = 'lifestream.visual-input-http' as const;
export const visualInputSchemaVersion = '1.0.0' as const;
export const visualInputSchemaId = 'https://lifestream.dev/contracts/visual-input-http/1.0.0' as const;

export type VisualInputMediaType = 'image/jpeg' | 'image/png';
export type VisualInputDropReason = 'disabled' | 'unsupported' | 'unconfigured' | 'source_unavailable' | 'permission_denied' | 'lease_conflict' | 'stale_revision' | 'stale_lease' | 'scope_changed' | 'clock_challenge_invalid' | 'clock_uncertain' | 'frame_invalid' | 'frame_oversize' | 'frame_stale' | 'frame_future' | 'rate_limited' | 'foreground_priority' | 'provider_unavailable' | 'provider_invalid' | 'deadline' | 'replaced' | 'cancelled';
type RequestBase = Readonly<{schemaVersion:typeof visualInputSchemaVersion;assistantId:string}>;
type ResponseBase = Readonly<{schemaVersion:typeof visualInputSchemaVersion;wireProfile:typeof visualInputWireProfile}>;
type CameraCommand = RequestBase & Readonly<{expectedRevision:number;idempotencyKey:string}>;
type ClockEcho = Readonly<{challengeId:string;endpointClockId:string;endpointReceivedMonotonicMs:number}>;

export type VisualCapabilitiesRequest = RequestBase & Readonly<{supportedVersions:readonly string[]}>;
export type VisualCameraRequest =
  | CameraCommand & ClockEcho & Readonly<{action:'enable'}>
  | CameraCommand & ClockEcho & Readonly<{action:'renew';leaseId:string}>
  | CameraCommand & Readonly<{action:'stop';leaseId:string}>;
export type VisualFrameMetadata = Readonly<{frameId:string;sequence:number;capturedMonotonicMs:number;clockMappingId:string;mediaType:VisualInputMediaType;sha256:string}>;
export type VisualBatchRequest = RequestBase & Readonly<{leaseId:string;endpointClockId:string;correlationId:string;frames:readonly VisualFrameMetadata[]}>;

export type VisualInputBounds = Readonly<{
  maxFramesPerBatch:number;maxCaptureFramesPerSecond:number;maxBatchSpanMs:number;maxFrameBytes:number;maxLongEdgePixels:number;
  minAdmissionIntervalMs:number;maxRawBytesPerSession:number;maxDecodedBytesPerSession:number;maxHostSessions:number;
  leaseTtlMs:number;renewIntervalMs:number;deadlineMs:number;freshnessMs:number;maxClockUncertaintyMs:number;
}>;
export type VisualClockChallenge = Readonly<{id:string;hostSentMonotonicMs:number;hostSentAt:string;expiresAt:string}>;
export type VisualNegotiation = Readonly<{
  profile:'lifestream.conversational-vision.v1' | null;selectedVersion:typeof visualInputSchemaVersion | null;
  implemented:true;configured:boolean;providerConnected:boolean;sourceConnected:boolean;
  mediaTypes:readonly VisualInputMediaType[];bounds:VisualInputBounds;challenge:VisualClockChallenge | null;
}>;
export type VisualCameraState = Readonly<{
  revision:number;captureActive:boolean;activeForSession:boolean;reason:VisualInputDropReason | null;
  leaseId:string | null;expiresAtMonotonicMs:number | null;clockMappingId:string | null;currentObservationUsable:boolean;
}>;
export type VisualTransportBounds = Readonly<{maxConcurrentUploadsPerSession:1;maxConcurrentUploadsPerHost:number;uploadDeadlineMs:number}>;
export type VisualCapabilitiesResponse = ResponseBase & Readonly<{
  available:boolean;reason:'source_unavailable' | 'unconfigured' | 'unsupported' | 'provider_unavailable' | null;
  negotiation:VisualNegotiation | null;transport?:VisualTransportBounds;camera:VisualCameraState;
}>;
export type VisualCameraResponse = ResponseBase & Readonly<{camera:VisualCameraState}>;
export type VisualInputObservation = Readonly<{observationId:string;frameIds:readonly string[];appearance:string;inference:string | null;confidence:number | null;limitations:readonly string[]}>;
export type VisualInputPerceptionResult = Readonly<{
  requestId:string;status:'complete' | 'empty' | 'rejected' | 'cancelled' | 'timedOut' | 'failed';
  observations:readonly VisualInputObservation[];reason:string | null;
}>;
export type VisualBatchResponse = ResponseBase & Readonly<{requestId:string;queued:boolean;result:VisualInputPerceptionResult}>;
export type VisualInputErrorResponse = Readonly<{code:string;message?:string}>;

export type VisualInputShapes = {
  capabilitiesRequest:VisualCapabilitiesRequest;
  cameraRequest:VisualCameraRequest;
  batchRequest:VisualBatchRequest;
  capabilitiesResponse:VisualCapabilitiesResponse;
  cameraResponse:VisualCameraResponse;
  batchResponse:VisualBatchResponse;
  errorResponse:VisualInputErrorResponse;
};
export type VisualInputKind = keyof VisualInputShapes;
const definitions:Readonly<Record<VisualInputKind,string>> = Object.freeze({
  capabilitiesRequest:'CapabilitiesRequest',cameraRequest:'CameraRequest',batchRequest:'BatchRequest',
  capabilitiesResponse:'CapabilitiesResponse',cameraResponse:'CameraResponse',batchResponse:'BatchResponse',errorResponse:'ErrorResponse'
});

/** Shape validation only. Authentication, lease/scope, clocks, byte budgets and exact media binding remain host checks. */
export function validateVisualInput(kind:VisualInputKind,value:unknown):ValidationResult {
  const definition=definitions[kind];
  if (!Object.hasOwn(definitions,kind)) return {valid:false,errors:[{instancePath:'',keyword:'schema',message:'unknown visual input shape'}]};
  return createContractValidator().validate(`${visualInputSchemaId}#/$defs/${definition}`,value);
}
