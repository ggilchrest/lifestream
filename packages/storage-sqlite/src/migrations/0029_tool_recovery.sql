CREATE TABLE IF NOT EXISTS tool_recovery_bindings (
  invocation_id TEXT PRIMARY KEY REFERENCES tool_invocation_requests(invocation_id),
  binding_json TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_recovery_observations (
  invocation_id TEXT NOT NULL REFERENCES tool_recovery_bindings(invocation_id),
  sequence INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (invocation_id, sequence)
);
