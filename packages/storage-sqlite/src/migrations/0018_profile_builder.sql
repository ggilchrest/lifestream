-- Bounded owner-local intake state. Existing scaffold tables retain their data.
CREATE TABLE IF NOT EXISTS profile_builder_jobs (job_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_builder_candidates (candidate_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profile_builder_snapshots (job_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS profile_builder_candidates_job ON profile_builder_candidates(job_id);
