-- Approval request custody is distinct from final action admission.
-- No expiry cleanup or replacement of an uncertain original attempt.
CREATE TABLE IF NOT EXISTS pwce_approval_custody (
 producer_key TEXT PRIMARY KEY,
 invocation_id TEXT NOT NULL UNIQUE,
 intent_json TEXT NOT NULL,
 intent_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pwce_approval_observations (
 producer_key TEXT NOT NULL REFERENCES pwce_approval_custody(producer_key),
 sequence INTEGER NOT NULL CHECK(sequence >= 0 AND sequence < 17),
 proof_json TEXT NOT NULL,
 proof_sha256 TEXT NOT NULL,
 PRIMARY KEY(producer_key, sequence),
 UNIQUE(producer_key, proof_sha256)
);
