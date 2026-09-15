type Grant = { id: string; principalId: string; assistantId: string; status: "pending" | "active" | "denied" | "revoked"; scope: string[]; revision: number; terms: Record<string, unknown>; createdAt: string };
export function approveGrant(grant: Grant, principalId: string): Grant { if (grant.principalId !== principalId || grant.status !== "pending") throw new Error("grant approval denied"); return { ...grant, status: "active", revision: grant.revision + 1 }; }

import { createContractValidator } from '@lifestream/contracts';
import type { AuthorityRequest as CanonicalAuthorityRequest, CallScope, humanAuthorityGrant_Root as CanonicalGrant, humanAuthorityDecision_Root as CanonicalDecision } from '@lifestream/contracts/provider-messages';
const grantValidator = createContractValidator();
export type CanonicalGrantEvaluationContext = {
  principalId: string; sessionId: string; now: string;
  authorityContextRef: NonNullable<CallScope['authorityContextRef']>;
  assertCurrent(scope: CallScope): void;
};
export type CanonicalGrantEligibility = { disposition: CanonicalDecision['disposition']; reasonCode: CanonicalDecision['reasonCode'] };
/** Non-consuming eligibility for the exact selected grant. Scope and input digest
 * must have been derived from validated arguments by the trusted capability adapter. */
export function evaluateCanonicalGrant(grant: CanonicalGrant | undefined, request: CanonicalAuthorityRequest, context: CanonicalGrantEvaluationContext): CanonicalGrantEligibility {
  const denied = (reasonCode: CanonicalDecision['reasonCode']): CanonicalGrantEligibility => ({ disposition: 'denied', reasonCode });
  const valid = (schema: string, value: unknown) => grantValidator.validate(schema, value).valid;
  try {
    if (!valid('https://lifestream.dev/contracts/provider-messages/1.0.0#/$defs/AuthorityRequest', request) ||
      !valid('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/Time', context.now) ||
      !valid('https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/UUID', context.principalId)) return denied('authority_identity_invalid');
    const owned = structuredClone(request), selected = grant && structuredClone(grant), now = Date.parse(context.now);
    const authenticated = { principalId: context.principalId, sessionId: context.sessionId, now: context.now, authority: structuredClone(context.authorityContextRef) };
    const unchanged = () => context.principalId === authenticated.principalId && context.sessionId === authenticated.sessionId && context.now === authenticated.now &&
      context.authorityContextRef.providerRef === authenticated.authority.providerRef && context.authorityContextRef.contextId === authenticated.authority.contextId && context.authorityContextRef.revision === authenticated.authority.revision;
    context.assertCurrent(structuredClone(owned.scope));
    if (!unchanged()) return denied('authority_stale_context');
    if (owned.executionMode !== 'normal') return denied('authority_replay_mismatch');
    if (owned.scope.sessionId !== context.sessionId) return denied('authority_session_inactive');
    const authority = owned.scope.authorityContextRef;
    if (!authority || authority.providerRef !== context.authorityContextRef.providerRef || authority.contextId !== context.authorityContextRef.contextId || authority.revision !== context.authorityContextRef.revision || Date.parse(owned.deadlineAt) <= now) return denied('authority_stale_context');
    if (owned.payload.grantId === null) return { disposition: 'approvalRequired', reasonCode: 'authority_consent_required' };
    if (!selected || selected.grantId !== owned.payload.grantId) return denied('authority_unavailable');
    if (!valid('https://lifestream.dev/contracts/human-authority-grant/1.0.0', selected)) return denied('authority_unavailable');
    if (selected.principalId !== context.principalId) return denied('authority_identity_invalid');
    if (selected.assistantId !== owned.scope.assistantId || selected.endpointId !== owned.scope.endpointId || selected.environmentId !== owned.scope.environmentId || selected.authorityProviderRef !== authority.providerRef) return denied('authority_scope_mismatch');
    if (selected.status === 'revoked') return denied('authority_grant_revoked');
    if (selected.status === 'consumed') return denied('authority_grant_consumed');
    if (selected.status === 'expired' || Date.parse(selected.expiresAt) <= now) return denied('authority_grant_expired');
    if (Date.parse(selected.issuedAt) > now || Date.parse(selected.issuedAt) >= Date.parse(selected.expiresAt)) return denied('authority_unavailable');
    if (selected.reviewAfter !== null && (Date.parse(selected.reviewAfter) <= Date.parse(selected.issuedAt) || Date.parse(selected.reviewAfter) > Date.parse(selected.expiresAt))) return denied('authority_unavailable');
    if (selected.reviewAfter !== null && Date.parse(selected.reviewAfter) <= now) return denied('authority_review_due');
    const scope = owned.payload.scope;
    if (scope.capabilityId !== selected.scope.capabilityId || scope.capabilityVersion !== selected.scope.capabilityVersion || scope.operation !== selected.scope.operation ||
      scope.targetRefs.some(ref => !selected.scope.targetRefs.includes(ref)) || scope.dataScopeRefs.some(ref => !selected.scope.dataScopeRefs.includes(ref))) return denied('authority_scope_mismatch');
    if (selected.grantClass !== 'allowPersistent' && selected.sessionId !== owned.scope.sessionId) return denied('authority_session_inactive');
    if (selected.grantClass === 'allowOnce' && (selected.invocationId !== owned.payload.invocationId || selected.inputDigest !== owned.payload.inputDigest)) return denied('authority_scope_mismatch');
    context.assertCurrent(structuredClone(owned.scope));
    if (!unchanged()) return denied('authority_stale_context');
    return { disposition: 'authorized', reasonCode: 'authority_authorized' };
  } catch { return denied('authority_identity_invalid'); }
}
