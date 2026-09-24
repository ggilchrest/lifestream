-- Outbound notice identity and attempt truth. No notice text, credentials or provider payloads.
CREATE TABLE urgent_away_destination_bindings (
 scope_key TEXT PRIMARY KEY,
 binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64 AND binding_digest NOT GLOB '*[^a-f0-9]*'),
 bound_at TEXT NOT NULL
);
CREATE TABLE urgent_away_dispatches (
 dispatch_id TEXT PRIMARY KEY,
 scope_key TEXT NOT NULL,
 destination_ref TEXT NOT NULL,
 condition_ref TEXT NOT NULL,
 invocation_id TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL CHECK(revision > 0),
 state TEXT NOT NULL CHECK(state IN ('reserved','attempted','accepted','denied','approvalRequired','failed','unknown','cancelled')),
 updated_at TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 UNIQUE(scope_key,destination_ref,condition_ref)
);
CREATE INDEX urgent_away_scope ON urgent_away_dispatches(scope_key,updated_at DESC);
CREATE INDEX urgent_away_state ON urgent_away_dispatches(state);
