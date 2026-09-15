-- Canonical Initiative v1 metadata. No candidate text, audio or user transcript.
CREATE TABLE IF NOT EXISTS initiative_delivery (
  opportunity_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  dedup_hash TEXT NOT NULL,
  topic_hash TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  opportunity_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  reserved_ms INTEGER,
  budget_state TEXT NOT NULL DEFAULT 'none' CHECK (budget_state IN ('none','held','charged','released')),
  emission_started INTEGER NOT NULL DEFAULT 0 CHECK (emission_started IN (0,1)),
  receipt_id TEXT,
  UNIQUE (scope_key,dedup_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS initiative_delivery_receipt ON initiative_delivery(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS initiative_delivery_pending ON initiative_delivery(state,scope_key);
CREATE INDEX IF NOT EXISTS initiative_delivery_budget ON initiative_delivery(scope_key,reserved_ms) WHERE budget_state IN ('held','charged');
CREATE INDEX IF NOT EXISTS initiative_delivery_retention ON initiative_delivery(updated_ms);
CREATE TABLE IF NOT EXISTS initiative_source_watermarks (
  scope_key TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY(scope_key,source_kind)
);
-- Kept until host-observed engagement or explicit session reset, including restart.
CREATE TABLE IF NOT EXISTS initiative_unanswered_topics (
  scope_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  topic_hash TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  PRIMARY KEY(scope_key,session_id,topic_hash)
);
CREATE TABLE IF NOT EXISTS initiative_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  last_ms INTEGER NOT NULL
);
