import { randomUUID } from "node:crypto";
import type { Database } from "@lifestream/storage-sqlite";
import { EndpointRegistry, type EndpointProfile } from "@lifestream/runtime/endpoints/registry";

// Transport-owned projections of the existing Session and InteractionEndpoint tables.
// Selecting disclosure scope never asserts who is physically present or grants authority.
export function readSessionEndpoint(database: Database, sessionId: string): { revision: number; endpoint: EndpointProfile | null } {
  const row = database.connection.prepare("SELECT s.revision, e.profile_json AS profile, c.mode, c.audience_scope AS audience, c.configuration_revision AS endpointRevision FROM sessions s LEFT JOIN interaction_endpoints e ON s.endpoint_id=e.endpoint_id LEFT JOIN session_endpoint_settings c ON c.session_id=s.id AND c.endpoint_id=s.endpoint_id WHERE s.id=? AND s.status='active'").get(sessionId) as { revision: number; profile: string | null; mode: string | null; audience: string | null; endpointRevision: number | null } | undefined;
  const endpoint=row?.profile?JSON.parse(row.profile) as EndpointProfile:null;
  if(endpoint){
    endpoint.handoffSupport="newLinkedSession";
    endpoint.privacyClass=row?.audience==='authenticatedSession'?'personal':'public';
    endpoint.inputModalities=row?.mode==='audio'?['text','audio']:['text'];
    endpoint.outputModalities=row?.mode==='audio'?['text','audio']:['text'];
    endpoint.configurationRevision=row?.endpointRevision??endpoint.configurationRevision;
  }
  return { revision: row?.revision ?? 0, endpoint };
}
export function reviseSessionEndpoint(database: Database, sessionId: string, input: Record<string, unknown>, audioConfigured: boolean, principalId?: string): ReturnType<typeof readSessionEndpoint> {
  if (Object.keys(input).some(key => !["expectedRevision", "mode", "audienceScope", "bindingKey", "endpointClass"].includes(key)) || typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.mode !== "string" || !["none", "text", "audio"].includes(input.mode) || typeof input.audienceScope !== "string" || !["unknown", "authenticatedSession"].includes(input.audienceScope)) throw new Error("A revision, supported logical mode and disclosure scope are required");
  if (input.endpointClass !== undefined && !["desktopCompanion", "personalCompanion"].includes(input.endpointClass as string)) throw new Error("Unsupported companion endpoint class");
  if (input.bindingKey !== undefined && (!principalId || typeof input.bindingKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.bindingKey))) throw new Error('A principal-scoped endpoint binding is required');
  if (input.mode === "audio" && !audioConfigured) throw new Error("Audio transport is not configured");
  if (input.mode === "none" && input.audienceScope !== "unknown") throw new Error("An unbound endpoint has unknown audience scope");
  return database.transaction(tx => {
    if(tx.get("SELECT 1 FROM sessions WHERE id=? AND status!='active'",sessionId))throw new Error("This conversation has ended. Sign in again to start a new session.");
    const current = readSessionEndpoint(database, sessionId);
    if (current.revision !== input.expectedRevision) throw new Error("Session context revision conflict");
    let endpoint: EndpointProfile | null = null;
    if (input.mode !== "none") {
      const binding = input.bindingKey ? tx.get<{ endpoint_id: string; profile: string }>('SELECT b.endpoint_id,e.profile_json AS profile FROM endpoint_bindings b JOIN interaction_endpoints e ON e.endpoint_id=b.endpoint_id WHERE b.principal_id=? AND b.binding_key=?', principalId!, input.bindingKey) : undefined;
      if (binding && current.endpoint && binding.endpoint_id !== current.endpoint.endpointId) throw new Error('This session is already bound to a different endpoint');
      const previous = current.endpoint ?? (binding ? JSON.parse(binding.profile) as EndpointProfile : null);
      if (previous && input.endpointClass !== undefined && previous.endpointClass !== input.endpointClass) throw new Error("The bound endpoint class cannot change");
      const stored=previous?tx.get<{revision:number}>('SELECT configuration_revision AS revision FROM interaction_endpoints WHERE endpoint_id=?',previous.endpointId):undefined;
      endpoint = { schemaVersion: "1.0.0", endpointId: previous?.endpointId ?? randomUUID(), endpointClass: previous?.endpointClass ?? (input.endpointClass as "desktopCompanion" | "personalCompanion" | undefined) ?? "desktopCompanion", locationRef: null, ownership: "personal", inputModalities: input.mode === "audio" ? ["text", "audio"] : ["text"], outputModalities: input.mode === "audio" ? ["text", "audio"] : ["text"], privacyClass: input.audienceScope === "authenticatedSession" ? "personal" : "public", presenceCapabilities: [], rendererCapabilities: null, handoffSupport: "newLinkedSession", speakerIdentity: "unavailable", health: "healthy", configurationRevision: (previous?.configurationRevision ?? 0) + 1 };
      endpoint.configurationRevision=Math.max(previous?.configurationRevision??0,stored?.revision??0)+1;
      new EndpointRegistry().register(endpoint);
      tx.run("INSERT OR REPLACE INTO interaction_endpoints (endpoint_id,configuration_revision,endpoint_class,ownership,profile_json,health) VALUES (?,?,?,?,?,?)", endpoint.endpointId, endpoint.configurationRevision, endpoint.endpointClass, endpoint.ownership, JSON.stringify(endpoint), endpoint.health);
      if (input.bindingKey) tx.run('INSERT INTO endpoint_bindings(principal_id,binding_key,endpoint_id) VALUES(?,?,?) ON CONFLICT(principal_id,binding_key) DO NOTHING', principalId!, input.bindingKey, endpoint.endpointId);
    }
    if (current.revision === 0) tx.run("INSERT INTO sessions (id,conversation_id,revision,status,endpoint_id,interaction_id) VALUES (?,?,1,'active',?,?)", sessionId, randomUUID(), endpoint?.endpointId ?? null, randomUUID());
    else { tx.run("UPDATE sessions SET revision=revision+1,endpoint_id=? WHERE id=? AND revision=? AND status='active'", endpoint?.endpointId ?? null, sessionId, current.revision); if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new Error("Session context revision conflict"); }
    if(endpoint)tx.run('INSERT INTO session_endpoint_settings (session_id,endpoint_id,mode,audience_scope,configuration_revision) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET endpoint_id=excluded.endpoint_id,mode=excluded.mode,audience_scope=excluded.audience_scope,configuration_revision=excluded.configuration_revision',sessionId,endpoint.endpointId,String(input.mode),String(input.audienceScope),endpoint.configurationRevision);
    else tx.run('DELETE FROM session_endpoint_settings WHERE session_id=?',sessionId);
    return { revision: current.revision + 1, endpoint };
  });
}
