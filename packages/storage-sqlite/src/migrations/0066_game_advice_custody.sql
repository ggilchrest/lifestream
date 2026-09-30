-- Source references only; no reply/scene prose, recipient or delivery authority.
-- Privacy erasure removes the source snapshot; opaque dependency fences remain.
CREATE TABLE game_episode_advice_sources (
 episode_id TEXT NOT NULL REFERENCES game_experience_episodes(episode_id),
 advice_key TEXT NOT NULL, memory_key TEXT NOT NULL, help_key TEXT NOT NULL,
 memory_digest TEXT NOT NULL, help_digest TEXT NOT NULL, source_json TEXT,
 PRIMARY KEY(episode_id,advice_key)
);
CREATE INDEX game_advice_memory ON game_episode_advice_sources(memory_key);
CREATE INDEX game_advice_help ON game_episode_advice_sources(help_key);
