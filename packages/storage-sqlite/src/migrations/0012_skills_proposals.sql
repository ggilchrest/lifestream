CREATE TABLE IF NOT EXISTS skills (
  skill_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_proposals (
  proposal_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'inert'),
  created_at TEXT NOT NULL
);
