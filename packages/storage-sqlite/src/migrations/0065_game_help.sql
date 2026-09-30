-- Pending descriptive help only. No send/resume grant, message or raw image.
-- Opaque situation fences survive erasure; capacity cannot reset via reload.
CREATE TABLE game_help_items (
 help_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
 episode_id TEXT NOT NULL REFERENCES game_experience_episodes(episode_id),
 episode_digest TEXT NOT NULL, family_key TEXT NOT NULL UNIQUE,
 policy_digest TEXT NOT NULL, revision INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','forgotten','expired','invalidated')),
 payload_json TEXT, payload_digest TEXT,
 CHECK((state='pending' AND payload_json IS NOT NULL AND payload_digest IS NOT NULL)
    OR (state<>'pending' AND payload_json IS NULL AND payload_digest IS NULL))
);
CREATE INDEX game_help_owner ON game_help_items(owner_key,state);
CREATE INDEX game_help_episode ON game_help_items(episode_id,state);
CREATE TABLE game_help_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1),observed_at INTEGER NOT NULL);
INSERT INTO game_help_clock VALUES(1,0);
