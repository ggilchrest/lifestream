-- Bounded opaque automatic-start identities and controller blocking slots only.
-- No schedule enrollment, emulator state, save bytes or executable command.
CREATE TABLE game_start_claims (
 run_id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, scope_digest TEXT NOT NULL,
 owner_key TEXT NOT NULL, occurrence_key TEXT NOT NULL UNIQUE,
 calendar_key TEXT NOT NULL UNIQUE, policy_digest TEXT NOT NULL,
 claimed_at INTEGER NOT NULL, revision INTEGER NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('claimed','paused','recoveryRequired','stopped','completed')),
 receipt_digest TEXT
);
CREATE INDEX game_start_rolling ON game_start_claims(assistant_id,claimed_at);
CREATE TABLE game_controller_slots (
 assistant_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL UNIQUE REFERENCES game_start_claims(run_id)
);
