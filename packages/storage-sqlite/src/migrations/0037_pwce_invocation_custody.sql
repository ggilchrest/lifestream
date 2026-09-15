CREATE TABLE IF NOT EXISTS pwce_invocation_custody (
 invocation_id TEXT PRIMARY KEY,
 idempotency_key TEXT NOT NULL UNIQUE,
 request_digest TEXT NOT NULL,
 request_json TEXT NOT NULL,
 request_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pwce_invocation_observations (
 invocation_id TEXT NOT NULL REFERENCES pwce_invocation_custody(invocation_id),
 sequence INTEGER NOT NULL CHECK(sequence >= 0 AND sequence < 17),
 evidence_sha256 TEXT NOT NULL,
 observation_json TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 PRIMARY KEY(invocation_id, sequence),
 UNIQUE(invocation_id, evidence_sha256)
);
