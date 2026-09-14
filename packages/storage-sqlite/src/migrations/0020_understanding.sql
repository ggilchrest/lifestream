-- Derived Discovery state only. Canonical user evidence remains in its existing owners.
CREATE TABLE IF NOT EXISTS understanding_work (
  work_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  retry_hash TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  boundary TEXT NOT NULL,
  state TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  payload_json TEXT,
  UNIQUE(scope_key, retry_hash),
  UNIQUE(scope_key, snapshot_key)
);
CREATE INDEX IF NOT EXISTS understanding_work_budget ON understanding_work(scope_key, created_ms);
CREATE INDEX IF NOT EXISTS understanding_work_pending ON understanding_work(state, expires_ms);
CREATE INDEX IF NOT EXISTS understanding_work_expiry ON understanding_work(expires_ms) WHERE payload_json IS NOT NULL;
-- Retry identities survive payload expiry; no source or response content is retained here.
CREATE TABLE IF NOT EXISTS understanding_commands (
  scope_key TEXT NOT NULL,
  retry_hash TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  work_id TEXT NOT NULL,
  PRIMARY KEY(scope_key, retry_hash)
);
CREATE TABLE IF NOT EXISTS understanding_artifacts (
  artifact_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  boundary TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  topic_ref TEXT NOT NULL,
  fresh_until_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS understanding_artifacts_scope ON understanding_artifacts(scope_key, boundary, fresh_until_ms);
CREATE INDEX IF NOT EXISTS understanding_artifacts_expiry ON understanding_artifacts(fresh_until_ms);
CREATE TABLE IF NOT EXISTS understanding_projection (
  projection_id INTEGER PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES understanding_artifacts(artifact_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  boundary TEXT NOT NULL,
  content TEXT NOT NULL,
  fresh_until_ms INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS understanding_projection_fts USING fts5(scope_key, boundary, content, content='understanding_projection', content_rowid='projection_id');
CREATE TRIGGER IF NOT EXISTS understanding_projection_insert AFTER INSERT ON understanding_projection BEGIN
  INSERT INTO understanding_projection_fts(rowid,scope_key,boundary,content) VALUES (new.projection_id,new.scope_key,new.boundary,new.content);
END;
CREATE TRIGGER IF NOT EXISTS understanding_projection_delete AFTER DELETE ON understanding_projection BEGIN
  INSERT INTO understanding_projection_fts(understanding_projection_fts,rowid,scope_key,boundary,content) VALUES ('delete',old.projection_id,old.scope_key,old.boundary,old.content);
END;
