-- Consumer-owned custody of original intent and foreign producer evidence.
-- Expiry never frees an idempotency key or permits another initial admission.
CREATE TABLE IF NOT EXISTS pwce_admission_custody (
 idempotency_key TEXT PRIMARY KEY,
 invocation_id TEXT NOT NULL UNIQUE,
 intent_digest TEXT NOT NULL,
 intent_json TEXT NOT NULL,
 intent_sha256 TEXT NOT NULL,
 outcome_json TEXT,
 outcome_sha256 TEXT,
 CHECK ((outcome_json IS NULL) = (outcome_sha256 IS NULL))
);
