-- Selective descriptions, not screenshots, native saves, controls or grants.
-- Erased source fences remain opaque and are never evicted to permit replay.
CREATE TABLE game_experience_episodes (
 episode_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, revision INTEGER NOT NULL,
 family_key TEXT NOT NULL UNIQUE, policy_digest TEXT NOT NULL, source_digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('retained','forgotten','expired','invalidated')),
 payload_json TEXT,
 CHECK((state='retained' AND payload_json IS NOT NULL) OR (state<>'retained' AND payload_json IS NULL))
);
CREATE INDEX game_experience_owner ON game_experience_episodes(owner_key,state);
CREATE TABLE game_experience_sources (
 source_key TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES game_experience_episodes(episode_id)
);
CREATE TABLE game_experience_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1),observed_at INTEGER NOT NULL);
INSERT INTO game_experience_clock VALUES(1,0);
