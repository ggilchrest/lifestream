CREATE TABLE IF NOT EXISTS dreaming_runs (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL, input_digest TEXT NOT NULL, proposals_json TEXT NOT NULL, created_at TEXT NOT NULL);
