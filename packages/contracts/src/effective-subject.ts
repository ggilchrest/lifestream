import { contractFailure, contractSuccess, validateUnifiedDesktopRecord, type ContractPin } from './unified-desktop-contracts.ts';
import type { ValidationResult } from './validator.ts';
import type { EffectiveSubjectContext } from './effective-subject.types.ts';
export type * from './effective-subject.types.ts';
export const EFFECTIVE_SUBJECT_SCHEMA_ID = 'https://lifestream.dev/contracts/effective-subject/1.0.0';
export const validateEffectiveSubjectRecord = (kind: string, input: unknown, pin?: ContractPin): ValidationResult => validateUnifiedDesktopRecord('effective-subject', kind, input, pin);
/** Values resolved by the existing authenticated account/session owner, never request flags. */
export type AuthenticatedActor = Readonly<{actorId: string; authenticatedSessionId: string; installationId: string}>;
export type EffectiveSubjectAuthority = Readonly<{context: EffectiveSubjectContext; actorEnabled: boolean; targetEnabled: boolean; sessionValid: boolean; systemAdministrator: boolean; authorityRevision: number}>;
export function admitEffectiveSubject(binding: unknown, authentication: AuthenticatedActor, current: EffectiveSubjectAuthority): ValidationResult {
  const parsed = validateEffectiveSubjectRecord('EffectiveSubjectContext', binding);
  if (!parsed.valid) return parsed;
  const b = binding as EffectiveSubjectContext, c = current.context;
  if (!validateEffectiveSubjectRecord('EffectiveSubjectContext', c).valid || !current.actorEnabled || !current.targetEnabled || !current.sessionValid || current.authorityRevision !== c.authorityRevision) return contractFailure('forbidden', 'effective context unavailable');
  if (b.actorId !== authentication.actorId || b.authenticatedSessionId !== authentication.authenticatedSessionId || b.installationId !== authentication.installationId || ['actorId','effectiveUserId','authenticatedSessionId','installationId','authorityRevision','generation','issuedAt'].some(key => b[key as keyof EffectiveSubjectContext] !== c[key as keyof EffectiveSubjectContext])) return contractFailure('scopeChanged', 'effective context changed');
  if (b.actorId !== b.effectiveUserId && !current.systemAdministrator) return contractFailure('forbidden', 'current installation administration authority required');
  return contractSuccess();
}
/** Supplemental foundation guard; full canonical grant/proof/review/dispatch admission still applies. */
export function admitEffectiveGrantAttribution(grant: Readonly<{principalId: string; issuedBy: string; sessionId: string | null; authenticationEvidenceRef: string}>, proof: Readonly<{principalId: string; sessionId: string; authenticationEvidenceRef: string}>, binding: unknown, authentication: AuthenticatedActor, current: EffectiveSubjectAuthority): ValidationResult {
  const admitted = admitEffectiveSubject(binding, authentication, current);
  if (!admitted.valid) return admitted;
  const c = current.context;
  if (grant.principalId !== c.effectiveUserId || grant.issuedBy !== c.actorId || proof.principalId !== c.actorId || proof.sessionId !== c.authenticatedSessionId || proof.authenticationEvidenceRef !== grant.authenticationEvidenceRef || (grant.sessionId !== null && grant.sessionId !== c.authenticatedSessionId)) return contractFailure('forbidden', 'grant actor, subject or authentication mismatch');
  return contractSuccess();
}
