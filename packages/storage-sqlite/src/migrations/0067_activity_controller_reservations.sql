-- Finite metadata/budget custody; no buttons, media, save or executable request.
CREATE TABLE activity_controller_reservations (
 run_id TEXT NOT NULL REFERENCES activity_checkpoints(run_id),
 action_id TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,
 admission_id TEXT NOT NULL UNIQUE,invocation_id TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL, reserved_frames INTEGER NOT NULL,
 reserved_wall_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','settled')),
 settlement_digest TEXT,
 PRIMARY KEY(run_id,action_id)
);
