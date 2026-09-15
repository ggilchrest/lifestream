import { createHash, randomUUID } from "node:crypto";
import { mapPwceContextResponse, mapPwceEvidenceResponse } from "@lifestream/runtime/context/pwce-mapping";
import type { PwceContextMode, PwceQualifiedSlice, PwceResponseBinding } from "@lifestream/runtime/context/pwce-mapping";
import { EXPECTED_PWCE_PROFILE, PwceGatewayClient } from "./client.ts";
import { PwceCacheError, PwceScopedCache } from "./cache.ts";
import type { PwceCachedRead, PwceCacheScope } from "./cache.ts";
import { PwceCallScope, transportLimit } from "./transport.ts";

export type PwceQuery = {
  readonly mode: Exclude<PwceContextMode, "prepared">;
  readonly externalEntityId?: string; readonly property?: string; readonly asOf?: string;
  readonly text?: string; readonly cursor?: string; readonly limit?: number;
  readonly maxAgeMs?: number; readonly allowStale?: boolean;
};
type EvidenceProjection = ReturnType<typeof mapPwceEvidenceResponse>;

/** One host-owned authenticated scope, accessed only through the published Gateway. */
export class PwceContextSession {
  private readonly client: PwceGatewayClient;
  private readonly cache: PwceScopedCache<PwceQualifiedSlice>;
  private readonly lifetime = new AbortController();
  private readonly timeoutMs: number;
  private watching = false;
  constructor(client: PwceGatewayClient, scope: PwceCacheScope, options: { isCurrent: () => boolean; maximumAgeMs?: number; timeoutMs?: number }) {
    this.client = client; this.cache = new PwceScopedCache(scope, options);
    this.timeoutMs = transportLimit(options.timeoutMs, 5000, 30_000);
    // Validate all optional identities with the same client boundary before use.
    client.eventsUrl(scope.authorityContextRef, scope.siteRef, "0", 100, this.subscriptionScope());
  }
  close(): void { this.cache.close(); this.lifetime.abort(); }
  status(): ReturnType<PwceScopedCache<PwceQualifiedSlice>["status"]> { return this.cache.status(); }
  private subscriptionScope() {
    const { worldRef, executionEnvironmentRef, assistantRef, endpointRef, participantRefs, audienceRef } = this.cache.scope;
    return { worldRef, executionEnvironmentRef, ...(assistantRef !== undefined ? { assistantRef } : {}), ...(endpointRef !== undefined ? { endpointRef } : {}), ...(participantRefs !== undefined ? { participantRefs } : {}), ...(audienceRef !== undefined ? { audienceRef } : {}), requestId: randomUUID(), correlationId: randomUUID() };
  }
  private binding(): PwceResponseBinding {
    const scope = this.cache.scope;
    return { worldRef: scope.worldRef, executionEnvironmentRef: scope.executionEnvironmentRef, siteRefs: [scope.siteRef], authorityContextRef: scope.authorityContextRef, authorityExpiresAt: scope.authorityExpiresAt, requestId: randomUUID(), correlationId: randomUUID(), maxItems: 100, maxBytes: 262_144 };
  }
  private envelope(binding: PwceResponseBinding, operation: string) {
    return { ...this.subscriptionScope(), profileId: EXPECTED_PWCE_PROFILE.profileId, profileVersion: EXPECTED_PWCE_PROFILE.profileVersion, operation, authorityContextRef: binding.authorityContextRef, siteRef: this.cache.scope.siteRef, worldRef: binding.worldRef, executionEnvironmentRef: binding.executionEnvironmentRef, requestId: binding.requestId, correlationId: binding.correlationId };
  }
  private async call<R>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const call = new PwceCallScope(this.timeoutMs, signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal);
    try {
      call.check(); if (!this.cache.status().usable) throw new PwceCacheError("scope_unavailable");
      // The transport deadline still bounds the whole operation, but mapping
      // and cache failures retain their own codes instead of becoming outages.
      const result = await call.wait(action(call.signal).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error })));
      call.check(); if (!result.ok) throw result.error; return result.value;
    } catch (error) {
      this.cache.disconnected();
      if (error && typeof error === "object" && "code" in error && ["authentication_failed", "authority_context_expired", "authority_context_invalidated", "scope_denied"].includes(String(error.code))) this.close();
      throw error;
    } finally { call.close(); }
  }
  private async synchronize(signal: AbortSignal): Promise<void> {
    // A currently authenticated replay check precedes every protected cache read.
    // Each page advances its cursor; this is bounded pagination, not a retry.
    for (let page = 0; page < 100; page++) {
      if (!this.cache.status().usable) throw new PwceCacheError("scope_unavailable");
      const binding = this.binding();
      const response = await this.client.request({ ...this.envelope(binding, "events.subscribe"), afterCursor: this.cache.status().cursor, limit: 100 }, signal);
      if (response.profileId !== EXPECTED_PWCE_PROFILE.profileId || response.profileVersion !== EXPECTED_PWCE_PROFILE.profileVersion || response.requestId !== binding.requestId || response.correlationId !== binding.correlationId
        || response.worldRef !== binding.worldRef || response.executionEnvironmentRef !== binding.executionEnvironmentRef || response.siteRef !== this.cache.scope.siteRef || response.principalRef !== this.cache.scope.principalRef) throw new PwceCacheError("read_invalidated");
      if (!this.cache.acceptReplay({ events: response.events, nextCursor: response.nextCursor, resyncRequired: response.resyncRequired, hasMore: response.hasMore })) return;
    }
    throw new PwceCacheError("read_invalidated");
  }
  getPreparedInputs(signal?: AbortSignal): Promise<PwceCachedRead<PwceQualifiedSlice>> { return this.read("prepared", {}, signal); }
  queryContext(query: PwceQuery, signal?: AbortSignal): Promise<PwceCachedRead<PwceQualifiedSlice>> {
    const copy = structuredClone(query);
    if (!copy || !["current", "history", "asOf", "explain", "search"].includes(copy.mode) || Object.keys(copy).some(key => !["mode", "externalEntityId", "property", "asOf", "text", "cursor", "limit", "maxAgeMs", "allowStale"].includes(key))) return Promise.reject(new PwceCacheError("invalid_cache_input"));
    const { mode, ...input } = copy; return this.read(mode, input, signal);
  }
  private read(mode: PwceContextMode, input: Omit<PwceQuery, "mode">, signal?: AbortSignal): Promise<PwceCachedRead<PwceQualifiedSlice>> {
    return this.call(signal, async callSignal => {
      await this.synchronize(callSignal);
      const key = createHash("sha256").update(JSON.stringify([mode, Object.entries(input).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
      const cached = this.cache.get(key); if (cached) return cached;
      const ticket = this.cache.beginRead(key), binding = this.binding();
      const response = await this.client.request({ ...input, ...this.envelope(binding, mode === "prepared" ? "context.getPreparedInputs" : "context.query"), ...(mode === "prepared" ? {} : { mode }), limit: input.limit ?? 50, maxBytes: binding.maxBytes }, callSignal);
      const mapped = mapPwceContextResponse(response, { ...binding, mode, maxItems: input.limit ?? 50, ...(input.externalEntityId ? { subjectRef: `${this.cache.scope.siteRef}::${input.externalEntityId}` } : {}), ...(input.property ? { property: input.property } : {}), ...(input.asOf ? { asOf: input.asOf } : {}) });
      // Reject an in-flight read if an invalidation arrived during it, including
      // events discovered by this post-read poll before a delayed SSE frame.
      await this.synchronize(callSignal);
      const currentExpiry = mapped.items.filter(item => mode !== "asOf" && item.knowledgeState === "current").flatMap(item => item.validUntil ? [Date.parse(item.validUntil)] : item.eventTime && item.freshnessMs !== null && item.freshnessMs !== undefined ? [Date.parse(item.eventTime) + item.freshnessMs] : []);
      const validUntil = currentExpiry.length ? new Date(Math.min(...currentExpiry)).toISOString() : undefined;
      return this.cache.commitRead(ticket, mapped, { cursor: mapped.invalidationCursor, ...(validUntil ? { validUntil } : {}) });
    });
  }
  getEvidence(evidenceRef: string, signal?: AbortSignal): Promise<{ readonly value: EvidenceProjection; readonly isCurrent: () => boolean }> {
    if (typeof evidenceRef !== "string" || !evidenceRef || evidenceRef.length > 2048) return Promise.reject(new PwceCacheError("invalid_cache_input"));
    return this.call(signal, async callSignal => {
      await this.synchronize(callSignal);
      const ticket = this.cache.beginRead(createHash("sha256").update(`evidence:${evidenceRef}`).digest("hex")), binding = this.binding();
      const response = await this.client.request({ ...this.envelope(binding, "evidence.get"), evidenceRef }, callSignal);
      const value = mapPwceEvidenceResponse(response, { ...binding, evidenceRef });
      await this.synchronize(callSignal);
      if (!this.cache.isReadCurrent(ticket)) throw new PwceCacheError("read_invalidated");
      const expires = performance.now() + 1000;
      return { value, isCurrent: () => performance.now() < expires && this.cache.isReadCurrent(ticket) };
    });
  }
  async *subscribeInvalidations(signal?: AbortSignal): AsyncGenerator<{ readonly disposition: "duplicate" | "invalidated" | "resync" | "closed" }> {
    if (this.watching) throw new PwceCacheError("invalid_cache_input");
    if (!this.cache.status().usable) throw new PwceCacheError("scope_unavailable");
    this.watching = true;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, this.lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      for await (const frame of this.client.subscribeInvalidations(this.cache.scope.authorityContextRef, this.cache.scope.siteRef, { scope: this.subscriptionScope(), afterCursor: this.cache.status().cursor, signal: combined })) {
        const disposition = this.cache.accept(frame);
        if (disposition === "duplicate") continue;
        yield { disposition }; if (disposition === "closed") return;
      }
    } finally { controller.abort(); this.watching = false; this.cache.disconnected(); }
  }
}
