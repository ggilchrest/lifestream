-- Review receipts retain request digests, never user notes or hypothesis prose.
CREATE TABLE IF NOT EXISTS understanding_reviews (
  scope_key TEXT NOT NULL,
  retry_hash TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('reviewHypothesis','rejectHypothesis')),
  PRIMARY KEY (scope_key, retry_hash)
);
-- Replayed from the existing owner-local recovery journal after database restore.
CREATE TABLE IF NOT EXISTS understanding_hypothesis_rejections (
  scope_key TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rejected_revision INTEGER NOT NULL,
  PRIMARY KEY (scope_key, artifact_id)
);
CREATE INDEX IF NOT EXISTS understanding_rejection_fingerprint ON understanding_hypothesis_rejections(scope_key, fingerprint);
CREATE INDEX IF NOT EXISTS understanding_hypothesis_status ON understanding_artifacts(scope_key, kind, json_extract(payload_json, '$.status'), fresh_until_ms);
