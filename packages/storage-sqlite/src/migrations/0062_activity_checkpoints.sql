-- Host metadata and budget reservation only; no emulator/game/save bytes.
CREATE TABLE activity_checkpoints (
 run_id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,activity_id TEXT NOT NULL,
 checkpoint_revision INTEGER NOT NULL,state_revision INTEGER NOT NULL,ledger_revision INTEGER NOT NULL,
 epoch INTEGER NOT NULL,timeline_id TEXT NOT NULL,timeline_revision INTEGER NOT NULL,
 policy_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','needsReview','retracted','expired')),
 payload_json TEXT,used_json TEXT NOT NULL,
 CHECK(state='active' OR payload_json IS NULL)
);
CREATE TABLE activity_planning_reservations (
 run_id TEXT NOT NULL REFERENCES activity_checkpoints(run_id),
 view_id TEXT NOT NULL,view_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,
 reserved_input INTEGER NOT NULL,reserved_output INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','settled')),
 settlement_digest TEXT,
 PRIMARY KEY(run_id,view_id,view_revision)
);
CREATE TABLE activity_metadata_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),observed_at INTEGER NOT NULL);
INSERT INTO activity_metadata_clock VALUES(1,0);
