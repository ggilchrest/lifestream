-- Scoped message annotations; no existing body or consent is rewritten.
CREATE TABLE conversation_message_ratings (entry_id TEXT PRIMARY KEY REFERENCES conversation_timeline(entry_id), actor_id TEXT NOT NULL, effective_user_id TEXT NOT NULL, rating TEXT NOT NULL CHECK(rating IN ('good','bad')), updated_at TEXT NOT NULL);
CREATE TABLE conversation_message_revisions (entry_id TEXT NOT NULL REFERENCES conversation_timeline(entry_id), revision INTEGER NOT NULL, retained_text TEXT NOT NULL, changed_at TEXT NOT NULL, PRIMARY KEY(entry_id,revision));
CREATE TABLE conversation_forks (conversation_id TEXT PRIMARY KEY REFERENCES conversation_catalog(conversation_id), source_conversation_id TEXT NOT NULL, source_entry_id TEXT NOT NULL, cutoff_order INTEGER NOT NULL);
CREATE TABLE conversation_message_clock (conversation_id TEXT PRIMARY KEY REFERENCES conversation_catalog(conversation_id), revision INTEGER NOT NULL);
