import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContractValidator } from '@lifestream/contracts';
import type { CallScope, CapabilitySnapshotRequest } from '@lifestream/contracts/provider-messages';
import { PwceGatewayClient, PwceCapabilityCatalog, PwceInvalidationStreams, type PwceCapabilityBinding, type PwceCatalogRecord } from '@lifestream/providers-pwce';
import { CanonicalProviderBoundary } from '@lifestream/runtime/ports/provider-boundary';
import { CapabilityCall } from '@lifestream/runtime/capabilities/call';
import type { ProviderCallContext } from '@lifestream/runtime/ports/provider-messages';
import { boundedJson } from '@lifestream/runtime/capabilities/schema-validation';
import type { CapabilityCallContext } from '@lifestream/runtime/capabilities/ports';
import { resolveCapabilitySchema } from '@lifestream/runtime/capabilities/schema-artifacts';
import type { PwceProfile } from '../config/schema.ts';
import { pwceIdentity } from './pwce-identity.ts';

export type PwceCapabilityOwner = {
  assistantId: string; endpointId: string; sessionId: string; principalId: string;
  conversationId: string | null; interactionTraceId: string | null;
  revision: string; audienceKnown: boolean; isCurrent(): boolean;
};
export type PwceCapabilityLease = { client: PwceGatewayClient; catalog: PwceCapabilityCatalog; record: PwceCatalogRecord; context: ProviderCallContext; deadlineAt: string; expiresAt: string };
type Entry = { key: string; owner: PwceCapabilityOwner; scope: CallScope; binding?: PwceCapabilityBinding; expiresAt: number;
  controller: AbortController; ready: boolean; users: number; initialization: Promise<void>; onReady?: () => void };
let validator: ReturnType<typeof createContractValidator> | undefined;
const common = 'https://lifestream.dev/contracts/protocol-common/1.0.0#/$defs/';
// Unselected deployments must not compile another full schema registry.
const valid = (type: string, value: unknown) => (validator ??= createContractValidator()).validate(common + type, value).valid;
const unavailable = (): never => { throw new Error('pwce_capability_discovery_unavailable'); };

/** Authenticated host discovery. No dispatcher credential, grant repository or
 * action methods are held here. Catalog eligibility is never action permission. */
export class PwceCapabilityDiscovery {
  private readonly profile: PwceProfile;
  private readonly client: PwceGatewayClient;
  private readonly catalog: PwceCapabilityCatalog;
  private readonly streams: PwceInvalidationStreams;
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(profile: PwceProfile, token: string) {
    this.profile = structuredClone(profile);
    this.client = new PwceGatewayClient({ baseUrl: profile.endpoint, token, requestTimeoutMs: profile.timeoutMs });
    const resolve = async (scope: CallScope) => {
      const entry = [...this.entries.values()].find(item => isDeepStrictEqual(item.scope, scope));
      if (!entry?.binding || !this.current(entry)) return unavailable();
      return structuredClone(entry.binding);
    };
    const isCurrent = (binding: PwceCapabilityBinding, scope: CallScope) => [...this.entries.values()].some(entry => this.current(entry) && isDeepStrictEqual(entry.scope, scope) && isDeepStrictEqual(entry.binding, binding));
    this.catalog = new PwceCapabilityCatalog({ providerRef: 'pwce', client: this.client, resolve, isCurrent });
    this.streams = new PwceInvalidationStreams({ providerRef: 'pwce', client: this.client, catalog: this.catalog, resolve, isCurrent,
      onReady: scope => {
        const entry = [...this.entries.values()].find(item => isDeepStrictEqual(item.scope, scope));
        if (entry && this.current(entry)) { entry.ready = true; entry.onReady?.(); }
      } });
  }
  private current(entry: Entry): boolean {
    try { return !this.closed && !entry.controller.signal.aborted && this.entries.get(entry.key) === entry && Date.now() < entry.expiresAt && entry.owner.isCurrent(); } catch { return false; }
  }
  private remove(entry: Entry): void {
    entry.controller.abort();
    if (entry.scope.authorityContextRef) this.catalog.invalidateAuthority(entry.scope.authorityContextRef);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }
  close(): void { this.closed = true; for (const entry of this.entries.values()) this.remove(entry); this.catalog.invalidateAll(); }
  private mode(): CapabilitySnapshotRequest['executionMode'] {
    if (this.profile.executionEnvironmentRef === 'dry-run') return unavailable();
    return ['replay','simulation'].includes(this.profile.executionEnvironmentRef) ? this.profile.executionEnvironmentRef as 'replay' | 'simulation' : 'normal';
  }
  private async initialize(entry: Entry): Promise<void> {
    const timer = setTimeout(() => this.remove(entry), this.profile.timeoutMs);
    try {
      if (!entry.binding) {
        const identity = pwceIdentity(this.profile.lifestreamEnvironmentId, entry.owner);
        const authority = await this.client.authority(this.profile.siteRefs, entry.controller.signal, identity);
        if (!this.current(entry) || Object.keys(authority).sort().join(',') !== 'authorityContextRef,expiresAt,siteRefs' || !valid('UUID', authority.authorityContextRef) || !valid('Time', authority.expiresAt) || Date.parse(String(authority.expiresAt)) <= Date.now() || Date.parse(String(authority.expiresAt)) > Date.now() + 3600000 || !isDeepStrictEqual(authority.siteRefs, this.profile.siteRefs)) return unavailable();
        entry.expiresAt = Math.min(entry.expiresAt, Date.parse(String(authority.expiresAt)));
        // Revision 1 identifies this local immutable mapping, not a PWCE grant revision.
        entry.scope.authorityContextRef = { providerRef: 'pwce', contextId: String(authority.authorityContextRef), revision: 1 };
        entry.binding = { authorityContextRef: String(authority.authorityContextRef), principalRef: this.profile.principalRef, siteRefs: [...this.profile.siteRefs], worldRef: this.profile.worldRef, executionEnvironmentRef: this.profile.executionEnvironmentRef, identity };
      }
      const request = { schemaVersion: '1.0.0' as const, operation: 'CapabilityProvider.subscribeInvalidations' as const, requestId: randomUUID(), correlationId: randomUUID(), cancellationId: randomUUID(), deadlineAt: new Date(entry.expiresAt).toISOString(), executionMode: this.mode(), scope: { ...structuredClone(entry.scope), endpointId: entry.owner.endpointId, sessionId: entry.owner.sessionId, authorityContextRef: entry.scope.authorityContextRef! }, idempotencyKey: null, payload: { providerRef: 'pwce', afterSequence: null, sourceRevision: null } };
      let settled = false;
      await new Promise<void>((resolve, reject) => {
        entry.onReady = () => { if (this.current(entry)) { settled = true; resolve(); } };
        void (async () => {
          try {
            const boundary = new CanonicalProviderBoundary({ providerRef: 'pwce' });
            const provider = boundary.capability({ getSnapshot: this.catalog.getSnapshot.bind(this.catalog), subscribeInvalidations: this.streams.subscribeCapabilities.bind(this.streams), invoke: async () => unavailable(), getInvocation: async () => unavailable() });
            for await (const event of provider.subscribeInvalidations(request, { signal: entry.controller.signal, isCurrent: candidate => isDeepStrictEqual(candidate, entry.scope) && this.current(entry) })) {
              if (event.kind === 'data') { this.remove(entry); break; }
              if (event.kind === 'terminal') break;
            }
          } catch { /* Current discovery fails; the next explicit read may acquire fresh authority. */ }
          finally { delete entry.onReady; this.remove(entry); if (!settled) reject(new Error('pwce_capability_watch_unavailable')); }
        })();
      });
    } catch { this.remove(entry); return unavailable(); } finally { clearTimeout(timer); }
  }
  /** Trusted host operation only. Original records come from retained host/journal
   * custody, never HTTP fields. Reattachment reads the SAME authority; it cannot
   * acquire replacement authority or rescue a previously cancelled operation. */
  async withCatalog<T>(input: PwceCapabilityOwner, inputCall: CapabilityCallContext, operation: (lease: PwceCapabilityLease) => Promise<T>, originalInput?: PwceCatalogRecord): Promise<T> {
    if (originalInput && !boundedJson(originalInput, 262144)) return unavailable();
    const original = originalInput ? structuredClone(originalInput) : undefined;
    const { isCurrent, ...metadata } = input, owner = { ...structuredClone(metadata), isCurrent: isCurrent.bind(input) };
    if (this.closed || owner.audienceKnown !== true || typeof owner.revision !== 'string' || !owner.revision || owner.revision.length > 128 || typeof owner.principalId !== 'string' || !owner.principalId || owner.principalId.length > 128 || ![owner.assistantId,owner.endpointId,owner.sessionId,this.profile.lifestreamEnvironmentId].every(id => valid('UUID', id)) || ![owner.conversationId,owner.interactionTraceId].every(id => id === null || valid('UUID', id))) return unavailable();
    this.mode();
    const call = new CapabilityCall({ ...inputCall, executionMode: this.mode() === 'normal' ? 'live' : this.mode() as 'replay' | 'simulation', deadlineAt: new Date(Math.min(Date.parse(inputCall.deadlineAt), Date.now() + this.profile.timeoutMs)).toISOString(), isCurrent: () => !this.closed && owner.isCurrent() && inputCall.isCurrent() });
    let entry: Entry | undefined;
    try {
      call.check();
      for (const candidate of this.entries.values()) if (!this.current(candidate)) this.remove(candidate);
      const baseScope = { assistantId: owner.assistantId, endpointId: owner.endpointId, sessionId: owner.sessionId, environmentId: this.profile.lifestreamEnvironmentId, conversationId: owner.conversationId, interactionTraceId: owner.interactionTraceId };
      if (original) {
        const reference = original.scope.authorityContextRef;
        if (!reference || reference.providerRef !== 'pwce' || reference.revision !== 1 || !valid('UUID', reference.contextId) || original.executionMode !== this.mode() || !valid('Time', original.snapshot.expiresAt) || Date.parse(original.snapshot.expiresAt) <= Date.now() ||
          !isDeepStrictEqual(original.scope, { ...baseScope, authorityContextRef: reference }) ||
          !isDeepStrictEqual(original.binding, { authorityContextRef: reference.contextId, principalRef: this.profile.principalRef, siteRefs: this.profile.siteRefs, worldRef: this.profile.worldRef, executionEnvironmentRef: this.profile.executionEnvironmentRef, identity: pwceIdentity(this.profile.lifestreamEnvironmentId, owner) })) return unavailable();
      }
      const key = createHash('sha256').update(JSON.stringify([metadata,original?.scope.authorityContextRef ?? null])).digest('hex');
      entry = original ? [...this.entries.values()].find(item => isDeepStrictEqual(item.scope, original.scope) && this.current(item)) : this.entries.get(key);
      if (!entry) {
        if (this.entries.size >= 16) return unavailable();
        entry = { key, owner, scope: { assistantId: owner.assistantId, endpointId: owner.endpointId, sessionId: owner.sessionId, environmentId: this.profile.lifestreamEnvironmentId, conversationId: owner.conversationId, interactionTraceId: owner.interactionTraceId, authorityContextRef: null }, controller: new AbortController(), ready: false, users: 0, expiresAt: Date.now() + 25000, initialization: Promise.resolve() };
        if (original) { entry.scope = structuredClone(original.scope); entry.binding = structuredClone(original.binding); entry.expiresAt = Math.min(entry.expiresAt, Date.parse(original.snapshot.expiresAt)); }
        this.entries.set(key, entry); entry.initialization = this.initialize(entry); void entry.initialization.catch(() => undefined);
      }
      entry.users++;
      await call.wait(() => entry!.initialization);
      if (!entry.ready || !this.current(entry)) return unavailable();
      const context = { signal: AbortSignal.any([call.context.signal, entry.controller.signal]), isCurrent: (scope: CallScope) => isDeepStrictEqual(scope, entry!.scope) && this.current(entry!) && call.context.isCurrent() };
      const request: CapabilitySnapshotRequest = { schemaVersion: '1.0.0', operation: 'CapabilityProvider.getSnapshot', requestId: call.context.requestId, correlationId: call.context.correlationId, cancellationId: randomUUID(), deadlineAt: call.context.deadlineAt, executionMode: this.mode(), scope: { ...structuredClone(entry.scope), endpointId: entry.owner.endpointId, sessionId: entry.owner.sessionId, authorityContextRef: entry.scope.authorityContextRef! }, idempotencyKey: null, payload: { requestedCapabilityIds: [] } };
      const result = await call.wait(() => this.catalog.getSnapshot(request, context));
      if (result.outcome.status !== 'succeeded') return unavailable();
      const record = this.catalog.retained(result.outcome.payload.snapshotId, entry.scope);
      if (!record || original && !isDeepStrictEqual(record, original)) return unavailable();
      const value = await call.wait(() => operation({ client: this.client, catalog: this.catalog, record: structuredClone(record), context, deadlineAt: call.context.deadlineAt, expiresAt: new Date(Math.min(entry!.expiresAt, Date.parse(record.snapshot.expiresAt))).toISOString() }));
      call.check();
      if (!this.current(entry) || !isDeepStrictEqual(this.catalog.retained(record.snapshot.snapshotId, entry.scope), record)) return unavailable();
      return value;
    } catch (error) { if (entry && entry.users === 1) this.remove(entry); throw error; } finally { if (entry) { entry.users--; if (!entry.ready && entry.users === 0) this.remove(entry); } call.close(); }
  }
  async discover(input: PwceCapabilityOwner, inputCall: CapabilityCallContext) {
    return this.withCatalog(input, inputCall, async lease => {
      const { record, client, catalog, context } = lease, bundle = await client.capabilityContracts(context.signal), tools = [];
      const call = new CapabilityCall({ ...inputCall, deadlineAt: lease.deadlineAt, signal: context.signal, isCurrent: () => context.isCurrent(record.scope) });
      try {
        const schemaScope = { assistantId: record.scope.assistantId, endpointId: record.scope.endpointId!, sessionId: record.scope.sessionId!, environment: record.scope.environmentId, authorityContextRef: record.scope.authorityContextRef! };
        for (const definition of record.snapshot.capabilities) {
          const descriptor = bundle.capabilities[0];
          if (definition.inputSchemaRef !== descriptor.inputSchemaArtifact.reference || definition.outputSchemaRef !== descriptor.resultSchemaArtifact.reference) return unavailable();
          const inputSchema = await resolveCapabilitySchema(descriptor.inputSchemaArtifact, schemaScope, call, catalog.schemas);
          await resolveCapabilitySchema(descriptor.resultSchemaArtifact, schemaScope, call, catalog.schemas);
          tools.push({ capabilityId: definition.capabilityId, version: definition.version, sideEffectClass: definition.sideEffectClass, authorization: definition.authorization, inputSchema, inputSchemaRef: descriptor.inputSchemaArtifact, outputSchemaRef: descriptor.resultSchemaArtifact });
        }
        call.check();
        return { status: 'available', protocol: 'canonical', providerRef: 'pwce', environmentId: this.profile.lifestreamEnvironmentId, expiresAt: lease.expiresAt, tools, grantsAuthority: false, dispatchStarted: false, actionAdministration: 'unavailable', limitation: 'Capability discovery is available; PWCE action preparation and administration are not yet connected.' };
      } finally { call.close(); }
    });
  }

}
