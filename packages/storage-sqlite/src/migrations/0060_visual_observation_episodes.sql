-- Explicit, relationship-scoped consent; ordinary automatic memory is insufficient.
CREATE TABLE visual_memory_policies (
 scope_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL, assistant_id TEXT NOT NULL,
 relationship_id TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL, retention_ms INTEGER, approved_at INTEGER NOT NULL
);
CREATE TABLE visual_observation_episodes (
 episode_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES visual_memory_policies(scope_key),
 session_key TEXT NOT NULL, appearance_key TEXT, revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('retained','forgotten','expired','invalidated')),
 retained_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload_json TEXT,
 CHECK((state='retained' AND payload_json IS NOT NULL) OR (state<>'retained' AND payload_json IS NULL))
);
CREATE INDEX visual_episode_scope ON visual_observation_episodes(scope_key,retained_at);
CREATE INDEX visual_episode_expiry ON visual_observation_episodes(state,expires_at);
-- Salted opaque fences retain no observation prose, raw images or subject identity.
CREATE TABLE visual_episode_sources (
 scope_key TEXT NOT NULL, source_key TEXT NOT NULL, episode_id TEXT NOT NULL
 REFERENCES visual_observation_episodes(episode_id), PRIMARY KEY(scope_key,source_key)
);
