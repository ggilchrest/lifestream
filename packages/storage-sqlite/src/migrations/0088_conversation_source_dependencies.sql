-- Source-only projection. The independent conversation journal is authoritative.
CREATE TABLE conversation_source_admissions (
  admission_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL UNIQUE REFERENCES conversation_timeline(entry_id) ON DELETE CASCADE,
  entry_identity_digest TEXT NOT NULL CHECK(length(entry_identity_digest)=64),
  closure_json TEXT NOT NULL CHECK(json_valid(closure_json) AND length(CAST(closure_json AS BLOB))<=131072),
  closure_digest TEXT NOT NULL CHECK(length(closure_digest)=64),
  original_retention_json TEXT NOT NULL CHECK(json_valid(original_retention_json) AND length(CAST(original_retention_json AS BLOB))<=1024),
  original_retention_digest TEXT NOT NULL CHECK(length(original_retention_digest)=64)
);
CREATE TABLE conversation_source_content_commits (
  content_commit_id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL UNIQUE REFERENCES conversation_source_admissions(admission_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL UNIQUE REFERENCES conversation_timeline(entry_id) ON DELETE CASCADE,
  commit_json TEXT NOT NULL CHECK(json_valid(commit_json) AND length(CAST(commit_json AS BLOB))<=4096),
  commit_digest TEXT NOT NULL CHECK(length(commit_digest)=64)
);
