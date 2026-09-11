import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Database } from "../src/database.ts";

test("SQLite database migrates, persists, and rejects changed history", () => {
  const directory = mkdtempSync(join(tmpdir(), "lifestream-sqlite-")); const path = join(directory, "state.db");
  const first = new Database({ path }); assert.equal(first.connection.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(first.migrate().length, 13); assert.equal(first.migrate().length, 13);
  assert.ok(first.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capability_snapshots'").get()); first.close();
  const second = new Database({ path }); assert.equal(second.migrate().length, 13); second.close();
  const changed = new Database({ path, migrations: [{ id: 1, name: "initial", sql: "SELECT 1", digest: "changed" }] });
  assert.throws(() => changed.migrate(), /digest mismatch/); changed.close(); rmSync(directory, { recursive: true, force: true });
});

test("transaction rolls back on failure", () => {
  const database = new Database({ path: ":memory:" }); database.migrate(); database.exec("CREATE TABLE sample (value TEXT NOT NULL)");
  assert.throws(() => database.transaction((tx) => { tx.run("INSERT INTO sample VALUES (?)", "discarded"); throw new Error("stop"); }), /stop/);
  assert.deepEqual(database.connection.prepare("SELECT * FROM sample").all(), []); database.close();
});

test("sparse migration ledger upgrades without rewriting existing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "lifestream-sparse-")); const path = join(directory, "state.db");
  const seed = new Database({ path });
  seed.connection.exec("CREATE TABLE preserved (value TEXT NOT NULL)");
  seed.connection.prepare("INSERT INTO preserved VALUES (?)").run("keep-me");
  const migration = seed.migrate()[0];
  seed.connection.exec("DELETE FROM schema_migrations WHERE id > 1");
  seed.close();
  const upgraded = new Database({ path }); const records = upgraded.migrate();
  assert.equal(records.length, 13); assert.equal(records[0]?.id, migration?.id);
  assert.deepEqual(upgraded.connection.prepare("SELECT value FROM preserved").all().map((row) => ({ ...row })), [{ value: "keep-me" }]);
  upgraded.close(); rmSync(directory, { recursive: true, force: true });
});
