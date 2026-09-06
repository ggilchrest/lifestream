import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MigrationRecord { id: number; name: string; digest: string; appliedAt: string; }
export interface Migration { id: number; name: string; sql: string; digest: string; }

const migrationDirectory = dirname(new URL(import.meta.url).pathname);

export function loadMigrations(): Migration[] {
  return [{ id: 1, name: "initial", file: "0001_initial.sql" }].map(({ id, name, file }) => {
    const sql = readFileSync(join(migrationDirectory, file), "utf8");
    return { id, name, sql, digest: createHash("sha256").update(sql).digest("hex") };
  });
}

export function migrationDigest(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }
