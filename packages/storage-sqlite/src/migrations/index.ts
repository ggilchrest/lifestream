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
    [14, "memory_lifecycle", "0014_memory_lifecycle.sql"]
  ].map(([id, name, file]) => {
    const sql = readFileSync(join(migrationDirectory, file as string), "utf8");
    return { id: id as number, name: name as string, sql, digest: createHash("sha256").update(sql).digest("hex") };
  });
}

export function migrationDigest(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }
