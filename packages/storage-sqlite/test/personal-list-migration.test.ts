import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Database } from "../src/database.ts";
import { loadMigrations, migrationDigest, type Migration } from "../src/migrations/index.ts";

const lists = loadMigrations().find(migration => migration.name === "personal_lists")!;

function fixture(t: TestContext, migrations: Migration[]) {
  const directory = mkdtempSync(join(tmpdir(), "personal-lists-upgrade-"));
  const path = join(directory, "state.sqlite");
  let database = new Database({ path, migrations });
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    initial: database,
    reopen(migrations: Migration[]) {
      database.close();
      database = new Database({ path, migrations });
      return database;
    }
  };
}

test("adding lists preserves an unrelated migration at 69 and its stored rows", t => {
  const sql = "CREATE TABLE earlier_feature (value TEXT)";
  const earlier = { id: 69, name: "earlier_feature", sql, digest: migrationDigest(sql) };
  const store = fixture(t, [earlier]);
  const previous = store.initial.migrate();
  store.initial.exec("INSERT INTO earlier_feature VALUES ('kept')");

  const updated = store.reopen([earlier, lists]);
  const current = updated.migrate();
  assert.deepEqual(current.slice(0, 1), previous);
  assert.equal(current[1].id, 91);
  assert.equal(updated.connection.prepare("SELECT value FROM earlier_feature").get()!.value, "kept");
  updated.exec("INSERT INTO personal_lists (owner, name) VALUES ('test-owner', 'Shopping')");
  assert.deepEqual(updated.migrate(), current);
});

test("upgrading the lists preview preserves the original receipt and saved items", t => {
  const store = fixture(t, [{ ...lists, id: 69 }]);
  const [preview] = store.initial.migrate();
  store.initial.exec("INSERT INTO personal_lists (owner, name) VALUES ('test-owner', 'Shopping')");
  store.initial.exec("INSERT INTO personal_list_items (id, owner, list, title) VALUES ('item', 'test-owner', 'Shopping', 'Apples')");

  const updated = store.reopen([lists]);
  const expected = [{ ...preview, id: 91 }];
  assert.deepEqual(updated.migrate().map(row => ({ ...row })), expected);
  assert.equal(updated.connection.prepare("SELECT title FROM personal_list_items WHERE id = 'item'").get()!.title, "Apples");
  assert.deepEqual(updated.migrate().map(row => ({ ...row })), expected);
});

test("a Windows preview upgrades to the same lists migration fingerprint", t => {
  assert.ok(!lists.sql.includes("\r"));
  const sql = lists.sql.replace(/\n/g, "\r\n");
  const store = fixture(t, [{ ...lists, id: 69, sql, digest: migrationDigest(sql) }]);
  const [preview] = store.initial.migrate();
  const [upgraded] = store.reopen([lists]).migrate();
  assert.equal(upgraded.digest, lists.digest);
  assert.equal(upgraded.id, 91);
  assert.equal(upgraded.appliedAt, preview.appliedAt);
});

test("a different preview fingerprint leaves the migration ledger intact", t => {
  const sql = lists.sql + "\n-- different preview\n";
  const store = fixture(t, [{ ...lists, id: 69, sql, digest: migrationDigest(sql) }]);
  store.initial.migrate();

  const updated = store.reopen([lists]);
  assert.throws(() => updated.migrate(), /preview migration digest mismatch/);
  const rows = updated.connection.prepare("SELECT id, digest FROM schema_migrations ORDER BY id").all();
  assert.deepEqual(rows.map(row => [row.id, row.digest]), [[69, migrationDigest(sql)]]);
});
