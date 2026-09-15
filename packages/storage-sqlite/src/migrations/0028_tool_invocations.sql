CREATE TABLE IF NOT EXISTS tool_invocation_requests (
  idempotency_key TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  interaction_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  response_json TEXT,
  response_sha256 TEXT,
  CHECK ((response_json IS NULL) = (response_sha256 IS NULL))
);
