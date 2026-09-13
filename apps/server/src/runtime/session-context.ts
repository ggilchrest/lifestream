import { randomUUID } from "node:crypto";
import type { Database } from "@lifestream/storage-sqlite";
import { EndpointRegistry, type EndpointProfile } from "@lifestream/runtime/endpoints/registry";

// Transport-owned projections of the existing Session and InteractionEndpoint tables.
// Selecting disclosure scope never asserts who is physically present or grants authority.
export function readSessionEndpoint(database: Database, sessionId: string): { revision: number; endpoint: EndpointProfile | null } {
  const row = database.connection.prepare("SELECT s.revision, e.profile_json AS profile FROM sessions s LEFT JOIN interaction_endpoints e ON s.endpoint_id=e.endpoint_id WHERE s.id=? AND s.status='active'").get(sessionId) as { revision: number; profile: string | null } | undefined;
  return { revision: row?.revision ?? 0, endpoint: row?.profile ? JSON.parse(row.profile) as EndpointProfile : null };
}
export function reviseSessionEndpoint(database: Database, sessionId: string, input: Record<string, unknown>, audioConfigured: boolean): ReturnType<typeof readSessionEndpoint> {
  if (Object.keys(input).some(key => !["expectedRevision", "mode", "audienceScope"].includes(key)) || !Number.isInteger(input.expectedRevision) || !["none", "text", "audio"].includes(String(input.mode)) || !["unknown", "authenticatedSession"].includes(String(input.audienceScope))) throw new Error("A revision, supported logical mode and disclosure scope are required");
  if (input.mode === "audio" && !audioConfigured) throw new Error("Audio transport is not configured");
  if (input.mode === "none" && input.audienceScope !== "unknown") throw new Error("An unbound endpoint has unknown audience scope");
  return database.transaction(tx => {
    const current = readSessionEndpoint(database, sessionId);
    if (current.revision !== input.expectedRevision) throw new Error("Session context revision conflict");
    let endpoint: EndpointProfile | null = null;
    if (input.mode !== "none") {
      endpoint = { schemaVersion: "1.0.0", endpointId: current.endpoint?.endpointId ?? randomUUID(), endpointClass: "desktopCompanion", locationRef: null, ownership: "personal", inputModalities: input.mode === "audio" ? ["text", "audio"] : ["text"], outputModalities: input.mode === "audio" ? ["text", "audio"] : ["text"], privacyClass: input.audienceScope === "authenticatedSession" ? "personal" : "public", presenceCapabilities: [], rendererCapabilities: null, handoffSupport: "sameSession", speakerIdentity: "unavailable", health: "healthy", configurationRevision: (current.endpoint?.configurationRevision ?? 0) + 1 };
      new EndpointRegistry().register(endpoint);
      tx.run("INSERT OR REPLACE INTO interaction_endpoints (endpoint_id,configuration_revision,endpoint_class,ownership,profile_json,health) VALUES (?,?,?,?,?,?)", endpoint.endpointId, endpoint.configurationRevision, endpoint.endpointClass, endpoint.ownership, JSON.stringify(endpoint), endpoint.health);
    }
    if (current.revision === 0) tx.run("INSERT INTO sessions (id,conversation_id,revision,status,endpoint_id,interaction_id) VALUES (?,?,1,'active',?,?)", sessionId, randomUUID(), endpoint?.endpointId ?? null, randomUUID());
    else { tx.run("UPDATE sessions SET revision=revision+1,endpoint_id=? WHERE id=? AND revision=? AND status='active'", endpoint?.endpointId ?? null, sessionId, current.revision); if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new Error("Session context revision conflict"); }
    return { revision: current.revision + 1, endpoint };
  });
}
