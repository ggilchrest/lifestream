-- A call reservation is consumed even when inference fails or returns no candidate.
-- No provider payload, output text or permission is persisted here.
CREATE TABLE IF NOT EXISTS initiative_inference_calls (
  opportunity_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  claim_id TEXT NOT NULL UNIQUE,
  started_ms INTEGER NOT NULL,
  settled_ms INTEGER,
  runtime_slot INTEGER NOT NULL DEFAULT 1 CHECK (runtime_slot=1)
);
CREATE UNIQUE INDEX IF NOT EXISTS initiative_inference_active
  ON initiative_inference_calls(runtime_slot) WHERE settled_ms IS NULL;
CREATE INDEX IF NOT EXISTS initiative_inference_scope_budget
  ON initiative_inference_calls(scope_key,started_ms);
CREATE INDEX IF NOT EXISTS initiative_inference_runtime_budget
  ON initiative_inference_calls(started_ms);
