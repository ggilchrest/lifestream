-- Payload-free source lifecycle fences survive erasure, expiry and restart.
-- They carry no text, audio, credentials or inferred subject identity.
CREATE TABLE conversation_content_fences (
 entry_id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversation_catalog(conversation_id),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 reason TEXT NOT NULL,
 changed_at TEXT NOT NULL
);
CREATE INDEX conversation_content_fences_conversation ON conversation_content_fences(conversation_id,entry_id);
CREATE UNIQUE INDEX conversation_timeline_identity ON conversation_timeline(conversation_id,turn_id,speaker);
