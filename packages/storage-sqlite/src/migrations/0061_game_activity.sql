-- Metadata continuity only. No game bytes, emulator state or executable controls.
CREATE TABLE campaign_journals (
 journal_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, campaign_id TEXT NOT NULL,
 revision INTEGER NOT NULL, access_revision INTEGER NOT NULL,
 policy_revision INTEGER NOT NULL,policy_digest TEXT NOT NULL,expires_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','needsReview','retracted','expired')),
 header_json TEXT, goals_json TEXT,
 CHECK(state IN ('active','needsReview') OR (header_json IS NULL AND goals_json IS NULL))
);
CREATE INDEX campaign_journal_owner ON campaign_journals(owner_key,campaign_id);
CREATE TABLE campaign_journal_entries (
 journal_id TEXT NOT NULL REFERENCES campaign_journals(journal_id),entry_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,payload_json TEXT,
 state TEXT NOT NULL CHECK(state IN ('retained','omitted','fenced')),
 PRIMARY KEY(journal_id,entry_id),CHECK(state='retained' OR payload_json IS NULL)
);
CREATE TABLE campaign_journal_sources (
 owner_key TEXT NOT NULL,source_hash TEXT NOT NULL,fenced INTEGER NOT NULL CHECK(fenced IN (0,1)),
 PRIMARY KEY(owner_key,source_hash)
);
CREATE TABLE campaign_journal_goal_versions (
 journal_id TEXT NOT NULL REFERENCES campaign_journals(journal_id),goal_id TEXT NOT NULL,
 revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,fenced INTEGER NOT NULL CHECK(fenced IN (0,1)),
 PRIMARY KEY(journal_id,goal_id)
);
CREATE TABLE campaign_journal_entry_sources (
 journal_id TEXT NOT NULL,entry_id TEXT NOT NULL,owner_key TEXT NOT NULL,source_hash TEXT NOT NULL,
 PRIMARY KEY(journal_id,entry_id,source_hash),
 FOREIGN KEY(journal_id,entry_id) REFERENCES campaign_journal_entries(journal_id,entry_id),
 FOREIGN KEY(owner_key,source_hash) REFERENCES campaign_journal_sources(owner_key,source_hash)
);
CREATE TABLE campaign_journal_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1),observed_at INTEGER NOT NULL);
INSERT INTO campaign_journal_clock VALUES(1,0);
