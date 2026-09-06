CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
