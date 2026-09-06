CREATE TABLE IF NOT EXISTS assistant_profiles (
  assistant_id TEXT NOT NULL,
  profile_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (assistant_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_profiles_one_active ON assistant_profiles (assistant_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS profile_activation_audit (
  id INTEGER PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  old_revision INTEGER,
  new_revision INTEGER NOT NULL
);
