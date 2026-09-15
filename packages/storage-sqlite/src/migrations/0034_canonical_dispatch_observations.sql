-- Reconciliation evidence never replaces an original dispatch response.
CREATE TABLE IF NOT EXISTS canonical_dispatch_observations (
 invocation_id TEXT NOT NULL REFERENCES canonical_dispatch_admissions(invocation_id),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 17), request_id TEXT NOT NULL,
 payload_json TEXT NOT NULL, sha256 TEXT NOT NULL,
 PRIMARY KEY(invocation_id, sequence), UNIQUE(invocation_id, request_id)
);
