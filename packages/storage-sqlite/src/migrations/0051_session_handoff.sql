-- Dialogue remains volatile. Persist only use fences and bounded outcome metadata.
CREATE TABLE session_handoff_usage (
 session_id TEXT PRIMARY KEY,
 used_at TEXT NOT NULL
);
-- Existing sign-ins cannot prove that their earlier volatile dialogue was empty.
INSERT INTO session_handoff_usage SELECT session_id,datetime('now') FROM local_sessions;
CREATE TABLE session_handoff_records (
 handoff_id TEXT PRIMARY KEY,
 principal_id TEXT NOT NULL,
 assistant_id TEXT NOT NULL,
 source_session_id TEXT NOT NULL,
 destination_session_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 response_json TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 UNIQUE(principal_id,idempotency_key)
);
