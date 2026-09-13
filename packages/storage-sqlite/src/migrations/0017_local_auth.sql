CREATE TABLE IF NOT EXISTS local_accounts (
  principal_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, owner INTEGER NOT NULL CHECK(owner IN (0,1)),
  password_verifier TEXT NOT NULL, totp_secret TEXT, totp_last_step INTEGER NOT NULL DEFAULT -1,
  epoch INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS local_one_owner ON local_accounts(owner) WHERE owner = 1;
CREATE TABLE IF NOT EXISTS local_sessions (
  token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id),
  session_id TEXT NOT NULL, csrf_hash TEXT NOT NULL, origin TEXT NOT NULL,
  epoch INTEGER NOT NULL, authenticated_at INTEGER NOT NULL, admin_last_activity INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS local_recovery_codes (code_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id), epoch INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS local_auth_attempts (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_assistant_permissions (principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id), assistant_id TEXT NOT NULL, administer INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(principal_id,assistant_id));
CREATE TABLE IF NOT EXISTS local_admin_proposals (proposal_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id), session_id TEXT NOT NULL, operation_json TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, decided_by TEXT);
CREATE TABLE IF NOT EXISTS local_auth_events (id INTEGER PRIMARY KEY, principal_id TEXT, action TEXT NOT NULL, occurred_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_skill_revisions (skill_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(skill_id,revision));
