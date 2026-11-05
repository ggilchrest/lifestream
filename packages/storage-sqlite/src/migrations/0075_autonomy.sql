CREATE TABLE autonomy_settings (
  scope_key TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);
CREATE TABLE autonomy_improvements (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  idea_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(scope_key, idea_key)
);
CREATE INDEX autonomy_improvements_scope ON autonomy_improvements(scope_key);
CREATE TABLE autonomy_jobs (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  job_key TEXT NOT NULL,
  record_json TEXT NOT NULL,
  UNIQUE(scope_key, job_key)
);
CREATE INDEX autonomy_jobs_scope ON autonomy_jobs(scope_key);
CREATE TABLE autonomy_budget (
  scope_key TEXT NOT NULL,
  day INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  compute_ms REAL NOT NULL,
  cost_usd REAL NOT NULL,
  PRIMARY KEY(scope_key, day)
);
CREATE TABLE autonomy_briefings (
  scope_key TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);
CREATE TABLE autonomy_candidate_plans (
  improvement_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  boundary TEXT NOT NULL,
  plan_json TEXT NOT NULL
);
