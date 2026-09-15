-- Historical admissions remain historical. Missing checked identity is never
-- backfilled from a later request and cannot become permission to dispatch.
CREATE TABLE IF NOT EXISTS dispatch_admissions (
  invocation_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS governed_admission_evidence (
  invocation_id TEXT PRIMARY KEY REFERENCES dispatch_admissions(invocation_id),
  identity_json TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS governed_dispatch_claims (
  invocation_id TEXT PRIMARY KEY REFERENCES governed_admission_evidence(invocation_id),
  claimed_at TEXT NOT NULL
);
