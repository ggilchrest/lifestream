-- Explicit subject mappings and versioned declarations; no legacy identity inference.
CREATE TABLE IF NOT EXISTS user_profile_deployment (singleton INTEGER PRIMARY KEY CHECK(singleton=1), deployment_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_subject_mappings (principal_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, deployment_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_profile_revisions (profile_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES user_subject_mappings(principal_id), revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','active','superseded','revoked')), payload_json TEXT NOT NULL, UNIQUE(principal_id,revision));
CREATE UNIQUE INDEX IF NOT EXISTS user_profile_active ON user_profile_revisions(principal_id) WHERE status='active';
