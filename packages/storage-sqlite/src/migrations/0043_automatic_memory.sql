CREATE TABLE automatic_memory_policies (
  scope_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE TABLE automatic_memory_work (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES automatic_memory_policies(scope_key),
  source_turn TEXT NOT NULL, policy_revision INTEGER NOT NULL, state TEXT NOT NULL,
  input_text TEXT NOT NULL, input_digest TEXT NOT NULL, prepared_json TEXT, result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, reason TEXT,
  UNIQUE(scope_key,source_turn)
);
CREATE INDEX automatic_memory_pending ON automatic_memory_work(state,created_at);
CREATE TABLE automatic_memory_exclusions (
  principal_id TEXT NOT NULL, assistant_id TEXT NOT NULL, memory_key TEXT NOT NULL,
  removed_at TEXT NOT NULL, PRIMARY KEY(principal_id,assistant_id,memory_key)
);
