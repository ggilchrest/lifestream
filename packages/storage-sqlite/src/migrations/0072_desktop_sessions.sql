-- Control metadata only; no frames, native bearer tokens or input payloads.
CREATE TABLE desktop_sessions (
 session_id TEXT PRIMARY KEY,
 installation_id TEXT NOT NULL,
 resource_group_id TEXT NOT NULL,
 projection_json TEXT NOT NULL,
 process_instance_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 event_sequence INTEGER NOT NULL DEFAULT 0,
 heartbeat_sequence INTEGER NOT NULL DEFAULT 0,
 UNIQUE(installation_id, resource_group_id)
);
CREATE TABLE desktop_operations (
 operation_id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL,
 effective_user_id TEXT NOT NULL,
 authenticated_session_id TEXT NOT NULL,
 installation_id TEXT NOT NULL,
 client_instance_id TEXT NOT NULL,
 context_ref TEXT NOT NULL,
 context_generation INTEGER NOT NULL,
 authority_revision INTEGER NOT NULL,
 session_id TEXT NOT NULL REFERENCES desktop_sessions(session_id),
 session_epoch INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 request_json TEXT NOT NULL,
 result_json TEXT NOT NULL,
 failure_code TEXT,
 created_at_ms INTEGER NOT NULL,
 UNIQUE(actor_id,effective_user_id,session_id,session_epoch,idempotency_key)
);
CREATE TABLE desktop_events (
 session_id TEXT NOT NULL REFERENCES desktop_sessions(session_id),
 event_sequence INTEGER NOT NULL,
 event_json TEXT NOT NULL,
 PRIMARY KEY(session_id,event_sequence)
);
CREATE TABLE desktop_viewers (
 viewer_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL REFERENCES desktop_sessions(session_id),
 actor_id TEXT NOT NULL,
 effective_user_id TEXT NOT NULL,
 authenticated_session_id TEXT NOT NULL,
 installation_id TEXT NOT NULL,
 client_instance_id TEXT NOT NULL,
 context_ref TEXT NOT NULL,
 context_generation INTEGER NOT NULL,
 authority_revision INTEGER NOT NULL,
 session_epoch INTEGER NOT NULL,
 surface_id TEXT NOT NULL,
 source_binding_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
