-- Local canonical admissions share the same writer as grant lifecycle mutations.
CREATE TABLE IF NOT EXISTS canonical_dispatch_admissions (
 invocation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
 grant_id TEXT NOT NULL REFERENCES canonical_grants(grant_id), idempotency_key TEXT NOT NULL UNIQUE,
 payload_json TEXT NOT NULL, sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS canonical_dispatch_grant ON canonical_dispatch_admissions(grant_id);
CREATE TABLE IF NOT EXISTS canonical_dispatch_claims (
 invocation_id TEXT PRIMARY KEY REFERENCES canonical_dispatch_admissions(invocation_id), claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canonical_dispatch_results (
 invocation_id TEXT PRIMARY KEY REFERENCES canonical_dispatch_claims(invocation_id), payload_json TEXT NOT NULL, sha256 TEXT NOT NULL, evidence_base64 TEXT
);
