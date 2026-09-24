CREATE TABLE channel_personal_context (
 assistant_id TEXT NOT NULL,
 principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id),
 revision INTEGER NOT NULL CHECK(revision > 0),
 owner_allowed INTEGER NOT NULL CHECK(owner_allowed IN (0,1)),
 consented INTEGER NOT NULL CHECK(consented IN (0,1)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (assistant_id,principal_id)
);
