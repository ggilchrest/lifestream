-- Scope-bound fixture catalogs survive ordinary restart. No grants or outcomes.
CREATE TABLE IF NOT EXISTS fixture_capability_snapshots (
 scope_digest TEXT PRIMARY KEY,
 snapshot_id TEXT NOT NULL UNIQUE,
 expires_at TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 sha256 TEXT NOT NULL
);
