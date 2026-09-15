import type * as M from '@lifestream/contracts/provider-messages';

/** Supplied by the trusted composition root, never reconstructed from wire data. */
export interface ProviderCallContext {
  signal: AbortSignal;
  isCurrent(scope: M.CallScope): boolean;
}

export interface CapabilityProvider {
  getSnapshot(request: M.CapabilitySnapshotRequest, context: ProviderCallContext): Promise<M.CapabilitySnapshotResult>;
  invoke(request: M.CapabilityInvocationRequest, context: ProviderCallContext): Promise<M.CapabilityInvocationResult>;
  getInvocation(request: M.CapabilityStatusRequest, context: ProviderCallContext): Promise<M.CapabilityStatusResult>;
  subscribeInvalidations(request: M.CapabilityInvalidationRequest, context: ProviderCallContext): AsyncIterable<M.CapabilityInvalidationEvent>;
}

export interface AuthorityProvider {
  evaluate(request: M.AuthorityRequest, context: ProviderCallContext): Promise<M.AuthorityResult>;
  authorizeDispatch(request: M.AuthorityDispatchRequest, context: ProviderCallContext): Promise<M.AuthorityDispatchResult>;
  getGrants(request: M.GrantQueryRequest, context: ProviderCallContext): Promise<M.GrantQueryResult>;
  subscribeInvalidations(request: M.AuthorityInvalidationRequest, context: ProviderCallContext): AsyncIterable<M.AuthorityInvalidationEvent>;
}
