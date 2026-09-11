import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";

export type AssistantProfile = Record<string, unknown> & { assistantId: string; profileId: string; revision: number; status: "draft" | "active" | "superseded" | "retired"; createdAt: string; createdBy: string };
const uuid = /^[0-9a-f-]+$/;
function validate(profile: AssistantProfile): void {
  if (profile.schemaVersion !== "2.0.0" || !uuid.test(profile.assistantId) || !uuid.test(profile.profileId) || !Number.isInteger(profile.revision) || profile.revision < 1 || !profile.createdAt.endsWith("Z")) throw new Error("invalid AssistantProfile");
  if (profile.status !== "draft" && profile.status !== "active" && profile.status !== "superseded" && profile.status !== "retired") throw new Error("invalid AssistantProfile status");
}
export class AssistantProfileRepository {
  private readonly database: Database;
  constructor(database: Database) { this.database = database; this.ensureSchema(); }
  private ensureSchema(): void {
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "migrations/0002_assistant_profiles.sql"), "utf8");
    const digest = createHash("sha256").update(sql).digest("hex");
    this.database.transaction((tx) => { const row = tx.get<{ digest: string }>("SELECT digest FROM schema_migrations WHERE id = 2"); if (row && row.digest !== digest) throw new Error("Migration 2 digest mismatch"); if (!row) { tx.database.exec(sql); tx.run("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)", 2, "assistant_profiles", digest, new Date().toISOString()); } });
  }
  create(profile: AssistantProfile): AssistantProfile { validate(profile); this.database.transaction((tx) => tx.run("INSERT INTO assistant_profiles VALUES (?, ?, ?, ?, ?, ?)", profile.assistantId, profile.profileId, profile.revision, profile.status, JSON.stringify(profile), profile.createdAt)); return structuredClone(profile); }
  get(profileId: string): AssistantProfile | undefined { const row = this.database.connection.prepare("SELECT profile_json AS profileJson FROM assistant_profiles WHERE profile_id = ?").get(profileId) as { profileJson: string } | undefined; return row ? JSON.parse(row.profileJson) as AssistantProfile : undefined; }
  list(assistantId: string): AssistantProfile[] { return (this.database.connection.prepare("SELECT profile_json AS profileJson FROM assistant_profiles WHERE assistant_id = ? ORDER BY revision").all(assistantId) as { profileJson: string }[]).map((row) => JSON.parse(row.profileJson) as AssistantProfile); }
  activate(profileId: string, expectedActiveRevision: number | null, actor: string, reason: string, at: string): AssistantProfile {
    return this.database.transaction((tx) => { const candidate = tx.get<{ assistantId: string; revision: number; profileJson: string }>("SELECT assistant_id AS assistantId, revision, profile_json AS profileJson FROM assistant_profiles WHERE profile_id = ? AND status = 'draft'", profileId); if (!candidate) throw new Error("profile is not an activatable draft"); const current = tx.get<{ revision: number }>("SELECT revision FROM assistant_profiles WHERE assistant_id = ? AND status = 'active'", candidate.assistantId); if ((current?.revision ?? null) !== expectedActiveRevision) throw new Error("profile activation conflict"); tx.run("UPDATE assistant_profiles SET status = 'superseded', profile_json = json_set(profile_json, '$.status', 'superseded') WHERE assistant_id = ? AND status = 'active'", candidate.assistantId); tx.run("UPDATE assistant_profiles SET status = 'active', profile_json = json_set(profile_json, '$.status', 'active') WHERE profile_id = ?", profileId); tx.run("INSERT INTO profile_activation_audit (assistant_id, actor, reason, occurred_at, old_revision, new_revision) VALUES (?, ?, ?, ?, ?, ?)", candidate.assistantId, actor, reason, at, current?.revision ?? null, candidate.revision); return { ...JSON.parse(candidate.profileJson) as AssistantProfile, status: "active" }; });
  }
}
