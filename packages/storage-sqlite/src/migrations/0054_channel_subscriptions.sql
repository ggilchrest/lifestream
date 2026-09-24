CREATE TABLE channel_subscriptions (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id),
  created_by TEXT NOT NULL REFERENCES local_accounts(principal_id),
  channel TEXT NOT NULL CHECK(channel IN ('telegram','ios-push','android-push')),
  label TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  requested_conversations INTEGER NOT NULL CHECK(requested_conversations IN (0,1)),
  requested_alerts INTEGER NOT NULL CHECK(requested_alerts IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('unpaired','disabled','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX channel_subscriptions_scope ON channel_subscriptions(assistant_id, principal_id);
