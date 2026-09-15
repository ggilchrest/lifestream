CREATE TABLE IF NOT EXISTS understanding_candidate_suppressions (
  scope_key TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  retry_hash TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  PRIMARY KEY(scope_key, artifact_id),
  UNIQUE(scope_key, retry_hash)
);
CREATE INDEX IF NOT EXISTS understanding_candidate_fingerprint ON understanding_candidate_suppressions(scope_key,fingerprint);
