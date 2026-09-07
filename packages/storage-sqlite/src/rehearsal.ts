import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
export type BackupManifest = { sourcePath: string; destinationPath: string; byteLength: number; sha256: string; migrationHead: number };
export type RestoreReport = { manifest: BackupManifest; restoredPath: string; migrationHead: number; integrityVerified: true };
export type BackupSource = { path: string; backup(destination: string): Promise<number>; connection: { prepare(sql: string): { get(): unknown } } };
export type RestoreDatabase = { migrate(): Array<{ id: number }>; close(): void };

function digest(path: string): { byteLength: number; sha256: string } { const bytes = readFileSync(path); return { byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }; }

export async function backupFixture(source: BackupSource, destinationPath: string): Promise<BackupManifest> {
  if (source.path === ":memory:" || source.path === destinationPath) throw new Error("backup requires a distinct file fixture");
  await source.backup(destinationPath);
  if (!existsSync(destinationPath)) throw new Error("backup did not create destination");
  const file = digest(destinationPath); const migration = source.connection.prepare("SELECT MAX(id) AS head FROM schema_migrations").get() as { head?: number } | undefined;
  return { sourcePath: source.path, destinationPath, ...file, migrationHead: migration?.head ?? 0 };
}

export function restoreFixture(manifest: BackupManifest, openDatabase: (path: string) => RestoreDatabase): RestoreReport {
  if (!existsSync(manifest.destinationPath) || statSync(manifest.destinationPath).isDirectory()) throw new Error("backup artifact is missing");
  const actual = digest(manifest.destinationPath); if (actual.sha256 !== manifest.sha256 || actual.byteLength !== manifest.byteLength) throw new Error("backup integrity mismatch");
  const restored = openDatabase(manifest.destinationPath); const migrations = restored.migrate();
  if ((migrations.at(-1)?.id ?? 0) < manifest.migrationHead) { restored.close(); throw new Error("restored migration history is incomplete"); }
  restored.close(); return { manifest: structuredClone(manifest), restoredPath: manifest.destinationPath, migrationHead: migrations.at(-1)?.id ?? 0, integrityVerified: true };
}
