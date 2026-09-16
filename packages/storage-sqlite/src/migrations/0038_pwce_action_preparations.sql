-- Lifestream-owned immutable review; no foreign grant or dispatch authority.
CREATE TABLE IF NOT EXISTS pwce_action_preparations (
 principal_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 invocation_id TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 PRIMARY KEY(principal_id,idempotency_key)
);
