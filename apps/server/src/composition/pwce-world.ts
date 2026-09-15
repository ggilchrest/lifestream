import { pwceIdentity } from './pwce-identity.ts';
import { createHash } from "node:crypto";
import { PwceContextSession, PwceGatewayClient } from "@lifestream/providers-pwce";
import { formatWorldContext, unavailableWorldContext } from "@lifestream/runtime/context/world";
import type { PreparedWorldLease } from "@lifestream/runtime/context/world";
import type { PwceProfile } from "../config/schema.ts";

export type WorldOwner = { assistantId: string; principalId: string; sessionId: string; endpointId: string | null; audienceKnown: boolean; revision: string; isCurrent: () => boolean; onInvalidation?: () => void };
type Entry = { sessions: PwceContextSession[]; owner: WorldOwner; controller: AbortController; usedAt: number };
const reference = (kind: string, values: unknown[]) => `lifestream.${kind}.${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`;

export class PwceWorldContext {
  private readonly client: PwceGatewayClient;
  private readonly profile: PwceProfile;
  private readonly entries = new Map<string, Entry>();
  private readonly controller = new AbortController();
  private readonly expiry: ReturnType<typeof setInterval>;
  constructor(profile: PwceProfile, token: string) {
    this.profile = structuredClone(profile);
    this.client = new PwceGatewayClient({ baseUrl: profile.endpoint, token, requestTimeoutMs: profile.timeoutMs });
    this.expiry = setInterval(() => this.prune(), 15_000); this.expiry.unref();
  }
  async probe(signal: AbortSignal): Promise<void> { await this.client.negotiate(signal); }
  private current(owner: WorldOwner): boolean { try { return !this.controller.signal.aborted && owner.isCurrent(); } catch { return false; } }
  private notify(owner: WorldOwner): void { try { owner.onInvalidation?.(); } catch { /* Notification cannot restore a revoked lease. */ } }
  private remove(key: string): void { const entry = this.entries.get(key); if (!entry) return; entry.controller.abort(); entry.sessions.forEach(session => session.close()); this.entries.delete(key); this.notify(entry.owner); }
  prune(): void { for (const [key, entry] of this.entries) if (!this.current(entry.owner) || Date.now() - entry.usedAt >= 30_000 || entry.sessions.some(session => !session.status().usable)) this.remove(key); }
  close(): void { this.controller.abort(); clearInterval(this.expiry); for (const key of this.entries.keys()) this.remove(key); }
  async prepare(owner: WorldOwner, signal: AbortSignal): Promise<PreparedWorldLease> {
    const unavailable = (reason: "audience_unknown" | "provider_unavailable" | "scope_unavailable"): PreparedWorldLease => ({ context: unavailableWorldContext(reason), isCurrent: () => this.current(owner), isSnapshotCurrent: () => this.current(owner) });
    if (!this.current(owner)) return unavailable("scope_unavailable");
    if (!owner.audienceKnown || !owner.endpointId) return unavailable("audience_unknown");
    this.prune();
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), this.profile.timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal, this.controller.signal]);
    const key = reference("scope", [this.profile.lifestreamEnvironmentId, owner.assistantId, owner.principalId, owner.sessionId, owner.endpointId, owner.revision]);
    try {
      let entry = this.entries.get(key);
      if (!entry) {
        const identity = pwceIdentity(this.profile.lifestreamEnvironmentId, { ...owner, endpointId: owner.endpointId });
        const authority = await this.client.authority(this.profile.siteRefs, combined, identity);
        if (!this.current(owner) || combined.aborted || typeof authority.authorityContextRef !== "string" || typeof authority.expiresAt !== "string"
          || !Array.isArray(authority.siteRefs) || JSON.stringify(authority.siteRefs) !== JSON.stringify(this.profile.siteRefs)) throw new Error("World authority is unavailable");
        // Recheck after the asynchronous authority call so concurrent requests do
        // not leak duplicate connections for the same owner binding.
        entry = this.entries.get(key);
        if (!entry) {
          if (this.entries.size >= 16) this.remove(this.entries.keys().next().value!);
          const controller = new AbortController();
          const sessions = this.profile.siteRefs.map(siteRef => new PwceContextSession(this.client, { ...identity, worldRef: this.profile.worldRef, executionEnvironmentRef: this.profile.executionEnvironmentRef, authorityContextRef: authority.authorityContextRef as string, authorityExpiresAt: authority.expiresAt as string, siteRef, principalRef: this.profile.principalRef, sessionId: owner.sessionId, environmentId: this.profile.lifestreamEnvironmentId }, { isCurrent: () => this.current(owner) && !controller.signal.aborted, timeoutMs: this.profile.timeoutMs }));
          entry = { sessions, owner, controller, usedAt: Date.now() }; this.entries.set(key, entry);
          for (const session of sessions) void (async () => { try { for await (const _event of session.subscribeInvalidations(controller.signal)) { this.notify(owner); } } catch { /* Next preparation obtains fresh authority; there is no hidden reconnect. */ } finally { session.close(); this.notify(owner); } })();
        }
      }
      entry.usedAt = Date.now();
      const reads = await Promise.all(entry.sessions.map(session => session.getPreparedInputs(combined)));
      if (combined.aborted || !this.current(owner) || reads.some(read => !read.isCurrent())) throw new Error("World read changed during preparation");
      const context = formatWorldContext(reads.map(read => read.value), this.profile.maximumPromptBytes);
      return { context, isCurrent: () => this.current(owner) && reads.every(read => read.isCurrent()), isSnapshotCurrent: () => this.current(owner) && reads.every(read => read.isSnapshotCurrent()) };
    } catch { this.remove(key); return unavailable("provider_unavailable"); }
    finally { clearTimeout(timer); }
  }
}
