CREATE TABLE IF NOT EXISTS relational_initiative_ledger (
  opportunity_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin = 'relationalOpportunity'),
  urgency TEXT NOT NULL CHECK (urgency = 'low'),
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  outcome TEXT,
  recorded_at TEXT NOT NULL
);
