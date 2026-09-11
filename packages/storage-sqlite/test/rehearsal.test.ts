import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/database.ts";
import { backupFixture, restoreFixture } from "../src/rehearsal.ts";

test("fixture backup and restore preserve migration head and integrity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lifestream-sqlite-rehearsal-")); const sourcePath = join(directory, "source.db"); const destinationPath = join(directory, "backup.db");
  const source = new Database({ path: sourcePath }); source.migrate(); source.exec("CREATE TABLE fixture_data (value TEXT NOT NULL)"); source.exec("INSERT INTO fixture_data VALUES ('preserved')");
  const manifest = await backupFixture(source, destinationPath); source.close(); const report = restoreFixture(manifest, (path) => new Database({ path })); assert.equal(report.integrityVerified, true); assert.equal(report.migrationHead, 15); rmSync(directory, { recursive: true, force: true });
});

test("restore rejects a missing or changed backup and backup rejects memory/collision targets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lifestream-sqlite-rehearsal-")); const sourcePath = join(directory, "source.db"); const destinationPath = join(directory, "backup.db"); const source = new Database({ path: sourcePath }); source.migrate();
  await assert.rejects(() => backupFixture(new Database({ path: ":memory:" }), destinationPath), /distinct file/); await assert.rejects(() => backupFixture(source, sourcePath), /distinct file/); const manifest = await backupFixture(source, destinationPath); source.close(); const restored = new Database({ path: destinationPath }); restored.exec("CREATE TABLE changed (value TEXT)"); restored.close(); assert.throws(() => restoreFixture(manifest, (path) => new Database({ path })), /integrity mismatch/); rmSync(directory, { recursive: true, force: true });
});
