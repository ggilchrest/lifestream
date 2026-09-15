-- Minimal pending-output bookkeeping; no candidate or audio payload is retained.
CREATE TABLE IF NOT EXISTS initiative_playback_pending (
  opportunity_id TEXT PRIMARY KEY REFERENCES initiative_delivery(opportunity_id) ON DELETE CASCADE
);
