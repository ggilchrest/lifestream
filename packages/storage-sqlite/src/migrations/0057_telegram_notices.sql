CREATE TABLE telegram_notice_deliveries (
  invocation_id TEXT PRIMARY KEY,
  scope_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES channel_subscriptions(id),
  state TEXT NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown','cancelled')),
  message_id INTEGER,
  updated_at INTEGER NOT NULL
);
