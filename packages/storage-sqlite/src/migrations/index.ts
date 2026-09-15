import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MigrationRecord { id: number; name: string; digest: string; appliedAt: string; }
export interface Migration { id: number; name: string; sql: string; digest: string; }

const migrationDirectory = dirname(new URL(import.meta.url).pathname);

export function loadMigrations(): Migration[] {
  return [
    [1, "initial", "0001_initial.sql"],
    [2, "assistant_profiles", "0002_assistant_profiles.sql"],
    [3, "adaptations", "0003_adaptations.sql"],
    [4, "memory", "0004_memory.sql"],
    [5, "prepared_context", "0005_prepared_context.sql"],
    [6, "dreaming", "0006_dreaming.sql"],
    [7, "sessions", "0007_sessions.sql"],
    [8, "trace_outbox", "0008_trace_outbox.sql"],
    [9, "human_authority", "0009_human_authority.sql"],
    [11, "capability_cache", "0011_capability_cache.sql"],
    [12, "skills_proposals", "0012_skills_proposals.sql"],
    [13, "endpoints", "0013_endpoints.sql"],
    [14, "memory_lifecycle", "0014_memory_lifecycle.sql"],
    [15, "adaptation_lifecycle", "0015_adaptation_lifecycle.sql"],
    [16, "initiative_ledger", "0016_initiative_ledger.sql"],
    [17, "local_auth", "0017_local_auth.sql"],
    [18, "profile_builder", "0018_profile_builder.sql"],
    [19, "user_profiles", "0019_user_profiles.sql"],
    [20, "understanding", "0020_understanding.sql"],
    [21, "understanding_review", "0021_understanding_review.sql"],
    [22, "understanding_candidates", "0022_understanding_candidates.sql"],
    [23, "initiative_delivery", "0023_initiative_delivery.sql"],
    [24, "initiative_inference", "0024_initiative_inference.sql"],
    [25, "initiative_playback", "0025_initiative_playback.sql"],
    [26, "initiative_expression", "0026_initiative_expression.sql"],
    [27, "governed_admissions", "0027_governed_admissions.sql"],
    [28, "tool_invocations", "0028_tool_invocations.sql"],
    [29, "tool_recovery", "0029_tool_recovery.sql"],
    [30, "canonical_grants", "0030_canonical_grants.sql"],
    [31, "canonical_authority_evidence", "0031_canonical_authority_evidence.sql"],
    [32, "canonical_preparations", "0032_canonical_preparations.sql"],
    [33, "canonical_dispatch", "0033_canonical_dispatch.sql"],
    [34, "canonical_dispatch_observations", "0034_canonical_dispatch_observations.sql"],
    [35, "fixture_capability_snapshots", "0035_fixture_capability_snapshots.sql"],
    [36, "pwce_admission_custody", "0036_pwce_admission_custody.sql"]
  ].map(([id, name, file]) => {
    const sql = readFileSync(join(migrationDirectory, file as string), "utf8");
    return { id: id as number, name: name as string, sql, digest: createHash("sha256").update(sql).digest("hex") };
  });
}

export function migrationDigest(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }
