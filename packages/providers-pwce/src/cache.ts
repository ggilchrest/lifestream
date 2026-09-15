import type { PwceInvalidationEvent, PwceSubscriptionScope } from "./client.ts";
import { createHash } from "node:crypto";

export type PwceCacheScope = Omit<PwceSubscriptionScope, "requestId" | "correlationId"> & {
  readonly authorityContextRef: string; readonly authorityExpiresAt: string;
  readonly siteRef: string; readonly principalRef: string;
  readonly sessionId: string; readonly environmentId: string;
};
export type PwceReadTicket = { readonly epoch: number; readonly key: string; readonly cursor: string };
export type PwceCachedRead<T> = { readonly value: T; readonly expiresAt: string; readonly isCurrent: () => boolean };
type Entry<T> = { value: T; epoch: number; expires: number; monotonicExpires: number; bytes: number };
const kinds = new Set(["context.invalidated", "authority.invalidated", "capabilities.invalidated", "action.updated", "provider.degraded"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048;
const cursorValue = (value: unknown): number | undefined => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;

export class PwceCacheError extends Error {
  readonly code: "scope_unavailable" | "read_invalidated" | "invalid_cache_input";
  constructor(code: PwceCacheError["code"]) { super(`PWCE context is unavailable (${code})`); this.code = code; }
}

/** Volatile, single-session read cache. It cannot issue grants or authorize effects. */
export class PwceScopedCache<T> {
  readonly scope: PwceCacheScope;
  private readonly ownerCurrent: () => boolean;
  private readonly clock: () => number;
  private readonly monotonic: () => number;
  private readonly maximumAgeMs: number;
  private readonly authorityExpires: number;
  private readonly authorityMonotonicExpires: number;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly seen = new Map<string, { cursor: string; fingerprint: string }>();
  private readonly tickets = new WeakSet<PwceReadTicket>();
  private epoch = 0;
  private bytes = 0;
  private cursor = "0";
  private usable = true;
  private needsRefresh = true;
  private reason = "initial_read_required";

  constructor(scope: PwceCacheScope, options: { isCurrent: () => boolean; maximumAgeMs?: number; clock?: () => number; monotonic?: () => number }) {
    this.scope = structuredClone(scope);
    Object.freeze(this.scope.participantRefs); Object.freeze(this.scope);
    this.ownerCurrent = options.isCurrent;
    this.clock = options.clock ?? Date.now; this.monotonic = options.monotonic ?? (() => performance.now());
    this.maximumAgeMs = options.maximumAgeMs ?? 1000;
    this.authorityExpires = Date.parse(scope.authorityExpiresAt);
    if (!Number.isFinite(this.authorityExpires) || !Number.isInteger(this.maximumAgeMs) || this.maximumAgeMs < 1 || this.maximumAgeMs > 30_000
      || [scope.worldRef, scope.executionEnvironmentRef, scope.authorityContextRef, scope.siteRef, scope.principalRef, scope.sessionId, scope.environmentId].some(value => !bounded(value))) throw new PwceCacheError("invalid_cache_input");
    this.authorityMonotonicExpires = this.monotonic() + Math.max(0, this.authorityExpires - this.clock());
    this.checkScope();
  }
  private checkScope(): boolean {
    let current = false;
    try { current = this.ownerCurrent(); } catch { /* Unknown owner scope is unavailable. */ }
    if (!this.usable || !current || this.clock() >= this.authorityExpires || this.monotonic() >= this.authorityMonotonicExpires) {
      if (this.usable) this.close(current ? "authority_expired" : "owner_scope_changed");
      return false;
    }
    return true;
  }
  private clear(reason: string): void {
    this.epoch++; this.entries.clear(); this.bytes = 0; this.needsRefresh = true; this.reason = reason;
  }
  close(reason = "subscription_closed"): void { if (this.usable) { this.clear(reason); this.usable = false; } }
  /** A reconnect starts a new connection under this still-current authority. No cache survives it. */
  disconnected(): void { if (this.checkScope()) this.clear("subscription_disconnected"); }
  status(): { cursor: string; refreshRequired: boolean; usable: boolean; reason: string; entries: number } {
    this.checkScope(); return { cursor: this.cursor, refreshRequired: this.needsRefresh, usable: this.usable, reason: this.reason, entries: this.entries.size };
  }
  beginRead(key: string): PwceReadTicket {
    if (!this.checkScope()) throw new PwceCacheError("scope_unavailable");
    if (!bounded(key)) throw new PwceCacheError("invalid_cache_input");
    const ticket = Object.freeze({ key, epoch: this.epoch, cursor: this.cursor }); this.tickets.add(ticket); return ticket;
  }
  isReadCurrent(ticket: PwceReadTicket): boolean { return this.tickets.has(ticket) && this.checkScope() && ticket.epoch === this.epoch; }
  acceptReplay(value: { events: unknown; nextCursor: unknown; resyncRequired: unknown; hasMore: unknown }): boolean {
    const next = cursorValue(value.nextCursor);
    const previous = Number(this.cursor);
    if (!this.checkScope()) throw new PwceCacheError("scope_unavailable");
    if (next === undefined || !Array.isArray(value.events) || value.events.length > 100 || typeof value.resyncRequired !== "boolean" || typeof value.hasMore !== "boolean") { this.clear("malformed_replay"); throw new PwceCacheError("read_invalidated"); }
    if (value.resyncRequired) {
      if (value.events.length || value.hasMore) { this.clear("malformed_replay"); throw new PwceCacheError("read_invalidated"); }
      this.seen.clear(); this.clear("replay_resync"); this.cursor = value.nextCursor as string; return false;
    }
    if (next < Number(this.cursor)) { this.clear("replay_cursor_regressed"); throw new PwceCacheError("read_invalidated"); }
    for (const item of value.events) {
      if (!object(item)) { this.clear("malformed_replay"); throw new PwceCacheError("read_invalidated"); }
      const result = this.accept({ id: typeof item.cursor === "string" ? item.cursor : null, event: typeof item.type === "string" ? item.type : "", data: JSON.stringify(item) });
      if (result === "resync" || result === "closed") throw new PwceCacheError("read_invalidated");
    }
    if (next < Number(this.cursor) || value.hasMore && (!value.events.length || next <= previous)) { this.clear("malformed_replay_cursor"); throw new PwceCacheError("read_invalidated"); }
    this.cursor = value.nextCursor as string; return value.hasMore;
  }
  commitRead(ticket: PwceReadTicket, value: T, options: { cursor: string; validUntil?: string } ): PwceCachedRead<T> {
    if (!this.tickets.delete(ticket) || !this.checkScope() || ticket.epoch !== this.epoch) throw new PwceCacheError("read_invalidated");
    const cursor = cursorValue(options.cursor);
    if (cursor === undefined || cursor < Number(ticket.cursor)) { this.clear("response_cursor_regressed"); throw new PwceCacheError("read_invalidated"); }
    let copied: T; let size: number;
    try {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error();
      size = new TextEncoder().encode(encoded).byteLength;
      copied = JSON.parse(encoded) as T;
    } catch { throw new PwceCacheError("invalid_cache_input"); }
    if (size > 262_144) throw new PwceCacheError("invalid_cache_input");
    const now = this.clock();
    const validity = options.validUntil === undefined ? Infinity : Date.parse(options.validUntil);
    if (Number.isNaN(validity)) throw new PwceCacheError("invalid_cache_input");
    const expires = Math.min(now + this.maximumAgeMs, this.authorityExpires, validity);
    if (expires <= now) throw new PwceCacheError("read_invalidated");
    this.remove(ticket.key);
    while (this.entries.size >= 32 || this.bytes + size > 1_048_576) this.remove(this.entries.keys().next().value!);
    const entry = { value: copied, epoch: this.epoch, expires, monotonicExpires: this.monotonic() + expires - now, bytes: size };
    this.entries.set(ticket.key, entry); this.bytes += size;
    // The read's cursor is not an acknowledgement of event delivery. Keep the
    // event high-water mark until replay is consumed; otherwise races lose events.
    this.needsRefresh = false; this.reason = "fresh_read";
    return this.lease(ticket.key, entry);
  }
  private remove(key: string): void { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); } }
  private entryCurrent(key: string, entry: Entry<T>): boolean {
    return this.checkScope() && !this.needsRefresh && this.entries.get(key) === entry && entry.epoch === this.epoch && this.clock() < entry.expires && this.monotonic() < entry.monotonicExpires;
  }
  private lease(key: string, entry: Entry<T>): PwceCachedRead<T> {
    return { value: structuredClone(entry.value), expiresAt: new Date(entry.expires).toISOString(), isCurrent: () => this.entryCurrent(key, entry) };
  }
  get(key: string): PwceCachedRead<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) { this.checkScope(); return undefined; }
    if (!this.entryCurrent(key, entry)) { this.remove(key); return undefined; }
    return this.lease(key, entry);
  }
  /** Transport error/EOF must be reported separately; an event is never a grant. */
  accept(frame: PwceInvalidationEvent): "duplicate" | "invalidated" | "resync" | "closed" {
    if (!this.checkScope()) return "closed";
    if (frame.event === "resync.required") {
      try {
        const data: unknown = JSON.parse(frame.data);
        if (object(data) && ["authority_context_expired", "authority_context_invalidated", "authentication_failed", "scope_denied"].includes(String(data.reason))) { this.close("authority_invalidated"); return "closed"; }
      } catch { /* Malformed control frames still invalidate all cached data. */ }
      this.seen.clear(); this.cursor = "0"; this.clear("resync_required");
      // Any terminal reason still requires a new authenticated call. The caller
      // closes the binding for authority/owner changes instead of renewing it here.
      return "resync";
    }
    if (new TextEncoder().encode(frame.data).byteLength > 65_536) { this.clear("oversized_invalidation"); return "resync"; }
    let data: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(frame.data); if (!object(parsed)) throw new Error(); data = parsed; }
    catch { this.clear("malformed_invalidation"); return "resync"; }
    const cursor = cursorValue(data.cursor);
    const watch = data.watch;
    if (!kinds.has(frame.event) || data.type !== frame.event || cursor === undefined || frame.id !== data.cursor || !bounded(data.eventId)
      || !bounded(data.reason) || !(data.affectedRef === null || bounded(data.affectedRef))
      || !bounded(data.occurredAt) || !Number.isFinite(Date.parse(data.occurredAt)) || !bounded(data.correlationId)
      || !(typeof data.sourceRevision === "string" && bounded(data.sourceRevision) || typeof data.sourceRevision === "number" && Number.isSafeInteger(data.sourceRevision))
      || !object(watch) || !Array.isArray(watch.siteRefs) || !Array.isArray(watch.principalRefs)
      || watch.siteRefs.length > 128 || watch.principalRefs.length > 128 || !watch.siteRefs.every(bounded) || !watch.principalRefs.every(bounded)
      || !(watch.siteRefs.includes(this.scope.siteRef) || watch.principalRefs.includes(this.scope.principalRef))) {
      this.clear("invalid_invalidation_scope"); return "resync";
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([data.type, data.cursor, data.sourceRevision, data.affectedRef, data.reason, data.occurredAt, data.correlationId, [...watch.siteRefs].sort(), [...watch.principalRefs].sort()])).digest("hex");
    const prior = this.seen.get(data.eventId);
    if (prior && prior.cursor === data.cursor && prior.fingerprint === fingerprint) return "duplicate";
    if (prior || cursor <= Number(this.cursor)) { this.clear("invalidation_order_conflict"); return "resync"; }
    this.cursor = data.cursor as string;
    this.seen.set(data.eventId, { cursor: this.cursor, fingerprint });
    if (this.seen.size > 128) this.seen.delete(this.seen.keys().next().value!);
    if (frame.event === "authority.invalidated") { this.close("authority_invalidated"); return "closed"; }
    this.clear(frame.event); return "invalidated";
  }
}
