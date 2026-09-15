import { randomUUID } from "node:crypto";
import { createContractValidator } from "@lifestream/contracts";
import type { Database } from "@lifestream/storage-sqlite";
import type { RelationshipContextRecord } from "@lifestream/runtime/context";
const validator = createContractValidator();
type Declaration = { key: string; value: string | number | boolean; sensitivity: "ordinary" | "personal" | "sensitive" };
type Scope = { assistantId: string; purposes: string[]; audiences: string[]; allowedKeys: string[] };
export type UserProfile = { schemaVersion: "1.0.0"; profileId: string; userId: string; deploymentId: string; revision: number; status: "draft" | "active" | "superseded" | "revoked"; subjectRef: string; declarations: Declaration[]; assistantScopes: Scope[]; consentRefs: string[]; sourceRefs: string[]; createdAt: string; validFrom: string; revokedAt: string | null };
export class ProfileScopeError extends Error { status: number; constructor(message: string, status = 422) { super(message); this.status = status; } }
const requireValue = (value: unknown, message: string, status = 422): void => { if (!value) throw new ProfileScopeError(message, status); };
// Uses the existing owner-local SQLite database; profile declarations never carry relationship history.
export class UserProfileAdministration {
  private db: Database;
  constructor(db: Database) { this.db = db; }
  identity(principalId: string): { principalId: string; userId: string; deploymentId: string; participant: "authenticatedPrincipal"; currentSpeaker: "unverified"; audience: "sessionSelectedSeparately" } | null {
    const row = this.db.connection.prepare("SELECT user_id AS userId, deployment_id AS deploymentId FROM user_subject_mappings WHERE principal_id=?").get(principalId) as { userId: string; deploymentId: string } | undefined;
    return row ? { principalId, ...row, participant: "authenticatedPrincipal", currentSpeaker: "unverified", audience: "sessionSelectedSeparately" } : null;
  }
  deploymentId(): string {
    return this.db.transaction(tx => {
      tx.run("INSERT OR IGNORE INTO user_profile_deployment (singleton, deployment_id) VALUES (1, ?)", randomUUID());
      return tx.get<{ deploymentId: string }>("SELECT deployment_id AS deploymentId FROM user_profile_deployment WHERE singleton=1")!.deploymentId;
    });
  }
  establish(principalId: string): NonNullable<ReturnType<UserProfileAdministration["identity"]>> {
    let identity = this.identity(principalId); if (identity) return identity;
    requireValue(/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(principalId), "Stable authenticated UUID principal required; legacy fixture identities are not inferred profile subjects", 409);
    this.db.transaction(tx => {
      tx.run("INSERT OR IGNORE INTO user_profile_deployment (singleton, deployment_id) VALUES (1, ?)", randomUUID());
      const deployment = tx.get<{ deploymentId: string }>("SELECT deployment_id AS deploymentId FROM user_profile_deployment WHERE singleton=1")!;
      tx.run("INSERT INTO user_subject_mappings (principal_id,user_id,deployment_id) VALUES (?,?,?)", principalId, principalId, deployment.deploymentId);
    }); identity = this.identity(principalId); return identity!;
  }
  list(principalId: string): UserProfile[] {
    return (this.db.connection.prepare("SELECT payload_json AS payload FROM user_profile_revisions WHERE principal_id=? ORDER BY revision").all(principalId) as { payload: string }[]).map(row => JSON.parse(row.payload) as UserProfile);
  }
  active(principalId: string): UserProfile | undefined { const row=this.db.connection.prepare("SELECT payload_json AS payload FROM user_profile_revisions WHERE principal_id=? AND status='active'").get(principalId) as {payload:string}|undefined; return row ? JSON.parse(row.payload) as UserProfile : undefined; }
  boundary(principalId: string): string { const row=this.db.connection.prepare("SELECT profile_id AS id,revision FROM user_profile_revisions WHERE principal_id=? AND status='active'").get(principalId) as {id:string;revision:number}|undefined; return row ? `${row.id}:${row.revision}` : "unmapped"; }
  records(principalId: string, assistantId: string): RelationshipContextRecord[] {
    const profile = this.active(principalId); if (!profile) return [];
    const scope = profile.assistantScopes.find(item => item.assistantId === assistantId);
    if (!scope || !scope.audiences.includes("authenticatedSession") || !["conversation", "personalization", "mention"].every(purpose => scope.purposes.includes(purpose))) return [];
    return profile.declarations.filter(item => scope.allowedKeys.includes(item.key)).map(item => ({ id: `user-profile:${profile.profileId}:${item.key}`, revision: profile.revision, content: `${item.key}: ${item.value}`, sourceFamily: `user-declaration:${profile.userId}`, status: "approved", use: /^(?:communication|style|terminology|explanation|convention)[.:]/u.test(item.key) ? "baseline" : "relevant", personalization: true, mention: true, uncertainty: "attributed declaration, not independent verification" }));
  }
  handle(method: string, operation: string | undefined, principalId: string, raw: Record<string, unknown>, canUseAssistant: (id: string) => boolean): { status: number; body: Record<string, unknown> } {
    try {
      if (method === "GET" && !operation) return { status: 200, body: { identity: this.identity(principalId), profiles: this.list(principalId), limitations: ["Only this authenticated subject's declarations are available. Relationship history, conversation, adaptations and grants are never shared.", "Current speaker and physical audience are not inferred from this mapping."] } };
      if (method === "GET" && operation === "export") return { status: 200, body: { profiles: this.list(principalId), scope: "authenticatedSubject", grantsIncluded: false, externalCopiesRevocable: false } };
      requireValue(method === "POST", "Unsupported profile operation", 405);
      const identity = this.establish(principalId), profiles = this.list(principalId), active = profiles.find(item => item.status === "active");
      requireValue(raw.expectedActiveRevision === (active?.revision ?? null), "Active User Profile changed; refresh before review or activation", 409);
      if (!operation || operation === "rollback") {
        const previous = operation === "rollback" ? profiles.find(item => item.profileId === raw.profileId && item.status === "superseded") : undefined;
        if (operation === "rollback") requireValue(previous, "Rollback requires a retained superseded profile", 409);
        requireValue(profiles.length < 32, "Retained profile revision capacity reached", 409);
        const declarations = previous?.declarations ?? raw.declarations, assistantScopes = previous?.assistantScopes ?? raw.assistantScopes;
        const now = new Date().toISOString();
        const profile = { schemaVersion: "1.0.0", profileId: randomUUID(), userId: identity.userId, deploymentId: identity.deploymentId, revision: (profiles.at(-1)?.revision ?? 0) + 1, status: "draft", subjectRef: `authenticated-principal:${principalId}`, declarations, assistantScopes, consentRefs: [], sourceRefs: [`declaration:${principalId}`], createdAt: now, validFrom: now, revokedAt: null } as UserProfile;
        requireValue(validator.validate("https://lifestream.dev/contracts/user-profile/1.0.0", profile).valid, "User Profile schema validation failed");
        requireValue(profile.declarations.length <= 64 && profile.assistantScopes.length <= 16 && new Set(profile.declarations.map(item => item.key)).size === profile.declarations.length, "Bounded unique declarations and Assistant subsets required");
        requireValue(profile.declarations.every(item => ["string", "number", "boolean"].includes(typeof item.value) && String(item.value).length <= 2000 && !/password|credential|private.key|access.token/iu.test(item.key)), "Only bounded scalar declarations without credential fields are supported");
        const keys = new Set(profile.declarations.map(item => item.key));
        requireValue(new Set(profile.assistantScopes.map(item => item.assistantId)).size === profile.assistantScopes.length && profile.assistantScopes.every(scope => canUseAssistant(scope.assistantId) && scope.allowedKeys.length <= 64 && scope.allowedKeys.every(key => keys.has(key)) && scope.purposes.every(purpose => ["conversation", "personalization", "mention"].includes(purpose)) && scope.audiences.every(audience => audience === "authenticatedSession")), "Assistant subset must be explicitly permitted; sharing, training and broader audience grants are unsupported", 403);
        this.db.connection.prepare("INSERT INTO user_profile_revisions (profile_id,principal_id,revision,status,payload_json) VALUES (?,?,?,'draft',?)").run(profile.profileId, principalId, profile.revision, JSON.stringify(profile));
        return { status: 201, body: { profile, previewOnly: true, requiresActivation: true, difference: { priorRevision: active?.revision ?? null, declarationKeys: profile.declarations.map(item => item.key), assistantSubsets: profile.assistantScopes } } };
      }
      const target = profiles.find(item => item.profileId === raw.profileId);
      requireValue(target && target.revision === raw.expectedRevision, "User Profile revision changed", 409);
      if (operation === "activate") {
        requireValue(target!.status === "draft", "Only a reviewed draft can activate", 409);
        requireValue(target!.assistantScopes.every(scope => canUseAssistant(scope.assistantId)), "Assistant permission was revoked", 403);
        this.db.transaction(tx => {
          if (active) tx.run("UPDATE user_profile_revisions SET status='superseded',payload_json=? WHERE profile_id=?", JSON.stringify({ ...active, status: "superseded" }), active.profileId);
          tx.run("UPDATE user_profile_revisions SET status='active',payload_json=? WHERE profile_id=?", JSON.stringify({ ...target, status: "active", consentRefs: [`local-profile-review:${target!.profileId}:${principalId}`] }), target!.profileId);
        });
      } else if (operation === "revoke") {
        requireValue(target!.status === "active", "Only the current active profile can be revoked", 409);
        this.db.connection.prepare("UPDATE user_profile_revisions SET status='revoked',payload_json=? WHERE profile_id=?").run(JSON.stringify({ ...target, status: "revoked", revokedAt: new Date().toISOString() }), target!.profileId);
      } else throw new ProfileScopeError("Unsupported profile operation", 404);
      return { status: 200, body: { profiles: this.list(principalId), activeStateChanged: true } };
    } catch (error) { if (error instanceof ProfileScopeError) return { status: error.status, body: { code: "user_profile_scope_or_revision", message: error.message } }; throw error; }
  }
}
