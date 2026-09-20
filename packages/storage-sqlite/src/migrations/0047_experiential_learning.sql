CREATE TABLE experience_state (scope_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE experience_episodes (scope_key TEXT NOT NULL, id TEXT NOT NULL, independence TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(scope_key,id), UNIQUE(scope_key,independence));
CREATE TABLE experience_jobs (scope_key TEXT NOT NULL, id TEXT NOT NULL, epoch INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(scope_key,id));
CREATE TABLE experience_calls (scope_key TEXT NOT NULL, job_id TEXT NOT NULL, attempt INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(scope_key,job_id,attempt));
CREATE TABLE experience_lineage (scope_key TEXT NOT NULL, id TEXT NOT NULL, at_ms INTEGER NOT NULL, payload_json TEXT NOT NULL, inverse_items_json TEXT NOT NULL, PRIMARY KEY(scope_key,id));
CREATE TABLE experience_selections (scope_key TEXT NOT NULL, id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(scope_key,id));
CREATE TABLE experience_turns (scope_key TEXT NOT NULL, turn_id TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(scope_key,turn_id));
