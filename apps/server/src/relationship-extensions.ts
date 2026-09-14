import { createHash, randomUUID } from "node:crypto";
import { createContractValidator } from "@lifestream/contracts";
import type { Database } from "@lifestream/storage-sqlite";

export type ExtensionKind = "initiative" | "understanding";
export type ExtensionSettings = Partial<Record<ExtensionKind, Record<string, unknown>>>;
export type RelationshipConfiguration = {
  quarantined?: boolean; representation?: "recordOriented" | "conventionOriented";
  derivedLabId?: string; derivedInsightId?: string; name?: string;
  basisActiveConfigurationId?: string | null; restoredFrom?: string;
  configurationId: string; relationshipId: string; revision: number;
  status: "draft" | "active" | "superseded"; preset: "balanced" | "concise" | "coaching";
  controls: Record<string, number>; createdAt: string; createdBy: string;
  supersedes?: string | undefined; extensions?: ExtensionSettings;
};
type Scope = { assistantId: string; userId: string; relationshipId: string; deploymentId?: string };
type Result = { status: number; body: Record<string, unknown> };
const validator = createContractValidator();
const apiId = (kind: ExtensionKind) => `https://lifestream.dev/contracts/${kind === "initiative" ? "initiative" : "understanding"}-api/1.0.0`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const extensionError = (status: number, code: string, message: string): Result => ({ status, body: { schemaVersion: "1.0.0", code, message, retryable: false, correlationId: randomUUID() } });

// Settings are stored in the existing parent record. There is no extension active pointer.
export const projectExtension = (kind: ExtensionKind, parent: RelationshipConfiguration, scope: Scope): Record<string, unknown> | undefined => {
  const settings = parent.extensions?.[kind];
  if (!settings) return undefined;
  return { ...structuredClone(settings), schemaVersion: "1.0.0", recordType: "configuration", assistantId: scope.assistantId, userId: scope.userId, relationshipId: scope.relationshipId, deploymentId: scope.deploymentId, configurationId: parent.configurationId, revision: parent.revision, lifecycle: parent.status,
    ...(kind === "initiative" ? { parentConfigurationRevision: `${parent.configurationId}:${parent.revision}` } : { relationshipConfigurationRef: `relationship-configuration:${parent.configurationId}:${parent.revision}` }) };
};

export function handleExtensionConfiguration(options: {
  database: Database; kind: ExtensionKind; scope: Scope; request: unknown;
  defaults: Record<string, number>; current: () => boolean;
  activationDenial: (parent: RelationshipConfiguration) => string | undefined;
  reload: () => void;
}): Result {
  const { database, kind, scope, defaults } = options;
  if (!validator.validate(`${apiId(kind)}#/$defs/Request`, options.request).valid) return extensionError(422, "invalid_extension_request", "Unsupported version, operation or fields.");
  if (!scope.deploymentId) return extensionError(409, "identity_mapping_required", "This relationship needs an explicit authenticated user and deployment mapping.");
  const request = options.request as Record<string, unknown>;
  const operation = String(request.operation);
  if (!["inspect", "draft", "preview", "activate", "rollback"].includes(operation)) return extensionError(409, "operation_unavailable", "This operation is not yet available in this runtime.");
  try {
    const result = database.transaction(tx => {
      if (!options.current()) return extensionError(409, "current_scope_required", "Relationship authorization or privacy state changed.");
      const parents = tx.all<{ payload: string }>("SELECT payload_json AS payload FROM assistant_relationship_configurations WHERE relationship_id=? ORDER BY json_extract(payload_json,'$.revision') LIMIT 129", scope.relationshipId).map(row => JSON.parse(row.payload) as RelationshipConfiguration);
      const active = parents.find(parent => parent.status === "active");
      const key = typeof request.idempotencyKey === "string" ? request.idempotencyKey : undefined;
      const binding = `extension:${kind}:${operation}:${createHash("sha256").update(canonical([{assistantId:scope.assistantId,userId:scope.userId,relationshipId:scope.relationshipId,deploymentId:scope.deploymentId}, request])).digest("hex")}`;
      if (key) {
        const previous = tx.get<{ relationshipId: string; operation: string; response: string }>("SELECT relationship_id AS relationshipId, operation, response_json AS response FROM assistant_relationship_idempotency WHERE idempotency_key=?", key);
        if (previous) return previous.relationshipId === scope.relationshipId && previous.operation === binding ? JSON.parse(previous.response) as Result : extensionError(409, "idempotency_conflict", "This retry key was used for a different request.");
      }
      let selected = parents.find(parent => parent.configurationId === request.configurationId);
      let changed = false;
      let status = 200;
      const save = (parent: RelationshipConfiguration) => tx.run("INSERT OR REPLACE INTO assistant_relationship_configurations (configuration_id,relationship_id,payload_json) VALUES (?,?,?)", parent.configurationId, scope.relationshipId, JSON.stringify(parent));
      if (operation === "draft" || operation === "rollback") {
        if (parents.length >= 128) return extensionError(409, "configuration_capacity", "The bounded configuration history is full.");
        if (operation === "draft" && request.expectedActiveConfigurationId !== (active?.configurationId ?? null)) return extensionError(409, "configuration_basis_stale", "Active settings changed. Review a fresh draft.");
        if (operation === "rollback" && (!selected || selected.status !== "superseded" || selected.revision !== request.expectedRevision || !selected.extensions?.[kind] || selected.quarantined)) return extensionError(409, "rollback_conflict", "Select an available superseded configuration at its current revision.");
        const source = operation === "rollback" ? selected! : active;
        selected = { ...(source ? structuredClone(source) : { preset: "balanced" as const, controls: { ...defaults } }), configurationId: randomUUID(), relationshipId: scope.relationshipId, revision: Math.max(0, ...parents.map(parent => parent.revision)) + 1, status: "draft", basisActiveConfigurationId: active?.configurationId ?? null, createdBy: scope.userId, createdAt: new Date().toISOString(), name: `${operation === "rollback" ? "Rollback" : "Review"} ${kind}`, extensions: { ...structuredClone(source?.extensions ?? {}), ...(operation === "draft" ? { [kind]: structuredClone(request.settings) as Record<string, unknown> } : {}) } };
        if (operation === "rollback") selected.restoredFrom = String(request.configurationId);
        save(selected); status = 201;
      } else if (operation === "preview" || operation === "activate") {
        if (!selected || !selected.extensions?.[kind] || selected.quarantined) return extensionError(404, "configuration_unavailable", "Configuration is unavailable in this relationship.");
        if (operation === "activate") {
          if (selected.status !== "draft" || selected.revision !== request.expectedRevision || selected.basisActiveConfigurationId !== (active?.configurationId ?? null)) return extensionError(409, "configuration_basis_stale", "The draft or its active basis changed.");
          const denial = options.activationDenial(selected);
          if (denial) return extensionError(409, "configuration_policy_denied", denial);
          if (active) save({ ...active, status: "superseded" });
          selected = { ...selected, status: "active" }; save(selected); changed = true;
        }
      }
      const records = (operation === "inspect" ? parents : selected ? [selected] : []).filter(parent => !parent.quarantined).map(parent => projectExtension(kind, parent, scope)).filter(record => record !== undefined);
      const response: Result = { status, body: { schemaVersion: "1.0.0", relationshipId: scope.relationshipId, operation, activeConfigurationId: changed ? selected!.configurationId : active?.configurationId ?? null, records: records.slice(-128), explanations: [{ code: changed ? "activated" : "review_only", summary: changed ? "The existing parent configuration was activated. Output and research still require current runtime policy." : "Review has no delivery, acquisition or active-setting effect.", sourceRefs: [] }], activeStateChanged: changed, executionMode: "live", nextCursor: null, ...(kind === "initiative" ? { delivery: null } : {}) } };
      if (!validator.validate(`${apiId(kind)}#/$defs/Response`, response.body).valid) throw new Error("Invalid extension response");
      if (key) tx.run("INSERT INTO assistant_relationship_idempotency (idempotency_key,relationship_id,operation,response_json) VALUES (?,?,?,?)", key, scope.relationshipId, binding, JSON.stringify(response));
      return response;
    });
    if (result.status < 400) options.reload();
    return result;
  } catch { return extensionError(409, "extension_transaction_failed", "The configuration transaction could not complete; no partial configuration was activated."); }
}

/** Keep additive settings off unchanged legacy configuration response shapes. */
export function legacyConfigurationView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyConfigurationView);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !(key === "extensions" && typeof record.configurationId === "string" && typeof record.relationshipId === "string" && record.controls !== undefined)).map(([key, child]) => [key, legacyConfigurationView(child)]));
}
