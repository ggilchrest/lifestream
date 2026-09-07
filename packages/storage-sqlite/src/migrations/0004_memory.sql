CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, content TEXT NOT NULL, provenance_json TEXT NOT NULL, lifecycle_json TEXT NOT NULL, created_at TEXT NOT NULL);
