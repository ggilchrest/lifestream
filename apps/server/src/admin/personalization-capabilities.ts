/** Public implementation inventory: references existing domain operations, never grants authority. */
export type AdministrationCapability = {
  key: string; owner: string; version: number; scope: string; access: string; lifecycle: string;
  source: string; limits: string; precedence: string; authorization: string; apply: string;
  status: "supported" | "unavailable" | "deferred";
};
export function administrationCapabilities(): AdministrationCapability[] {
  const rows: Array<[string, string, string, string, AdministrationCapability["status"], string]> = [
    ["assistant.definition", "AssistantProfile", "Assistant", "/api/admin/v1/assistants/:id/revisions", "supported", "Bounded identity and numeric adaptation fields; secret values, grants and executable imports rejected"],
    ["assistant.preview", "AssistantProfile", "Assistant", "/api/admin/v1/assistants/:id/preview", "supported", "Diff and candidate only; no active state, memory, tools or grants"],
    ["assistant.activation", "AssistantProfile", "Assistant", "/api/admin/v1/assistants/:id/activate", "supported", "Explicit Human action with expected active revision"],
    ["assistant.rollback", "AssistantProfile", "Assistant", "/api/admin/v1/assistants/:id/rollback", "supported", "Creates a reviewed draft; separate activation required"],
    ["assistant.importExport", "AssistantProfile", "Assistant", "/api/admin/v1/assistants/:id/export", "supported", "Validated profile-only import; grants and secrets excluded"],
    ["memory.lifecycle", "MemoryRecord", "Assistant", "/api/admin/v1/assistants/:id/memories", "supported", "Candidate, review, correction and history; permissions checked before access"],
    ["persona.adaptation", "AdaptivePersona", "Assistant", "/api/admin/v1/assistants/:id/adaptations", "supported", "Numeric declared bounds; protected fields require Human review"],
    ["relationship.controls", "Relationship", "Relationship", "/api/admin/v1/assistants/:id/relationships/:relationship/configurations", "supported", "Draft/activation/reset/rollback; expression cannot widen privacy or authority"],
    ["authority.administration", "HumanAuthority", "Principal and Assistant", "/api/authority/v1", "supported", "Availability never grants invocation authority; current scope/revocation checked"],
    ["provider.configuration", "RuntimeConfig", "Deployment", "configuration files and /api/runtime/v1/profile", "supported", "Operator-selected profiles and secret references only; profile mutation is separate"],
    ["endpoint.bindings", "InteractionEndpoint", "Endpoint", "deployment-managed bindings", "unavailable", "Physical bindings remain composition-owned; no binding editor"],
    ["renderer.authoring", "PresentationProfile", "Assistant", "opaque profile reference", "deferred", "No renderer editor; text and audio administration remain available"],
    ["voice.training", "VoiceProfile", "Assistant", "separately authorized training", "deferred", "No training operation in ordinary administration"],
  ];
  return rows.map(([key, owner, scope, access, status, limits]) => ({ key, owner, version: 1, scope, access, status, limits,
    lifecycle: "draft, validate, preview, explicit activation, history and rollback where supported",
    source: "stored owner-local revision or configured deployment profile",
    precedence: "current validated request, policy and protected bounds precede profile preferences",
    authorization: "current authenticated Human and explicit target scope; imported or AI text is never authority",
    apply: key === "provider.configuration" ? "explicit runtime profile operation; no automatic restart" : "owner-local revision boundary; no implicit deployment" }));
}
