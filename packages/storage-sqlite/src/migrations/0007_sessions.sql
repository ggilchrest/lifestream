CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, endpoint_id TEXT, interaction_id TEXT NOT NULL);
