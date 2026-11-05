CREATE TABLE voice_reference_library (
  reference_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  pcm BLOB NOT NULL,
  transcript TEXT NOT NULL,
  provenance_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (principal_id, assistant_id, sha256)
);
CREATE INDEX voice_reference_owner ON voice_reference_library(principal_id,assistant_id);
