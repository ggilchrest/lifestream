CREATE TABLE IF NOT EXISTS capability_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  authority_provider_ref TEXT NOT NULL,
  authority_context_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capability_snapshots_scope_idx
  ON capability_snapshots (assistant_id, endpoint_id, session_id, environment, authority_provider_ref, authority_context_id, authority_revision);
