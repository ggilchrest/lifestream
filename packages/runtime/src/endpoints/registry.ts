export type EndpointClass = "ambientPresence" | "personalCompanion" | "desktopCompanion" | "voiceOnly" | "testHarness";
export type EndpointProfile = { schemaVersion: "1.0.0"; endpointId: string; endpointClass: EndpointClass; locationRef: string | null; ownership: "personal" | "shared" | "managed" | "fixture"; inputModalities: ("text" | "audio")[]; outputModalities: ("text" | "audio" | "semanticEmbodiment")[]; privacyClass: "public" | "personal" | "sensitive" | "restricted"; presenceCapabilities: ("glanceable" | "spatial" | "walkUp" | "notifications")[]; rendererCapabilities: unknown; handoffSupport: "none" | "newLinkedSession" | "sameSession"; speakerIdentity: "verified" | "inferred" | "ambiguous" | "unavailable"; health: "healthy" | "degraded" | "unavailable"; configurationRevision: number };

export class EndpointRegistry {
  private readonly endpoints = new Map<string, EndpointProfile>();
  register(profile: EndpointProfile): EndpointProfile { validate(profile); if (this.endpoints.has(profile.endpointId)) throw new Error("endpoint already registered"); const copy = structuredClone(profile); this.endpoints.set(profile.endpointId, copy); return structuredClone(copy); }
  revise(endpointId: string, expectedRevision: number, changes: Partial<EndpointProfile>): EndpointProfile { const current = this.endpoints.get(endpointId); if (!current || current.configurationRevision !== expectedRevision) throw new Error("endpoint revision conflict"); const next = { ...current, ...changes, endpointId, configurationRevision: expectedRevision + 1 }; validate(next); this.endpoints.set(endpointId, structuredClone(next)); return structuredClone(next); }
  retire(endpointId: string, expectedRevision: number): EndpointProfile { return this.revise(endpointId, expectedRevision, { health: "unavailable" }); }
  get(endpointId: string): EndpointProfile | undefined { const profile = this.endpoints.get(endpointId); return profile && structuredClone(profile); }
  list(): EndpointProfile[] { return [...this.endpoints.values()].map((profile) => structuredClone(profile)); }
}

function validate(profile: EndpointProfile): void { if (!/^[0-9a-f-]{36}$/.test(profile.endpointId) || profile.schemaVersion !== "1.0.0" || profile.inputModalities.length < 1 || profile.outputModalities.length < 1 || !Number.isInteger(profile.configurationRevision) || profile.configurationRevision < 1) throw new Error("endpoint profile invalid"); if (profile.endpointClass === "ambientPresence" && profile.speakerIdentity === undefined) throw new Error("ambient speaker identity required"); }
