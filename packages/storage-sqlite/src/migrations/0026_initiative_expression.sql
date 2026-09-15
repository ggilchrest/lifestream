-- Bounded observation metadata only; no generated text, audio or provider prose.
CREATE TABLE IF NOT EXISTS initiative_expression (
  opportunity_id TEXT PRIMARY KEY REFERENCES initiative_delivery(opportunity_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  observed_ms INTEGER NOT NULL,
  report_json TEXT NOT NULL CHECK(length(report_json)<=4096)
);
