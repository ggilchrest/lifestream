import type { ValidationResult } from './validator.ts';
import { validateUnifiedDesktopRecord } from './unified-desktop-contracts.ts';
import type { DesktopSession, OperationRequest, OperationResult, SessionEvent, PauseReceipt } from './desktop-session.types.ts';

export type { DesktopSession, Owner, Surface, Health, OperationRequest, OperationResult, BoundaryError, SessionEvent, PauseReceipt } from './desktop-session.types.ts';
export const DESKTOP_SESSION_SCHEMA_ID = 'https://lifestream.dev/contracts/desktop-session/1.0.0' as const;
export const DESKTOP_SESSION_LIMITS = Object.freeze({ messageBytes: 16384, surfaces: 16, reasonCodes: 32, takeoverMs: 3000, stationaryFrameMs: 250, heartbeatMs: 1000, leaseMs: 3000, ledgerMs: 86400000 });
export type DesktopRecordKind = 'DesktopSession' | 'OperationRequest' | 'OperationResult' | 'BoundaryError' | 'SessionEvent' | 'PauseReceipt';
const good = (): ValidationResult => ({ valid: true, errors: [] });
const bad = (keyword: string, message: string, instancePath = ''): ValidationResult => ({ valid: false, errors: [{ instancePath, keyword, message }] });

// Ajv format checks syntax. Calendar rollover and non-UTC dates are rejected too.
function validUtcDate(value: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].every((part, index) => part === Number(match[index + 1]));
}
function datesValid(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(datesValid);
  if (value && typeof value === 'object') return Object.entries(value).every(([key, child]) => typeof child === 'string' && /At$/.test(key) ? validUtcDate(child) : datesValid(child));
  return true;
}
function sessionSemantics(session: DesktopSession): ValidationResult {
  if (new Set(session.surfaces.map(surface => surface.surfaceId)).size !== session.surfaces.length) return bad('uniqueSurface', 'Surface identities must be unique.', '/surfaces');
  if (session.owner) {
    if (session.owner.effectiveUserId !== session.effectiveUserId) return bad('scope', 'Owner effective scope differs from the session.', '/owner/effectiveUserId');
    if (Date.parse(session.owner.expiresAt) <= Date.parse(session.updatedAt)) return bad('leaseExpired', 'Active owner lease must outlive the projection.', '/owner/expiresAt');
    if (session.health.guard !== 'ready') return bad('guard', 'Active control requires a ready host guard.', '/health/guard');
  }
  return good();
}
function eventSemantics(event: SessionEvent): ValidationResult {
  const snapshot = event.snapshot;
  if (event.sessionId !== snapshot.sessionId || event.sessionEpoch !== snapshot.sessionEpoch || event.ownershipRevision !== snapshot.ownershipRevision || event.controlEpoch !== snapshot.controlEpoch) return bad('correlation', 'Event and snapshot scope/revisions must match.', '/snapshot');
  if (event.type === 'operationCompleted' && event.operationId === null) return bad('correlation', 'Operation completion must identify its operation.', '/operationId');
  if (event.type === 'authorizationRevoked' && snapshot.owner !== null) return bad('revocation', 'Revocation cannot retain a control owner.', '/snapshot/owner');
  if (Date.parse(event.occurredAt) < Date.parse(snapshot.updatedAt)) return bad('order', 'Event cannot precede its snapshot.', '/occurredAt');
  return sessionSemantics(snapshot);
}
function pauseSemantics(receipt: PauseReceipt): ValidationResult {
  const elapsed = Date.parse(receipt.acknowledgedAt) - Date.parse(receipt.requestedAt);
  if (elapsed < 0) return bad('order', 'Pause acknowledgement cannot precede its request.', '/acknowledgedAt');
  const samples = receipt.frameSamples;
  for (let index = 1; index < samples.length; index++) {
    if (samples[index]!.observedAtMonotonicMs <= samples[index - 1]!.observedAtMonotonicMs || samples[index]!.frameNumber < samples[index - 1]!.frameNumber) return bad('order', 'Pause samples must have increasing monotonic times and nondecreasing frame counts.', '/frameSamples');
  }
  if (receipt.status === 'confirmed') {
    if (!receipt.inputNeutral || elapsed > DESKTOP_SESSION_LIMITS.takeoverMs) return bad('pauseUnconfirmed', 'Confirmed pause requires neutral input within the transition deadline.');
    if (samples.some(sample => sample.frameNumber !== samples[0]!.frameNumber) || samples.at(-1)!.observedAtMonotonicMs - samples[0]!.observedAtMonotonicMs < DESKTOP_SESSION_LIMITS.stationaryFrameMs) return bad('pauseUnconfirmed', 'Confirmed pause requires stationary frame-count samples across at least 250 ms.', '/frameSamples');
  }
  return good();
}

/** Validity of bounded control metadata is never effect admission or host qualification. */
export function validateDesktopSessionRecord(kind: DesktopRecordKind, value: unknown): ValidationResult {
  const structural = validateUnifiedDesktopRecord('desktop-session', kind, value);
  if (!structural.valid) return structural;
  if (!datesValid(value)) return bad('date-time', 'All timestamps must be valid UTC calendar times.');
  if (kind === 'DesktopSession') return sessionSemantics(value as DesktopSession);
  if (kind === 'SessionEvent') return eventSemantics(value as SessionEvent);
  if (kind === 'PauseReceipt') return pauseSemantics(value as PauseReceipt);
  if (kind === 'OperationResult') {
    const result = value as OperationResult;
    if (result.result && 'surfaces' in result.result) return sessionSemantics(result.result as DesktopSession);
    if (result.result && 'status' in result.result) return validateDesktopSessionRecord('OperationResult', result.result);
  }
  return good();
}

/** Read-only requests deliberately ignore stale expected revisions, but never scope. */
export function validateDesktopRequestAgainstSession(request: unknown, session: unknown, clientInstanceId: string, nowMs: number, lastHeartbeatSequence?: number): ValidationResult {
  const requestValidity = validateDesktopSessionRecord('OperationRequest', request);
  if (!requestValidity.valid) return requestValidity;
  const sessionValidity = validateDesktopSessionRecord('DesktopSession', session);
  if (!sessionValidity.valid) return sessionValidity;
  const operation = request as OperationRequest, current = session as DesktopSession;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return bad('invalidRequest', 'Trusted current time must be a nonnegative safe integer.');
  if (operation.sessionId !== current.sessionId || operation.resourceGroupId !== current.resourceGroupId || operation.clientInstanceId !== clientInstanceId) return bad('scope', 'Request does not match the authenticated session/client scope.');
  if (operation.operation === 'describeSession' || operation.operation === 'getOperation') return good();
  if (operation.expectedSessionEpoch !== current.sessionEpoch || operation.expectedControlEpoch !== current.controlEpoch) return bad('staleEpoch', 'Request epochs are stale.');
  if (operation.expectedOwnershipRevision !== current.ownershipRevision) return bad('revisionConflict', 'Ownership revision changed.');
  const payload = operation.payload;
  if ('surfaceId' in payload && !current.surfaces.some(surface => surface.surfaceId === payload.surfaceId)) return bad('scope', 'Requested surface is outside the session.');
  if (operation.operation === 'takeOver' && !['observing', 'assistantControlled', 'paused'].includes(current.state)) return bad('controlBusy', 'Takeover requires an observed, assistant-controlled or acknowledged paused state.');
  if (operation.operation === 'resumeHumanGame') {
    if (current.state !== 'humanControlledPaused' || current.owner?.kind !== 'human' || current.owner.clientInstanceId !== clientInstanceId) return bad('notOwner', 'Game resume requires the current paused human owner.');
    if (Date.parse(current.owner.expiresAt) <= nowMs) return bad('leaseExpired', 'An expired human lease cannot resume the game.');
    if (!current.capabilities.includes('resumeGame') || !current.surfaces.some(surface => surface.surfaceId === operation.payload.surfaceId && surface.kind === 'game' && surface.availability === 'ready')) return bad('unsupportedCapability', 'Game resume requires a ready admitted game surface and negotiated capability.');
  }
  if (operation.operation === 'heartbeat') {
    if (!current.owner || current.owner.kind !== 'human' || current.owner.clientInstanceId !== clientInstanceId || current.owner.leaseId !== operation.payload.leaseId) return bad('notOwner', 'Only the exact current human owner can renew this client lease.');
    if (Date.parse(current.owner.expiresAt) <= nowMs) return bad('leaseExpired', 'Heartbeat cannot resurrect an expired owner lease.');
    if (!Number.isSafeInteger(lastHeartbeatSequence) || lastHeartbeatSequence! < 0 || operation.payload.sequence <= lastHeartbeatSequence!) return bad('order', 'Heartbeat must advance the trusted current lease sequence.');
  }
  return good();
}

/** The exact operation-specific result is correlated without adding a wire discriminator. */
export function validateDesktopOperationResult(request: unknown, result: unknown): ValidationResult {
  const requestValidity = validateDesktopSessionRecord('OperationRequest', request);
  if (!requestValidity.valid) return requestValidity;
  const resultValidity = validateDesktopSessionRecord('OperationResult', result);
  if (!resultValidity.valid) return resultValidity;
  const operation = request as OperationRequest, outcome = result as OperationResult;
  if (operation.operationId !== outcome.operationId || operation.sessionId !== outcome.sessionId) return bad('correlation', 'Result does not identify the original operation/session.');
  if (['accepted', 'completed'].includes(outcome.status) && !['describeSession', 'getOperation'].includes(operation.operation) && (outcome.ownershipRevision < operation.expectedOwnershipRevision || outcome.controlEpoch < operation.expectedControlEpoch!)) return bad('staleEpoch', 'Admitted mutation result cannot precede its expected ownership revision or control epoch.');
  if (outcome.result === null) return good(); // Rejected, pending and unknown are not a completion claim.
  const payload = outcome.result;
  let matches = false;
  switch (operation.operation) {
    case 'describeSession': matches = 'surfaces' in payload && payload.sessionId === operation.sessionId && payload.resourceGroupId === operation.resourceGroupId; break;
    case 'getOperation': matches = 'status' in payload && payload.operationId === operation.payload.targetOperationId && payload.sessionId === operation.sessionId; break;
    case 'attachViewer': matches = 'viewerId' in payload; break;
    case 'detachViewer': matches = 'detached' in payload; break;
    case 'takeOver': case 'transferHumanControl': matches = 'transitionId' in payload && (outcome.status !== 'completed' || ['humanControlledPaused', 'humanControlledActive'].includes(outcome.state)); break;
    case 'returnToAssistant': matches = 'transitionId' in payload && (outcome.status !== 'completed' || ['assistantControlled', 'paused'].includes(outcome.state)); break;
    case 'resumeHumanGame': matches = 'resumed' in payload && outcome.status === 'completed' && outcome.state === 'humanControlledActive'; break;
    case 'pause': matches = 'pauseReceiptId' in payload && outcome.status === 'completed' && ['paused', 'humanControlledPaused'].includes(outcome.state); break;
    case 'heartbeat': matches = 'expiresAt' in payload && outcome.status === 'completed'; break;
  }
  return matches ? good() : bad('correlation', 'Result payload does not match its requested operation or confirmed state.', '/result');
}

export type DesktopPauseScope = { resourceGroupId: string; controlEpoch: number; processInstanceId: string; runId: string };
/** Expected scope must come from the trusted host. Matching a fixture is not observed pause proof. */
export function validateDesktopPauseReceipt(receipt: unknown, expected: DesktopPauseScope): ValidationResult {
  const validity = validateDesktopSessionRecord('PauseReceipt', receipt);
  if (!validity.valid) return validity;
  const pause = receipt as PauseReceipt;
  if (pause.status !== 'confirmed') return bad('pauseUnconfirmed', 'Failed or unknown pause cannot grant control.');
  if (pause.resourceGroupId !== expected.resourceGroupId || pause.controlEpoch !== expected.controlEpoch || pause.processInstanceId !== expected.processInstanceId || pause.runId !== expected.runId) return bad('scope', 'Pause receipt belongs to a different host run or epoch.');
  return good();
}

/** Checks a confirmed pause against the current projection, not an image or UI label. */
export function validateDesktopPauseProjection(receipt: unknown, projection: unknown, expected: DesktopPauseScope): ValidationResult {
  const pauseValidity = validateDesktopPauseReceipt(receipt, expected);
  if (!pauseValidity.valid) return pauseValidity;
  const projectionValidity = validateDesktopSessionRecord('DesktopSession', projection);
  if (!projectionValidity.valid) return projectionValidity;
  const pause = receipt as PauseReceipt, session = projection as DesktopSession;
  if (pause.resourceGroupId !== session.resourceGroupId || pause.controlEpoch !== session.controlEpoch) return bad('scope', 'Pause must match the projected resource and epoch.');
  if (!['humanControlledPaused', 'paused'].includes(session.state)) return bad('pauseUnconfirmed', 'Pause evidence cannot label an active, pending or uncertain state as paused.');
  if (Date.parse(pause.acknowledgedAt) > Date.parse(session.updatedAt)) return bad('order', 'Projection cannot precede pause acknowledgement.');
  return good();
}

/** Checks metadata monotonicity; runtime executors still require their final host guard. */
export function validateDesktopSessionTransition(previous: unknown, next: unknown): ValidationResult {
  for (const value of [previous, next]) { const validity = validateDesktopSessionRecord('DesktopSession', value); if (!validity.valid) return validity; }
  const old = previous as DesktopSession, current = next as DesktopSession;
  if (['sessionId', 'workspaceId', 'resourceGroupId', 'effectiveUserId', 'assistantId', 'endpointRef'].some(key => old[key as keyof DesktopSession] !== current[key as keyof DesktopSession])) return bad('scope', 'A transition cannot switch session scope.');
  if (current.sessionEpoch < old.sessionEpoch || current.ownershipRevision < old.ownershipRevision || current.controlEpoch < old.controlEpoch || Date.parse(current.updatedAt) < Date.parse(old.updatedAt)) return bad('staleEpoch', 'Session metadata must not move backwards.');
  if (current.sessionEpoch > old.sessionEpoch && current.owner !== null) return bad('restart', 'A restarted session cannot preserve an active lease.', '/owner');
  const ownerChanged = old.owner?.leaseId !== current.owner?.leaseId || old.owner?.kind !== current.owner?.kind || old.owner?.actorId !== current.owner?.actorId || old.owner?.effectiveUserId !== current.owner?.effectiveUserId || old.owner?.clientInstanceId !== current.owner?.clientInstanceId;
  const changed = old.state !== current.state || ownerChanged;
  if (changed && current.ownershipRevision <= old.ownershipRevision) return bad('revisionConflict', 'Ownership changes require a new revision.');
  const completingPending = old.owner === null && ['takeoverPending', 'returnPending'].includes(old.state);
  if (((ownerChanged && !completingPending) || (old.state !== current.state && ['takeoverPending', 'returnPending'].includes(current.state))) && current.controlEpoch <= old.controlEpoch) return bad('staleEpoch', 'Fencing or changing a lease requires a new control epoch.');
  const transitions: Record<DesktopSession['state'], readonly DesktopSession['state'][]> = {
    unavailable: ['observing', 'paused', 'recoveryRequired'],
    observing: ['assistantControlled', 'takeoverPending', 'paused', 'unavailable', 'recoveryRequired'],
    assistantControlled: ['takeoverPending', 'paused', 'unavailable', 'recoveryRequired'],
    takeoverPending: ['humanControlledPaused', 'humanControlledActive', 'paused', 'unavailable', 'recoveryRequired'],
    humanControlledPaused: ['humanControlledActive', 'returnPending', 'takeoverPending', 'paused', 'unavailable', 'recoveryRequired'],
    humanControlledActive: ['humanControlledPaused', 'returnPending', 'takeoverPending', 'paused', 'unavailable', 'recoveryRequired'],
    returnPending: ['assistantControlled', 'paused', 'unavailable', 'recoveryRequired'],
    paused: ['assistantControlled', 'takeoverPending', 'observing', 'unavailable', 'recoveryRequired'],
    recoveryRequired: ['paused', 'observing', 'unavailable']
  };
  if (old.state !== current.state && !transitions[old.state].includes(current.state)) return bad('transition', 'Ownership state change requires its fencing or reconciliation path.');
  if (old.state === 'takeoverPending' && current.state === 'humanControlledActive' && current.surfaces.some(surface => surface.kind === 'game')) return bad('pauseUnconfirmed', 'Game takeover must first enter the human-controlled paused state.');
  if (old.owner && current.owner && old.owner.leaseId === current.owner.leaseId && ownerChanged) return bad('scope', 'A lease cannot be reassigned to another actor or client.');
  return good();
}
