CREATE TABLE personal_lists (
  owner TEXT NOT NULL, name TEXT COLLATE NOCASE NOT NULL,
  PRIMARY KEY(owner, name)
);
CREATE TABLE personal_list_items (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, list TEXT COLLATE NOCASE NOT NULL,
  title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  done INTEGER NOT NULL DEFAULT 0, trigger_kind TEXT, cue TEXT, due_at INTEGER,
  delivery TEXT CHECK(delivery IN ('pending','delivered','acknowledged','cancelled','inactive')),
  delivered_to TEXT, delivered_at INTEGER, acknowledged_at INTEGER,
  seen_home_at INTEGER, eligible INTEGER NOT NULL DEFAULT 0, target_endpoint TEXT,
  FOREIGN KEY(owner,list) REFERENCES personal_lists(owner,name)
);
CREATE INDEX personal_list_owner ON personal_list_items(owner,list);
CREATE INDEX personal_list_due ON personal_list_items(delivery,due_at);
CREATE TABLE personal_list_commands (
  owner TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, list TEXT NOT NULL,
  PRIMARY KEY(owner,request_id)
);
