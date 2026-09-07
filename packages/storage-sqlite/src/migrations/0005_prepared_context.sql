CREATE TABLE IF NOT EXISTS prepared_context (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, cache_key TEXT NOT NULL, context_json TEXT NOT NULL, expires_at TEXT NOT NULL);
