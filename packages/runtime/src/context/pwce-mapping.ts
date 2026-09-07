export type PwceKnowledgeState = "current" | "stale" | "unknown" | "conflicted" | "unavailable" | "notDetected";
export type PwceWorldItem = { readonly itemRef: string; readonly property: string; readonly value: unknown; readonly knowledgeState: PwceKnowledgeState; readonly basis: "observed" | "derived" | null; readonly sourceRevision: string; readonly evidenceRefs: readonly string[]; readonly limitations: readonly string[] };
export type LifestreamWorldContextSlice = { readonly profileId: "lifestream-pwce.v1"; readonly worldRef: string; readonly environmentRef: string; readonly siteRefs: readonly string[]; readonly authorityContextRef: string; readonly sourceRevision: string; readonly asOf: string; readonly items: readonly PwceWorldItem[]; readonly limitations: readonly string[] };

export function mapPwceSlice(input: Omit<LifestreamWorldContextSlice, "profileId" | "items"> & { items: readonly PwceWorldItem[] }): LifestreamWorldContextSlice {
  if (!input.worldRef || !input.environmentRef || !input.authorityContextRef || !input.sourceRevision) throw new Error("incomplete PWCE context binding");
  return { ...input, profileId: "lifestream-pwce.v1", siteRefs: [...input.siteRefs], items: input.items.map((item) => ({ ...item, evidenceRefs: [...item.evidenceRefs], limitations: [...item.limitations] })), limitations: [...input.limitations] };
}
