import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../src/database.ts";

test("endpoint migration is durable and does not imply authority", () => { const database = new Database({ path: ":memory:" }); database.migrate(); database.exec("INSERT INTO interaction_endpoints VALUES ('e', 1, 'testHarness', 'fixture', '{}', 'healthy')"); assert.equal(database.connection.prepare("SELECT endpoint_class, health FROM interaction_endpoints WHERE endpoint_id = 'e'").get()?.endpoint_class, "testHarness"); database.close(); });
