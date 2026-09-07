import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../src/database.ts";

test("skills and proposals have inert durable tables", () => { const database = new Database({ path: ":memory:" }); assert.equal(database.migrate().length, 3); assert.ok(database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('skills', 'capability_proposals')").all().length === 2); database.close(); });
